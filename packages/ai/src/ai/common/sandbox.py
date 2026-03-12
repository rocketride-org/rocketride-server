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

Runs agent-supplied code via ``exec()`` inside a controlled namespace with:

1. **Restricted builtins** — only safe, pure-computation builtins are exposed.
   Dangerous functions (``open``, ``eval``, ``exec``, ``compile``,
   ``__import__``, ``globals``, ``locals``, ``breakpoint``, ``exit``,
   ``quit``, ``input``, ``getattr``, ``setattr``, ``delattr``) are removed.

2. **Allowlist-only ``__import__``** — a gated ``__import__`` is injected that
   only permits modules explicitly listed in ``allowed_modules``.  Everything
   else raises ``ImportError``.

3. **stdout capture** via a ``StringIO``-backed ``print()`` override.

4. **Timeout enforcement** via a daemon thread with ``thread.join(timeout)``.
"""

from __future__ import annotations

import ast
import builtins
import importlib
import io
import subprocess
import sys
import threading
import traceback
from typing import Any, Dict, List, Set

_TIMEOUT = 20
_MAX_OUTPUT = 51200  # 50 KB

# ── Builtins that are NOT exposed to sandboxed code ──────────────────────────
#
# These fall into a few categories:
#   - Sandbox escape:  eval, exec, compile, __import__
#   - File / OS access: open
#   - Host introspection: globals, locals, vars, dir, breakpoint
#   - Attribute manipulation: getattr, setattr, delattr (prevents reaching
#     into objects to pull out references to blocked functionality)
#   - Interactive / process control: input, exit, quit
#   - Low-level: memoryview, classmethod
# ── Dunder attributes blocked in AST validation ─────────────────────────────
# These prevent object-graph walks like:
#   ().__class__.__mro__[1].__subclasses__()
# which can recover subprocess.Popen, os._wrap_close, etc. from the CPython
# class hierarchy without using any blocked builtins.
_BLOCKED_DUNDERS = frozenset({
    '__subclasses__',
    '__mro__',
    '__bases__',
    '__base__',
    '__class__',
    '__dict__',
    '__globals__',
    '__code__',
    '__func__',
    '__self__',
    '__module__',
    '__import__',
    '__spec__',
    '__loader__',
    '__builtins__',
    '__qualname__',
    '__reduce__',
    '__reduce_ex__',
    '__getattr__',
    '__setattr__',
    '__delattr__',
    '__init_subclass__',
    '__set_name__',
    '__class_getitem__',
    '__instancecheck__',
    '__subclasscheck__',
    '__subclasshook__',
    '__del__',
    '__weakref__',
})


class SandboxValidationError(Exception):
    """Raised when sandboxed code fails AST validation."""


def _validate_ast(code: str) -> None:
    """Parse *code* and reject access to dangerous dunder attributes.

    Raises ``SandboxValidationError`` if the code accesses any attribute in
    ``_BLOCKED_DUNDERS``, or ``SyntaxError`` if the code can't be parsed.
    """
    tree = ast.parse(code, filename='<agent_script>')
    violations: List[str] = []

    for node in ast.walk(tree):
        # obj.__subclasses__  /  obj.__mro__  etc.
        if isinstance(node, ast.Attribute) and node.attr in _BLOCKED_DUNDERS:
            violations.append(
                f'line {node.lineno}: access to "{node.attr}" is not allowed'
            )
        # Catch string-based access: something["__subclasses__"]
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            if isinstance(node.slice.value, str) and node.slice.value in _BLOCKED_DUNDERS:
                violations.append(
                    f'line {node.lineno}: access to "{node.slice.value}" via subscript is not allowed'
                )

    if violations:
        raise SandboxValidationError(
            'Code blocked by sandbox AST validation:\n' + '\n'.join(violations)
        )


_REMOVED_BUILTINS = frozenset({
    'open',
    'eval',
    'exec',
    'compile',
    'globals',
    'locals',
    'vars',
    'dir',
    'breakpoint',
    'exit',
    'quit',
    'input',
    'getattr',
    'setattr',
    'delattr',
    '__import__',
    'memoryview',
    'classmethod',
})

# ── Default allowed modules ─────────────────────────────────────────────────
# Safe, pure-computation modules with no filesystem, network, or OS access.
_DEFAULT_ALLOWED_MODULES = frozenset({
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
})


def execute_sandboxed(
    code: str,
    *,
    allowed_modules: Set[str] | None = None,
) -> Dict[str, Any]:
    """Run *code* in a restricted ``exec()`` sandbox and return the result.

    Returns a dict with ``stdout``, ``stderr``, ``exit_code``, ``timed_out``,
    and ``result`` (the value of a variable named ``result`` if set by the
    code).

    *allowed_modules*, if provided, is merged with ``_DEFAULT_ALLOWED_MODULES``
    to form the full allowlist.  Only modules in this set can be imported.
    """
    # ── 0. AST validation — reject dunder attribute access ────────────────
    try:
        _validate_ast(code)
    except (SandboxValidationError, SyntaxError) as exc:
        return {
            'stdout': '',
            'stderr': str(exc),
            'exit_code': 1,
            'timed_out': False,
        }

    allowlist = _DEFAULT_ALLOWED_MODULES | (allowed_modules or set())

    # ── 1. Build builtins with dangerous names removed ───────────────────
    safe_builtins: Dict[str, Any] = {
        k: v for k, v in vars(builtins).items()
        if k not in _REMOVED_BUILTINS
    }

    # ── 2. Inject allowlist-only __import__ ──────────────────────────────
    original_import = builtins.__import__

    def restricted_import(name: str, *args: Any, **kwargs: Any) -> Any:
        top_level = name.split('.')[0]
        if top_level not in allowlist:
            raise ImportError(
                f"Import of '{name}' is not allowed. "
                f"Allowed modules: {', '.join(sorted(allowlist))}"
            )
        try:
            return original_import(name, *args, **kwargs)
        except ModuleNotFoundError:
            # Module is allowed but not installed — auto-install via pip
            if top_level not in _DEFAULT_ALLOWED_MODULES:
                _pip_install(top_level)
                return original_import(name, *args, **kwargs)
            raise

    safe_builtins['__import__'] = restricted_import

    # ── 3. Capture stdout via print() override ───────────────────────────
    captured_stdout = io.StringIO()

    def _sandbox_print(*args: Any, sep: str = ' ', end: str = '\n', **kwargs: Any) -> None:
        text = sep.join(str(a) for a in args) + end
        captured_stdout.write(text)

    safe_builtins['print'] = _sandbox_print

    # ── 4. Execution namespace ───────────────────────────────────────────
    sandbox_globals: Dict[str, Any] = {'__builtins__': safe_builtins}

    # ── 5. Run in a daemon thread with timeout ───────────────────────────
    timed_out = False
    stderr = ''
    exit_code = 0

    def _run() -> None:
        nonlocal stderr, exit_code
        try:
            exec(compile(code, '<agent_script>', 'exec'), sandbox_globals)  # noqa: S102
        except SystemExit as e:
            exit_code = int(e.code) if e.code is not None else 0
        except Exception:
            stderr = traceback.format_exc()
            exit_code = 1

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    thread.join(timeout=_TIMEOUT)

    if thread.is_alive():
        timed_out = True
        stderr = f'[Execution timed out after {_TIMEOUT}s]'
        exit_code = -1

    # ── 6. Collect output ────────────────────────────────────────────────
    stdout = _truncate(captured_stdout.getvalue())
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
            response['result'] = (
                result_val
                if isinstance(result_val, (str, int, float, bool, list, dict, type(None)))
                else repr(result_val)
            )
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
    half = max_size // 2
    return (
        text[:half]
        + f'\n\n... [truncated — {len(text)} chars total, limit {max_size}] ...\n\n'
        + text[-half:]
    )
