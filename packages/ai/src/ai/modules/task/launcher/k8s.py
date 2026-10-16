# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
The Kubernetes runtime: each task runs in its own Job, one pod from ``rocketride/node``.

The ``kubectl`` CLI drives it through ``asyncio.create_subprocess_exec``, never a
library: ``kubectl attach -i`` is a real process whose stdout, stderr and stdin
are the task's, so the stdio reader and ``--autoterm`` work as they do for a
subprocess. A run is three commands — ``create -f -``, ``attach -i -q``,
``delete job`` — beside one ``get pods --watch`` that serves every task of the
engine. The exit code always comes from that watch, never from ``kubectl
attach``, which returns 0 whatever the task did.

Nothing of a task is kept in the cluster: the Job's manifest holds neither the
task file nor a value of the environment. Both travel in one tar stream on the
attach's stdin, which the container's command (``BOOTSTRAP``) unpacks before
it becomes the engine. What follows the archive on that stdin is the engine's
own, and its staying open is what ``--autoterm`` watches.

A crashed task's minidump is not fetched yet: it goes with the pod.
"""

from __future__ import annotations

import asyncio
import atexit
import io
import json
import os
import re
import shlex
import signal
import socket
import tarfile
import time
import uuid
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from rocketlib import debug

from ai.constants import CONST_SUBPROCESS_BUFFER_LIMIT

from .base import Launch, Launcher, LaunchSpec
from .docker import (
    CONST_CLI_TIMEOUT,
    CONST_CONTAINER_CRASHDB_PATH,
    CONST_CONTAINER_DATA_PATH,
    CONST_CONTAINER_ENGINE,
    CONST_CONTAINER_NODE_SCRIPT,
    CONST_IMAGE_GID,
    CONST_IMAGE_UID,
    CONST_TASK_DATA_PORT_CONTAINER,
    LABEL_EAS,
    LABEL_TASK,
    CliResult,
    StoreUnavailableError,
    engine_version,
    is_host_only,
    rewrite_loopback,
    rewrite_loopback_dsns,
)

if TYPE_CHECKING:
    from ..task_server import TaskServer

# The one container of a task's pod
CONST_CONTAINER_NAME = 'task'

# The environment inside the start stream: sourced by the bootstrap, then removed
CONST_ENV_FILE = '.rr-env'

# Where the directories named in k8s.mounts land, under the data directory
CONST_MOUNT_DIR = 'mounts'

# The most those directories may hold: they travel in the start stream of every task
CONST_MOUNT_SIZE_LIMIT = 16 * 1024 * 1024

# The exit code of a task whose pod is gone before it showed one, as after SIGKILL
CONST_LOST_EXIT_CODE = -9

# Seconds `kubectl delete pod` leaves the engine between SIGTERM and SIGKILL
CONST_TERMINATE_GRACE = 5

# Seconds a port-forward may take to listen (measured: 0.15)
CONST_FORWARD_TIMEOUT = 30.0

# A watch that ends sooner than this is not started again at once: the cluster cannot be reached
CONST_WATCH_MIN_LIFE = 5.0

# Seconds one watch lives before it ends itself and is started again. It bounds a watch whose
# engine went without running its exit hooks (--autoterm leaves by quick_exit): nothing else ends it
CONST_WATCH_MAX_LIFE = 300

# Seconds a new watch gets to print the pods that exist before the missing ones are counted
CONST_WATCH_SETTLE = 2.0

# The values behind the labels, which Kubernetes cuts to 63 plain characters
ANNOTATION_TASK = 'rocketride.task-id'
ANNOTATION_EAS = 'rocketride.eas-instance'

# One line per watch event: its type, then the pod's name, Job, phase, IP, exit code and waiting reason
WATCH_FORMAT = (
    '{.type}|{.object.metadata.name}|{.object.metadata.labels.job-name}'
    '|{.object.status.phase}|{.object.status.podIP}'
    '|{.object.status.containerStatuses[0].state.terminated.exitCode}'
    '|{.object.status.containerStatuses[0].state.waiting.reason}{"\\n"}'
)
WATCH_EVENTS = frozenset({'ADDED', 'MODIFIED', 'DELETED'})

# Waiting reasons that do not pass by themselves: the start is refused with what is wrong
START_FAILURES: Dict[str, str] = {
    'ErrImageNeverPull': 'Image {image} not found on the node (k8s.image_pull_policy is Never, so it is not pulled)',
    'ImagePullBackOff': 'Image {image} cannot be pulled to the node',
    'CreateContainerConfigError': 'The container of pod {pod} cannot be created (CreateContainerConfigError)',
}

# A name the shell can export
ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')

# The container's command. `head -c N` takes exactly the start stream, so the rest of stdin
# is the engine's and stays open; nobody attached within `t` seconds and `timeout` ends the
# wait, tar fails and so does the pod. What is unpacked is private (umask 077); the engine
# gets the image's own umask back. After `exec` it is PID 1 and gets SIGTERM itself.
BOOTSTRAP = '\n'.join(
    [
        'set -eu',
        'umask 077',
        'n=$1; t=$2; shift 2',
        'timeout "$t" head -c "$n" | tar -xf - -C {data}',
        'if [ -f {data}/{env} ]; then set -a; . {data}/{env}; set +a; rm -f {data}/{env}; fi',
        'umask 022',
        'exec "$@"',
    ]
).format(data=CONST_CONTAINER_DATA_PATH, env=CONST_ENV_FILE)

# k8s.* settings, their RR_K8S_* variables and defaults ('' = derived, or not set)
DEFAULT_CONFIG: Dict[str, str] = {
    'namespace': 'rocketride-tasks',
    'context': '',
    'image': '',
    'image_pull_policy': 'IfNotPresent',
    'memory': '2Gi',
    'cpus': '1',
    'memory_request': '256Mi',
    'cpu_request': '100m',
    'ephemeral_storage': '',
    'reach': 'auto',
    'host_alias': '',
    'mounts': '',
    'instance': '',
    'node_selector': '',
    'tolerations': '',
    'node': '',
    'runtime_class': '',
    'start_timeout': '120',
    'ttl': '600',
}

IMAGE_PULL_POLICIES = {'always': 'Always', 'ifnotpresent': 'IfNotPresent', 'never': 'Never'}


class K8sError(RuntimeError):
    """A kubectl command failed, or the cluster cannot run the task."""


def node_selector(text: str) -> Dict[str, str]:
    """
    The ``node_selector`` setting as a pod spec holds it.

    Args:
        text: ``key=value[,key=value]``.

    Returns:
        The node labels a task's pod asks for.

    Raises:
        ValueError: If a pair has no key or no ``=``.
    """
    selector: Dict[str, str] = {}
    for pair in filter(None, (p.strip() for p in text.split(','))):
        key, equals, value = pair.partition('=')
        if not equals or not key.strip():
            raise ValueError(f'k8s.node_selector must be key=value[,key=value], not {text!r}')
        selector[key.strip()] = value.strip()
    return selector


def tolerations(text: str) -> List[Dict[str, Any]]:
    """
    The ``tolerations`` setting as a pod spec holds it.

    Args:
        text: A JSON list of tolerations, or ''.

    Returns:
        The tolerations.

    Raises:
        ValueError: If it is not a JSON list of objects.
    """
    if not text.strip():
        return []
    try:
        value = json.loads(text)
    except ValueError as e:
        raise ValueError(f'k8s.tolerations must be a JSON list of tolerations: {e}') from e
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f'k8s.tolerations must be a JSON list of tolerations, not {text!r}')
    return value


def label_value(text: str) -> str:
    """
    A string as a label value: at most 63 of ``[A-Za-z0-9._-]``, a letter or digit at both ends.

    Args:
        text: A task id or an instance id.

    Returns:
        The value; what it was made from goes into an annotation.
    """
    return re.sub(r'[^A-Za-z0-9._-]', '_', text)[:63].strip('._-')


def job_name(task_id: str) -> str:
    """
    A new Job name for a task: ``rr-<task id>-<6 hex>``.

    The id is cut to what a DNS label allows; the suffix tells two runs of
    one task apart.

    Args:
        task_id: The task's id.

    Returns:
        The name, short enough for the pod name made from it.
    """
    stem = re.sub(r'[^a-z0-9]+', '-', task_id.lower()).strip('-')[:40].strip('-') or 'task'
    return f'rr-{stem}-{uuid.uuid4().hex[:6]}'


def double_dollars(command: Sequence[str]) -> List[str]:
    """
    A command as a pod spec has to hold it.

    Kubernetes expands ``$(NAME)`` in ``command`` and turns ``$$`` into ``$``
    (measured), so every ``$`` is doubled and arrives as written.

    Args:
        command: The command as the container must see it.

    Returns:
        The command for the manifest.
    """
    return [element.replace('$', '$$') for element in command]


def k8s_config(config: Mapping[str, Any], environ: Mapping[str, str]) -> Dict[str, str]:
    """
    The k8s runtime's settings: ``server.config['k8s']``, then ``RR_K8S_*``, then defaults.

    Args:
        config: The server config (``port`` names the default instance id).
        environ: The engine's environment (``.env`` is already loaded into it).

    Returns:
        Every key of ``DEFAULT_CONFIG``, filled in.

    Raises:
        ValueError: If a setting cannot be used; the message names it.
    """
    merged = dict(DEFAULT_CONFIG)
    for key in DEFAULT_CONFIG:
        value = environ.get(f'RR_K8S_{key.upper()}')
        if value:
            merged[key] = value
    for key, value in (config.get('k8s') or {}).items():
        if value not in (None, ''):
            merged[key] = str(value)
    merged = {key: value.strip() for key, value in merged.items()}

    merged['reach'] = merged['reach'].lower()
    if merged['reach'] not in ('auto', 'pod', 'forward'):
        raise ValueError(f'k8s.reach must be auto, pod or forward, not {merged["reach"]!r}')
    policy = IMAGE_PULL_POLICIES.get(merged['image_pull_policy'].lower())
    if policy is None:
        raise ValueError(
            f'k8s.image_pull_policy must be Always, IfNotPresent or Never, not {merged["image_pull_policy"]!r}'
        )
    merged['image_pull_policy'] = policy
    for key in ('start_timeout', 'ttl'):
        if not (merged[key].isascii() and merged[key].isdigit()) or int(merged[key]) == 0:
            raise ValueError(f'k8s.{key} must be a number of seconds above zero, not {merged[key]!r}')
    if not merged['namespace']:
        raise ValueError('k8s.namespace must name the namespace tasks run in')
    for name in filter(None, (n.strip() for n in merged['mounts'].split(','))):
        # A name becomes a directory in the pod and a variable of its shell
        if not ENV_NAME.fullmatch(name):
            raise ValueError(f'k8s.mounts must hold names of variables, not {name!r}')
    node_selector(merged['node_selector'])
    tolerations(merged['tolerations'])
    if merged['node'] == 'same':
        merged['node'] = environ.get('NODE_NAME', '').strip()
        if not merged['node']:
            raise ValueError("k8s.node=same needs NODE_NAME, the engine's own node, in the environment")

    if not merged['image']:
        merged['image'] = f'rocketride/node:{engine_version()}'
    # Stable across restarts, or the startup sweep finds nothing to remove
    if not merged['instance']:
        merged['instance'] = f'{socket.gethostname()}-{config.get("port", 5565)}'
    if not label_value(merged['instance']):
        raise ValueError(f'k8s.instance must hold a letter or a digit, not {merged["instance"]!r}')
    return merged


def env_file(env: Mapping[str, str]) -> bytes:
    """
    A task's environment as the ``export`` lines the bootstrap sources.

    ``shlex.quote`` keeps a value literal, so quotes, ``$``, backticks and line
    breaks arrive as they are. A name the shell cannot hold is left out.

    Args:
        env: The task's environment.

    Returns:
        The file.
    """
    lines = [f'export {name}={shlex.quote(env[name])}\n' for name in sorted(env) if ENV_NAME.fullmatch(name)]
    return ''.join(lines).encode('utf-8', 'surrogateescape')


def _tar_member(name: str, mode: int, size: int = 0, directory: bool = False) -> tarfile.TarInfo:
    """
    The header of one member of the start stream, owned by the image's user.

    Args:
        name: The member's path under the data directory.
        mode: Its permissions.
        size: Its length, for a file.
        directory: Whether it is a directory.

    Returns:
        The header.
    """
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.uid, info.gid = CONST_IMAGE_UID, CONST_IMAGE_GID
    info.uname = info.gname = 'rocketride'
    info.mtime = int(time.time())
    if directory:
        info.type = tarfile.DIRTYPE
    return info


def _add_directory(tar: tarfile.TarFile, source: str, target: str, budget: int) -> int:
    """
    Put a host directory into the start stream: its directories and its regular files.

    Args:
        tar: The archive being written.
        source: The directory on this host.
        target: Its path in the archive.
        budget: The bytes the mounted directories may still take.

    Returns:
        What is left of the budget.

    Raises:
        K8sError: If the directory does not fit.
    """
    for root, directories, files in os.walk(source):
        directories.sort()
        relative = os.path.relpath(root, source).replace(os.sep, '/')
        base = target if relative == '.' else f'{target}/{relative}'
        tar.addfile(_tar_member(base, 0o755, directory=True))
        for name in sorted(files):
            path = os.path.join(root, name)
            if not os.path.isfile(path):
                continue
            budget -= os.path.getsize(path)
            if budget < 0:
                raise K8sError(
                    f'The directories named in k8s.mounts hold more than {CONST_MOUNT_SIZE_LIMIT // 2**20} MiB '
                    f'(at {source}); they are sent to every task as it starts'
                )
            with open(path, 'rb') as f:
                data = f.read()
            mode = 0o755 if os.stat(path).st_mode & 0o100 else 0o644
            tar.addfile(_tar_member(f'{base}/{name}', mode, len(data)), io.BytesIO(data))
    return budget


def payload_tar(task_file: bytes, env: Mapping[str, str], directories: Mapping[str, str]) -> bytes:
    """
    The start stream: what a task's pod reads from stdin before it becomes the engine.

    One tar archive with ``task.json`` and the environment file, both 0600,
    and each directory of ``k8s.mounts`` under ``mounts/<NAME>``. It has no
    member for the root: unpacking one would change ``/opt/data`` itself.

    Args:
        task_file: The task file.
        env: The task's environment.
        directories: Host directories, by the name of the variable that names each.

    Returns:
        The tar archive.

    Raises:
        K8sError: If the directories hold more than ``CONST_MOUNT_SIZE_LIMIT``.
    """
    buffer = io.BytesIO()
    # GNU headers: a long path stays one member for any tar
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.GNU_FORMAT) as tar:
        for name, data in (('task.json', task_file), (CONST_ENV_FILE, env_file(env))):
            tar.addfile(_tar_member(name, 0o600, len(data)), io.BytesIO(data))
        budget = CONST_MOUNT_SIZE_LIMIT
        for variable in sorted(directories):
            budget = _add_directory(tar, directories[variable], f'{CONST_MOUNT_DIR}/{variable}', budget)
    return buffer.getvalue()


_QUANTITY_UNITS = {
    'n': 1e-9,
    'u': 1e-6,
    'm': 1e-3,
    '': 1.0,
    'k': 1e3,
    'M': 1e6,
    'G': 1e9,
    'T': 1e12,
    'Ki': 2.0**10,
    'Mi': 2.0**20,
    'Gi': 2.0**30,
    'Ti': 2.0**40,
}


def parse_quantity(text: str) -> Optional[float]:
    """
    A Kubernetes quantity such as ``1500000n``, ``250m`` or ``128Mi`` as a number.

    Args:
        text: The quantity text.

    Returns:
        Cores or bytes, or None when it cannot be read.
    """
    match = re.fullmatch(r'\s*([0-9]*\.?[0-9]+)\s*([A-Za-z]*)\s*', str(text or ''))
    if not match or match.group(2) not in _QUANTITY_UNITS:
        return None
    return float(match.group(1)) * _QUANTITY_UNITS[match.group(2)]


# The kubectl processes nothing ends with the engine: a watch and a port-forward have no stdin to see it go
_helpers: set = set()


def _end_helpers() -> None:
    """
    End the helper processes still running, as the engine exits.

    An ``atexit`` hook: a child is not ended with its parent, and a watch would
    go on until the cluster closes it. The event loop is closed by now, so each
    is signalled by pid and not through its transport.
    """
    while _helpers:
        process = _helpers.pop()
        if process.returncode is None:
            try:
                os.kill(process.pid, signal.SIGTERM)
            except OSError:
                pass


atexit.register(_end_helpers)


async def _stop(process: Optional[asyncio.subprocess.Process]) -> None:
    """
    End a helper process (a watch, an attach, a port-forward) and reap it.

    Args:
        process: The process, or None.
    """
    if process is None:
        return
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()
    _helpers.discard(process)


async def _discard(stream: asyncio.StreamReader) -> None:
    """
    Read a helper's output to its end, so a full pipe never stalls it.

    Args:
        stream: The output nobody else reads.
    """
    try:
        while await stream.read(4096):
            pass
    except OSError:
        pass


class KubectlCli:
    """Runs the kubectl CLI; tests replace it with a fake that records every argv."""

    def __init__(self, executable: str = 'kubectl', context: str = '', namespace: str = '') -> None:
        """
        Remember which binary to run, and against what.

        Args:
            executable: The kubectl CLI.
            context: The kubeconfig context; '' is the current one, or the cluster the engine runs in.
            namespace: The namespace of every command.
        """
        self.executable = executable
        self.context = context
        self.namespace = namespace

    def argv(self, args: Sequence[str]) -> List[str]:
        """
        A command with the cluster and namespace it applies to.

        Args:
            args: The command and its arguments.

        Returns:
            The arguments after ``kubectl``.
        """
        scope = ['--context', self.context] if self.context else []
        return [*scope, '-n', self.namespace, *args]

    async def run(
        self,
        args: Sequence[str],
        *,
        stdin: Optional[bytes] = None,
        check: bool = True,
        timeout: float = CONST_CLI_TIMEOUT,
    ) -> CliResult:
        """
        Run one command to completion.

        Args:
            args: The command and its arguments.
            stdin: Bytes to feed it, if any.
            check: Raise on a non-zero exit code.
            timeout: Seconds before the command is killed: kubectl itself waits on an API
                server that does not answer for as long as it takes.

        Returns:
            Its exit code and output.

        Raises:
            K8sError: If ``check`` and the command failed, or if it did not end within ``timeout``.
        """
        process = await asyncio.create_subprocess_exec(
            self.executable,
            *self.argv(args),
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout)
        except BaseException as e:
            # A timeout or a cancel: the command does not go on alone (a create would leave a
            # Job nobody removes), and its pipes are read to their end, or it is never reaped
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.communicate()
            if isinstance(e, asyncio.TimeoutError):
                # No exit code is coming: the caller learns it from the error, whatever check says
                raise K8sError(f'kubectl {args[0]} timed out after {timeout:g} s') from None
            raise
        result = CliResult(process.returncode, stdout.decode(errors='replace'), stderr.decode(errors='replace'))
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise K8sError(f'kubectl {args[0]} failed (exit {result.returncode}): {detail}')
        return result

    async def attach(self, args: Sequence[str]) -> asyncio.subprocess.Process:
        """
        Start a long-running command whose stdio the caller reads (``attach -i``).

        Args:
            args: The command and its arguments.

        Returns:
            The running process, with its stdin, stdout and stderr piped.
        """
        return await asyncio.create_subprocess_exec(
            self.executable,
            *self.argv(args),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=CONST_SUBPROCESS_BUFFER_LIMIT,
        )

    async def spawn(self, args: Sequence[str]) -> asyncio.subprocess.Process:
        """
        Start a long-lived helper that only talks (``get --watch``, ``port-forward``).

        Args:
            args: The command and its arguments.

        Returns:
            The running process; its stdout carries its stderr too, so one reader keeps both from filling.
        """
        process = await asyncio.create_subprocess_exec(
            self.executable,
            *self.argv(args),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # Ended with the engine at the latest (see _end_helpers)
        _helpers.add(process)
        return process


class WatchedPod:
    """The pod of one launch as the watch last showed it; ``start()`` and the launch wait on it."""

    def __init__(self, job: str) -> None:
        """
        Know nothing yet but the Job the pod will belong to.

        Args:
            job: The Job's name.
        """
        self.job = job
        self.name = ''
        self.phase = ''
        self.ip = ''
        # Why the container is not running yet: ContainerCreating, ErrImageNeverPull, ...
        self.waiting = ''
        self.exit_code: Optional[int] = None
        self._changed = asyncio.Event()

    @property
    def ended(self) -> bool:
        """Whether the pod is over: it has an exit code, or a phase nothing follows."""
        return self.exit_code is not None or self.phase in ('Succeeded', 'Failed')

    def seen(self, name: str, phase: str, ip: str, waiting: str, exit_code: Optional[int], gone: bool) -> None:
        """
        Take one watch event.

        Args:
            name: The pod's name.
            phase: Its phase.
            ip: Its IP, or ''.
            waiting: Its container's waiting reason, or ''.
            exit_code: Its container's exit code, or None.
            gone: The event is the pod's deletion.
        """
        self.name, self.phase, self.waiting = name, phase, waiting
        self.ip = ip or self.ip
        if self.exit_code is None:
            self.exit_code = exit_code
        if gone:
            self.lost()
        self._changed.set()

    def lost(self) -> None:
        """The pod is gone: without an exit code by now, none will come."""
        if self.exit_code is None:
            self.exit_code = CONST_LOST_EXIT_CODE
        self._changed.set()

    async def wait(self, done: Callable[[], bool]) -> None:
        """
        Wait until the watch has shown what is asked for.

        Args:
            done: Whether it has.
        """
        while not done():
            self._changed.clear()
            await self._changed.wait()


class PodWatcher:
    """
    One ``kubectl get pods --watch`` for every task of this engine instance.

    A CLI process per task only to learn its exit code would cost 39 MB each
    (measured), so a single watch on the instance's label tells every launch
    its pod's name, when it runs and how it ended. A watch ends itself every
    few minutes (``CONST_WATCH_MAX_LIFE``), or sooner when the API server
    closes it; it is started again and first prints the pods that exist. A pod
    that went meanwhile is in no such list, so the pods are counted once more
    (``_resync``) and a launch whose pod is missing without an exit code is
    lost.
    """

    def __init__(self, cli: KubectlCli, selector: str) -> None:
        """
        Bind to the pods of one engine instance.

        Args:
            cli: The kubectl CLI.
            selector: The label selector of the instance's pods.
        """
        self._cli = cli
        self._selector = selector
        # The launches' pods, by Job name
        self._pods: Dict[str, WatchedPod] = {}
        self._process: Optional[asyncio.subprocess.Process] = None
        self._reader: Optional[asyncio.Future] = None
        self._resyncs: set = set()

    def watch_args(self) -> List[str]:
        """
        The watch command.

        Returns:
            The command and its arguments.
        """
        return [
            'get',
            'pods',
            '-l',
            self._selector,
            '--watch',
            '--output-watch-events',
            '-o',
            f'jsonpath={WATCH_FORMAT}',
            f'--request-timeout={CONST_WATCH_MAX_LIFE}s',
        ]

    def track(self, job: str) -> WatchedPod:
        """
        Follow the pod of a Job that is about to be created.

        Args:
            job: The Job's name.

        Returns:
            The pod, still unknown.
        """
        pod = self._pods[job] = WatchedPod(job)
        return pod

    def forget(self, job: str) -> None:
        """
        Stop following a Job that is being deleted; whoever still waits for its pod is told it is lost.

        Args:
            job: The Job's name.
        """
        pod = self._pods.pop(job, None)
        if pod is not None:
            pod.lost()

    async def start(self) -> None:
        """
        Start the watch and keep it running.

        Raises:
            OSError: If kubectl cannot be started.
        """
        if self._reader is None:
            self._process = await self._cli.spawn(self.watch_args())
            self._reader = asyncio.ensure_future(self._run())

    async def stop(self) -> None:
        """End the watch; nothing is started again."""
        tasks = [task for task in (self._reader, *self._resyncs) if task is not None]
        self._reader = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        process, self._process = self._process, None
        await _stop(process)

    async def _run(self) -> None:
        """Read the watch to its end and start it again, for as long as the engine runs."""
        while True:
            started = time.monotonic()
            try:
                if self._process is None:
                    self._process = await self._cli.spawn(self.watch_args())
                    resync = asyncio.ensure_future(self._resync())
                    self._resyncs.add(resync)
                    resync.add_done_callback(self._resyncs.discard)
                ended = await self._read(self._process)
            except OSError as e:
                ended = str(e)
            self._process = None
            debug(f'[k8s] the pod watch ended ({ended}); starting it again')
            # One that ended at once is not hammered
            await asyncio.sleep(max(0.0, CONST_WATCH_MIN_LIFE - (time.monotonic() - started)))

    async def _read(self, process: asyncio.subprocess.Process) -> str:
        """
        Give the watch's events to the launches until it ends.

        Args:
            process: The watch.

        Returns:
            How it ended, for the log.
        """
        said = ''
        try:
            async for raw in process.stdout:
                line = raw.decode(errors='replace').strip()
                # A line that is no event is kubectl saying why it stops
                if line and not self._event(line):
                    said = line
        except ValueError as e:
            # A line longer than the reader takes: nothing to read on from
            said = str(e)
            await _stop(process)
        code = await process.wait()
        _helpers.discard(process)
        return f'exit {code}: {said or "no message"}'

    def _event(self, line: str) -> bool:
        """
        Take one line of the watch.

        Args:
            line: The line.

        Returns:
            Whether it was an event.
        """
        fields = line.split('|')
        if len(fields) != 7 or fields[0] not in WATCH_EVENTS:
            return False
        event, name, job, phase, ip, exit_code, waiting = fields
        pod = self._pods.get(job)
        if pod is not None:
            code = int(exit_code) if exit_code.lstrip('-').isdigit() else None
            pod.seen(name, phase, ip, waiting, code, gone=event == 'DELETED')
        return True

    async def _resync(self) -> None:
        """
        After the watch was started again: a pod that went while nobody watched is lost.

        The new watch says nothing about a pod that no longer exists, and
        nothing marks the end of its first list. So the pods are listed by a
        command of their own, once the watch had time to take over: a failed
        listing judges nobody, and only a pod seen before it can be missing.
        """
        await asyncio.sleep(CONST_WATCH_SETTLE)
        running = [pod for pod in self._pods.values() if pod.name and pod.exit_code is None]
        if not running:
            return
        try:
            listed = await self._cli.run(
                ['get', 'pods', '-l', self._selector, '-o', 'jsonpath={.items[*].metadata.name}'],
                check=False,
            )
        except (OSError, K8sError):
            return
        if listed.returncode != 0:
            return
        names = set(listed.stdout.split())
        for pod in running:
            if pod.name not in names:
                debug(f'[k8s] pod {pod.name} went while the watch was down')
                pod.lost()


class K8sMetricsSampler:
    """CPU and memory of one pod, from the cluster's metrics API."""

    # The metrics server measures a pod about this often; asking sooner returns the same sample
    min_interval = 15.0

    def __init__(self, cli: KubectlCli, namespace: str, pod: str) -> None:
        """
        Bind to a pod.

        Args:
            cli: The kubectl CLI.
            namespace: The pod's namespace.
            pod: The pod to read.
        """
        self._cli = cli
        self._path = f'/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods/{pod}'

    async def sample(self) -> Optional[Tuple[float, int]]:
        """
        One reading.

        Returns:
            ``(cpu_percent, memory_bytes)``, or None when the cluster has no
            metrics API or no sample of this pod yet.
        """
        try:
            result = await self._cli.run(['get', '--raw', self._path], check=False)
            if result.returncode != 0:
                return None
            containers = json.loads(result.stdout).get('containers') or []
            usages = [container.get('usage') or {} for container in containers]
        except (OSError, ValueError, AttributeError, K8sError):
            return None
        cpus = [parse_quantity(usage.get('cpu')) for usage in usages]
        memories = [parse_quantity(usage.get('memory')) for usage in usages]
        if not usages or None in cpus or None in memories:
            return None
        # Cores to percent summed over cores, the way psutil reports it
        return sum(cpus) * 100.0, int(sum(memories))


