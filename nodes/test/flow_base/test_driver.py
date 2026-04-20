# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.driver.FlowDriverBase — contract + scoping."""

from __future__ import annotations

import asyncio

import pytest

from nodes.flow_base import (
    AsyncInvoker,
    Bounds,
    BoundsError,
    FlowAction,
    FlowContext,
    FlowDriverBase,
    FlowResult,
)


class _StubDriver(FlowDriverBase):
    """Concrete driver that just emits the chunk unchanged."""

    driver_name = 'stub'

    async def evaluate(self, ctx: FlowContext) -> bool:
        return True

    async def dispatch(self, ctx: FlowContext, decision: bool) -> FlowResult:
        return FlowResult.emit(payload=ctx.chunk)


class _SlowDriver(FlowDriverBase):
    driver_name = 'slow'

    async def evaluate(self, ctx: FlowContext) -> None:
        await asyncio.sleep(0.5)

    async def dispatch(self, ctx: FlowContext, decision) -> FlowResult:
        return FlowResult.emit(payload=ctx.chunk)


def _make_invoker():
    def sync_invoke(param, component_id=''):
        return None

    return AsyncInvoker(sync_invoke)


class TestRunLoop:
    @pytest.mark.asyncio
    async def test_returns_flow_result(self):
        d = _StubDriver(invoker=_make_invoker())
        result = await d.run('hello')
        assert isinstance(result, FlowResult)
        assert result.action == FlowAction.EMIT
        assert result.payload == 'hello'

    @pytest.mark.asyncio
    async def test_fresh_state_per_run(self):
        """Two consecutive runs get independent PerChunkState objects."""
        seen_states = []
        leak_observed_at_entry = []

        class _Capture(FlowDriverBase):
            driver_name = 'capture'

            async def evaluate(self, ctx: FlowContext) -> None:
                # Observe the state BEFORE mutating — if state leaked
                # from a prior run, `leak` would already be set here.
                leak_observed_at_entry.append(ctx.state.get('leak'))
                seen_states.append(ctx.state)
                ctx.state.set('leak', 'from_prev_run')

            async def dispatch(self, ctx, decision) -> FlowResult:
                return FlowResult.emit(payload=ctx.chunk)

        d = _Capture(invoker=_make_invoker())
        await d.run('a')
        await d.run('b')

        assert len(seen_states) == 2
        assert seen_states[0] is not seen_states[1]
        assert leak_observed_at_entry == [None, None]  # fresh at every run

    @pytest.mark.asyncio
    async def test_deadline_enforced(self):
        d = _SlowDriver(invoker=_make_invoker(), bounds=Bounds(timeout_s=0.05))
        with pytest.raises(BoundsError):
            await d.run('x')


class TestAbstractMethods:
    def test_cannot_instantiate_base(self):
        with pytest.raises(TypeError):
            FlowDriverBase(invoker=_make_invoker())
