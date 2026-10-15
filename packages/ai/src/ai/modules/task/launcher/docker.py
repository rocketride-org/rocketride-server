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
The docker runtime: each task runs in its own container from ``rocketride/node``.

The ``docker`` CLI drives it through ``asyncio.create_subprocess_exec``, never a
library: ``docker start -a -i`` is a real process whose stdout, stderr and stdin
are the container's, so the stdio reader and ``--autoterm`` work as they do for
a subprocess. A run is five commands — ``create -i``, ``cp -``, ``start -a -i``,
``wait``, ``rm -f`` — and the exit code always comes from ``docker wait``, never
from the CLI, which can die before the container does.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import socket
import sys
import tarfile
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit

from rocketlib import debug

from ai.constants import CONST_SUBPROCESS_BUFFER_LIMIT

from .base import Launch, Launcher, LaunchSpec

if TYPE_CHECKING:
    from ..task_server import TaskServer

# Where node.py listens inside every container; the address outside is the launcher's
CONST_TASK_DATA_PORT_CONTAINER = 5570

# Seconds a short docker command may take: a daemon that takes the connection and
# never answers would otherwise hang every task start
CONST_CLI_TIMEOUT = 60.0

# Container IPs route only from the daemon's own Linux host: an engine on macOS or
# Windows reaches the containers of a daemon in a VM through published ports alone
ENGINE_ON_LINUX = sys.platform.startswith('linux')

# The store subtrees the tasks of this engine have mounted: by task id until the container
# exists, by container id after. No other task's root may lie inside or around one of them
_ROOTS_IN_USE: Dict[str, str] = {}

# The engine's data directory inside the image (engine-base: mkdir /opt/data)
CONST_CONTAINER_DATA_PATH = '/opt/data'

# Where a run's store subtree is mounted inside its container
CONST_CONTAINER_STORE_ROOT = '/opt/store'

# The image's own user and group (rocketride); the group can write what a run installs
CONST_IMAGE_UID = 1000
CONST_IMAGE_GID = 1000

# The task's command line inside the image (WORKDIR /opt/rocketride)
CONST_CONTAINER_ENGINE = './engine'
CONST_CONTAINER_NODE_SCRIPT = 'ai/node.py'

# Which task a container runs, and which engine instance owns it
LABEL_TASK = 'rocketride.task'
LABEL_EAS = 'rocketride.eas'

# Loopback inside a container is the container; these hosts move to the host gateway
LOOPBACK_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1'})
HOST_GATEWAY = 'host.docker.internal'

# Variables describing the engine's host: inside the image they would replace
# its own values (PATH, UV_CACHE_DIR) or point at paths that do not exist there
HOST_ONLY_ENV_NAMES = frozenset(
    {
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'PWD',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LD_LIBRARY_PATH',
        'DYLD_LIBRARY_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH',
        'DYLD_FRAMEWORK_PATH',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'SYSTEMROOT',
        'WINDIR',
        'SYSTEMDRIVE',
        'COMSPEC',
        'PATHEXT',
        'USERPROFILE',
        'USERNAME',
        'VIRTUAL_ENV',
        'PYTHONPATH',
        'PYTHONHOME',
        'UV_CACHE_DIR',
        'UV_LINK_MODE',
        'HF_HOME',
    }
)
HOST_ONLY_ENV_PREFIXES = ('XDG_',)

# What the docker CLI itself needs from the engine's environment
CLI_ENV_NAMES = (
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'XDG_RUNTIME_DIR',
    # Windows: where the CLI finds its config and contexts, and what it needs to run
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
)

# docker.* settings, their RR_DOCKER_* variables and defaults ('' = derived)
DEFAULT_CONFIG: Dict[str, str] = {
    'image': '',
    'publish': 'auto',
    'memory': '2g',
    'cpus': '1',
    # Threads count too: room for a model's thread pools, not for a fork bomb
    'pids_limit': '4096',
    'network': 'bridge',
    'models': '',
    'log_driver': 'none',
    'instance': '',
}


class DockerError(RuntimeError):
    """A docker CLI command failed, or the daemon cannot be used."""


class StoreUnavailableError(RuntimeError):
    """A pipeline opens the store itself, and this container cannot be given it."""


def engine_version() -> str:
    """
    The engine version as images are tagged: ``major.minor.patch``.

    Returns:
        The version, e.g. ``3.4.0`` for an engine reporting ``3.4.0.9999``.
    """
    from rocketlib import getVersion

    return '.'.join(str(getVersion()['version']).split('.')[:3])


def docker_config(config: Mapping[str, Any], environ: Mapping[str, str]) -> Dict[str, str]:
    """
    The docker runtime's settings: ``server.config['docker']``, then ``RR_DOCKER_*``, then defaults.

    Args:
        config: The server config (``port`` names the default instance id).
        environ: The engine's environment (``.env`` is already loaded into it).

    Returns:
        Every key of ``DEFAULT_CONFIG``, filled in.

    Raises:
        ValueError: If ``publish`` is not auto, true or false.
    """
    merged = dict(DEFAULT_CONFIG)
    for key in DEFAULT_CONFIG:
        value = environ.get(f'RR_DOCKER_{key.upper()}')
        if value:
            merged[key] = value
    for key, value in (config.get('docker') or {}).items():
        if value not in (None, ''):
            merged[key] = str(value)

    # host would bind every task's port 5570 on the host itself, none leaves it out of reach,
    # container:<name> shares another container's: none of them is a network of the task's own
    network = merged['network'].strip()
    if network.lower() in ('host', 'none') or network.lower().startswith('container:'):
        raise ValueError(f'docker.network must give each task a network of its own, not {network!r}')
    merged['publish'] = merged['publish'].strip().lower()
    if merged['publish'] not in ('auto', 'true', 'false'):
        raise ValueError(f'docker.publish must be auto, true or false, not {merged["publish"]!r}')
    if not merged['image']:
        merged['image'] = f'rocketride/node:{engine_version()}'
    # Stable across restarts, or the startup sweep finds nothing to remove
    if not merged['instance']:
        merged['instance'] = f'{socket.gethostname()}:{config.get("port", 5565)}'
    return merged


