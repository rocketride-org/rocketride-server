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
How the engine started this task: the flags on its command line.

``--hosted``: the task belongs to a hosted engine. Its rules hold wherever the
task runs: a credit check before every pipe.

``--shared-host``: the guards for a shared machine apply: the sandbox keeps to
its default modules, ``tool_python`` ignores ``allowed_modules``, stdio MCP is
refused. A hosted engine gives it to every task, whatever the runtime (see
``TaskEngine._shares_host`` in ai.modules.task.task_engine).

``--modelserver=<address>``: GPU inference is delegated to a model server, so
this task neither installs nor imports torch and the other tensor runtimes
(``ai.common.models.gpu_guard``, ``ai/common/torch/_depends_hooks.py``). This
is the only flag that keeps torch off a task; a hosted engine without a model
server loads it itself.

The engine passes them as it starts the task (ai.modules.task.launcher). A pipeline's own
args can add one, which only makes the task stricter. Standard library only: nodes and ``_depends_hooks.py`` files import this,
and importing ``ai`` or ``ai.common`` would run ``depends()``.
"""

import sys
from typing import Optional

HOSTED_FLAG = '--hosted'
SHARED_HOST_FLAG = '--shared-host'
MODEL_SERVER_FLAG = '--modelserver='


def is_hosted() -> bool:
    """True when this task belongs to a hosted engine."""
    return HOSTED_FLAG in sys.argv


def is_shared_host() -> bool:
    """True when the guards for a shared host apply to this task."""
    return SHARED_HOST_FLAG in sys.argv


def model_server_address() -> Optional[str]:
    """
    The address after ``--modelserver=``, exactly as given; None when absent or empty.

    The first occurrence wins. No parsing and no protocol prefixing: the client
    SDK normalises the URI (ws vs wss, default ports).
    """
    for arg in sys.argv:
        if arg.startswith(MODEL_SERVER_FLAG):
            value = arg[len(MODEL_SERVER_FLAG) :]
            return value if value else None
    return None


def delegates_to_model_server() -> bool:
    """True when this task runs its GPU inference on a model server (``--modelserver=<address>``)."""
    return model_server_address() is not None
