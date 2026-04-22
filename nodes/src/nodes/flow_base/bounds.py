# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Timeout and iteration-count enforcement for flow drivers.

`Bounds` is shared by every `flow_*` node. `flow_if_else` uses only the
overall `timeout_s`. `max_iterations` is included in the contract so a
future iterating driver can reuse the same primitive without changing
this module.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator


class BoundsError(Exception):
    """Raised when a flow driver exceeds its time or iteration budget."""


@dataclass(frozen=True)
class Bounds:
    """Execution limits for a single flow driver invocation.

    `timeout_s` caps the total time spent in `FlowDriverBase.run()`.
    `max_iterations` caps loop bodies for iterating drivers; drivers
    that do not iterate (e.g. `flow_if_else`) ignore it.
    """

    timeout_s: float = 30.0
    max_iterations: int = 10_000

    @asynccontextmanager
    async def deadline(self) -> AsyncIterator[None]:
        """Enforce `timeout_s` over the wrapped async block."""
        try:
            async with asyncio.timeout(self.timeout_s):
                yield
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise BoundsError(f'flow driver exceeded timeout of {self.timeout_s}s') from exc

    def check_iteration(self, i: int) -> None:
        """Raise if the iteration counter exceeds `max_iterations`.

        Callers pass the *count* of iterations performed so far; the
        check fails when `i >= max_iterations` so a driver that sets
        `max_iterations=100` runs iterations 0..99 and rejects 100.
        """
        if i >= self.max_iterations:
            raise BoundsError(f'flow driver exceeded max_iterations of {self.max_iterations}')
