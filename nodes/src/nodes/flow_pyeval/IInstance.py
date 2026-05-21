# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.pyeval per-pipeline instance.

`checkCondition` parses the condition with ``ast.parse(mode='eval')``
and evaluates it under restricted builtins; user expressions reference
the active lane's payload by name (`text`, `image`, `obj`, ...).
"""

from __future__ import annotations

import ast
from typing import Any

from rocketlib import error, warning

from ..flow_base import FlowBaseIInstance
from .IGlobal import IGlobal


# Audited builtins available inside the sandbox. Anything not listed
# (including __import__, eval, exec, open) is unreachable.
_SAFE_BUILTINS: dict = {
    'abs': abs,
    'all': all,
    'any': any,
    'bool': bool,
    'bytes': bytes,
    'dict': dict,
    'enumerate': enumerate,
    'filter': filter,
    'float': float,
    'int': int,
    'isinstance': isinstance,
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


# AST nodes that mutate state, import, or escape the sandbox — rejected before compile.
_FORBIDDEN_NODES: tuple = (
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


class IInstance(FlowBaseIInstance):
    """Routing flow with sandboxed Python condition evaluation."""

    IGlobal: IGlobal

    def checkCondition(self, condition: str, **kwargs: Any) -> bool:
        """Evaluate ``condition`` against the active payload; fail-closed to ELSE."""
        if not isinstance(condition, str) or not condition.strip():
            return False

        # ast.parse(mode='eval') treats leading whitespace as indentation.
        expression = condition.strip()

        try:
            tree = ast.parse(expression, mode='eval')
        except SyntaxError as exc:
            warning(f'flow.pyeval: invalid syntax in condition {expression!r}: {exc}')
            return False

        for node in ast.walk(tree):
            if isinstance(node, _FORBIDDEN_NODES):
                warning(f'flow.pyeval: rejected {type(node).__name__} in condition {expression!r} — forbidden')
                return False
            # Block dunder attribute access (__class__, __globals__) to prevent escapes.
            if isinstance(node, ast.Attribute) and node.attr.startswith('_'):
                warning(f'flow.pyeval: rejected access to dunder {node.attr!r} in condition {expression!r}')
                return False

        try:
            compiled = compile(tree, filename='<flow.pyeval>', mode='eval')
        except Exception as exc:
            warning(f'flow.pyeval: failed to compile condition {expression!r}: {exc}')
            return False

        # Namespace: safe builtins + lane bindings + `obj` (current entry).
        namespace: dict = {'__builtins__': _SAFE_BUILTINS}
        namespace.update(kwargs)
        namespace['obj'] = getattr(self.instance, 'currentObject', None)

        try:
            return bool(eval(compiled, namespace, {}))  # noqa: S307 — AST-gated
        except Exception as exc:
            error(f'flow.pyeval: evaluation failed for condition {expression!r} — fail-closed to ELSE: {exc}')
            return False
