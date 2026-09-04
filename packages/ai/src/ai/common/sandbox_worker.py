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
Child process that executes one RestrictedPython script and exits.

Run by :func:`ai.common.sandbox.execute_sandboxed` as::

    <sys.executable> <path to this file>

with a JSON request on stdin and a JSON response on stdout. It is deliberately
invoked **by path rather than by module name**, so importing it does not pull
in the ``ai`` package ``__init__`` (which resolves dependencies) on a hot path.
For the same reason nothing here imports from ``ai``: the request carries the
fully-resolved allowlist, so this module needs no configuration of its own.

Why a child process at all: the timeout has to be able to stop a runaway
script, and there is no safe way to interrupt a thread from outside. Injecting
an asynchronous exception (``PyThreadState_SetAsyncExc``) lands at an arbitrary
bytecode boundary, including inside library code holding a lock and not written
to survive an exception there — which deadlocks the interpreter for every
thread. Killing a process has none of those failure modes and reclaims the
script's CPU and memory unconditionally.

Protocol
--------
Request (stdin, one JSON object)::

    {'code': '<source>', 'allowed_modules': ['math', ...], 'max_output': 51200}

Response (stdout, one JSON object)::

    {"stdout": "...", "stderr": "...", "exit_code": 0, "result": <optional>}

