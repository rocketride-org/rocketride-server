# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mem0 node - global (per-pipe) state.

Reads the Mem0 API key, endpoint, default memory scope and store/recall
options from the resolved node config. The two instance tools reuse this state.
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_mem0."""

    api_key: str = ''
    base_url: str = 'https://api.mem0.ai'
    user_id: str = ''
    agent_id: str = ''
    run_id: str = ''
    app_id: str = ''
    infer: bool = True
    search_limit: int = 10
    wait: bool = True
    ingest_timeout: int = 30

    def beginGlobal(self) -> None:
        """Load the Mem0 connection config and default scope (once per pipe)."""
        # The resolved config: defaults applied, bounds validated, the key a
        # required secret (a ${ROCKETRIDE_MEM0_APIKEY} reference resolved per
        # call, no process-env fallback)
        cfg = self.config

        self.api_key = str(cfg.api_key or '').strip()
        # Optional override for self-hosted / enterprise deployments; the
        # default is the hosted endpoint (https://api.mem0.ai).
        self.base_url = cfg.base_url.strip().rstrip('/')
        self.user_id = str(cfg.user_id or '').strip()
        self.agent_id = str(cfg.agent_id or '').strip()
        self.run_id = str(cfg.run_id or '').strip()
        self.app_id = str(cfg.app_id or '').strip()
        self.infer = cfg.infer
        self.wait = cfg.wait
        self.ingest_timeout = cfg.ingest_timeout
        self.search_limit = cfg.search_limit

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''
