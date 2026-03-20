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

Runs agent-supplied code via RestrictedPython inside a controlled namespace with:

1. **RestrictedPython compilation** — ``compile_restricted`` transforms the AST
   to inject runtime guard calls that prevent attribute/item access escapes.

2. **Safe builtins** — RestrictedPython's ``safe_builtins`` replaces the full
   ``__builtins__``, removing dangerous functions by default.

3. **Allowlist-only ``__import__``** — a gated ``__import__`` is injected that
   only permits modules explicitly listed in ``allowed_modules``.  Everything
   else raises ``ImportError``.

4. **stdout capture** via a ``StringIO``-backed ``print()`` override.

5. **Timeout enforcement** via a daemon thread with ``thread.join(timeout)``.
"""

from __future__ import annotations

import importlib
import subprocess
import operator
import sys
import threading
import traceback
from typing import Any, Dict, Set

from RestrictedPython import compile_restricted, safe_builtins, PrintCollector
from RestrictedPython.Eval import default_guarded_getiter
from RestrictedPython.Guards import (
    full_write_guard,
    guarded_unpack_sequence,
    safer_getattr,
)

_TIMEOUT = 20
_MAX_OUTPUT = 51200  # 50 KB

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


# ── Extra builtins added on top of RestrictedPython's safe_builtins ───────
# safe_builtins is intentionally minimal (no dict, list, enumerate, etc.).
# These are non-dangerous builtins agents need for everyday data work.
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
    """
    # ── 0. Compile with RestrictedPython ───────────────────────────────
    try:
        compiled = compile_restricted(
            code,
            filename='<agent_script>',
            mode='exec',
        )
    except SyntaxError as exc:
        return {
            'stdout': '',
            'stderr': str(exc),
            'exit_code': 1,
            'timed_out': False,
        }

    # compile_restricted returns None when it encounters policy violations
    if compiled is None:
        return {
            'stdout': '',
            'stderr': 'Code blocked by RestrictedPython compilation policy.',
            'exit_code': 1,
            'timed_out': False,
        }

    allowlist = _DEFAULT_ALLOWED_MODULES | (allowed_modules or set())

    # ── 1. Build safe builtins ─────────────────────────────────────────
    # RestrictedPython's safe_builtins is very minimal — it omits common
    # data-processing builtins that agents need (dict, list, enumerate, etc.).
    # We add back the ones that are safe for sandboxed computation.
    sandbox_builtins: Dict[str, Any] = dict(safe_builtins)
    import builtins as _builtins

    for _name in _EXTRA_SAFE_BUILTINS:
        sandbox_builtins[_name] = getattr(_builtins, _name)

    # ── 2. Inject allowlist-only __import__ ────────────────────────────
    original_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

    def restricted_import(name: str, *args: Any, **kwargs: Any) -> Any:
        top_level = name.split('.')[0]
        if top_level not in allowlist:
            raise ImportError(f"Import of '{name}' is not allowed. Allowed modules: {', '.join(sorted(allowlist))}")
        try:
            return original_import(name, *args, **kwargs)
        except ModuleNotFoundError:
            # Module is allowed but not installed — auto-install via pip
            if top_level not in _DEFAULT_ALLOWED_MODULES:
                _pip_install(top_level)
                return original_import(name, *args, **kwargs)
            raise

    sandbox_builtins['__import__'] = restricted_import

    # ── 3. Execution namespace with RestrictedPython guards ──────────
    # RestrictedPython transforms print() calls to use PrintCollector.
    # After execution, the collected output is in the ``printed`` variable.
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

    # ── 5. Run in a daemon thread with timeout ─────────────────────────
    timed_out = False
    stderr = ''
    exit_code = 0

    def _run() -> None:
        nonlocal stderr, exit_code
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
        except Exception:
            stderr = traceback.format_exc()
            exit_code = 1

    effective_timeout = timeout if timeout is not None else _TIMEOUT

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    thread.join(timeout=effective_timeout)

    if thread.is_alive():
        timed_out = True
        stderr = f'[Execution timed out after {effective_timeout}s]'
        exit_code = -1

    # ── 6. Collect output ──────────────────────────────────────────────
    # RestrictedPython stores the PrintCollector instance as '_print';
    # calling it returns the collected text.
    _print_collector = sandbox_globals.get('_print')
    stdout = _truncate(_print_collector() if callable(_print_collector) else '')
    stderr = _truncate(stderr)

    result_val = sandbox_globals.get('result')
    response: Dict[str, Any] = {
        'stdout': stdout,
        'stderr': stderr,
        'exit_code': exit_code,
        'timed_out': timed_out,
    }

    if result_val is not None:
        try:
            response['result'] = result_val if isinstance(result_val, (str, int, float, bool, list, dict, type(None))) else repr(result_val)
        except Exception:
            response['result'] = repr(result_val)

    return response


def _pip_install(package: str) -> None:
    """Auto-install a package via pip. Only called for non-default allowlisted modules."""
    subprocess.check_call(
        [sys.executable, '-m', 'pip', 'install', '--quiet', package],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    # Clear the import cache so the freshly installed module is found
    importlib.invalidate_caches()


def _truncate(text: str, max_size: int = _MAX_OUTPUT) -> str:
    """Truncate output to *max_size* characters, keeping head and tail."""
    if len(text) <= max_size:
        return text
    marker = f'\n\n... [truncated — {len(text)} chars total, limit {max_size}] ...\n\n'
    half = (max_size - len(marker)) // 2
    return text[:half] + marker + text[-half:]
