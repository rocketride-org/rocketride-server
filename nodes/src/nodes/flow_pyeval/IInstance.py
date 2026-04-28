# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.pyeval per-pipeline instance.

Concrete subclass of `flow.base.FlowBaseIInstance` that overrides
`checkCondition` with a sandboxed Python expression evaluator. The
condition is parsed via ``ast.parse(mode='eval')`` and evaluated with a
restricted set of builtins; user expressions can reference the active
lane's payload by name (`text`, `image`, `obj`, etc.).
"""

from __future__ import annotations

import ast
import logging
from typing import Any

from ..flow_base import FlowBaseIInstance
from ..flow_base.IInstance import _flow_log, _flow_log_exc
from .IGlobal import IGlobal

_logger = logging.getLogger('rocketride.flow')


# Audited safe builtins — small, audited surface that user expressions
# can reach. Anything not in this dict (including __import__, eval, exec,
# open) is unavailable inside the sandbox.
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


# AST nodes that mutate state, invoke imports, or escape the sandbox.
# The walk before compile rejects expressions containing any of these.
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
        """Parse and evaluate ``condition`` against the active payload.

        ``kwargs`` carries the bound lane payload (e.g. ``text='...'``).
        ``obj`` is added as an alias for the current entry's metadata so
        expressions can reference attributes like ``obj.size``.

        On any sandbox / evaluation error the method returns False
        (fail-closed to ELSE) — never raises.
        """
        if not isinstance(condition, str) or not condition.strip():
            return False

        # Strip leading/trailing whitespace — `ast.parse(mode='eval')` is
        # strict about leading whitespace and treats it as indentation.
        expression = condition.strip()

        try:
            tree = ast.parse(expression, mode='eval')
        except SyntaxError as exc:
            _logger.error('flow.pyeval invalid syntax in condition %r: %s', expression, exc)
            return False

        for node in ast.walk(tree):
            if isinstance(node, _FORBIDDEN_NODES):
                _logger.error(
                    'flow.pyeval rejected %s in condition %r — forbidden',
                    type(node).__name__,
                    expression,
                )
                return False
            # Block dunder attribute access (__class__, __globals__, etc.)
            # to prevent escapes via bound objects.
            if isinstance(node, ast.Attribute) and node.attr.startswith('_'):
                _logger.error(
                    'flow.pyeval rejected access to dunder %r in condition %r',
                    node.attr,
                    expression,
                )
                return False

        try:
            compiled = compile(tree, filename='<flow.pyeval>', mode='eval')
        except Exception as exc:
            _logger.error('flow.pyeval failed to compile condition %r: %s', expression, exc)
            return False

        # Build evaluation namespace: safe builtins + the active lane
        # bindings + `obj` referencing the current entry.
        namespace: dict = {'__builtins__': _SAFE_BUILTINS}
        namespace.update(kwargs)
        namespace['obj'] = getattr(self.instance, 'currentObject', None)

        try:
            result = bool(eval(compiled, namespace, {}))  # noqa: S307 — AST-gated
            _flow_log('warn',
                'flow_pyeval evaluated condition=%r kwargs_keys=%r → %s',
                expression, list(kwargs.keys()), result,
            )
            return result
        except Exception as exc:
            _flow_log_exc(
                'flow.pyeval evaluation failed for condition %r: %s — fail-closed to ELSE',
                expression, exc,
            )
            _logger.error(
                'flow.pyeval evaluation failed for condition %r: %s — fail-closed to ELSE',
                expression,
                exc,
            )
            return False
