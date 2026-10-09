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
The Launcher seam: how a task process is started, reached, stopped and measured.

``Task`` builds a ``LaunchSpec`` and calls ``Launcher.start``; everything that
differs between runtimes (a local subprocess, a container) stays behind it.
The ``Launch`` it returns behaves like ``asyncio.subprocess.Process`` for what
``Task`` uses, so the stdio reader and the exit-code bookkeeping do not change.
"""

from __future__ import annotations

import abc
import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class LaunchSpec:
    """Everything a runtime needs to start one task; the runtime decides how."""

    # The task's id, for names and labels
    task_id: str
    # The resolved task file; secrets are in it, so it is never logged
    task_file: bytes
    # SHA-256 of the run's /task/data token (the token itself never leaves Task)
    token_sha256: str
    # The task's environment, already filtered by the allowlist
    env: Dict[str, str]
    # Engine args from the pipeline, appended after the runtime's own
    pipeline_args: List[str] = field(default_factory=list)
    # The model server address EAS was started with, if any
    modelserver: Optional[str] = None
    # The engine is hosted (--saas): the subprocess runtime passes --hosted
    hosted: bool = False
    # An inherited --trace=... when the pipeline set none
    trace_arg: Optional[str] = None
    # An inherited --node_path=... when the pipeline set none
    node_path_arg: Optional[str] = None
    # Attach the VS Code debugger to the task (subprocess runtime only)
    debug_attach: bool = False
    # Resource limits the pipeline asks for (none yet: runtime defaults apply)
    limits: Dict[str, Any] = field(default_factory=dict)


class Launch(abc.ABC):
    """One started task, shaped like ``asyncio.subprocess.Process``.

    ``process`` is a real ``asyncio.subprocess.Process`` whose stdout, stderr
    and stdin are the task's own; ``address`` is where its ``/task/data``
    listens. ``returncode``, ``wait``, ``terminate`` and ``kill`` speak for the
    task itself, which for a container is not the process that carries its
    stdio.
    """

    def __init__(self, process: asyncio.subprocess.Process, address: str) -> None:
        """Keep the stdio-carrying process and the data address.

        Args:
            process: The process whose stdio is the task's.
            address: ``host:port`` of the task's ``/task/data``.
        """
        self.process = process
        self.address = address

    @property
    def pid(self) -> Optional[int]:
        """The pid of the stdio-carrying process, for log lines."""
        return self.process.pid

    @property
    @abc.abstractmethod
    def returncode(self) -> Optional[int]:
        """The task's exit code, or None while it runs."""

    @abc.abstractmethod
    async def wait(self) -> int:
        """Wait for the task to exit and return its exit code."""

    @abc.abstractmethod
    def terminate(self) -> None:
        """Ask the task to stop (SIGTERM)."""

    @abc.abstractmethod
    def kill(self) -> None:
        """Stop the task now (SIGKILL)."""

    @abc.abstractmethod
    def metrics(self) -> Dict[str, Any]:
        """Keyword arguments telling ``TaskMetrics`` where CPU and memory come from."""

    @abc.abstractmethod
    async def cleanup(self) -> None:
        """Release what the launch holds; safe to call more than once."""


class Launcher(abc.ABC):
    """Starts tasks for one runtime; one instance serves every Task of a process."""

    # The runtime's name, as given to --runtime
    name: str = ''

    @property
    @abc.abstractmethod
    def task_data_path(self) -> str:
        """The engine's data directory as the task sees it (``paths.base`` in the task file)."""

    @abc.abstractmethod
    async def start(self, spec: LaunchSpec) -> Launch:
        """Start a task; on any failure release what was taken and raise."""