def is_host_only(name: str) -> bool:
    """
    Whether a variable describes the engine's host and stays out of the container.

    Args:
        name: The variable name.

    Returns:
        True to keep it out.
    """
    return name in HOST_ONLY_ENV_NAMES or name.startswith(HOST_ONLY_ENV_PREFIXES)


def rootless_daemon(info: Mapping[str, Any]) -> bool:
    """
    Whether ``docker info`` describes a rootless daemon.

    Args:
        info: ``docker info`` as JSON.

    Returns:
        True when its security options name rootless.
    """
    return any('name=rootless' in str(option) for option in info.get('SecurityOptions') or ())


def engine_is_root() -> bool:
    """
    Whether this engine runs as root; never on Windows, which has no uid.

    Returns:
        True for uid 0.
    """
    getuid = getattr(os, 'getuid', None)
    return getuid is not None and getuid() == 0


def remote_daemon(endpoint: str) -> bool:
    """
    Whether a docker endpoint names another host.

    Args:
        endpoint: ``unix://...``, ``npipe://...``, ``tcp://host:port`` or ``ssh://[user@]host``.

    Returns:
        True for a TCP or SSH endpoint whose host is not a loopback address.
    """
    parts = urlsplit(endpoint)
    if parts.scheme.lower() not in ('tcp', 'ssh', 'http', 'https'):
        return False
    return (parts.hostname or '').lower() not in LOOPBACK_HOSTS


def overlaps(a: str, b: str) -> bool:
    """
    Whether one of two different paths lies inside the other.

    Args:
        a: A path.
        b: Another path.

    Returns:
        True when they differ and one is an ancestor of the other.
    """
    return a != b and (a.startswith(b + os.sep) or b.startswith(a + os.sep))


def _swap_loopback_host(netloc: str) -> str:
    """
    Replace a loopback host in ``[userinfo@]host[:port]`` with the host gateway name.

    Args:
        netloc: The authority part of an address.

    Returns:
        The netloc, rewritten only when its host is a loopback address.
    """
    userinfo, at, hostport = netloc.rpartition('@')
    if hostport.startswith('['):
        host, _, rest = hostport[1:].partition(']')
        port = rest
    elif hostport.count(':') == 1:
        host, colon, port_number = hostport.partition(':')
        port = colon + port_number
    else:
        host, port = hostport, ''
    if host.lower() not in LOOPBACK_HOSTS:
        return netloc
    return f'{userinfo}{at}{HOST_GATEWAY}{port}'


def rewrite_loopback(address: str) -> str:
    """
    Point a loopback address at the host gateway, so a container reaches the host.

    Handles ``host:port`` and ``scheme://[user@]host:port/...``. A bare port
    (``5590``) has no host and is left alone, as is any other host.

    Args:
        address: A model server address or a database DSN.

    Returns:
        The address, with a loopback host rewritten to ``host.docker.internal``.
    """
    if '://' in address:
        parts = urlsplit(address)
        return urlunsplit(parts._replace(netloc=_swap_loopback_host(parts.netloc)))
    if address.isdigit():
        return address
    return _swap_loopback_host(address)


def rewrite_loopback_dsns(value: str) -> str:
    """
    ``rewrite_loopback`` for each DSN of a ``ROCKETRIDE_DB_DSNS`` map.

    Args:
        value: The map, as JSON.

    Returns:
        The map with each loopback host rewritten; a value that is no map of
        strings, as it was.
    """
    try:
        dsns = json.loads(value)
    except ValueError:
        return value
    if not isinstance(dsns, dict) or not all(isinstance(dsn, str) for dsn in dsns.values()):
        return value
    return json.dumps({key: rewrite_loopback(dsn) for key, dsn in dsns.items()})


