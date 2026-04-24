# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_if_else.driver.IfElseDriver.

Covers the fail-closed-to-ELSE branch plus the trace.error surface that
was added in response to Stephan's garbage-condition case (Condition:
"asfasdfasdfasf" accepted silently, all chunks went to ELSE with no UI
feedback).
"""

from __future__ import annotations

import logging

import pytest

from nodes.flow_base import AsyncInvoker, Decision, FlowAction
from nodes.flow_if_else.driver import IfElseDriver


def _invoker() -> AsyncInvoker:
    return AsyncInvoker(lambda param, component_id='': None)


class TestEvaluate:
    @pytest.mark.asyncio
    async def test_truthy_condition_routes_to_then(self):
        d = IfElseDriver(expression='len(text) > 0', invoker=_invoker())
        result = await d.run('hello')
        assert result.decision == Decision.THEN
        assert result.action == FlowAction.EMIT

    @pytest.mark.asyncio
    async def test_falsy_condition_routes_to_else(self):
        d = IfElseDriver(expression='len(text) > 0', invoker=_invoker())
        result = await d.run('')
        assert result.decision == Decision.ELSE

    @pytest.mark.asyncio
    async def test_literal_false_routes_to_else(self):
        """Stephan's case 1 baseline: the driver itself evaluates 'False'
        correctly. If the chunk still reaches THEN downstream, the bug is
        in the dispatcher/gate, not here.
        """
        d = IfElseDriver(expression='False', invoker=_invoker())
        result = await d.run('anything')
        assert result.decision == Decision.ELSE


class TestSandboxErrorSurface:
    """Stephan's case 2: garbage condition fail-closed to ELSE *and* now
    surfaces through the trace so the Errors panel shows why.
    """

    @pytest.mark.asyncio
    async def test_garbage_condition_routes_to_else(self):
        d = IfElseDriver(expression='asfasdfasdfasf', invoker=_invoker())
        result = await d.run('x')
        assert result.decision == Decision.ELSE

    @pytest.mark.asyncio
    async def test_sandbox_error_emits_trace_error(self, caplog):
        d = IfElseDriver(expression='asfasdfasdfasf', invoker=_invoker())
        with caplog.at_level(logging.INFO, logger='rocketride.flow'):
            await d.run('x')

        error_records = [r for r in caplog.records if getattr(r, 'flow_event', None) == 'error']
        assert error_records, 'expected a flow.error log record for the SandboxError'
        rec = error_records[0]
        err_msg = getattr(rec, 'error_message', '')
        assert 'condition evaluation failed' in err_msg.lower()
        assert getattr(rec, 'expression', None) == 'asfasdfasdfasf'
        assert getattr(rec, 'action', None) == 'fail_closed_to_else'

    @pytest.mark.asyncio
    async def test_syntax_error_emits_trace_error(self, caplog):
        d = IfElseDriver(expression='1 +', invoker=_invoker())
        with caplog.at_level(logging.INFO, logger='rocketride.flow'):
            result = await d.run('x')
        assert result.decision == Decision.ELSE
        assert any(getattr(r, 'flow_event', None) == 'error' for r in caplog.records)

    @pytest.mark.asyncio
    async def test_forbidden_node_emits_trace_error(self, caplog):
        d = IfElseDriver(expression='__import__("os")', invoker=_invoker())
        with caplog.at_level(logging.INFO, logger='rocketride.flow'):
            result = await d.run('x')
        assert result.decision == Decision.ELSE
        assert any(getattr(r, 'flow_event', None) == 'error' for r in caplog.records)


class TestConstruction:
    def test_empty_expression_raises(self):
        with pytest.raises(ValueError):
            IfElseDriver(expression='', invoker=_invoker())

    def test_whitespace_expression_raises(self):
        with pytest.raises(ValueError):
            IfElseDriver(expression='   ', invoker=_invoker())
