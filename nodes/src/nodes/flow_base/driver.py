# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Async base class for every `flow_*` driver.

One `FlowDriverBase` instance per pipeline node. `run(chunk)` is the
per-chunk entry point: it opens a fresh `PerChunkState`, a trace span,
and a timeout deadline, then delegates to subclass-specific
`evaluate()` + `dispatch()` hooks. The common plumbing (state scope,
tracing, bounds enforcement) lives here so no concrete driver can
accidentally skip it.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional

from .bounds import Bounds
from .invoker import AsyncInvoker
from .state import PerChunkState
from .trace import FlowTrace
from .types import FlowContext, FlowResult


class FlowDriverBase(ABC):
    """Async driver base. Subclasses override `evaluate` and `dispatch`.

    The concrete `IInstance` that owns this driver is responsible for
    translating the returned `FlowResult` into engine write calls or
    `preventDefault()` — see `flow_if_else.IInstance._gate` for the
    canonical consumer.
    """

    driver_name: str = 'flow'

    def __init__(
        self,
        *,
        invoker: AsyncInvoker,
        bounds: Optional[Bounds] = None,
        node_id: str = '',
        trace: Optional[FlowTrace] = None,
    ) -> None:
        """Wire the driver to its invoker, bounds, and trace sink."""
        self.invoker = invoker
        self.bounds = bounds or Bounds()
        self.node_id = node_id
        self.trace = trace or FlowTrace(node_id=node_id, driver_name=self.driver_name)

    async def run(self, chunk: Any) -> FlowResult:
        """Execute one flow cycle for `chunk` and return the outcome.

        Subclasses should NOT override this method directly. Override
        `evaluate` and `dispatch` instead so the state/trace/bounds
        scoping is preserved uniformly.
        """
        ctx = FlowContext(
            chunk=chunk,
            state=PerChunkState(),
            invoker=self.invoker,
            bounds=self.bounds,
            trace=self.trace,
            node_id=self.node_id,
        )

        async with self.trace.span(chunk):
            async with self.bounds.deadline():
                decision = await self.evaluate(ctx)
                return await self.dispatch(ctx, decision)

    @abstractmethod
    async def evaluate(self, ctx: FlowContext) -> Any:
        """Return the driver-specific decision for this chunk.

        For `flow_if_else` this is a `bool`. For `flow_switch` this is a
        dispatch key. For `flow_for` this is an iterable. The return
        value is passed verbatim to `dispatch()`.
        """

    @abstractmethod
    async def dispatch(self, ctx: FlowContext, decision: Any) -> FlowResult:
        """Act on `decision` and produce the `FlowResult` for the chunk."""
