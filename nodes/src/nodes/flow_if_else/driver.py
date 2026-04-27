# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""IfElseDriver — evaluates a boolean expression and picks a branch."""

from __future__ import annotations

from typing import Any

from ..flow_base import (
    Decision,
    FlowContext,
    FlowDriverBase,
    FlowResult,
    SandboxError,
    cond,
    evaluate_expression,
)
from .IGlobal import _dbg  # [IFELSE-DEBUG]

# Default values for every standard lane name. Pre-bound on every
# evaluation so user expressions can reference any lane without raising
# NameError when the active lane is different. Mirrors the load-time
# `_EXPECTED_LANE_BINDINGS` in IGlobal.py — keep them in sync.
# Bytes lanes default to `b''` (not `None`) so subscript / slice
# operations like `image[:4]` work on inactive lanes without raising.
_LANE_DEFAULTS: dict[str, Any] = {
    'text': '',
    'image': b'',
    'audio': b'',
    'video': b'',
    'table': '',
    'documents': [],
    'questions': [],
    'answers': [],
    'classifications': [],
}


class IfElseDriver(FlowDriverBase):
    """Two-branch driver: truthy → THEN, falsy → ELSE.

    Every chunk is routed to exactly one branch — the driver never
    returns ``FlowAction.SKIP``. When the expression raises or times
    out, it fails closed to the ELSE branch.

    Expression bindings:

    - ``<payload_name>`` (``text``, ``image``, ``audio``, ...) — incoming chunk.
    - ``state`` — per-chunk state store.
    - ``cond`` — the `flow_base.cond` helper namespace.
    """

    driver_name = 'flow_if_else'

    def __init__(
        self,
        *,
        expression: str,
        payload_name: str = 'text',
        extras: dict = None,
        **kwargs: Any,
    ) -> None:
        """Configure the condition expression and payload binding name."""
        super().__init__(**kwargs)
        if not expression or not expression.strip():
            raise ValueError('IfElseDriver requires a non-empty expression')
        self.expression = expression
        self.payload_name = payload_name
        # Extra named bindings supplied by the gating mixin (e.g. ``mimeType``,
        # ``action`` for streaming methods). Letting the user's condition
        # reference these is the only way to write a stable expression
        # across the BEGIN/WRITE/END streaming sequence — the buffer
        # changes per action but ``mimeType`` does not.
        self.extras = extras or {}

    async def evaluate(self, ctx: FlowContext) -> bool:
        # Pre-bind every standard lane name so the user's expression can
        # reference any lane (`text`, `table`, `image`, …) without
        # NameError when the active lane is something else. The active
        # lane's default is overwritten with the real chunk last, so the
        # expression sees the real payload on the active side and a
        # neutral default on the others — `text or table` works whichever
        # lane fires. Streaming-method extras (`mimeType`, `action`) are
        # added on top so byte-stable conditions are possible.
        bindings = {
            **_LANE_DEFAULTS,
            'state': ctx.state,
            'cond': cond,
            self.payload_name: ctx.chunk,
            **self.extras,
        }
        _dbg(f'[IFELSE-DEBUG] evaluate expression={self.expression!r} payload_name={self.payload_name!r} chunk_type={type(ctx.chunk).__name__}')
        try:
            value = evaluate_expression(self.expression, bindings)
        except SandboxError as exc:
            # Fail-closed: any evaluation error routes the chunk to ELSE.
            # Surface through the trace so the Errors panel shows *why*
            # chunks are all going to ELSE instead of the user having to
            # guess from downstream behaviour — pairs with the load-time
            # validation in IGlobal so the only runtime failures that
            # reach here are payload-shape mismatches, not typos.
            run_id = ctx.state.get('_run_id', '') if ctx.state else ''
            ctx.trace.error(
                run_id,
                f'condition evaluation failed: {exc}',
                expression=self.expression,
                payload_name=self.payload_name,
                action='fail_closed_to_else',
            )
            return False
        result = bool(value)
        _dbg(f'[IFELSE-DEBUG] evaluate result value={value!r} → bool={result}')
        return result

    async def dispatch(self, ctx: FlowContext, decision: bool) -> FlowResult:
        branch = Decision.THEN if decision else Decision.ELSE
        run_id = ctx.state.get('_run_id', '')
        ctx.trace.decision(run_id, decision=branch.value, truthy=decision)
        return FlowResult.emit(payload=ctx.chunk, decision=branch)
