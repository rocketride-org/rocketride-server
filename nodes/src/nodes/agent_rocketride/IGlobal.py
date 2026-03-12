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
        """
        Instantiate and attach the RocketRideDriver that runs the agent loop.
        
        Configuration (including instructions) is loaded by AgentBase.__init__ via Config.getNodeConfig and is not handled here.
        """
        from .rocketride_agent import RocketRideDriver
        self.agent = RocketRideDriver(self)

    def endGlobal(self) -> None:
        """
        Clear the per-pipe RocketRide agent reference when the pipe shuts down.
        
        Sets the `agent` attribute to None to release the RocketRideDriver instance.
        """
        self.agent = None
