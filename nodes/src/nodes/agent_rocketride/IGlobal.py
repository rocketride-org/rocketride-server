# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
RocketRide Wave node — global (per-pipe) state and configuration.
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

        Configuration (including instructions) is loaded by
        ``AgentBase.__init__`` via ``Config.getNodeConfig``, so no
        config handling is needed here.
        """
        from .rocketride_agent import RocketRideDriver
        self.agent = RocketRideDriver(self)

    def endGlobal(self) -> None:
        """Release the agent driver when the pipe closes."""
        self.agent = None
