# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.invoker.AsyncInvoker."""

from __future__ import annotations

import asyncio
import threading

import pytest

from nodes.flow_base import AsyncInvoker


class TestAsyncFacade:
    @pytest.mark.asyncio
    async def test_awaitable_returns_value(self):
        def sync_invoke(param, component_id=''):
            return f'{component_id}:{param}'

        inv = AsyncInvoker(sync_invoke)
        result = await inv.invoke('hello', component_id='node_a')
        assert result == 'node_a:hello'

    @pytest.mark.asyncio
    async def test_runs_on_executor_thread(self):
        main_tid = threading.get_ident()
        captured_tid = {'tid': None}

        def sync_invoke(param, component_id=''):
            captured_tid['tid'] = threading.get_ident()
            return None

        inv = AsyncInvoker(sync_invoke)
        await inv.invoke('x')
        assert captured_tid['tid'] is not None
        assert captured_tid['tid'] != main_tid

    @pytest.mark.asyncio
    async def test_concurrent_invocations(self):
        """`asyncio.gather` over multiple invokes runs them in parallel."""
        call_count = {'n': 0}
        lock = threading.Lock()

        def sync_invoke(param, component_id=''):
            with lock:
                call_count['n'] += 1
            return param

        inv = AsyncInvoker(sync_invoke)
        results = await asyncio.gather(*[inv.invoke(i) for i in range(10)])
        assert sorted(results) == list(range(10))
        assert call_count['n'] == 10

    @pytest.mark.asyncio
    async def test_propagates_exception(self):
        def sync_invoke(param, component_id=''):
            raise ValueError('boom')

        inv = AsyncInvoker(sync_invoke)
        with pytest.raises(ValueError, match='boom'):
            await inv.invoke('x')
