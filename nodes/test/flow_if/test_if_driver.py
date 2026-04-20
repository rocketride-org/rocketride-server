# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for IfDriver — the first flow_base consumer."""

from __future__ import annotations

import pytest

from nodes.flow_base import AsyncInvoker, Bounds, FlowAction
from nodes.flow_if.driver import IfDriver


def _invoker():
    return AsyncInvoker(lambda param, component_id='': None)


class TestPassThrough:
    @pytest.mark.asyncio
    async def test_truthy_emits(self):
        d = IfDriver(expression='True', invoker=_invoker())
        r = await d.run('payload')
        assert r.action == FlowAction.EMIT
        assert r.payload == 'payload'

    @pytest.mark.asyncio
    async def test_falsy_skips(self):
        d = IfDriver(expression='False', invoker=_invoker())
        r = await d.run('payload')
        assert r.action == FlowAction.SKIP


class TestExpressionBindings:
    @pytest.mark.asyncio
    async def test_text_binding_available(self):
        d = IfDriver(expression='len(text) > 3', invoker=_invoker())
        assert (await d.run('four')).action == FlowAction.EMIT
        assert (await d.run('hi')).action == FlowAction.SKIP

    @pytest.mark.asyncio
    async def test_cond_helpers_available(self):
        d = IfDriver(
            expression="cond.contains(text, 'error')",
            invoker=_invoker(),
        )
        assert (await d.run('an error occurred')).action == FlowAction.EMIT
        assert (await d.run('all good')).action == FlowAction.SKIP

    @pytest.mark.asyncio
    async def test_custom_payload_name(self):
        d = IfDriver(
            expression='payload > 0',
            payload_name='payload',
            invoker=_invoker(),
        )
        assert (await d.run(5)).action == FlowAction.EMIT
        assert (await d.run(-1)).action == FlowAction.SKIP


class TestFailClosed:
    """Evaluation errors must be treated as `False` — skip, not crash."""

    @pytest.mark.asyncio
    async def test_malformed_expression_skips(self):
        d = IfDriver(expression='text.nonexistent_method()', invoker=_invoker())
        r = await d.run('anything')
        assert r.action == FlowAction.SKIP

    @pytest.mark.asyncio
    async def test_type_error_skips(self):
        d = IfDriver(expression='text + 1', invoker=_invoker())
        r = await d.run('hello')
        assert r.action == FlowAction.SKIP


class TestConstructorValidation:
    def test_empty_expression_rejected(self):
        with pytest.raises(ValueError):
            IfDriver(expression='', invoker=_invoker())

    def test_whitespace_expression_rejected(self):
        with pytest.raises(ValueError):
            IfDriver(expression='   ', invoker=_invoker())


class TestTimeout:
    @pytest.mark.asyncio
    async def test_driver_respects_bounds(self):
        """IfDriver inherits deadline enforcement from FlowDriverBase."""
        # Note: evaluating a trivial expression is <1ms. This test just
        # confirms the deadline plumbing is wired; tight timeouts on
        # pure-Python eval() are not testable without artificial sleep.
        d = IfDriver(
            expression='True',
            invoker=_invoker(),
            bounds=Bounds(timeout_s=5.0),
        )
        r = await d.run('x')
        assert r.action == FlowAction.EMIT
