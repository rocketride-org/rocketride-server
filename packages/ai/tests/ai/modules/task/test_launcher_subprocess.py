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
Unit tests for the subprocess runtime (``ai.modules.task.launcher.subprocess``).

The runtime is the launch block ``Task.start_task`` used to hold, moved as is,
so these pin what it did: the argv in its old order, the 0600 task file, the
port from the pool, the python shim for VS Code debugging, and what cleanup
and a failed start give back. ``create_subprocess_exec`` is stubbed; no
process starts.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai import CONST_AI_NODE_SCRIPT
from ai.constants import CONST_SUBPROCESS_BUFFER_LIMIT, CONST_TASK_DATA_PATH
from ai.modules.task import launcher as launcher_pkg
from ai.modules.task.launcher import CONST_HOSTED_CHILD_FLAG, LaunchSpec, SubprocessLauncher, create_launcher
from ai.modules.task.launcher import subprocess as spawn
from ai.modules.task.launcher.subprocess import file_checksum


def _spec(**overrides) -> LaunchSpec:
    """A LaunchSpec with every optional piece set, overridable per test."""
    values = dict(
        task_id='task-1',
        task_file=b'{"type": "pipeline"}\n\n',
        token_sha256='a' * 64,
        env={'PATH': '/usr/bin'},
        pipeline_args=['--threads=2', f'--data_token_sha256={"b" * 64}'],
        modelserver='127.0.0.1:5590',
        hosted=True,
        trace_arg='--trace=debugOut',
        node_path_arg='--node_path=/ws/nodes',
    )
    values.update(overrides)
    return LaunchSpec(**values)


def _server() -> SimpleNamespace:
    """A stand-in for TaskServer's port pool."""
    return SimpleNamespace(assign_port=MagicMock(return_value=20007), release_port=MagicMock())


class _Process:
    """Just enough of asyncio.subprocess.Process."""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.returncode = None
        self.calls = []

    async def wait(self) -> int:
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.calls.append('terminate')

    def kill(self) -> None:
        self.calls.append('kill')


@pytest.fixture
def launches(monkeypatch):
    """Record create_subprocess_exec calls and hand back a fake process."""
    calls = []

    async def fake_exec(*argv, **kwargs):
        calls.append((argv, kwargs))
        return _Process()

    monkeypatch.setattr(spawn.asyncio, 'create_subprocess_exec', fake_exec)
    return calls


# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------


def test_argv_keeps_the_old_order():
    """Engine args first, then the pipeline's, then what is inherited — as start_task built them."""
    args = SubprocessLauncher.build_args(_spec(), '/tmp/task-1.json', 20007)
    assert args == [
        CONST_AI_NODE_SCRIPT,
        '/tmp/task-1.json',
        '--autoterm',
        '--monitor=app',
        '--data_port=20007',
        '--data_host=127.0.0.1',
        f'--data_token_sha256={"a" * 64}',
        CONST_HOSTED_CHILD_FLAG,
        '--modelserver=127.0.0.1:5590',
        '--threads=2',
        f'--data_token_sha256={"b" * 64}',
        '--trace=debugOut',
        '--node_path=/ws/nodes',
    ]


def test_argv_without_the_optional_pieces():
    """No hosted flag, model server or inherited args when the spec has none."""
    spec = _spec(hosted=False, modelserver=None, pipeline_args=[], trace_arg=None, node_path_arg=None)
    args = SubprocessLauncher.build_args(spec, '/tmp/t.json', 20000)
    assert CONST_HOSTED_CHILD_FLAG not in args
    assert not any(a.startswith(('--modelserver', '--trace', '--node_path')) for a in args)
    assert args[-1] == f'--data_token_sha256={"a" * 64}'


# ---------------------------------------------------------------------------
# start / cleanup
# ---------------------------------------------------------------------------


async def test_start_writes_a_private_task_file_and_takes_a_port(launches):
    """The task file is 0600 with the spec's bytes; the port is the pool's; the env is the spec's."""
    server = _server()
    launch = await SubprocessLauncher(server).start(_spec())
    try:
        ((argv, kwargs),) = launches
        taskpath = argv[2]
        with open(taskpath, 'rb') as f:
            assert f.read() == b'{"type": "pipeline"}\n\n'
        if os.name != 'nt':
            assert stat.S_IMODE(os.stat(taskpath).st_mode) == 0o600
        assert argv[0] == sys.executable
        assert kwargs['env'] == {'PATH': '/usr/bin'}
        assert kwargs['cwd'] == os.path.dirname(sys.executable)
        assert kwargs['limit'] == CONST_SUBPROCESS_BUFFER_LIMIT
        for stream in ('stdin', 'stdout', 'stderr'):
            assert kwargs[stream] == asyncio.subprocess.PIPE
        assert launch.address == '127.0.0.1:20007'
        assert launch.metrics() == {'pid': 4242}
        assert launch.pid == 4242
    finally:
        await launch.cleanup()