class K8sLaunch(Launch):
    """A task running in a pod; ``process`` is the ``kubectl attach -i`` that carries its stdio."""

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        address: str,
        cli: KubectlCli,
        job: str,
        pod: WatchedPod,
        port: Optional[int],
        forward: Optional[asyncio.subprocess.Process],
        server: 'TaskServer',
        launcher: 'K8sLauncher',
        task_id: str,
    ) -> None:
        """
        Keep what the launch holds in the cluster and on this host.

        Args:
            process: The attached CLI process.
            address: ``host:port`` of the task's ``/task/data``.
            cli: The kubectl CLI.
            job: The task's Job.
            pod: Its pod, as the watch shows it.
            port: The forwarded port taken from the pool, or None.
            forward: The ``kubectl port-forward`` behind that port, or None.
            server: The server whose pool the port came from.
            launcher: The launcher, which deletes the Job.
            task_id: The task's id, for the log.
        """
        super().__init__(process, address)
        self.job = job
        self._cli = cli
        self._pod = pod
        self._port = port
        self._forward = forward
        # A forward prints a line per connection, and nobody else reads them
        self._forward_output = asyncio.ensure_future(_discard(forward.stdout)) if forward else None
        self._server = server
        self._launcher = launcher
        self._task_id = task_id
        self._removed = False
        self._signals: set = set()
        # The dumps the task announced (>DUMP), by file name
        self._dumps: List[str] = []

    @property
    def returncode(self) -> Optional[int]:
        """The exit code of the pod's container, or None while it runs."""
        return self._pod.exit_code

    async def wait(self) -> int:
        """Wait for the watch to show the pod's end; a timeout around this loses nothing."""
        await self._pod.wait(lambda: self._pod.exit_code is not None)
        return self._pod.exit_code

    def _signal(self, args: List[str]) -> None:
        """Delete the pod in the background, as Process.terminate signals synchronously."""
        if self._pod.exit_code is not None or self._removed:
            return
        task = asyncio.ensure_future(self._cli.run(args, check=False))
        self._signals.add(task)
        task.add_done_callback(self._signals.discard)
        # A delete the cluster did not take has no one to tell: the watch reports the end
        task.add_done_callback(lambda done: done.cancelled() or done.exception())

    def terminate(self) -> None:
        """SIGTERM to the engine: the pod is deleted with a few seconds to finish."""
        self._signal(['delete', 'pod', self._pod.name, f'--grace-period={CONST_TERMINATE_GRACE}', '--wait=false'])

    def kill(self) -> None:
        """SIGKILL: the pod is deleted at once."""
        self._signal(['delete', 'pod', self._pod.name, '--grace-period=0', '--force', '--wait=false'])

    def metrics(self) -> Dict[str, Any]:
        """CPU and memory from the metrics API; no local PID, so the GPU half reads zero."""
        return {'sampler': K8sMetricsSampler(self._cli, self._launcher.config['namespace'], self._pod.name)}

    def crash_dump_announced(self, name: str) -> None:
        """Remember a dump the task announced; it stays in the pod, which this runtime does not read yet."""
        if not self._dumps:
            debug(
                f'[k8s] task {self._task_id} wrote a crash dump ({name!r}); '
                'dumps are not fetched under --runtime=k8s yet and go with the pod'
            )
        self._dumps.append(name)

    async def cleanup(self) -> None:
        """Stop the port-forward, delete the Job and give the forwarded port back; safe to call twice."""
        if not self._removed:
            self._removed = True
            try:
                await _stop(self._forward)
            finally:
                await self._launcher.remove(self.job)
        if self._port:
            self._server.release_port(self._port)
            self._port = None


