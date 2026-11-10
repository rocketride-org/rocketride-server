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

        # The schema's minLength counts whitespace, so a blank or bare '/'
        # value passes it and would only fail on the first tool call
        self.base_url = cfg.base_url.strip().rstrip('/')
        if not self.base_url:
            raise Exception('tool_cognee: base_url is required')

        # Optional: cognee self-hosted with access control off needs no key.
        # The key reaches the node through its config (a ${ROCKETRIDE_COGNEE_APIKEY}
        # reference resolved per call); there is no process-env fallback
        self.api_key = str(cfg.api_key or '').strip()

        # A blank dataset would silently widen the scope to the server default
        self.dataset = cfg.dataset.strip()
        if not self.dataset:
            raise Exception('tool_cognee: dataset is required')
        self.allow_dataset_override = cfg.allow_dataset_override
        self.search_type = cfg.search_type
        self.top_k = cfg.top_k
        self.request_timeout = cfg.request_timeout

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''