def task_tar(data: bytes, uid: int = CONST_IMAGE_UID, gid: int = CONST_IMAGE_GID) -> bytes:
    """
    The task file as a one-member tar stream for ``docker cp -``.

    The header sets owner and mode, so the file is 0600 and belongs to the
    user the task runs as, and nothing is written to the host.

    Args:
        data: The task file.
        uid: The task's uid.
        gid: The task's gid.

    Returns:
        The tar archive.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        info = tarfile.TarInfo('task.json')
        info.size = len(data)
        info.mode = 0o600
        info.uid, info.gid = uid, gid
        # Names only for the image's own user; any other is known by number alone
        if (uid, gid) == (CONST_IMAGE_UID, CONST_IMAGE_GID):
            info.uname = info.gname = 'rocketride'
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


_SIZE_UNITS = {
    '': 1,
    'b': 1,
    'kb': 1000,
    'kib': 1024,
    'mb': 1000**2,
    'mib': 1024**2,
    'gb': 1000**3,
    'gib': 1024**3,
    'tb': 1000**4,
    'tib': 1024**4,
}


def parse_size(text: str) -> Optional[int]:
    """
    A ``docker stats`` size such as ``12.5MiB`` in bytes.

    Args:
        text: The size text.

    Returns:
        Bytes, or None when it cannot be read.
    """
    match = re.fullmatch(r'\s*([0-9]*\.?[0-9]+)\s*([A-Za-z]*)\s*', text or '')
    if not match or match.group(2).lower() not in _SIZE_UNITS:
        return None
    return int(float(match.group(1)) * _SIZE_UNITS[match.group(2).lower()])


def parse_percent(text: str) -> Optional[float]:
    """
    A ``docker stats`` percentage such as ``12.34%``.

    Args:
        text: The percentage text.

    Returns:
        The number, or None when it cannot be read.
    """
    try:
        return float(str(text).strip().rstrip('%'))
    except ValueError:
        return None


@dataclass
class CliResult:
    """What one docker CLI command returned."""

    returncode: int
    stdout: str
    stderr: str


class DockerCli:
    """Runs the docker CLI; tests replace it with a fake that records every argv."""

    def __init__(self, executable: str = 'docker') -> None:
        """
        Remember which binary to run.

        Args:
            executable: The docker CLI.
        """
        self.executable = executable

    async def run(
        self,
        args: Sequence[str],
        *,
        stdin: Optional[bytes] = None,
        env: Optional[Mapping[str, str]] = None,
        check: bool = True,
        timeout: Optional[float] = CONST_CLI_TIMEOUT,
    ) -> CliResult:
        """
        Run one command to completion.

        Args:
            args: The arguments after ``docker``.
            stdin: Bytes to feed it, if any.
            env: The CLI's environment; None inherits the engine's.
            check: Raise on a non-zero exit code.
            timeout: Seconds before the command is killed; None for one that lasts as long as a task.

        Returns:
            Its exit code and output.

        Raises:
            DockerError: If ``check`` and the command failed, or if it did not end within ``timeout``.
        """
        process = await asyncio.create_subprocess_exec(
            self.executable,
            *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(env) if env is not None else None,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout)
        except BaseException as e:
            # A timeout or a cancel: the command does not go on alone (a create would leave a
            # container nobody removes), and its pipes are read to their end, or it is never reaped
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.communicate()
            if isinstance(e, asyncio.TimeoutError):
                # No exit code is coming: the caller learns it from the error, whatever check says
                raise DockerError(f'docker {args[0]} timed out after {timeout:g} s') from None
            raise
        result = CliResult(process.returncode, stdout.decode(errors='replace'), stderr.decode(errors='replace'))
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise DockerError(f'docker {args[0]} failed (exit {result.returncode}): {detail}')
        return result

    async def attach(self, args: Sequence[str]) -> asyncio.subprocess.Process:
        """
        Start a long-running command whose stdio the caller reads (``start -a -i``).

        Args:
            args: The arguments after ``docker``.

        Returns:
            The running process, with its stdin, stdout and stderr piped.
        """
        return await asyncio.create_subprocess_exec(
            self.executable,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=CONST_SUBPROCESS_BUFFER_LIMIT,
        )


class DockerStatsSampler:
    """CPU and memory of one container, from ``docker stats``."""

    # A docker stats call takes about a second
    min_interval = 1.0

    def __init__(self, cli: DockerCli, container_id: str) -> None:
        """
        Bind to a container.

        Args:
            cli: The docker CLI.
            container_id: The container to read.
        """
        self._cli = cli
        self._container_id = container_id

    async def sample(self) -> Optional[Tuple[float, int]]:
        """
        One reading.

        Returns:
            ``(cpu_percent, memory_bytes)``, or None when stats are unavailable.
        """
        try:
            result = await self._cli.run(
                ['stats', '--no-stream', '--format', '{{json .}}', self._container_id],
                check=False,
            )
            if result.returncode != 0:
                return None
            row = json.loads(result.stdout.strip().splitlines()[0])
        except (OSError, ValueError, IndexError, DockerError):
            return None
        cpu = parse_percent(row.get('CPUPerc', ''))
        memory = parse_size(str(row.get('MemUsage', '')).split('/')[0])
        if cpu is None or memory is None:
            return None
        return cpu, memory


class DockerLaunch(Launch):
    """A task running in a container; ``process`` is the ``docker start -a -i`` that carries its stdio."""

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        address: str,
        cli: DockerCli,
        container_id: str,
        port: Optional[int],
        server: 'TaskServer',
    ) -> None:
        """
        Start watching for the container's exit.

        Args:
            process: The attached CLI process.
            address: ``host:port`` of the task's ``/task/data``.
            cli: The docker CLI.
            container_id: The container.
            port: The published port taken from the pool, or None.
            server: The server whose pool the port came from.
        """
        super().__init__(process, address)
        self.container_id = container_id
        self._cli = cli
        self._port = port
        self._server = server
        self._returncode: Optional[int] = None
        self._removed = False
        self._signals: set = set()
        self._wait_task = asyncio.ensure_future(self._wait_for_exit())

    async def _wait_for_exit(self) -> int:
        """
        ``docker wait``: the container's own exit code.

        Falls back to the CLI's code only when the daemon cannot say: the
        container already exited and was removed (``--rm``), in which case
        ``docker start -a`` returned the container's code itself.

        Returns:
            The exit code.
        """
        # As long as the task runs: no time limit
        result = await self._cli.run(['wait', self.container_id], check=False, timeout=None)
        text = result.stdout.strip()
        if result.returncode == 0 and text.lstrip('-').isdigit():
            self._returncode = int(text)
        else:
            self._returncode = await self.process.wait()
        return self._returncode

    @property
    def returncode(self) -> Optional[int]:
        """The container's exit code, or None while it runs."""
        return self._returncode

    async def wait(self) -> int:
        """Wait for the container to exit; a timeout around this does not stop the watch."""
        return await asyncio.shield(self._wait_task)

    def _signal(self, args: List[str]) -> None:
        """Send a signal through the daemon in the background, as Process.terminate does synchronously."""
        if self._returncode is not None or self._removed:
            return
        task = asyncio.ensure_future(self._cli.run(args, check=False))
        self._signals.add(task)
        task.add_done_callback(self._signals.discard)
        # A signal the daemon could not deliver has no one to tell: the exit watch reports the end
        task.add_done_callback(lambda done: done.cancelled() or done.exception())

    def terminate(self) -> None:
        """SIGTERM to the container, an explicit command to the daemon."""
        self._signal(['kill', '-s', 'TERM', self.container_id])

    def kill(self) -> None:
        """SIGKILL to the container."""
        self._signal(['kill', self.container_id])

    async def _remove(self) -> None:
        """
        ``docker rm -f``; a container already gone counts as removed.

        Raises:
            DockerError: If the daemon did not remove it.
        """
        result = await self._cli.run(['rm', '-f', self.container_id], check=False)
        if result.returncode != 0 and 'no such container' not in result.stderr.lower():
            raise DockerError(f'docker rm failed (exit {result.returncode}): {result.stderr.strip()}')
        self._removed = True
        _ROOTS_IN_USE.pop(self.container_id, None)

    def metrics(self) -> Dict[str, Any]:
        """CPU and memory from ``docker stats``; no local PID, so the GPU half reads zero."""
        return {'sampler': DockerStatsSampler(self._cli, self.container_id)}

    async def cleanup(self) -> None:
        """
        Remove the container and give a published port back; safe to call twice.

        A container the daemon did not remove keeps its port, and the next call
        tries again; the next engine start sweeps whatever is left.

        Raises:
            DockerError: If the container could not be removed.
        """
        if not self._removed:
            await self._remove()
        if self._port:
            self._server.release_port(self._port)
            self._port = None


