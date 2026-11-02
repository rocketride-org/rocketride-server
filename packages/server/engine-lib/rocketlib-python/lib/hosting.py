# =============================================================================
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
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
How a hosted engine started this task: the two flags on its command line.

``--hosted``: the task belongs to a hosted engine. Its rules hold wherever the
task runs: a credit check before every pipe, no torch install or import.

``--shared-host``: the task runs on the engine's own host (spawn), so the
guards for a shared machine apply: the sandbox keeps to its default modules,
``tool_python`` ignores ``allowed_modules``, stdio MCP is refused.

The engine passes them as it starts the task (task_engine). A pipeline's own
args can add one, which only makes the task stricter. Standard library only: nodes and ``_depends_hooks.py`` files import this,
and importing ``ai`` or ``ai.common`` would run ``depends()``.
"""

import sys

HOSTED_FLAG = '--hosted'
SHARED_HOST_FLAG = '--shared-host'


def is_hosted() -> bool:
    """True when this task belongs to a hosted engine."""
    return HOSTED_FLAG in sys.argv


def is_shared_host() -> bool:
    """True when this task shares its host with the engine."""
    return SHARED_HOST_FLAG in sys.argv
