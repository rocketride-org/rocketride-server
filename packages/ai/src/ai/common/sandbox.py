# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
   else raises ``ImportError``.  Auto-install via pip has been removed (F-01).

4. **stdout capture** via a ``StringIO``-backed ``print()`` override.

5. **Timeout enforcement** via ``multiprocessing.Process`` with
   ``process.terminate()`` / ``process.kill()`` so timed-out scripts are
   actually killed rather than left running (F-09).
"""

from __future__ import annotations

import multiprocessing
import operator
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
# To add a module, pre-install it in the container image and add it here.
# Do NOT add modules at runtime — all allowed modules must be present at
# container build time (pip auto-install removed, see F-01).
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


# ── Module-level worker function (must be top-level for pickling) ──────────

def _sandbox_worker(code: str, allowlist: frozenset, result_queue: multiprocessing.Queue) -> None:
    """
    Worker function executed in a child process.

    Compiles and executes *code* inside a RestrictedPython sandbox, then
    puts the result dict into *result_queue*.  Runs in an isolated process
    so that ``process.terminate()`` can forcibly kill it on timeout.
    """
    import builtins as _builtins
    import traceback as _traceback

    # ── Compile ────────────────────────────────────────────────────────────
    try:
        compiled = compile_restricted(code, filename='<agent_script>', mode='exec')
    except SyntaxError as exc:
        result_queue.put({'stdout': '', 'stderr': str(exc), 'exit_code': 1, 'timed_out': False})
        return

    if compiled is None:
        result_queue.put({
            'stdout': '',
            'stderr': 'Code blocked by RestrictedPython compilation policy.',
            'exit_code': 1,
            'timed_out': False,
        })
        return

    # ── Build safe builtins ────────────────────────────────────────────────
    sandbox_builtins: Dict[str, Any] = dict(safe_builtins)
    for _name in _EXTRA_SAFE_BUILTINS:
        sandbox_builtins[_name] = getattr(_builtins, _name)

    # ── Allowlist-only __import__ — NO auto-install (F-01 fix) ────────────
    original_import = _builtins.__import__

    def restricted_import(name: str, *args: Any, **kwargs: Any) -> Any:
        top_level = name.split('.')[0]
        if top_level not in allowlist:
            raise ImportError(
                f"Import of '{name}' is not allowed in the sandbox. "
                f"Allowed modules: {', '.join(sorted(allowlist))}. "
                f"To add a module, it must be pre-installed in the server image and "
                f"added to the operator's allowedModules configuration."
            )
        # Module must already be installed — no runtime pip install.
        return original_import(name, *args, **kwargs)

    sandbox_builtins['__import__'] = restricted_import

    # ── Execution namespace ────────────────────────────────────────────────
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

    stderr = ''
    exit_code = 0

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
        stderr = _traceback.format_exc()
        exit_code = 1

    _print_collector = sandbox_globals.get('_print')
    stdout = _print_collector() if callable(_print_collector) else ''

    result_val = sandbox_globals.get('result')
    response: Dict[str, Any] = {
        'stdout': _truncate(stdout),
        'stderr': _truncate(stderr),
        'exit_code': exit_code,
        'timed_out': False,
    }

    if result_val is not None:
        try:
            response['result'] = (
                result_val
                if isinstance(result_val, (str, int, float, bool, list, dict, type(None)))
                else repr(result_val)
            )
        except Exception:
            response['result'] = repr(result_val)

    result_queue.put(response)


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

    All allowed modules must be pre-installed in the container image.
    Runtime pip installation has been removed (security fix F-01).

    Execution runs in a child *process* (not a thread) so that timed-out
    scripts can be forcibly terminated (security fix F-09).
    """
    allowlist = _DEFAULT_ALLOWED_MODULES | (allowed_modules or set())
    effective_timeout = timeout if timeout is not None else _TIMEOUT

    # Use a multiprocessing Queue to receive the result from the child process.
    result_queue: multiprocessing.Queue = multiprocessing.Queue()

    proc = multiprocessing.Process(
        target=_sandbox_worker,
        args=(code, allowlist, result_queue),
        daemon=True,
    )
    proc.start()
    proc.join(timeout=effective_timeout)

    if proc.is_alive():
        # Timed out — forcibly kill the child process (F-09 fix).
        proc.terminate()
        proc.join(timeout=2)
        if proc.is_alive():
            proc.kill()
            proc.join(timeout=1)
        return {
            'stdout': '',
            'stderr': f'[Execution timed out after {effective_timeout}s]',
            'exit_code': -1,
            'timed_out': True,
        }

    if result_queue.empty():
        return {
            'stdout': '',
            'stderr': '[Sandbox process exited without producing a result]',
            'exit_code': proc.exitcode if proc.exitcode is not None else -1,
            'timed_out': False,
        }

    return result_queue.get_nowait()


def _truncate(text: str, max_size: int = _MAX_OUTPUT) -> str:
    """Truncate output to *max_size* characters, keeping head and tail."""
    if len(text) <= max_size:
        return text
    marker = f'\n\n... [truncated — {len(text)} chars total, limit {max_size}] ...\n\n'
    half = (max_size - len(marker)) // 2
    return text[:half] + marker + text[-half:]
