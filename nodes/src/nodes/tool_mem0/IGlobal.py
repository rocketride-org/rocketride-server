# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mem0 node — global (per-pipe) state.

Reads the Mem0 Platform credentials and default scope from the node config and
holds them for the instance-level tool functions. Connection details are
validated once here so every ``remember`` / ``recall`` call reuses them.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

# Defaults / bounds (avoid magic constants scattered in the code).
_DEFAULT_BASE_URL = 'https://api.mem0.ai'
_DEFAULT_SEARCH_LIMIT = 10
_MAX_SEARCH_LIMIT = 100
_DEFAULT_INGEST_TIMEOUT = 30
_MAX_INGEST_TIMEOUT = 120


class IGlobal(IGlobalBase):
    """Global state for tool_mem0."""

    api_key: str = ''
    base_url: str = _DEFAULT_BASE_URL
    user_id: str = ''
    agent_id: str = ''
    run_id: str = ''
    app_id: str = ''
    infer: bool = True
    search_limit: int = _DEFAULT_SEARCH_LIMIT
    wait: bool = True
    ingest_timeout: int = _DEFAULT_INGEST_TIMEOUT

    def beginGlobal(self) -> None:
        """Load and validate Mem0 connection config and default scope (once per pipe)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = str(cfg.get('api_key') or os.environ.get('MEM0_API_KEY', '')).strip()
        if not api_key:
            error('mem0: api_key is required — set it in node config or the MEM0_API_KEY env var')
            raise ValueError('mem0: api_key is required')

        self.api_key = api_key
        # Optional override for self-hosted / enterprise deployments; blank uses
        # the default hosted endpoint (https://api.mem0.ai).
        self.base_url = str(cfg.get('base_url') or _DEFAULT_BASE_URL).strip().rstrip('/')
        self.user_id = str(cfg.get('user_id') or '').strip()
        self.agent_id = str(cfg.get('agent_id') or '').strip()
        self.run_id = str(cfg.get('run_id') or '').strip()
        self.app_id = str(cfg.get('app_id') or '').strip()
        self.infer = bool(cfg.get('infer', True))
        self.wait = bool(cfg.get('wait', True))

        raw_timeout = cfg.get('ingest_timeout', _DEFAULT_INGEST_TIMEOUT)
        self.ingest_timeout = max(
            1, min(_MAX_INGEST_TIMEOUT, int(raw_timeout if raw_timeout is not None else _DEFAULT_INGEST_TIMEOUT))
        )

        raw_limit = cfg.get('search_limit', _DEFAULT_SEARCH_LIMIT)
        self.search_limit = max(
            1, min(_MAX_SEARCH_LIMIT, int(raw_limit if raw_limit is not None else _DEFAULT_SEARCH_LIMIT))
        )

    def validateConfig(self) -> None:
        """Warn (without raising) when required config such as the API key is missing."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            api_key = str(cfg.get('api_key') or os.environ.get('MEM0_API_KEY', '')).strip()
            if not api_key:
                warning('api_key is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Clear the cached API key when the pipe tears down."""
        self.api_key = ''
