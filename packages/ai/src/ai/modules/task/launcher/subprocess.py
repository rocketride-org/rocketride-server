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
The subprocess runtime: the task is a child process of the engine.

This is the launch block ``Task.start_task`` used to hold, moved as is: the
task file in a ``mkstemp`` 0600 file, a data port from the server's pool,
``--hosted`` when the engine is hosted, and the python shim for VS Code
subprocess debugging.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import sys
import tempfile
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from ai import CONST_AI_NODE_SCRIPT
from ai.constants import CONST_SUBPROCESS_BUFFER_LIMIT, CONST_TASK_DATA_PATH

from .base import Launch, Launcher, LaunchSpec

if TYPE_CHECKING:
    from ..task_server import TaskServer

# Task subprocesses of a hosted engine get this flag on their command line.
# Pipeline-supplied args can add flags but not remove this one, so nodes can
# rely on it (the MCP stdio client refuses to start when it is present).
CONST_HOSTED_CHILD_FLAG = '--hosted'

# The python shim for VS Code subprocess debugging is copied once per process
copied_python_shim = False


def file_checksum(path: str) -> str:
    """
    SHA-256 of a file, read in 8 KiB chunks.

    Args:
        path: File to hash.

    Returns:
        Hexadecimal SHA-256 digest.
    """
    hash_sha256 = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()


async def write_task_file(task_id: str, data: bytes) -> str:
    """
    Write the task file to a new temporary file.

    ``mkstemp`` gives owner-only permissions (0600), an unpredictable name and
    exclusive creation, so the secrets in the file are not readable by others
    and a planted symlink is never followed.

    Args:
        task_id: The task's id, part of the file name.
        data: The resolved task file.

    Returns:
        The path of the new file.

    Raises:
        OSError: If the file cannot be created or written.
    """
    fd, taskpath = tempfile.mkstemp(suffix='.json', prefix=f'task-{task_id}-')
    with os.fdopen(fd, 'wb') as f:
        await asyncio.to_thread(f.write, data)
    return taskpath


def _python_shim() -> str:
    """
    The python shim VS Code needs to attach to a subprocess.

    The debugger launches subprocesses through a ``python`` executable next to
    the engine, so the engine is copied there once per process (again if it
    changed).

    Returns:
        The path of the shim.

    Raises:
        RuntimeError: If the shim does not exist and cannot be created.
    """
    global copied_python_shim

    execdir = os.path.dirname(sys.executable)
    _, ext = os.path.splitext(sys.executable)
    execpython = os.path.join(execdir, f'python{ext}')
    execengine = sys.executable

    if not copied_python_shim:
        should_copy = not os.path.exists(execpython)
        if not should_copy:
            try:
                should_copy = file_checksum(execengine) != file_checksum(execpython)
            except Exception:
                should_copy = True

        if should_copy:
            try:
                shutil.copy2(execengine, execpython)
            except Exception as e:
                if not os.path.exists(execpython):
                    raise RuntimeError(f"Failed to create debug shim '{execpython}': {e}")

        copied_python_shim = True

    return execpython


class SubprocessLaunch(Launch):
    """A task running as a child process; the process is the task."""

    def __init__(self, process: asyncio.subprocess.Process, port: int, taskpath: str, server: 'TaskServer') -> None:
        """
        Keep what cleanup has to give back.

        Args:
            process: The task process.
            port: The data port taken from the server's pool.
            taskpath: The task file on disk.
            server: The server whose pool the port came from.
        """
        super().__init__(process, f'127.0.0.1:{port}')
        self._port: Optional[int] = port
        self._taskpath: Optional[str] = taskpath
        self._server = server

    @property
    def returncode(self) -> Optional[int]:
        """The process exit code, or None while it runs."""
        return self.process.returncode

    async def wait(self) -> int:
        """Wait for the process to exit."""
        return await self.process.wait()

    def terminate(self) -> None:
        """Send SIGTERM to the process."""
        self.process.terminate()

    def kill(self) -> None:
        """Send SIGKILL to the process."""
        self.process.kill()

    def metrics(self) -> Dict[str, Any]:
        """CPU and memory from psutil over the process tree."""
        return {'pid': self.process.pid}

    async def cleanup(self) -> None:
        """Remove the task file and give the port back."""
        _release(self._server, self._taskpath, self._port)
        self._taskpath = None
        self._port = None


def _release(server: 'TaskServer', taskpath: Optional[str], port: Optional[int]) -> None:
    """
    Remove a task file and give a port back, ignoring what is already gone.

    Args:
        server: The server whose pool the port came from.
        taskpath: The task file, or None.
        port: The data port, or None.
    """
    if taskpath:
        try:
            os.remove(taskpath)
        except OSError:
            pass
    if port:
        server.release_port(port)


class SubprocessLauncher(Launcher):
    """Starts each task as a child process of the engine."""

    name = 'spawn'

    def __init__(self, server: 'TaskServer') -> None:
        """
        Bind to the server whose port pool the tasks use.

        Args:
            server: The task server.
        """
        self._server = server

    @property
    def task_data_path(self) -> str:
        """The engine's own data directory."""
        return CONST_TASK_DATA_PATH

    @staticmethod
    def build_args(spec: LaunchSpec, taskpath: str, port: int) -> List[str]:
        """
        The child's argv after the executable, in today's order.

        Args:
            spec: What to launch.
            taskpath: The task file on disk.
            port: The data port.

        Returns:
            The argument list.
        """
        # --autoterm: exit when parent dies (stdin closes)
        args = [CONST_AI_NODE_SCRIPT, taskpath, '--autoterm', '--monitor=app']
        args.extend(
            [
                f'--data_port={port}',
                '--data_host=127.0.0.1',
                f'--data_token_sha256={spec.token_sha256}',
            ]
        )
        if spec.hosted:
            args.append(CONST_HOSTED_CHILD_FLAG)
        if spec.modelserver:
            args.append(f'--modelserver={spec.modelserver}')
        args.extend(spec.pipeline_args)
        if spec.trace_arg:
            args.append(spec.trace_arg)
        if spec.node_path_arg:
            args.append(spec.node_path_arg)
        return args

    async def start(self, spec: LaunchSpec) -> SubprocessLaunch:
        """
        Write the task file, take a port and start the child.

        Args:
            spec: What to launch.

        Returns:
            The running task.

        Raises:
            OSError: If the file cannot be written or the process cannot start.
            RuntimeError: If the debug shim cannot be created.
        """
        os.makedirs(self.task_data_path, exist_ok=True)

        taskpath: Optional[str] = None
        port: Optional[int] = None
        try:
            taskpath = await write_task_file(spec.task_id, spec.task_file)
            exec_path = _python_shim() if spec.debug_attach else sys.executable
            port = self._server.assign_port()
            process = await asyncio.create_subprocess_exec(
                exec_path,
                *self.build_args(spec, taskpath, port),
                cwd=os.path.dirname(exec_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=CONST_SUBPROCESS_BUFFER_LIMIT,
                env=spec.env,
            )
        except BaseException:
            _release(self._server, taskpath, port)
            raise
        return SubprocessLaunch(process, port, taskpath, self._server)
