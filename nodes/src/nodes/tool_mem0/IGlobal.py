# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mem0 node - global (per-pipe) state.

Reads the Mem0 API key and endpoint from the resolved node config. The two
instance tools reuse this state; the default memory scope and the store/recall
options are each call's settings (``IInstance._call_options``).
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_mem0: the account key and the endpoint."""

    api_key: str = ''
    base_url: str = 'https://api.mem0.ai'

    def beginGlobal(self) -> None:
        """Load the Mem0 connection config (once per pipe)."""
        # The resolved config: defaults applied, bounds validated, the key a
        # required secret (a ${ROCKETRIDE_MEM0_APIKEY} reference resolved per
        # call, no process-env fallback)
        cfg = self.config

        # Required by the schema, but a whitespace-only value passes `required` and
        # would only fail later on the first remember/recall call: refuse it here.
        self.api_key = str(cfg.api_key or '').strip()
        if not self.api_key:
            raise ValueError(
                'tool_mem0: api_key is required - set it in the node config (a ${ROCKETRIDE_MEM0_APIKEY} reference)'
            )
        # Optional override for self-hosted / enterprise deployments; the
        # default is the hosted endpoint (https://api.mem0.ai).
        self.base_url = cfg.base_url.strip().rstrip('/')

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''
