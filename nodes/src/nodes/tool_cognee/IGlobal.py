# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cognee node — global (per-pipe) state.

Reads the cognee server URL, optional API key, default dataset, and recall
settings from node config. The three instance tools reuse this state.
"""

from __future__ import annotations

import os
from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

# Defaults / bounds (avoid magic constants scattered in the code).
_DEFAULT_BASE_URL = 'http://localhost:8000'
_DEFAULT_DATASET = 'main'
_DEFAULT_SEARCH_TYPE = 'GRAPH_COMPLETION_DECOMPOSITION'
_DEFAULT_TOP_K = 15
MAX_TOP_K = 100
_DEFAULT_REQUEST_TIMEOUT = 120
_MIN_REQUEST_TIMEOUT = 5
_MAX_REQUEST_TIMEOUT = 600

# Search types cognee's REST API accepts; the node clamps to this set so a bad
# config value can't reach the server.
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

    base_url: str = _DEFAULT_BASE_URL
    api_key: str = ''
    dataset: str = _DEFAULT_DATASET
    allow_dataset_override: bool = False
    search_type: str = _DEFAULT_SEARCH_TYPE
    top_k: int = _DEFAULT_TOP_K
    request_timeout: int = _DEFAULT_REQUEST_TIMEOUT

    def beginGlobal(self) -> None:
        """Load and validate the cognee connection config (once per pipe)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        base_url = str(cfg.get('base_url') or _DEFAULT_BASE_URL).strip().rstrip('/')
        if not base_url:
            error('cognee: base_url is required — set the cognee server URL in node config')
            raise ValueError('cognee: base_url is required')
        self.base_url = base_url

        # Optional: cognee self-hosted with access control off needs no key.
        # Falls back to the COGNEE_API_KEY env var when the field is blank.
        self.api_key = str(cfg.get('api_key') or os.environ.get('COGNEE_API_KEY', '')).strip()

        self.dataset = str(cfg.get('dataset') or _DEFAULT_DATASET).strip() or _DEFAULT_DATASET
        raw_allow_dataset_override = cfg.get('allow_dataset_override', False)
        self.allow_dataset_override = (
            raw_allow_dataset_override if isinstance(raw_allow_dataset_override, bool) else False
        )

        search_type = str(cfg.get('search_type') or _DEFAULT_SEARCH_TYPE).strip().upper()
        self.search_type = search_type if search_type in SEARCH_TYPES else _DEFAULT_SEARCH_TYPE

        raw_top_k = cfg.get('top_k', _DEFAULT_TOP_K)
        self.top_k = max(1, min(MAX_TOP_K, _coerce_int(raw_top_k, _DEFAULT_TOP_K)))

        raw_timeout = cfg.get('request_timeout', _DEFAULT_REQUEST_TIMEOUT)
        self.request_timeout = max(
            _MIN_REQUEST_TIMEOUT, min(_MAX_REQUEST_TIMEOUT, _coerce_int(raw_timeout, _DEFAULT_REQUEST_TIMEOUT))
        )

    def validateConfig(self) -> None:
        """Warn (without raising) when required config such as the server URL is missing."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            base_url = str(cfg.get('base_url') or '').strip()
            if not base_url:
                warning('base_url is required — set the cognee server URL')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''


def _coerce_int(value: object, default: int) -> int:
    """Best-effort int coercion that rejects booleans and junk, falling back to default."""
    if isinstance(value, bool) or value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