class DockerLauncher(Launcher):
    """Starts each task in its own container through a local docker daemon."""

    name = 'docker'
    isolated = True

    def __init__(
        self,
        server: 'TaskServer',
        config: Optional[Mapping[str, str]] = None,
        cli: Optional[DockerCli] = None,
        environ: Optional[Mapping[str, str]] = None,
    ) -> None:
        """
        Bind to the server and settle the settings.

        Args:
            server: The task server (port pool, config).
            config: The docker settings; by default from ``docker_config``.
            cli: The docker CLI; tests pass a fake.
            environ: The engine's environment; by default ``os.environ``.
        """
        self._server = server
        self._environ = environ if environ is not None else os.environ
        self.config = dict(config) if config is not None else docker_config(server._config, self._environ)
        self._cli = cli or DockerCli()
        self._prepared: Optional[asyncio.Future] = None
        # Decided by prepare(): dial a published port (True) or the container IP (False)
        self.published: Optional[bool] = None
        # Decided by prepare(): the (uid, gid) tasks run as, or None for the image's own user
        self.user: Optional[Tuple[int, int]] = None
        # Why a task cannot use this engine's store through a mount ('' when it can), once there is a verdict
        self._store_problem: Optional[str] = None

    @property
    def task_data_path(self) -> str:
        """The data directory inside the image."""
        return CONST_CONTAINER_DATA_PATH

    async def prepare(self) -> None:
        """
        ``docker info`` and the startup sweep, once per process.

        ``TaskServer`` runs this at start and every ``start()`` waits for it,
        so the sweep happens before the first task and never again. A failure
        (no daemon) is raised to each caller and retried by the next one.

        Raises:
            DockerError: If the daemon cannot be used.
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
        """
        Pick the address mode from what the daemon is, then sweep.

        Raises:
            DockerError: If there is no daemon, or it is on another host.
        """
        try:
            result = await self._cli.run(['info', '--format', '{{json .}}'])
            info = json.loads(result.stdout)
        except (OSError, ValueError) as e:
            raise DockerError(f'No usable docker daemon for --runtime=docker: {e}') from e
        # A port published there is out of this engine's reach, and a mount names that host's files
        endpoint = await self.daemon_endpoint()
        if remote_daemon(endpoint):
            raise DockerError(
                f'The docker daemon at {endpoint} is on another host; --runtime=docker needs one on this host'
            )
        self.published = self.published_mode(info)
        self.user = self.task_user(info)
        who = f'{self.user[0]}:{self.user[1]}' if self.user else 'the image user'
        debug(
            f'[docker] daemon {info.get("OperatingSystem", "?")} ({info.get("OSType", "?")}); '
            f'tasks dialled at {"a published port" if self.published else "the container IP"}, running as {who}'
        )
        await self._sweep()

    async def daemon_endpoint(self) -> str:
        """
        The daemon the CLI talks to, as its current context resolves it.

        ``docker context inspect`` sees ``DOCKER_HOST`` and ``DOCKER_CONTEXT``
        alike; when the CLI cannot say, ``DOCKER_HOST`` is all there is.

        Returns:
            The endpoint, such as ``unix:///var/run/docker.sock``, or ''.
        """
        result = await self._cli.run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], check=False)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return str(self._environ.get('DOCKER_HOST', ''))

    def task_user(self, info: Mapping[str, Any]) -> Optional[Tuple[int, int]]:
        """
        The user a task container runs as: the engine's own, so a mount keeps one owner.

        Files a task writes into a bind mount keep its uid on the host, so the
        task runs as the engine's uid and gid and reaches the image's writable
        tree through the image's group (``--group-add``). Under a rootless
        daemon the container's root is the engine's user. With no uid at all
        (an engine on Windows) the image's own user stays, and so it does for
        an engine that runs as root: a root task would be root on the host of
        a daemon without user namespaces.

        Args:
            info: ``docker info`` as JSON.

        Returns:
            ``(uid, gid)``, or None for the image's own user.
        """
        if rootless_daemon(info):
            return 0, 0
        getuid = getattr(os, 'getuid', None)
        getgid = getattr(os, 'getgid', None)
        if getuid is None or getgid is None or engine_is_root():
            return None
        return getuid(), getgid()

    def give_to_tasks(self, path: str, tree: bool = False) -> None:
        """
        Hand a directory a task writes into to the image's user, when a root engine's tasks run as it.

        With ``tree``, what is already in it goes too, at every start: files
        that tasks running as root left there, or that the engine itself wrote
        since (the store's own commands run as root), would stay out of reach.
        Only what another user owns changes hands.

        Args:
            path: The directory.
            tree: Hand over its contents as well.
        """
        if self.user is not None or not engine_is_root():
            return
        # Never through a link: the tree is the tasks' own, and root must not be led out of it
        os.chown(path, CONST_IMAGE_UID, CONST_IMAGE_GID, follow_symlinks=False)
        if tree:
            for _, dirs, files, dir_fd in os.fwalk(path, follow_symlinks=False):
                for name in dirs + files:
                    owner = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                    if (owner.st_uid, owner.st_gid) != (CONST_IMAGE_UID, CONST_IMAGE_GID):
                        os.chown(name, CONST_IMAGE_UID, CONST_IMAGE_GID, dir_fd=dir_fd, follow_symlinks=False)

    def user_args(self) -> List[str]:
        """
        ``--user`` and ``--group-add`` for a task container, or nothing for the image's own user.

        Returns:
            The arguments.
        """
        if self.user is None:
            return []
        uid, gid = self.user
        args = ['--user', f'{uid}:{gid}']
        if gid != CONST_IMAGE_GID:
            args += ['--group-add', str(CONST_IMAGE_GID)]
        return args

    def published_mode(self, info: Mapping[str, Any]) -> bool:
        """
        Whether to publish the data port instead of dialling the container IP.

        The IP routes only from the daemon's own host, and only to a rootful
        daemon's bridge: an engine on that Linux host with a local Linux Engine.
        Not Docker Desktop's VM, not a rootless daemon's network namespace, not
        a VM's daemon seen from macOS or Windows. A daemon on another host never
        gets here (see ``_prepare``).

        Args:
            info: ``docker info`` as JSON.

        Returns:
            True for the published mode.
        """
        publish = self.config['publish']
        if publish in ('true', 'false'):
            return publish == 'true'
        local_engine = (
            ENGINE_ON_LINUX
            and not rootless_daemon(info)
            and info.get('OSType') == 'linux'
            and not str(info.get('OperatingSystem', '')).startswith('Docker Desktop')
        )
        return not local_engine

    async def _sweep(self) -> None:
        """Remove the containers an earlier life of this engine instance left behind."""
        result = await self._cli.run(['ps', '-aq', '--filter', f'label={LABEL_EAS}={self.config["instance"]}'])
        ids = result.stdout.split()
        if ids:
            await self._cli.run(['rm', '-f', *ids], check=False)
            debug(f'[docker] removed {len(ids)} container(s) left by an earlier run of {self.config["instance"]}')

    @staticmethod
    def task_args(spec: LaunchSpec) -> List[str]:
        """
        The command line inside the container: the subprocess runtime's, minus what does not apply.

        No ``--hosted`` (the container is the boundary) and no inherited
        ``--node_path`` (the nodes are in the image; a host path means nothing
        there). The data port is fixed and bound on every interface of the
        container's own network namespace.

        Args:
            spec: What to launch.

        Returns:
            The argv after the image name.
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
            args.append(f'--modelserver={rewrite_loopback(spec.modelserver)}')
        args.extend(spec.pipeline_args)
        if spec.trace_arg:
            args.append(spec.trace_arg)
        return args

    def container_env(self, spec: LaunchSpec, overrides: Mapping[str, str]) -> Dict[str, str]:
        """
        The task's environment as the container gets it.

        Host-only variables stay out, a loopback DSN moves to the host gateway,
        and the runtime's own values (the store, the model cache) go on top.

        Args:
            spec: What to launch.
            overrides: Variables the runtime sets.

        Returns:
            The container's environment.
        """
        # docker create gives the CLI's own value to a name it needs itself: none goes in
        env = {name: value for name, value in spec.env.items() if not is_host_only(name) and name not in CLI_ENV_NAMES}
        if env.get('ROCKETRIDE_DB_DSNS'):
            env['ROCKETRIDE_DB_DSNS'] = rewrite_loopback_dsns(env['ROCKETRIDE_DB_DSNS'])
        if self.config['models']:
            env['HF_HOME'] = '/models'
        env.update(overrides)
        return env

    def cli_env(self, container_env: Mapping[str, str]) -> Dict[str, str]:
        """
        The CLI's environment for ``create``: the container's values, so ``-e NAME`` finds them.

        Args:
            container_env: The container's environment.

        Returns:
            The container's variables plus what the CLI itself needs.
        """
        env = dict(container_env)
        env.update({name: self._environ[name] for name in CLI_ENV_NAMES if name in self._environ})
        return env

    def create_args(
        self,
        spec: LaunchSpec,
        container_env: Mapping[str, str],
        mounts: Sequence[Tuple[str, str, str]],
        port: Optional[int],
    ) -> List[str]:
        """
        The ``docker create`` argv.

        Values never go on argv: ``-e NAME`` takes each one from the CLI's own
        environment, so ``ps`` shows names only and nothing is written to the
        host's disk.

        Args:
            spec: What to launch.
            container_env: The container's environment.
            mounts: ``(source, target, mode)`` bind mounts.
            port: The published port, or None to dial the container IP.

        Returns:
            The arguments after ``docker``.
        """
        cfg = self.config
        args = [
            'create',
            '-i',
            # The daemon removes the container when it exits, even if this engine died first
            '--rm',
            # Never a pull while a task starts: a missing image is an error naming container:build
            '--pull',
            'never',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            *self.user_args(),
            '--memory',
            str(spec.limits.get('memory') or cfg['memory']),
            '--cpus',
            str(spec.limits.get('cpus') or cfg['cpus']),
            '--pids-limit',
            cfg['pids_limit'],
            '--network',
            cfg['network'],
            '--log-driver',
            cfg['log_driver'],
            '--add-host',
            f'{HOST_GATEWAY}:host-gateway',
            '--label',
            f'{LABEL_TASK}={spec.task_id}',
            '--label',
            f'{LABEL_EAS}={cfg["instance"]}',
        ]
        if port:
            args += ['-p', f'127.0.0.1:{port}:{CONST_TASK_DATA_PORT_CONTAINER}']
        if cfg['models']:
            args += ['-v', f'{cfg["models"]}:/models:ro']
        for source, target, mode in mounts:
            args += ['-v', f'{source}:{target}' + (f':{mode}' if mode else '')]
        for name in sorted(container_env):
            args += ['-e', name]
        args.append(cfg['image'])
        args += self.task_args(spec)
        return args

    async def _store_problem_of(self, base: str) -> str:
        """
        Why a task cannot use this engine's store through a mount, or '' when it can; probed until there is a verdict.

        Checked rather than guessed. ``DOCKER_HOST`` is no guide: a DinD daemon
        on a shared socket passes for local and still sees other files. And the
        owner a task's file gets on the host depends on the daemon (a
        user-namespace remap, Docker Desktop's file sharing). So a short probe
        container, run as a task runs, looks for a marker written here and
        writes one back, which this engine must find as its own and remove.

        Args:
            base: The store's directory on this host.

        Returns:
            The reason, or ''.
        """
        if self._store_problem is not None:
            return self._store_problem
        probe = os.path.join(base, f'.rocketride-probe-{uuid.uuid4().hex}')
        os.makedirs(probe)
        try:
            try:
                self.give_to_tasks(probe)
            except OSError as e:
                # A store that refuses chown (NFS with root_squash, say) cannot be the tasks' to write
                self._store_problem = f"the engine cannot give the store to the tasks' user: {e}"
                return self._store_problem
            with open(os.path.join(probe, 'engine'), 'w', encoding='utf-8') as f:
                f.write('probe\n')
            result = await self._cli.run(
                [
                    'run',
                    '--rm',
                    '--pull',
                    'never',
                    '--network',
                    'none',
                    '--cap-drop',
                    'ALL',
                    '--security-opt',
                    'no-new-privileges',
                    *self.user_args(),
                    '-v',
                    f'{probe}:/probe',
                    '--entrypoint',
                    'sh',
                    self.config['image'],
                    '-c',
                    'test -f /probe/engine || exit 3; touch /probe/task || exit 4',
                ],
                check=False,
            )
            written = os.path.join(probe, 'task')
            getuid = getattr(os, 'getuid', None)
            # Kept only as a verdict on the store; docker's own failure (no image yet, a daemon restart) is none
            verdict = True
            if result.returncode == 3 or (result.returncode == 0 and not os.path.exists(written)):
                problem = (
                    "the docker daemon does not see this engine's files (a remote daemon, or one in another container)"
                )
            elif result.returncode == 4:
                problem = f'a task container cannot write the store: {result.stderr.strip() or result.returncode}'
            elif result.returncode != 0:
                problem = f'the store probe did not run (exit {result.returncode}): {result.stderr.strip()}'
                verdict = False
            # Root manages whatever a task writes
            elif getuid is not None and not engine_is_root() and os.stat(written).st_uid != getuid():
                problem = (
                    f'a file a task writes into the store belongs to uid {os.stat(written).st_uid} on this host, '
                    f'not to the engine (uid {getuid()}); a user-namespace remap on the daemon?'
                )
            else:
                problem = ''
        finally:
            # Also proves the engine can remove what a task wrote
            shutil.rmtree(probe, ignore_errors=True)
        if not problem and os.path.exists(probe):
            problem = 'the engine cannot remove what a task container writes into the store'
        if verdict:
            self._store_problem = problem
        debug(f'[docker] store at {base}: {problem or "a task can use it through a mount"}')
        return problem

    async def store_mounts(self, spec: LaunchSpec) -> Tuple[List[Tuple[str, str, str]], Dict[str, str]]:
        """
        Bind mounts and variables for what the task needs from the host's files.

        A pipeline with ``tool_filesystem`` on a filesystem store gets only its
        run's ``storage.root`` subtree, and its store points there. Where that
        cannot work the pipeline is refused before anything starts, rather than
        left writing into the container's own tree and losing it with ``rm -f``.
        The node test mocks (``ROCKETRIDE_MOCK``) are mounted read-only at the
        path the variable names.

        Args:
            spec: What to launch.

        Returns:
            ``(mounts, overrides)``.

        Raises:
            StoreUnavailableError: If the pipeline needs a store this container cannot have.
        """
        mounts: List[Tuple[str, str, str]] = []
        overrides: Dict[str, str] = {}

        mock = spec.env.get('ROCKETRIDE_MOCK')
        if mock and os.path.isdir(mock):
            mounts.append((mock, mock, 'ro'))

        if not (spec.uses_store and spec.storage_root):
            return mounts, overrides

        from ai.account.store import Store

        url = Store._expand_url_path(self._environ.get('RR_STORE_URL') or Store._get_default_storage_url())
        scheme = url.split('://', 1)[0].lower()
        if scheme != 'filesystem':
            if (
                scheme == 's3'
                and not self._environ.get('RR_STORE_SECRET_KEY')
                and self._environ.get('AWS_WEB_IDENTITY_TOKEN_FILE')
            ):
                raise StoreUnavailableError(
                    'tool_filesystem is not available under --runtime=docker with an S3 store '
                    'authenticated through a web-identity token file: the container cannot read the token'
                )
            # Credentials in the environment (a static key) reach the container as they are
            return mounts, overrides

        base = os.path.abspath(url[len('filesystem://') :])
        # docker -v splits its argument on ':', a Windows drive letter aside
        colon = spec.storage_root if ':' in spec.storage_root else base if os.name != 'nt' and ':' in base else ''
        if colon:
            raise StoreUnavailableError(
                f'tool_filesystem is not available under --runtime=docker: {colon} has a ":", '
                'which a docker mount cannot take'
            )
        os.makedirs(base, exist_ok=True)
        problem = await self._store_problem_of(base)
        if problem:
            raise StoreUnavailableError(f'tool_filesystem is not available under --runtime=docker: {problem}')
        # The task names its storage root: a strict subdirectory of the store, reached through
        # no link (one a task left could lead another root elsewhere), is the one path checked,
        # created, handed over and mounted
        real_base = os.path.realpath(base)
        lexical = os.path.normpath(os.path.join(real_base, spec.storage_root))
        subtree = os.path.realpath(lexical)
        try:
            inside = os.path.commonpath([real_base, subtree]) == real_base
        except ValueError:
            inside = False
        canonical = os.path.normcase(subtree) == os.path.normcase(lexical)
        if not inside or not canonical or os.path.normcase(subtree) == os.path.normcase(real_base):
            raise StoreUnavailableError(
                f'tool_filesystem is not available under --runtime=docker: the storage root {spec.storage_root} '
                'leads out of the store'
            )
        # Held at once, with nothing awaited since the path was checked: no other task's root may
        # lie inside or around this one while both run, or one could swap a path under the other's
        # mount before the daemon resolves it
        key = os.path.normcase(subtree)
        if any(holder != spec.task_id and overlaps(key, root) for holder, root in _ROOTS_IN_USE.items()):
            raise StoreUnavailableError(
                f'tool_filesystem is not available under --runtime=docker: the storage root {spec.storage_root} '
                'lies inside or around one that a running task uses'
            )
        _ROOTS_IN_USE[spec.task_id] = key
        try:
            # Created here, or the daemon would create it as root
            os.makedirs(subtree, exist_ok=True)
            # A root engine walks the whole tree the first time: off the event loop
            try:
                await asyncio.to_thread(self.give_to_tasks, subtree, True)
            except OSError as e:
                raise StoreUnavailableError(
                    f'tool_filesystem is not available under --runtime=docker: the engine cannot give '
                    f"{spec.storage_root} to the tasks' user: {e}"
                ) from e
        except BaseException:
            _ROOTS_IN_USE.pop(spec.task_id, None)
            raise
        mounts.append((subtree, f'{CONST_CONTAINER_STORE_ROOT}/{spec.storage_root}', ''))
        overrides['RR_STORE_URL'] = f'filesystem://{CONST_CONTAINER_STORE_ROOT}'
        return mounts, overrides

    async def _wait_started(self, container_id: str, process: asyncio.subprocess.Process) -> None:
        """
        Poll until the daemon has started the container.

        ``docker start -a`` attaches before it starts the container, and
        ``docker wait`` returns at once, with 0, for a container that is only
        created; so its exit is watched only once it has left that state.

        Args:
            container_id: The container.
            process: The attached CLI, to stop polling if it already died.

        Raises:
            DockerError: If the container does not start.
        """
        for _ in range(200):
            result = await self._cli.run(['inspect', '--format', '{{.State.Status}}', container_id], check=False)
            status = result.stdout.strip()
            if result.returncode == 0 and status and status != 'created':
                return
            # Already run and removed (--rm): the CLI carries its exit code
            if result.returncode != 0 and 'no such' in (result.stderr + result.stdout).lower():
                return
            if process.returncode is not None:
                break
            await asyncio.sleep(0.05)
        raise DockerError(f'Container {container_id[:12]} did not start')

    async def _container_address(self, container_id: str, process: asyncio.subprocess.Process) -> str:
        """
        The container's IP on its network, polled until the daemon has started it.

        Args:
            container_id: The container.
            process: The attached CLI, to stop polling if it already died.

        Returns:
            ``ip:5570``.

        Raises:
            DockerError: If no address appears.
        """
        for _ in range(40):
            result = await self._cli.run(
                ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container_id],
                check=False,
            )
            ip = _network_ip(result.stdout, self.config['network']) if result.returncode == 0 else ''
            if ip:
                return f'{ip}:{CONST_TASK_DATA_PORT_CONTAINER}'
            if process.returncode is not None:
                break
            await asyncio.sleep(0.05)
        if process.returncode is not None:
            raise DockerError(
                f'Container {container_id[:12]} exited (code {process.returncode}) before its address was read'
            )
        raise DockerError(f'Container {container_id[:12]} has no IP address on network {self.config["network"]}')

    async def start(self, spec: LaunchSpec) -> DockerLaunch:
        """
        ``create -i``, ``cp -``, ``start -a -i``; on any failure remove what was made and raise.

        Args:
            spec: What to launch.

        Returns:
            The running task.

        Raises:
            DockerError: If the daemon or the image cannot be used.
            StoreUnavailableError: If the pipeline needs a store this container cannot have.
        """
        await self.prepare()
        mounts, overrides = await self.store_mounts(spec)

        port: Optional[int] = None
        container_id = ''
        process: Optional[asyncio.subprocess.Process] = None
        try:
            if self.published:
                port = self._server.assign_port()
            env = self.container_env(spec, overrides)
            try:
                created = await self._cli.run(self.create_args(spec, env, mounts, port), env=self.cli_env(env))
            except DockerError as e:
                # Only the image: a network or a path that is not found is a fault of its own
                if re.search(r'no such image|unable to find image', str(e), flags=re.IGNORECASE):
                    raise DockerError(
                        f'Image {self.config["image"]} not found; run ./builder container:build '
                        '(the runtime never pulls while a task starts)'
                    ) from e
                raise
            container_id = created.stdout.strip()
            # The root the task holds goes by its container from here
            if spec.task_id in _ROOTS_IN_USE:
                _ROOTS_IN_USE[container_id] = _ROOTS_IN_USE.pop(spec.task_id)
            await self._cli.run(
                ['cp', '-', f'{container_id}:{CONST_CONTAINER_DATA_PATH}'],
                stdin=task_tar(spec.task_file, *(self.user or (CONST_IMAGE_UID, CONST_IMAGE_GID))),
            )
            process = await self._cli.attach(['start', '-a', '-i', container_id])
            await self._wait_started(container_id, process)
            address = f'127.0.0.1:{port}' if port else await self._container_address(container_id, process)
        except BaseException:
            # The attached CLI goes with the container: left alone, its pipes stay open
            if process is not None:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                _, said = await process.communicate()
                # What the task wrote before its start failed: its crash message, for one
                if said:
                    debug(
                        f'[docker] task {spec.task_id} before its start failed: {said.decode(errors="replace")[-4000:]}'
                    )
            # A root held before create; one held by the container goes with its removal
            _ROOTS_IN_USE.pop(spec.task_id, None)
            # The start's own failure is the one to report: what the rollback meets is logged
            if container_id:
                await self._remove_quietly(container_id)
            if port:
                self._server.release_port(port)
            raise
        return DockerLaunch(process, address, self._cli, container_id, port, self._server)

    async def _remove_quietly(self, container_id: str) -> None:
        """
        ``rm -f`` for a start that failed, whose own failure is the one to report: an error here is logged.

        The engine's next startup sweep removes what is left.

        Args:
            container_id: The container.
        """
        try:
            result = await self._cli.run(['rm', '-f', container_id], check=False)
            # Still there, the container still holds its root
            if result.returncode == 0 or 'no such container' in result.stderr.lower():
                _ROOTS_IN_USE.pop(container_id, None)
        except Exception as e:
            debug(f'[docker] could not remove {container_id[:12]} after a failed start: {e}')


def _network_ip(networks_json: str, network: str) -> str:
    """
    The container's IP from ``docker inspect``'s ``.NetworkSettings.Networks``.

    The top-level ``.NetworkSettings.IPAddress`` is empty on API 1.56, so the
    address is read per network: the configured one, else the first that has one.

    Args:
        networks_json: The networks as JSON.
        network: The network the container was created on.

    Returns:
        The IP, or '' when there is none yet.
    """
    try:
        networks = json.loads(networks_json or 'null') or {}
    except ValueError:
        return ''
    preferred = networks.get(network) or {}
    if preferred.get('IPAddress'):
        return preferred['IPAddress']
    for settings in networks.values():
        if (settings or {}).get('IPAddress'):
            return settings['IPAddress']
    return ''
