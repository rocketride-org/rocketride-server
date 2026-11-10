# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cognee node - global (per-pipe) state.

Reads the cognee server URL, optional API key, default dataset, and recall
settings from the resolved node config. The three instance tools reuse this
state.
"""

from __future__ import annotations

from rocketlib import IGlobalBase

# Bounds the instance tools apply to per-call overrides (the schema bounds the
# configured default the same way).
MAX_TOP_K = 100

# Search types cognee's REST API accepts; the schema enum pins the configured
# default to this set, the instance checks per-call overrides against it.
SEARCH_TYPES = frozenset(
    {
        'GRAPH_COMPLETION',
        'GRAPH_COMPLETION_DECOMPOSITION',
        'RAG_COMPLETION',
        'CHUNKS',
        'SUMMARIES',
        'TEMPORAL',
        'FEELING_LUCKY',
    }
)


class IGlobal(IGlobalBase):
    """Global state for tool_cognee."""

    base_url: str = 'http://localhost:8000'
    api_key: str = ''
    dataset: str = 'main'
    allow_dataset_override: bool = False
    search_type: str = 'GRAPH_COMPLETION_DECOMPOSITION'
    top_k: int = 15
    request_timeout: int = 120

    def beginGlobal(self) -> None:
        """Load the cognee connection config (once per pipe)."""
        # The resolved config: defaults applied, bounds and enum validated
        cfg = self.config

        self.base_url = cfg.base_url.strip().rstrip('/')

        # Optional: cognee self-hosted with access control off needs no key.
        # The key reaches the node through its config (a ${ROCKETRIDE_COGNEE_APIKEY}
        # reference resolved per call); there is no process-env fallback
        self.api_key = str(cfg.api_key or '').strip()

        self.dataset = cfg.dataset.strip()
        self.allow_dataset_override = cfg.allow_dataset_override
        self.search_type = cfg.search_type
        self.top_k = cfg.top_k
        self.request_timeout = cfg.request_timeout

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''
