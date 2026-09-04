# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Restricted Python execution sandbox.

Agent-supplied code runs in a **child process**, one per call, under
RestrictedPython. The guards themselves live in :mod:`ai.common.sandbox_worker`,
which is what the child runs; this module owns spawning it, feeding it the
request, and enforcing the deadline.

The deadline is the reason for the process boundary. ``thread.join(timeout)``
only stops *waiting* — it does not stop the script — so a timed-out script used
to keep running inside the engine for the life of the process, burning CPU and
holding everything it had allocated, while the tool reported it as killed. A
single script appending to a list grew the engine by hundreds of MB per second
after its "timeout" until the OS killed it.

Interrupting the thread instead is not a safe fix. ``PyThreadState_SetAsyncExc``
delivers its exception at an arbitrary bytecode boundary, including inside
library code that holds a lock and is not written to survive an exception
there. Under ``coverage`` that reliably deadlocks the whole interpreter: the
exception lands inside the tracer while it holds its global data lock, the
worker dies without releasing it, and every other thread blocks on the next
traced line. The engine attaches ``debugpy`` in dev mode, so the same shape of
failure is reachable in normal operation, not just under test.

Killing a process has none of those failure modes. The kernel reclaims the
script's CPU and memory whatever state the interpreter was in, and no lock
inside this process is ever touched.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, Set

from .sandbox_worker import _truncate

_TIMEOUT = 20
_MAX_OUTPUT = 51200  # 50 KB

# The child is this file's sibling, run BY PATH so that starting it does not
# import the `ai` package __init__ (which resolves dependencies) on every call.
_WORKER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sandbox_worker.py')

# ── Default allowed modules ─────────────────────────────────────────────────
# Safe, pure-computation modules with no filesystem, network, or OS access.
_DEFAULT_ALLOWED_MODULES = frozenset(
    {
        'math',
        'cmath',
        'decimal',
        'fractions',
        'statistics',
        'random',
        'string',
        'textwrap',
        're',
        'json',
        'csv',
        'collections',
        'itertools',
        'functools',
        'operator',
        'copy',
        'dataclasses',
        'enum',
        'typing',
        'datetime',
        'time',
        'calendar',
        'base64',
        'hashlib',
        'hmac',
        'struct',
        'difflib',
        'pprint',
        'bisect',
        'heapq',
        'array',
        'numbers',
        'unicodedata',
    }
)


def execute_sandboxed(
    code: str,
    *,
    allowed_modules: Set[str] | None = None,
    timeout: int | None = None,
) -> Dict[str, Any]:
    """Run *code* in a RestrictedPython sandbox and return the result.

    Returns a dict with ``stdout``, ``stderr``, ``exit_code``, ``timed_out``,
    and ``result`` (the value of a variable named ``result`` if set by the
    code).

    *allowed_modules*, if provided, is merged with ``_DEFAULT_ALLOWED_MODULES``
    to form the full allowlist.  Only modules in this set can be imported.

    The script runs in a child process which is killed if it overruns
    *timeout*. A killed child produces no output, so ``stdout`` is empty on
    the timeout path — the script's prints die with it.
    """
    allowlist = _DEFAULT_ALLOWED_MODULES | (allowed_modules or set())
    effective_timeout = timeout if timeout is not None else _TIMEOUT

    request = json.dumps(
        {
            'code': code,
            'allowed_modules': sorted(allowlist),
            'max_output': _MAX_OUTPUT,
        }
    )

    try:
        completed = subprocess.run(
            [sys.executable, _WORKER_PATH],
            input=request,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
        )
    except subprocess.TimeoutExpired:
        # subprocess.run has already killed the child and reaped it. Whatever
        # the script allocated goes with the process.
        return {
            'stdout': '',
            'stderr': f'[Execution timed out after {effective_timeout}s]',
            'exit_code': -1,
            'timed_out': True,
        }
    except Exception as exc:  # noqa: BLE001 - spawning is the caller's problem to see
        return {
            'stdout': '',
            'stderr': f'[Sandbox could not start: {exc!r}]',
            'exit_code': 1,
            'timed_out': False,
        }

    try:
        response = json.loads(completed.stdout)
        if not isinstance(response, dict):
            # Valid JSON of the wrong shape. Subscripting it below would raise
            # TypeError out of a function whose contract is to return a result.
            raise ValueError(f'worker response was {type(response).__name__}, expected an object')
    except (TypeError, ValueError):
        # The child died before answering, or answered with something that is
        # not a response. Its stderr is the only evidence of why.
        detail = (completed.stderr or '').strip() or 'no output'
        return {
            'stdout': '',
            'stderr': f'[Sandbox worker exited {completed.returncode} without a result: {_truncate(detail, _MAX_OUTPUT)}]',
            'exit_code': 1,
            'timed_out': False,
        }

    response['timed_out'] = False
    response.setdefault('stdout', '')
    response.setdefault('stderr', '')
    response.setdefault('exit_code', 0)
    return response
