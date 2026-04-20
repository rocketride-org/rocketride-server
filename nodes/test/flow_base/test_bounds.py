# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Unit tests for flow_base.bounds."""

from __future__ import annotations

import asyncio

import pytest

from nodes.flow_base import Bounds, BoundsError


class TestDeadline:
    @pytest.mark.asyncio
    async def test_under_deadline_ok(self):
        b = Bounds(timeout_s=1.0)
        async with b.deadline():
            await asyncio.sleep(0.01)

    @pytest.mark.asyncio
    async def test_over_deadline_raises(self):
        b = Bounds(timeout_s=0.05)
        with pytest.raises(BoundsError):
            async with b.deadline():
                await asyncio.sleep(0.5)


class TestIterationCheck:
    def test_under_limit_ok(self):
        b = Bounds(max_iterations=3)
        for i in range(3):
            b.check_iteration(i)

    def test_at_limit_raises(self):
        b = Bounds(max_iterations=3)
        b.check_iteration(0)
        b.check_iteration(1)
        b.check_iteration(2)
        with pytest.raises(BoundsError):
            b.check_iteration(3)
