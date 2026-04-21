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
        try:
            value = evaluate_expression(self.expression, bindings)
        except SandboxError:
            # Fail-closed: any evaluation error routes the chunk to ELSE.
            return False
        return bool(value)

    async def dispatch(self, ctx: FlowContext, decision: bool) -> FlowResult:
        branch = Decision.THEN if decision else Decision.ELSE
        run_id = ctx.state.get('_run_id', '')
        ctx.trace.decision(run_id, decision=branch.value, truthy=decision)
        return FlowResult.emit(payload=ctx.chunk, decision=branch)