class K8sLauncher(Launcher):
    """Starts each task as a Job of one pod, through ``kubectl``."""

    name = 'k8s'
    isolated = True

    def __init__(
        self,
        server: 'TaskServer',
        config: Optional[Mapping[str, str]] = None,
        cli: Optional[KubectlCli] = None,
        environ: Optional[Mapping[str, str]] = None,
    ) -> None:
        """
        Bind to the server and settle the settings.

        Args:
            server: The task server (port pool, config).
            config: The k8s settings; by default from ``k8s_config``.
            cli: The kubectl CLI; tests pass a fake.
            environ: The engine's environment; by default ``os.environ``.
        """
        self._server = server
        self._environ = environ if environ is not None else os.environ
        self.config = dict(config) if config is not None else k8s_config(server._config, self._environ)
        self._cli = cli or KubectlCli(context=self.config['context'], namespace=self.config['namespace'])
        self._prepared: Optional[asyncio.Future] = None
        # Which pods and Jobs are this engine instance's
        self._selector = f'{LABEL_EAS}={label_value(self.config["instance"])}'
        self._watcher = PodWatcher(self._cli, self._selector)
        # Dial a forwarded port (True) or the pod IP (False)
        self.forwarded = self.forward_mode()

    @property
    def task_data_path(self) -> str:
        """The data directory inside the image."""
        return CONST_CONTAINER_DATA_PATH

    def forward_mode(self) -> bool:
        """
        Whether to dial a task through ``kubectl port-forward`` instead of its pod IP.

        A pod IP routes only inside the cluster: an engine that is a pod itself
        dials it, any other forwards a port of its own host.

        Returns:
            True for the forwarded mode.
        """
        reach = self.config['reach']
        if reach in ('pod', 'forward'):
            return reach == 'forward'
        return not self._environ.get('KUBERNETES_SERVICE_HOST')

    async def prepare(self) -> None:
        """
        The startup sweep and the pod watch, once per process.

        ``TaskServer`` runs this at start and every ``start()`` waits for it,
        so the sweep happens before the first task and never again. A failure
        (no kubectl, no cluster) is raised to each caller and retried by the
        next one.

        Raises:
            K8sError: If the cluster cannot be used.
        """
        if self._prepared is None:
            self._prepared = asyncio.ensure_future(self._prepare())
        prepared = self._prepared
        try:
            await asyncio.shield(prepared)
        except Exception:
            if self._prepared is prepared:
                self._prepared = None
            raise

    async def _prepare(self) -> None:
        """Sweep, then start watching the instance's pods."""
        try:
            await self._sweep()
            await self._watcher.start()
        except OSError as e:
            raise K8sError(f'No usable kubectl for --runtime=k8s: {e}') from e
        debug(
            f'[k8s] namespace {self.config["namespace"]}, context {self.config["context"] or "(current)"}; '
            f'tasks dialled at {"a forwarded port" if self.forwarded else "the pod IP"}'
        )

    async def _sweep(self) -> None:
        """Delete the Jobs an earlier life of this engine instance left behind, and their pods with them."""
        result = await self._cli.run(['delete', 'jobs', '-l', self._selector, '--ignore-not-found', '--wait=false'])
        removed = sum(1 for line in result.stdout.splitlines() if ' deleted' in line)
        if removed:
            debug(f'[k8s] removed {removed} job(s) left by an earlier run of {self.config["instance"]}')

    async def remove(self, job: str) -> None:
        """
        Delete a Job, its pod with it, and stop watching for that pod.

        It runs while a failure is on its way up or a task is torn down, so it
        never raises.

        Args:
            job: The Job's name.
        """
        self._watcher.forget(job)
        try:
            await self._cli.run(['delete', 'job', job, '--ignore-not-found', '--wait=false'], check=False)
        except (OSError, K8sError) as e:
            debug(f'[k8s] could not delete job {job}: {e}')

    def host_address(self, address: str, setting: str) -> str:
        """
        An address as a pod dials it: a loopback host becomes ``k8s.host_alias``.

        Loopback inside a pod is the pod. A cluster has no name of its own for
        the engine's host (``host.docker.internal`` is Docker Desktop's), so
        without the alias such an address is refused rather than guessed.

        Args:
            address: A model server address or a database DSN.
            setting: What holds it, for the error; a DSN carries a password and is never shown.

        Returns:
            The address a pod can use.

        Raises:
            K8sError: If the address is a loopback one and there is no alias.
        """
        alias = self.config['host_alias']
        if alias:
            return rewrite_loopback(address, alias)
        if rewrite_loopback(address) != address:
            raise K8sError(
                f'{setting} names this host by a loopback address, which inside a pod is the pod itself; '
                'set RR_K8S_HOST_ALIAS to the name pods reach this host by'
            )
        return address

    def task_args(self, spec: LaunchSpec) -> List[str]:
        """
        The engine's command line inside the pod: the docker runtime's.

        No ``--hosted`` (the pod is the boundary) and no inherited
        ``--node_path`` (the nodes are in the image; a host path means nothing
        there). The data port is fixed and bound on every interface of the
        pod's own network namespace.

        Args:
            spec: What to launch.

        Returns:
            The argv the bootstrap ``exec``s.

        Raises:
            K8sError: If the model server is on this host and there is no host alias.
        """
        args = [
            CONST_CONTAINER_ENGINE,
            CONST_CONTAINER_NODE_SCRIPT,
            f'{CONST_CONTAINER_DATA_PATH}/task.json',
            '--autoterm',
            '--monitor=app',
            f'--data_port={CONST_TASK_DATA_PORT_CONTAINER}',
            '--data_host=0.0.0.0',
            f'--data_token_sha256={spec.token_sha256}',
        ]
        if spec.modelserver:
            args.append(f'--modelserver={self.host_address(spec.modelserver, "--modelserver")}')
        args.extend(spec.pipeline_args)
        if spec.trace_arg:
            args.append(spec.trace_arg)
        return args

    def task_env(self, spec: LaunchSpec, overrides: Mapping[str, str]) -> Dict[str, str]:
        """
        The task's environment as the pod gets it, in the start stream and nowhere else.

        Host-only variables stay out, a loopback DSN of ``ROCKETRIDE_DB_DSNS``
        moves to the host alias, and the runtime's own values go on top.

        Args:
            spec: What to launch.
            overrides: Variables the runtime sets.

        Returns:
            The pod's environment.

        Raises:
            K8sError: If a DSN is on this host and there is no host alias.
        """
        env = {name: value for name, value in spec.env.items() if not is_host_only(name)}
        if env.get('ROCKETRIDE_DB_DSNS'):
            env['ROCKETRIDE_DB_DSNS'] = rewrite_loopback_dsns(
                env['ROCKETRIDE_DB_DSNS'], lambda dsn: self.host_address(dsn, 'ROCKETRIDE_DB_DSNS')
            )
        # The engine's own setting would name a path of its host
        env['ROCKETRIDE_CRASHDB_DIR'] = CONST_CONTAINER_CRASHDB_PATH
        env.update(overrides)
        return env

    def check_store(self, spec: LaunchSpec) -> None:
        """
        Refuse a pipeline that opens a store its pod cannot reach.

        A pod sees none of this engine's files: neither a filesystem store nor
        the token file S3 is authenticated through. Refused before anything
        starts, rather than left writing into the pod's own tree and losing it
        with the pod. S3 with a static key works: it is in the environment.

        Args:
            spec: What to launch.

        Raises:
            StoreUnavailableError: If the pipeline needs a store this pod cannot have.
        """
        if not (spec.uses_store and spec.storage_root):
            return

        from ai.account.store import Store

        url = Store._expand_url_path(self._environ.get('RR_STORE_URL') or Store._get_default_storage_url())
        scheme = url.split('://', 1)[0].lower()
        if scheme == 'filesystem':
            raise StoreUnavailableError(
                'tool_filesystem is not available under --runtime=k8s with a filesystem store: '
                "a pod does not see this engine's files"
            )
        if (
            scheme == 's3'
            and not self._environ.get('RR_STORE_SECRET_KEY')
            and self._environ.get('AWS_WEB_IDENTITY_TOKEN_FILE')
        ):
            raise StoreUnavailableError(
                'tool_filesystem is not available under --runtime=k8s with an S3 store '
                'authenticated through a web-identity token file: the pod cannot read the token'
            )

    def mounted_directories(self, spec: LaunchSpec) -> Tuple[Dict[str, str], Dict[str, str]]:
        """
        The host directories a task is told about through a variable named in ``k8s.mounts``.

        Each travels in the start stream, lands at ``/opt/data/mounts/<NAME>``
        and the variable points there.

        Args:
            spec: What to launch.

        Returns:
            ``(directories, overrides)``: the host path and the pod path, each by variable name.
        """
        directories: Dict[str, str] = {}
        overrides: Dict[str, str] = {}
        for name in filter(None, (n.strip() for n in self.config['mounts'].split(','))):
            path = spec.env.get(name)
            if path and os.path.isdir(path):
                directories[name] = path
                overrides[name] = f'{CONST_CONTAINER_DATA_PATH}/{CONST_MOUNT_DIR}/{name}'
        return directories, overrides

    def manifest(self, spec: LaunchSpec, job: str, payload_size: int, task_args: Sequence[str]) -> Dict[str, Any]:
        """
        The Job for one task.

        It holds no value of the environment and no task file, only the
        bootstrap and the engine's argv. Never a second pod (``backoffLimit``
        0), no token of the cluster's API in the task, none of the namespace's
        service addresses in its environment, and what Pod Security
        ``restricted`` asks for. The root stays writable, as under docker:
        ``depends()`` installs into the image's tree.

        Args:
            spec: What to launch.
            job: The Job's name.
            payload_size: The length of the start stream the bootstrap must read.
            task_args: The engine's argv.

        Returns:
            The manifest.
        """
        cfg = self.config
        labels = {LABEL_TASK: label_value(spec.task_id), LABEL_EAS: label_value(cfg['instance'])}
        limits = {
            'memory': str(spec.limits.get('memory') or cfg['memory']),
            'cpu': str(spec.limits.get('cpus') or cfg['cpus']),
        }
        if cfg['ephemeral_storage']:
            limits['ephemeral-storage'] = cfg['ephemeral_storage']
        container = {
            'name': CONST_CONTAINER_NAME,
            'image': cfg['image'],
            'imagePullPolicy': cfg['image_pull_policy'],
            'command': double_dollars(
                ['sh', '-c', BOOTSTRAP, 'rr-task', str(payload_size), cfg['start_timeout'], *task_args]
            ),
            # Open and never a terminal: closing it is EOF for --autoterm, not a hangup
            'stdin': True,
            'stdinOnce': True,
            'tty': False,
            'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
            'resources': {
                'requests': {'memory': cfg['memory_request'], 'cpu': cfg['cpu_request']},
                'limits': limits,
            },
        }
        pod: Dict[str, Any] = {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'enableServiceLinks': False,
            'securityContext': {
                'runAsNonRoot': True,
                'runAsUser': CONST_IMAGE_UID,
                'runAsGroup': CONST_IMAGE_GID,
                'seccompProfile': {'type': 'RuntimeDefault'},
            },
            'containers': [container],
        }
        if cfg['node_selector']:
            pod['nodeSelector'] = node_selector(cfg['node_selector'])
        if cfg['tolerations']:
            pod['tolerations'] = tolerations(cfg['tolerations'])
        if cfg['node']:
            pod['nodeName'] = cfg['node']
        if cfg['runtime_class']:
            pod['runtimeClassName'] = cfg['runtime_class']
        return {
            'apiVersion': 'batch/v1',
            'kind': 'Job',
            'metadata': {
                'name': job,
                'labels': labels,
                'annotations': {ANNOTATION_TASK: spec.task_id, ANNOTATION_EAS: cfg['instance']},
            },
            'spec': {
                'backoffLimit': 0,
                'ttlSecondsAfterFinished': int(cfg['ttl']),
                'template': {'metadata': {'labels': labels}, 'spec': pod},
            },
        }

    async def _wait_running(self, pod: WatchedPod) -> None:
        """
        Wait until the watch shows the pod running, with an IP when that is what is dialled.

        ``kubectl attach`` does not wait for a container: on a pod that is
        still being created it fails with "container task not found".

        Args:
            pod: The pod of the Job just created.

        Raises:
            K8sError: If the pod cannot start, ended first or did not start in time.
        """

        def settled() -> bool:
            if pod.ended or pod.waiting in START_FAILURES:
                return True
            return pod.phase == 'Running' and bool(self.forwarded or pod.ip)

        timeout = float(self.config['start_timeout'])
        try:
            await asyncio.wait_for(pod.wait(settled), timeout)
        except asyncio.TimeoutError:
            state = ', '.join(filter(None, (pod.phase, pod.waiting))) or 'no pod yet'
            raise K8sError(f'Job {pod.job} did not start within {timeout:g} s ({state})') from None
        if pod.waiting in START_FAILURES:
            raise K8sError(START_FAILURES[pod.waiting].format(image=self.config['image'], pod=pod.name))
        if pod.ended:
            raise K8sError(f'Pod {pod.name} ended before the task was given to it (exit code {pod.exit_code})')

    async def _send(self, process: asyncio.subprocess.Process, payload: bytes) -> None:
        """
        Write the start stream to the attached CLI, and leave its stdin open.

        Args:
            process: The attached CLI.
            payload: The start stream.

        Raises:
            K8sError: If the CLI does not take it in time.
        """
        timeout = float(self.config['start_timeout'])
        process.stdin.write(payload)
        try:
            await asyncio.wait_for(process.stdin.drain(), timeout)
        except asyncio.TimeoutError:
            raise K8sError(f'kubectl attach did not take the task within {timeout:g} s') from None

    async def _forward(self, pod: str, port: int) -> asyncio.subprocess.Process:
        """
        ``kubectl port-forward`` from a loopback port of this host to the pod's data port.

        Args:
            pod: The pod.
            port: The port on this host.

        Returns:
            The running process, once it listens.

        Raises:
            K8sError: If it does not come to listen.
        """
        process = await self._cli.spawn(
            ['port-forward', f'pod/{pod}', f'{port}:{CONST_TASK_DATA_PORT_CONTAINER}', '--address', '127.0.0.1']
        )
        said = ''
        try:
            while True:
                line = (await asyncio.wait_for(process.stdout.readline(), CONST_FORWARD_TIMEOUT)).decode(
                    errors='replace'
                )
                if 'Forwarding from' in line:
                    return process
                if not line:
                    raise K8sError(f'kubectl port-forward to pod {pod} failed: {said.strip() or "no message"}')
                said = line
        except asyncio.TimeoutError:
            await _stop(process)
            raise K8sError(
                f'kubectl port-forward to pod {pod} did not listen within {CONST_FORWARD_TIMEOUT:g} s'
            ) from None
        except BaseException:
            await _stop(process)
            raise

    async def start(self, spec: LaunchSpec) -> K8sLaunch:
        """
        ``create -f -``, wait for the pod to run, ``attach -i -q``, send the start stream.

        What cannot work is refused before anything is created; on any later
        failure the Job is deleted, the port given back and the helper
        processes ended, and the failure raised.

        Args:
            spec: What to launch.

        Returns:
            The running task.

        Raises:
            K8sError: If the cluster or the image cannot be used, or an address of this host has no alias.
            StoreUnavailableError: If the pipeline needs a store this pod cannot have.
        """
        await self.prepare()
        self.check_store(spec)
        task_args = self.task_args(spec)
        directories, overrides = self.mounted_directories(spec)
        payload = await asyncio.to_thread(payload_tar, spec.task_file, self.task_env(spec, overrides), directories)

        job = job_name(spec.task_id)
        # Followed before it exists, so no event of its pod is missed
        pod = self._watcher.track(job)
        port: Optional[int] = None
        process: Optional[asyncio.subprocess.Process] = None
        forward: Optional[asyncio.subprocess.Process] = None
        try:
            manifest = self.manifest(spec, job, len(payload), task_args)
            await self._cli.run(['create', '-f', '-'], stdin=json.dumps(manifest).encode('utf-8'))
            await self._wait_running(pod)
            process = await self._cli.attach(['attach', '-i', '-q', '-c', CONST_CONTAINER_NAME, pod.name])
            await self._send(process, payload)
            if self.forwarded:
                port = self._server.assign_port()
                forward = await self._forward(pod.name, port)
                address = f'127.0.0.1:{port}'
            else:
                host = f'[{pod.ip}]' if ':' in pod.ip else pod.ip
                address = f'{host}:{CONST_TASK_DATA_PORT_CONTAINER}'
        except BaseException:
            # A forward that did not come to listen has ended itself
            if port:
                self._server.release_port(port)
            try:
                await _stop(process)
            finally:
                await self.remove(job)
            raise
        return K8sLaunch(process, address, self._cli, job, pod, port, forward, self._server, self, spec.task_id)
