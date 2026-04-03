# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Multi-Agent orchestration node — global (per-pipe) state and configuration.

IGlobal holds the node-level configuration that is created once when the
pipeline starts and shared across all instances (concurrent requests).
The actual :class:`MultiAgentOrchestrator` is created per-request in
IInstance because it carries per-run state (blackboard, message queues).
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Per-pipe global state for the Multi-Agent orchestration node.

    Attributes:
        config: The node configuration dict, loaded in :meth:`beginGlobal`.
    """

    config: Dict[str, Any] = None

    def beginGlobal(self) -> None:
        """Load node configuration for the multi-agent orchestrator.

        Configuration fields (``agents_json``, ``communication_protocol``,
        ``max_rounds``, ``merge_strategy``) are read via
        ``Config.getNodeConfig()`` which handles profile merging, and
        stored for IInstance to use on each request.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        conn_config = getattr(self.glb, 'connConfig', None) or {}
        self.config = Config.getNodeConfig(self.glb.logicalType, conn_config)

    def endGlobal(self) -> None:
        """Release configuration when the pipe closes."""
        self.config = None
