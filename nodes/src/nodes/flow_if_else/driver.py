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
        **kwargs: Any,
    ) -> None:
        """Configure the condition expression and payload binding name."""
        super().__init__(**kwargs)
        if not expression or not expression.strip():
            raise ValueError('IfElseDriver requires a non-empty expression')
        self.expression = expression
        self.payload_name = payload_name

    async def evaluate(self, ctx: FlowContext) -> bool:
        bindings = {
            self.payload_name: ctx.chunk,
            'state': ctx.state,
            'cond': cond,
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
