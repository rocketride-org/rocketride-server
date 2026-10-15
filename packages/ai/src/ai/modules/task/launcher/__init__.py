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
How a task is started: the ``Launcher`` seam and its runtimes.

``--runtime`` on ``eaas.py`` picks one; without it a hosted (``--saas``)
engine runs docker and any other spawn. ``TaskServer`` keeps a single
launcher per runtime and every ``Task`` of the process uses it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Launch, Launcher, LaunchSpec
from .subprocess import CONST_HOSTED_CHILD_FLAG, SubprocessLauncher

if TYPE_CHECKING:
    from ..task_server import TaskServer

# The runtimes --runtime accepts
RUNTIMES = ('spawn', 'docker')

__all__ = [
    'CONST_HOSTED_CHILD_FLAG',
    'RUNTIMES',
    'Launch',
    'LaunchSpec',
    'Launcher',
    'SubprocessLauncher',
    'create_launcher',
    'default_runtime',
]


def default_runtime(hosted: bool) -> str:
    """
    The runtime when ``--runtime`` is not given.

    A hosted (``--saas``) engine runs every task in a container; any other
    engine keeps spawn (decided by Alexandru, 2026-10-07).

    Args:
        hosted: The engine runs with ``--saas``.

    Returns:
        ``'docker'`` or ``'spawn'``.
    """
    return 'docker' if hosted else 'spawn'


def create_launcher(runtime: str, server: 'TaskServer') -> Launcher:
    """
    Build the launcher for a runtime.

    Args:
        runtime: A name from ``RUNTIMES``; empty means spawn.
        server: The task server the launcher serves.

    Returns:
        The launcher.

    Raises:
        ValueError: If the runtime is unknown.
    """
    if not runtime or runtime == 'spawn':
        return SubprocessLauncher(server)
    if runtime == 'docker':
        from .docker import DockerLauncher

        return DockerLauncher(server)
    raise ValueError(f'Unknown runtime {runtime!r}; expected one of {", ".join(RUNTIMES)}')
