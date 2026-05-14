# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mocks used by Deep Agent node tests."""

from __future__ import annotations

import asyncio
from typing import Any


class FakeParallelDeepAgent:
    """Fake compiled DeepAgents graph whose async path fans out tool calls."""

    def __init__(self, delay: float) -> None:
        """Store the artificial per-task delay."""
        self.delay = delay

    def invoke(self, input_state: dict[str, Any], *, config: dict[str, Any]) -> dict[str, Any]:
        """Fail if the synchronous graph path is used."""
        raise AssertionError('sync invoke should not be used')

    async def ainvoke(self, input_state: dict[str, Any], *, config: dict[str, Any]) -> dict[str, Any]:
        """Run all supplied task calls concurrently."""

        async def run_one(call: dict[str, Any]) -> str:
            """Return one task result after the shared delay."""
            await asyncio.sleep(self.delay)
            return call['args']['description']

        calls = input_state['messages'][0].tool_calls
        return {'messages': await asyncio.gather(*(run_one(call) for call in calls))}