``timed_out`` is not part of the response: only the parent can observe a
timeout, because a timed-out child never gets to answer.
"""

from __future__ import annotations

import importlib
import io
import json
import operator
import subprocess
import sys
import warnings
from typing import Any, Dict, Set

from RestrictedPython import PrintCollector, compile_restricted, safe_builtins
from RestrictedPython.Eval import default_guarded_getiter
from RestrictedPython.Guards import (
    full_write_guard,
    guarded_unpack_sequence,
    safer_getattr,
)

# Modules that ship with the interpreter and are never pip-installed. Used only
# to decide whether an ImportError is worth an install attempt; the authoritative
# allowlist arrives in the request.
_STDLIB_NEVER_INSTALL = frozenset(
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

# Builtins added on top of RestrictedPython's deliberately minimal safe_builtins
# (which omits dict, list, enumerate, ...) — everyday data-work names that carry
# no capability of their own.
_EXTRA_SAFE_BUILTINS = frozenset(
    {
        'all',
        'any',
        'ascii',
        'bin',
        'bytearray',
        'dict',
        'enumerate',
        'filter',
        'format',
        'frozenset',
        'hasattr',
        'iter',
        'list',
        'map',
        'max',
        'min',
        'next',
        'object',
        'print',
        'reversed',
        'set',
        'sum',
        'super',
        'type',
    }
)

_INPLACE_OPS = {
    '+=': operator.iadd,
    '-=': operator.isub,
    '*=': operator.imul,
    '/=': operator.itruediv,
    '%=': operator.imod,
    '**=': operator.ipow,
    '<<=': operator.ilshift,
    '>>=': operator.irshift,
    '|=': operator.ior,
    '^=': operator.ixor,
    '&=': operator.iand,
    '//=': operator.ifloordiv,
    '@=': operator.imatmul,
}


def _guarded_getitem(obj: Any, key: Any) -> Any:
    """Allow subscript access — RestrictedPython requires this guard."""
    return obj[key]


def _pip_install(package: str) -> None:
    """Auto-install a package via pip. Only for allowlisted non-stdlib modules."""
    # capture_output + run, not check_call with a bare PIPE: check_call never
    # reads the pipe, so an install chatty enough to fill the buffer would
    # block forever instead of failing.
    subprocess.run(
        [sys.executable, '-m', 'pip', 'install', '--quiet', package],
        capture_output=True,
        timeout=60,
        check=True,
    )
    importlib.invalidate_caches()


def _truncate(text: str, max_size: int) -> str:
    """Truncate output to *max_size* characters, keeping head and tail."""
    if len(text) <= max_size:
        return text
    marker = f'\n\n... [truncated — {len(text)} chars total, limit {max_size}] ...\n\n'
    half = (max_size - len(marker)) // 2
    return text[:half] + marker + text[-half:]


def run_restricted(code: str, allowlist: Set[str], max_output: int) -> Dict[str, Any]:
    """Compile and run *code* under RestrictedPython, returning the result dict.

    Synchronous and single-threaded: enforcing the deadline is the parent's
    job, and it does it by killing this process.
    """
    # ── Compile ────────────────────────────────────────────────────────
    try:
        # compile_restricted emits a SyntaxWarning ("Prints, but never reads
        # 'printed' variable") for ANY code that prints without reading the
        # collector variable. Stdout is collected via PrintCollector below, so
        # the hint is meaningless noise for every sandboxed script — suppress
        # exactly that message; any OTHER SyntaxWarning still surfaces.
        with warnings.catch_warnings():
            warnings.filterwarnings(
                'ignore', category=SyntaxWarning, message=r".*Prints, but never reads 'printed' variable"
            )
            compiled = compile_restricted(code, filename='<agent_script>', mode='exec')
    except SyntaxError as exc:
        return {'stdout': '', 'stderr': str(exc), 'exit_code': 1}

    # compile_restricted returns None when it encounters policy violations
    if compiled is None:
        return {
            'stdout': '',
            'stderr': 'Code blocked by RestrictedPython compilation policy.',
            'exit_code': 1,
        }

    # ── Safe builtins ──────────────────────────────────────────────────
    import builtins as _builtins

    sandbox_builtins: Dict[str, Any] = dict(safe_builtins)
    for _name in _EXTRA_SAFE_BUILTINS:
        sandbox_builtins[_name] = getattr(_builtins, _name)

    original_import = _builtins.__import__

    def restricted_import(name: str, *args: Any, **kwargs: Any) -> Any:
        top_level = name.split('.')[0]
        if top_level not in allowlist:
            raise ImportError(f"Import of '{name}' is not allowed. Allowed modules: {', '.join(sorted(allowlist))}")
        try:
            return original_import(name, *args, **kwargs)
        except ModuleNotFoundError:
            # Allowed but not installed — install it, then retry once.
            if top_level not in _STDLIB_NEVER_INSTALL:
                _pip_install(top_level)
                return original_import(name, *args, **kwargs)
            raise

    sandbox_builtins['__import__'] = restricted_import

    # ── Execution namespace with RestrictedPython guards ───────────────
    sandbox_globals: Dict[str, Any] = {
        '__builtins__': sandbox_builtins,
        '_getattr_': safer_getattr,
        '_getitem_': _guarded_getitem,
        '_getiter_': default_guarded_getiter,
        '_iter_unpack_sequence_': guarded_unpack_sequence,
        '_write_': full_write_guard,
        '_inplacevar_': lambda op, x, y: _INPLACE_OPS[op](x, y),
        '_print_': PrintCollector,
        '_unpack_sequence_': guarded_unpack_sequence,
        '__metaclass__': type,
        '__name__': '<agent_script>',
    }

    # ── Run ────────────────────────────────────────────────────────────
    stderr = ''
    exit_code = 0

    # Real stdout is the response channel. Anything the script writes to it
    # directly (an allowlisted module, say) would corrupt the JSON, so it is
    # swapped for a buffer and folded into the reported stdout instead.
    stray = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = stray
    try:
        exec(compiled, sandbox_globals)  # noqa: S102
    except SystemExit as e:
        if e.code is None:
            exit_code = 0
        elif isinstance(e.code, int):
            exit_code = e.code
        else:
            stderr = f'SystemExit: {e.code}'
            exit_code = 1
    except BaseException:  # noqa: BLE001 - the script's failure is data, not ours
        import traceback

        stderr = traceback.format_exc()
        exit_code = 1
    finally:
        sys.stdout = real_stdout

    # RestrictedPython stores the PrintCollector instance as '_print'; calling
    # it returns the collected text.
    collector = sandbox_globals.get('_print')
    printed = collector() if callable(collector) else ''
    stdout = printed + stray.getvalue()

    response: Dict[str, Any] = {
        'stdout': _truncate(stdout, max_output),
        'stderr': _truncate(stderr, max_output),
        'exit_code': exit_code,
    }

    result_val = sandbox_globals.get('result')
    if result_val is not None:
        try:
            response['result'] = (
                result_val
                if isinstance(result_val, (str, int, float, bool, list, dict, type(None)))
                else repr(result_val)
            )
        except Exception:
            response['result'] = repr(result_val)

        # The result travels as JSON. A container of exotic objects survives the
        # isinstance check above but not serialisation, so fall back to repr
        # rather than letting the whole response fail to encode.
        try:
            json.dumps(response['result'])
        except (TypeError, ValueError):
            response['result'] = repr(result_val)

    return response


def main() -> int:
    """Read one request from stdin, run it, write one response to stdout."""
    try:
        request = json.loads(sys.stdin.read() or '{}')
        code = request.get('code') or ''
        allowlist = set(request.get('allowed_modules') or [])
        max_output = int(request.get('max_output') or 51200)
        response = run_restricted(code, allowlist, max_output)
    except Exception as exc:  # noqa: BLE001 - report, never traceback onto stdout
        response = {
            'stdout': '',
            'stderr': f'sandbox worker failed: {exc!r}',
            'exit_code': 1,
        }

    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
