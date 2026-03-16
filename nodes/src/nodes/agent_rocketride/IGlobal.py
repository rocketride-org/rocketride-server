# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave node — global (per-pipe) state and configuration.

IGlobal holds state that is created once when the pipeline starts and
shared across all instances (concurrent requests) on this node.  In the
Wave agent, that means the single RocketRideDriver instance which is
stateless across runs and safe to share.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Per-pipe global state for the RocketRide Wave agent node.

    Attributes:
        agent: The :class:`RocketRideDriver` instance, created in
            :meth:`beginGlobal` and torn down in :meth:`endGlobal`.
    """

    agent: Any = None

    def beginGlobal(self) -> None:
        """Create the :class:`RocketRideDriver` that powers the agent loop.

        Imported here (not at module level) to avoid a circular import —
        RocketRideDriver imports from planner and executor, which in turn
        import from the ai.common package.  Deferring the import to beginGlobal
        ensures the module graph is fully loaded before the driver is instantiated.

        Configuration (including instructions) is loaded by
        ``AgentBase.__init__`` via ``Config.getNodeConfig``, so no
        config handling is needed here.
        """
        from .rocketride_agent import RocketRideDriver
        self.agent = RocketRideDriver(self)

    def endGlobal(self) -> None:
        """Release the agent driver when the pipe closes.

        Setting to None allows the GC to reclaim any resources held by the
        driver (LLM clients, cached tool descriptors, etc.).
        """
        self.agent = None
