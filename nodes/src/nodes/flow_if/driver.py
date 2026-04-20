# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""IfDriver — evaluates a boolean expression and decides pass vs skip."""

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


class IfDriver(FlowDriverBase):
    """Single-gate driver: truthy → emit, falsy → skip.

    The expression runs in the AST-gated sandbox with two bindings:

    - ``text`` (or whatever `payload_name` is set to) — the incoming chunk.
    - ``state`` — the `PerChunkState` for this invocation.
    - ``cond`` — the `flow_base.cond` helper namespace.

    Evaluation errors are fail-closed: treated as `False` (i.e. skip).
    This keeps the pipeline resilient against malformed payloads
    without requiring defensive try/except in every user expression.
    """

    driver_name = 'flow_if'

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
            raise ValueError('IfDriver requires a non-empty expression')
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
            # Fail-closed: any evaluation error is treated as a rejection.
            # The trace span records the exception via `FlowTrace.span`.
            return False
        return bool(value)

    async def dispatch(self, ctx: FlowContext, decision: bool) -> FlowResult:
        branch = Decision.THEN if decision else Decision.ELSE
        run_id = ctx.state.get('_run_id', '')
        ctx.trace.decision(run_id, decision=branch.value, truthy=decision)
        if decision:
            return FlowResult.emit(payload=ctx.chunk, decision=branch)
        return FlowResult.skip(decision=branch)
