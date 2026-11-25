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
a subprocess. A run is five commands — ``create -i``, ``cp -`` (twice when the
run has packaged nodes), ``start -a -i``, ``wait``, ``rm -f`` — and the exit code
comes from ``docker wait``, not from the
CLI, which can die before the container does; the CLI's code stands only when
the daemon cannot say (see ``_wait_for_exit``).
"""

from __future__ import annotations

import asyncio
import io
import ipaddress
import json
import os
import re
import socket
import stat
import sys
import tarfile
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit

from rocketlib import debug

from ai.constants import CONST_SUBPROCESS_BUFFER_LIMIT

from .base import Launch, Launcher, LaunchSpec, task_argv

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

# The engine's data directory inside the image (engine-base: mkdir /opt/data)
CONST_CONTAINER_DATA_PATH = '/opt/data'

# The folder the task's start-up scan loads nodes from (WORKDIR /opt/rocketride)
CONST_CONTAINER_NODES_PATH = '/opt/rocketride/nodes'

# The most a run's packaged nodes may take, headers included: they are read into memory at every start.
# Today's largest node is about 6 MiB, all of them together about 16 MiB
CONST_NODES_SIZE_LIMIT = 64 * 1024 * 1024

# Where the host directories named in docker.mounts are mounted inside a container
CONST_CONTAINER_MOUNT_ROOT = '/opt/mounts'

# The image's own user and group (rocketride); the group can write what a run installs
CONST_IMAGE_UID = 1000
CONST_IMAGE_GID = 1000

# The task's command line inside the image (WORKDIR /opt/rocketride)
CONST_CONTAINER_ENGINE = './engine'
CONST_CONTAINER_NODE_SCRIPT = 'ai/node.py'

# Which task a container runs, and which engine instance owns it
LABEL_TASK = 'rocketride.task'
LABEL_EAS = 'rocketride.eas'

# Loopback inside a container is the container; a loopback host moves to this name
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
        # The ML libraries' caches and data: a host path there would win over the
        # image's home and over the models mount
        'HF_HOME',
        'HF_HUB_CACHE',
        'HF_ASSETS_CACHE',
        'HF_DATASETS_CACHE',
        'HF_MODULES_CACHE',
        'HF_XET_CACHE',
        'HF_TOKEN_PATH',
        'HUGGINGFACE_HUB_CACHE',
        'HUGGINGFACE_ASSETS_CACHE',
        'TRANSFORMERS_CACHE',
        'PYTORCH_TRANSFORMERS_CACHE',
        'PYTORCH_PRETRAINED_BERT_CACHE',
        'TORCH_HOME',
        'TORCH_EXTENSIONS_DIR',
        'PYTORCH_KERNEL_CACHE_PATH',
        'TIKTOKEN_CACHE_DIR',
        'NLTK_DATA',
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
    'DOCKER_TLS',
    'DOCKER_API_VERSION',
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
    'mounts': '',
    'log_driver': 'none',
    'instance': '',
}


class DockerError(RuntimeError):
    """A docker CLI command failed, or the daemon cannot be used."""


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
    return not is_loopback(parts.hostname or '')


def is_loopback(host: str) -> bool:
    """
    Whether a host names this machine's loopback: ``localhost``, 127/8 or ``::1``.

    Args:
        host: A host name or address, without brackets or port.

    Returns:
        True for a loopback address or ``localhost``.
    """
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == 'localhost'


def _swap_loopback_host(netloc: str, gateway: str = HOST_GATEWAY) -> str:
    """
    Replace a loopback host in ``[userinfo@]host[:port]`` with the host gateway name.

    Args:
        netloc: The authority part of an address.
        gateway: The name the host is reached by.

    Returns:
        The netloc, rewritten only when its host is a loopback address.
    """
    userinfo, at, hostport = netloc.rpartition('@')
    # A host list stays as it is: only a single host is rewritten
    if ',' in hostport:
        return netloc
    if hostport.startswith('['):
        host, _, rest = hostport[1:].partition(']')
        port = rest
    elif hostport.count(':') == 1:
        host, colon, port_number = hostport.partition(':')
        port = colon + port_number
    else:
        host, port = hostport, ''
    if not is_loopback(host):
        return netloc
    return f'{userinfo}{at}{gateway}{port}'


def rewrite_loopback(address: str, gateway: str = HOST_GATEWAY) -> str:
    """
    Point a loopback address at the host gateway, so a container reaches the host.

    Handles ``host:port`` and ``scheme://[user@]host:port/...``. A bare port
    (``5590``) has no host and is left alone, as is any other host.

    Args:
        address: A model server address or a database DSN.
        gateway: The name the host is reached by; ``host.docker.internal`` under docker.

    Returns:
        The address, with a loopback host rewritten to the gateway; any other
        address exactly as it was given.
    """
    if '://' in address:
        parts = urlsplit(address)
        netloc = _swap_loopback_host(parts.netloc, gateway)
        # urlunsplit is no exact round trip (scheme case, an empty ?, a host-less //)
        return address if netloc == parts.netloc else urlunsplit(parts._replace(netloc=netloc))
    if address.isdigit():
        return address
    return _swap_loopback_host(address, gateway)


def rewrite_loopback_dsns(value: str, rewrite: Callable[[str], str] = rewrite_loopback) -> str:
    """
    ``rewrite_loopback`` for each DSN of a ``ROCKETRIDE_DB_DSNS`` map.

    Args:
        value: The map, as JSON.
        rewrite: What each DSN goes through; the k8s runtime passes its own.

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
    return json.dumps({key: rewrite(dsn) for key, dsn in dsns.items()})


