# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Expression evaluator for flow driver conditions.

Phase 1 MVP: AST-gated `eval()` with a minimal, audited set of builtins
and no `__import__`. User expressions get bindings for:

- `cond.*` — the condition helpers in `flow_base.cond`
- `state`  — the `PerChunkState` for this invocation
- payload names supplied by the driver (typically `text`)

Phase 2 follow-up: swap this for the shared `execute_sandboxed`
RestrictedPython sandbox (same as `tool_python`) once we expose a
clean bindings-injection mechanism. The swap is isolated to this
module; drivers consume `evaluate_expression` and are unaffected.
"""

from __future__ import annotations

import ast
from typing import Any, Mapping

# ---------------------------------------------------------------------
# Audited safe builtins. Deliberately small — this is condition-
# evaluation scope, not general script execution. Anything else the
# user needs should be exposed via `cond.*` helpers.
# ---------------------------------------------------------------------
_SAFE_BUILTINS: dict[str, Any] = {
    'abs': abs,
    'all': all,
    'any': any,
    'bool': bool,
    'dict': dict,
    'enumerate': enumerate,
    'filter': filter,
    'float': float,
    'int': int,
    'len': len,
    'list': list,
    'map': map,
    'max': max,
    'min': min,
    'range': range,
    'round': round,
    'set': set,
    'sorted': sorted,
    'str': str,
    'sum': sum,
    'tuple': tuple,
    'zip': zip,
    'True': True,
    'False': False,
    'None': None,
}

# ---------------------------------------------------------------------
# AST node allowlist. Rejects anything that can escape: imports,
# function/class definitions, comprehensions with arbitrary attribute
# access, name bindings, etc.
# ---------------------------------------------------------------------
_FORBIDDEN_NODES: tuple[type, ...] = (
    ast.Import,
    ast.ImportFrom,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Global,
    ast.Nonlocal,
    ast.Delete,
    ast.Assign,
    ast.AugAssign,
    ast.AnnAssign,
    ast.With,
    ast.AsyncWith,
    ast.Try,
    ast.Raise,
    ast.Lambda,
    ast.Yield,
    ast.YieldFrom,
    ast.Await,
)


class SandboxError(RuntimeError):
    """Raised when an expression cannot be compiled or evaluated safely."""


def evaluate_expression(
    expression: str,
    bindings: Mapping[str, Any],
) -> Any:
    """Evaluate `expression` in a restricted namespace.

    `bindings` are injected as globals alongside `_SAFE_BUILTINS`. The
    expression must be a single expression (no statements); syntax is
    standard Python except imports, assignments, and other state-
    changing constructs are rejected at parse time.

    Callers that need fail-closed behavior (e.g. condition evaluation
    defaulting to `False`) should catch `SandboxError` explicitly.
    """
    if not isinstance(expression, str) or not expression.strip():
        raise SandboxError('expression must be a non-empty string')

    try:
        tree = ast.parse(expression, mode='eval')
    except SyntaxError as exc:
        raise SandboxError(f'invalid syntax: {exc}') from exc

    for node in ast.walk(tree):
        if isinstance(node, _FORBIDDEN_NODES):
            raise SandboxError(f'{type(node).__name__} is not allowed in flow conditions')
        # Block attribute access to dunder names — prevents __class__,
        # __globals__, __builtins__ escapes on bound objects.
        if isinstance(node, ast.Attribute) and node.attr.startswith('_'):
            raise SandboxError(f'access to dunder attribute {node.attr!r} is not allowed')

    compiled = compile(tree, filename='<flow_expression>', mode='eval')

    namespace: dict[str, Any] = {'__builtins__': _SAFE_BUILTINS}
    namespace.update(bindings)

    try:
        return eval(compiled, namespace, {})  # noqa: S307 — AST-gated
    except Exception as exc:
        raise SandboxError(f'evaluation failed: {exc}') from exc
