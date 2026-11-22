# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
xTrace Memory node - global (per-pipe) state.

Reads the xTrace API key, org id and endpoint from the resolved node config.
The two instance tools reuse this state; the default memory scope and the
ingest/recall options are each call's settings (``IInstance._call_options``).
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for xtrace_memory: the account key, the org id and the endpoint."""

    api_key: str = ''
    org_id: str = ''
    base_url: str = 'https://api.production.xtrace.ai'

    def beginGlobal(self) -> None:
        # The resolved config: the key and org id required by the schema (the key
        # a ${ROCKETRIDE_XTRACE_APIKEY} reference resolved per call, no process-env
        # fallback)
        cfg = self.config

        self.api_key = str(cfg.api_key or '').strip()
        self.org_id = cfg.org_id.strip()
        self.base_url = cfg.base_url.strip().rstrip('/')

    def endGlobal(self) -> None:
        self.api_key = ''