def task_tar(data: bytes, uid: int = CONST_IMAGE_UID, gid: int = CONST_IMAGE_GID) -> bytes:
    """
    The task file as a one-member tar stream for ``docker cp -``.

    The header sets owner and mode, so the file is 0600 and belongs to the
    user the task runs as, and the engine writes no copy of it to disk.

    Args:
        data: The task file.
        uid: The task's uid.
        gid: The task's gid.

    Returns:
        The tar archive.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        tar.addfile(tar_member('task.json', 0o600, len(data), uid=uid, gid=gid), io.BytesIO(data))
    return buffer.getvalue()


def tar_member(
    name: str, mode: int, size: int = 0, directory: bool = False, uid: int = CONST_IMAGE_UID, gid: int = CONST_IMAGE_GID
) -> tarfile.TarInfo:
    """
    The header of one member of a tar stream for a task, owned by the user the task runs as.

    Args:
        name: The member's path.
        mode: Its permissions.
        size: Its length, for a file.
        directory: Whether it is a directory.
        uid: The task's uid.
        gid: The task's gid.

    Returns:
        The header.
    """
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.uid, info.gid = uid, gid
    # Names only for the image's own user; any other is known by number alone
    if (uid, gid) == (CONST_IMAGE_UID, CONST_IMAGE_GID):
        info.uname = info.gname = 'rocketride'
    info.mtime = int(time.time())
    if directory:
        info.type = tarfile.DIRTYPE
    return info


def add_directory(
    tar: tarfile.TarFile, source: str, target: str, budget: int, uid: int = CONST_IMAGE_UID, gid: int = CONST_IMAGE_GID
) -> int:
    """
    Put a host directory into a tar stream for a task: its directories and its regular files, not links.

    Args:
        tar: The archive being written.
        source: The directory on this host.
        target: Its path in the archive.
        budget: The bytes of the archive it may still take, headers included.
        uid: The task's uid.
        gid: The task's gid.

    Returns:
        What is left of the budget; below zero when the directory does not fit, which ends the reading.

    Raises:
        OSError: If the directory, or a directory in it, cannot be read.
    """

    def unreadable(error: OSError) -> None:
        # os.walk skips a directory it cannot list: the task would get part of it, or none, without a word
        if not isinstance(error, FileNotFoundError) or error.filename == source:
            raise error

    end = tar.offset + budget
    for root, directories, files in os.walk(source, onerror=unreadable):
        # os.walk enters a Windows junction, which is a link to a directory
        directories[:] = sorted(name for name in directories if not os.path.isjunction(os.path.join(root, name)))
        relative = os.path.relpath(root, source).replace(os.sep, '/')
        base = target if relative == '.' else f'{target}/{relative}'
        tar.addfile(tar_member(base, 0o755, directory=True, uid=uid, gid=gid))
        for name in sorted(files):
            if tar.offset > end:
                break
            path = os.path.join(root, name)
            try:
                seen = os.stat(path, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(seen.st_mode):
                continue
            try:
                f = open(path, 'rb')
            except FileNotFoundError:
                # Removed after its look: left out, as one removed before it
                continue
            with f:
                # A link swapped in after the look is not followed: only the file looked at is read
                opened = os.fstat(f.fileno())
                if (opened.st_dev, opened.st_ino) != (seen.st_dev, seen.st_ino):
                    continue
                # One byte more than fits shows a file is too big without reading all of it
                data = f.read(end - tar.offset + 1)
            mode = 0o755 if seen.st_mode & 0o100 else 0o644
            tar.addfile(tar_member(f'{base}/{name}', mode, len(data), uid=uid, gid=gid), io.BytesIO(data))
        if tar.offset > end:
            break
    return end - tar.offset


def add_nodes(tar: tarfile.TarFile, folders: Sequence[str], uid: int, gid: int, under: str = '') -> None:
    """
    Put the run's node folders into a tar stream for a task.

    Each folder goes in under its own name with its digest file, so the task's
    scan loads it and ``depends()`` keeps it out of the lock's hash, as on the
    engine's disk.

    Args:
        tar: The archive being written.
        folders: The node folders on the engine's disk.
        uid: The task's uid.
        gid: The task's gid.
        under: The archive path the folders go under, with its trailing slash.

    Raises:
        ValueError: If they take more than ``CONST_NODES_SIZE_LIMIT``.
        OSError: If one of them cannot be read.
    """
    budget = CONST_NODES_SIZE_LIMIT
    for folder in folders:
        budget = add_directory(tar, folder, under + os.path.basename(folder), budget, uid, gid)
        if budget < 0:
            raise ValueError(
                f"The run's nodes take more than {CONST_NODES_SIZE_LIMIT // 2**20} MiB; they are copied in as it starts"
            )


def nodes_tar(folders: Sequence[str], uid: int, gid: int) -> bytes:
    """
    The run's node folders as a tar stream for ``docker cp -`` into the image's nodes folder (see ``add_nodes``).

    Args:
        folders: The node folders on the engine's disk.
        uid: The task's uid.
        gid: The task's gid.

    Returns:
        The tar archive.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        add_nodes(tar, folders, uid, gid)
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
        ``docker start -a`` returned the container's code itself, or
        ``docker wait`` could not even be started.

        Returns:
            The exit code.
        """
        # As long as the task runs: no time limit
        try:
            result = await self._cli.run(['wait', self.container_id], check=False, timeout=None)
        except OSError as e:
            debug(f'[docker] docker wait for {self.container_id[:12]} could not run: {e}')
            result = None
        text = result.stdout.strip() if result is not None else ''
        if result is not None and result.returncode == 0 and text.lstrip('-').isdigit():
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
        ``docker rm -f``; a container already gone, or one the daemon is already removing, counts as removed.

        Raises:
            DockerError: If the daemon did not remove it.
        """
        result = await self._cli.run(['rm', '-f', self.container_id], check=False)
        said = result.stderr.lower()
        # --rm: as the task exits the daemon removes it too, and that removal ends without us
        if result.returncode != 0 and 'no such container' not in said and 'already in progress' not in said:
            raise DockerError(f'docker rm failed (exit {result.returncode}): {result.stderr.strip()}')
        self._removed = True

    def metrics(self) -> Dict[str, Any]:
        """CPU and memory from ``docker stats``; no local PID, so the GPU half reads zero."""
        return {'sampler': DockerStatsSampler(self._cli, self.container_id)}

    async def cleanup(self) -> None:
        """
        Remove the container and give a published port back; safe to call twice.

        A container the daemon refused to remove may still run, so it keeps its
        port until the engine restarts; that start's sweep removes it.

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
        The user a task container runs as: the engine's own, so it reads a mount as the engine does.

        A bind mount keeps the owners and modes it has on the host, so the
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
            try:
                removed = await self._cli.run(['rm', '-f', *ids], check=False)
            except (DockerError, OSError) as e:
                # A removal that does not end in time, like a refused one, must not keep tasks from starting
                removed = CliResult(-1, '', str(e))
            if removed.returncode != 0:
                debug(
                    f'[docker] could not remove all of {len(ids)} container(s) left by an earlier run of '
                    f'{self.config["instance"]}: {removed.stderr.strip()}'
                )
            else:
                debug(f'[docker] removed {len(ids)} container(s) left by an earlier run of {self.config["instance"]}')

    @staticmethod
    def task_args(spec: LaunchSpec, modelserver: Optional[str]) -> List[str]:
        """
        The command line inside the container: the task's argv with the container's paths.

        The data port is fixed and bound on every interface of the container's
        own network namespace.

        Args:
            spec: What to launch.
            modelserver: The model server address as the container dials it, if any.

        Returns:
            The argv after the image name.
        """
        return [
            CONST_CONTAINER_ENGINE,
            *task_argv(
                spec,
                CONST_CONTAINER_NODE_SCRIPT,
                f'{CONST_CONTAINER_DATA_PATH}/task.json',
                CONST_TASK_DATA_PORT_CONTAINER,
                '0.0.0.0',
                modelserver,
            ),
        ]

    def container_env(self, spec: LaunchSpec, overrides: Mapping[str, str]) -> Dict[str, str]:
        """
        The task's environment as the container gets it.

        Host-only variables stay out, a loopback DSN moves to the host gateway,
        and the runtime's own values (the mounted directories, the model cache) go on top.

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
        environment, so ``ps`` shows names only and the engine writes no
        environment file.

        Args:
            spec: What to launch.
            container_env: The container's environment.
            mounts: ``(source, target, mode)`` bind mounts.
            port: The published port, or None to dial the container IP.

        Returns:
            The arguments after ``docker``.

        Raises:
            DockerError: If ``docker.models`` names no directory on this host that a mount can take.
        """
        cfg = self.config
        args = [
            'create',
            '-i',
            # The daemon removes the container when it exits, even if this engine died first
            '--rm',
            # Never a pull while a task starts: a missing image is an error saying how to get it
            '--pull',
            'never',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            *self.user_args(),
            '--memory',
            str(cfg['memory']),
            '--cpus',
            str(cfg['cpus']),
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
            models = cfg['models']
            # docker -v reads a bare name as a named volume, not a directory
            if not os.path.isabs(models):
                models = os.path.abspath(models)
            if not os.path.isdir(models):
                raise DockerError(f'docker.models is mounted into task containers, but {models} is no directory')
            # docker -v splits its argument on ':', a Windows drive letter aside
            if os.name != 'nt' and ':' in models:
                raise DockerError(
                    f'docker.models is mounted into task containers, but {models} has a ":", '
                    'which a docker mount cannot take'
                )
            args += ['-v', f'{models}:/models:ro']
        for source, target, mode in mounts:
            args += ['-v', f'{source}:{target}' + (f':{mode}' if mode else '')]
        for name in sorted(container_env):
            args += ['-e', name]
        args.append(cfg['image'])
        args += self.task_args(spec, spec.modelserver and rewrite_loopback(spec.modelserver))
        return args

    def image_missing(self, said: str) -> Optional[DockerError]:
        """
        The error for an image the daemon does not have, saying how to get it.

        Args:
            said: What docker said when a command that needs the image failed.

        Returns:
            The error, or None when ``said`` is about something else.
        """
        # Only the image: a network or a path that is not found is a fault of its own
        if not re.search(r'no such image|unable to find image', said, flags=re.IGNORECASE):
            return None
        image = self.config['image']
        # container:build makes the default image only
        default = image == f'rocketride/node:{engine_version()}'
        fix = 'run ./builder container:build' if default else 'pull or load it'
        return DockerError(f'Image {image} not found; {fix} (the runtime never pulls while a task starts)')

    def mounted_directories(self, spec: LaunchSpec) -> Tuple[List[Tuple[str, str, str]], Dict[str, str]]:
        """
        The host directories a task is told about through a variable named in ``docker.mounts``.

        Each is mounted read-only at ``/opt/mounts/<NAME>``, and the variable
        points there; one that names no directory stops the task, since the
        host path would reach it unchanged and mean nothing in the container.

        Args:
            spec: What to launch.

        Returns:
            ``(mounts, overrides)``.

        Raises:
            DockerError: If a variable names no directory a mount can take, or describes the engine host.
        """
        mounts: List[Tuple[str, str, str]] = []
        overrides: Dict[str, str] = {}
        for name in filter(None, (n.strip() for n in self.config['mounts'].split(','))):
            # docker create takes the CLI's own value of these, and the task would get it
            if name in CLI_ENV_NAMES or is_host_only(name):
                raise DockerError(
                    f'{name} cannot be mounted into task containers (docker.mounts): it describes the engine host'
                )
            path = spec.env.get(name)
            if not path:
                continue
            # docker -v reads a bare name as a named volume, not a directory
            if not os.path.isabs(path):
                path = os.path.abspath(path)
            if not os.path.isdir(path):
                raise DockerError(f'{name} is mounted into task containers (docker.mounts), but {path} is no directory')
            # docker -v splits its argument on ':', a Windows drive letter aside
            if os.name != 'nt' and ':' in path:
                raise DockerError(
                    f'{name} is mounted into task containers (docker.mounts), but {path} has a ":", '
                    'which a docker mount cannot take'
                )
            target = f'{CONST_CONTAINER_MOUNT_ROOT}/{name}'
            mounts.append((path, target, 'ro'))
            overrides[name] = target
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
        raise DockerError(
            f'Container {container_id[:12]} has no IPv4 address on network {self.config["network"]} '
            '(task containers need IPv4)'
        )

    async def start(self, spec: LaunchSpec) -> DockerLaunch:
        """
        ``create -i``, ``cp -`` (task file, then nodes), ``start -a -i``; on any failure remove what was made and raise.

        Args:
            spec: What to launch.

        Returns:
            The running task.

        Raises:
            DockerError: If the daemon or the image cannot be used.
            ValueError: If the run's nodes take more than ``CONST_NODES_SIZE_LIMIT``.
        """
        await self.prepare()
        mounts, overrides = self.mounted_directories(spec)

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
                missing = self.image_missing(str(e))
                if missing:
                    raise missing from e
                raise
            container_id = created.stdout.strip()
            owner = self.user or (CONST_IMAGE_UID, CONST_IMAGE_GID)
            await self._cli.run(
                ['cp', '-', f'{container_id}:{CONST_CONTAINER_DATA_PATH}'],
                stdin=task_tar(spec.task_file, *owner),
            )
            # The image holds only the server's own nodes: the packaged ones the run loads go in before it starts
            if spec.nodes:
                await self._cli.run(
                    ['cp', '-', f'{container_id}:{CONST_CONTAINER_NODES_PATH}'],
                    stdin=await asyncio.to_thread(nodes_tar, spec.nodes, *owner),
                )
            process = await self._cli.attach(['start', '-a', '-i', container_id])
            try:
                # Counted looks that each answer slowly would stretch a start without end
                await asyncio.wait_for(self._wait_started(container_id, process), CONST_CLI_TIMEOUT)
                address = (
                    f'127.0.0.1:{port}'
                    if port
                    else await asyncio.wait_for(self._container_address(container_id, process), CONST_CLI_TIMEOUT)
                )
            except asyncio.TimeoutError:
                raise DockerError(
                    f'Container {container_id[:12]} did not start within {CONST_CLI_TIMEOUT:g} s'
                ) from None
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
            # The start's own failure is the one to report: what the rollback meets is logged
            removed = await self._remove_quietly(container_id) if container_id else True
            # A container docker start ran keeps its published port until it is gone, as in cleanup()
            if port and (removed or process is None):
                self._server.release_port(port)
            raise
        return DockerLaunch(process, address, self._cli, container_id, port, self._server)

    async def _remove_quietly(self, container_id: str) -> bool:
        """
        ``rm -f`` for a start that failed, whose own failure is the one to report: an error here is logged.

        The engine's next startup sweep removes what is left.

        Args:
            container_id: The container.

        Returns:
            True when the container is gone, or the daemon is already removing it.
        """
        try:
            result = await self._cli.run(['rm', '-f', container_id], check=False)
            said = result.stderr.lower()
            # Gone, or one the daemon is already removing (--rm)
            if result.returncode == 0 or 'no such container' in said or 'already in progress' in said:
                return True
            debug(f'[docker] could not remove {container_id[:12]} after a failed start: {result.stderr.strip()}')
        except Exception as e:
            debug(f'[docker] could not remove {container_id[:12]} after a failed start: {e}')
        return False


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