async def test_cleanup_removes_the_file_and_gives_the_port_back_once(launches):
    """Cleanup releases the port and the file; a second call does nothing."""
    server = _server()
    launch = await SubprocessLauncher(server).start(_spec())
    taskpath = launches[0][0][2]

    await launch.cleanup()
    await launch.cleanup()

    assert not os.path.exists(taskpath)
    server.release_port.assert_called_once_with(20007)


async def test_a_failed_start_gives_back_what_it_took(monkeypatch):
    """When the process cannot start, the task file is removed and the port released."""
    written = []
    real_write = spawn.write_task_file

    async def recording_write(task_id, data):
        path = await real_write(task_id, data)
        written.append(path)
        return path

    async def failing_exec(*argv, **kwargs):
        raise OSError('no engine')

    monkeypatch.setattr(spawn, 'write_task_file', recording_write)
    monkeypatch.setattr(spawn.asyncio, 'create_subprocess_exec', failing_exec)
    server = _server()

    with pytest.raises(OSError, match='no engine'):
        await SubprocessLauncher(server).start(_spec())

    assert written and not os.path.exists(written[0])
    server.release_port.assert_called_once_with(20007)


async def test_launch_speaks_for_the_process(launches):
    """returncode, wait, terminate and kill are the process's own."""
    launch = await SubprocessLauncher(_server()).start(_spec())
    try:
        assert launch.returncode is None
        launch.terminate()
        launch.kill()
        assert launch.process.calls == ['terminate', 'kill']
        assert await launch.wait() == 0
        assert launch.returncode == 0
    finally:
        await launch.cleanup()


def test_task_data_path_is_the_engines_own():
    """The task file names this engine's data directory."""
    assert SubprocessLauncher(_server()).task_data_path == CONST_TASK_DATA_PATH


# ---------------------------------------------------------------------------
# VS Code subprocess debugging
# ---------------------------------------------------------------------------


async def test_debug_attach_runs_through_the_python_shim(monkeypatch, launches):
    """With the debugger attached, the child starts from the shim next to the engine."""
    monkeypatch.setattr(spawn, '_python_shim', lambda: '/opt/engine/python')
    launch = await SubprocessLauncher(_server()).start(_spec(debug_attach=True))
    try:
        ((argv, kwargs),) = launches
        assert argv[0] == '/opt/engine/python'
        assert kwargs['cwd'] == '/opt/engine'
    finally:
        await launch.cleanup()


def test_python_shim_is_copied_once_and_only_when_it_differs(monkeypatch, tmp_path):
    """The engine is copied to python next to it, once per process."""
    engine = tmp_path / 'engine'
    engine.write_bytes(b'engine-binary')
    monkeypatch.setattr(spawn.sys, 'executable', str(engine))
    monkeypatch.setattr(spawn, 'copied_python_shim', False)

    shim = spawn._python_shim()
    assert shim == str(tmp_path / 'python')
    assert (tmp_path / 'python').read_bytes() == b'engine-binary'

    # Once copied, the flag stops a second copy even if the engine changes
    engine.write_bytes(b'engine-binary-v2')
    spawn._python_shim()
    assert (tmp_path / 'python').read_bytes() == b'engine-binary'


# ---------------------------------------------------------------------------
# file_checksum (moved from Task._file_checksum)
# ---------------------------------------------------------------------------


def test_file_checksum_matches_sha256_of_file_contents(tmp_path):
    """The function returns the SHA-256 hex digest of the file body."""
    p = tmp_path / 'sample.bin'
    body = b'hello world\n' * 1024  # spans multiple 8 KiB reads
    p.write_bytes(body)
    assert file_checksum(str(p)) == hashlib.sha256(body).hexdigest()


def test_file_checksum_empty_file_yields_empty_sha256(tmp_path):
    """SHA-256 of an empty file is the canonical e3b0...b855."""
    p = tmp_path / 'empty.bin'
    p.write_bytes(b'')
    assert file_checksum(str(p)) == hashlib.sha256(b'').hexdigest()


# ---------------------------------------------------------------------------
# Runtime selection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('runtime', ['', 'spawn'])
def test_create_launcher_defaults_to_spawn(runtime):
    """No runtime, or spawn, is the subprocess runtime."""
    assert isinstance(create_launcher(runtime, _server()), SubprocessLauncher)


def test_create_launcher_refuses_an_unknown_runtime():
    """A runtime nobody implements is an error, not a silent spawn."""
    with pytest.raises(ValueError, match='k8s'):
        create_launcher('k8s', _server())


@pytest.mark.parametrize('hosted, expected', [(False, 'spawn'), (True, 'docker')])
def test_default_runtime_follows_the_hosted_flag(hosted, expected):
    """Without --runtime: docker with --saas, spawn otherwise."""
    assert launcher_pkg.default_runtime(hosted) == expected
    assert expected in launcher_pkg.RUNTIMES


def test_task_server_keeps_one_launcher_per_process():
    """Every Task of a process gets the same launcher instance."""
    from ai.modules.task.task_server import TaskServer

    server = TaskServer.__new__(TaskServer)
    server._config = {'runtime': 'spawn'}
    server._launcher = None

    first = server.launcher()
    assert isinstance(first, SubprocessLauncher)
    assert server.launcher() is first
