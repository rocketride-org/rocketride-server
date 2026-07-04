# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
xTrace Memory node — global (per-pipe) state.

Reads the xTrace credentials and default scope from the node config and
holds them for the instance-level tool functions. Connection details are
validated once here so every ``remember`` / ``recall`` call reuses them.
"""

from __future__ import annotations

import os
from typing import List

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning


def _split_group_ids(raw: object) -> List[str]:
    """Accept a comma-separated string or a list and return a clean id list."""
    if isinstance(raw, list):
        return [str(g).strip() for g in raw if str(g).strip()]
    if isinstance(raw, str):
        return [g.strip() for g in raw.split(',') if g.strip()]
    return []


# Defaults / bounds (avoid magic constants scattered in the code).
_DEFAULT_BASE_URL = 'https://api.production.xtrace.ai'
_DEFAULT_INGEST_TIMEOUT = 30
_MAX_INGEST_TIMEOUT = 120


class IGlobal(IGlobalBase):
    """Global state for xtrace_memory."""

    api_key: str = ''
    org_id: str = ''
    base_url: str = _DEFAULT_BASE_URL
    user_id: str = ''
    agent_id: str = ''
    app_id: str = ''
    group_ids: List[str] = []
    wait: bool = True
    ingest_timeout: int = _DEFAULT_INGEST_TIMEOUT
    extract_artifacts: bool = False
    search_mode: str = 'compose'
    search_limit: int = 10

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = str(cfg.get('api_key') or os.environ.get('XTRACE_API_KEY', '')).strip()
        org_id = str(cfg.get('org_id') or os.environ.get('XTRACE_ORG_ID', '')).strip()

        if not api_key:
            error('xtrace_memory: api_key is required — set it in node config or the XTRACE_API_KEY env var')
            raise ValueError('xtrace_memory: api_key is required')
        if not org_id:
            error('xtrace_memory: org_id is required — set it in node config or the XTRACE_ORG_ID env var')
            raise ValueError('xtrace_memory: org_id is required')

        self.api_key = api_key
        self.org_id = org_id
        self.base_url = str(cfg.get('base_url') or _DEFAULT_BASE_URL).strip().rstrip('/')
        self.user_id = str(cfg.get('user_id') or '').strip()
        self.agent_id = str(cfg.get('agent_id') or '').strip()
        self.app_id = str(cfg.get('app_id') or '').strip()
        self.group_ids = _split_group_ids(cfg.get('group_ids'))
        self.wait = bool(cfg.get('wait', True))

        raw_timeout = cfg.get('ingest_timeout', _DEFAULT_INGEST_TIMEOUT)
        self.ingest_timeout = max(
            1, min(_MAX_INGEST_TIMEOUT, int(raw_timeout if raw_timeout is not None else _DEFAULT_INGEST_TIMEOUT))
        )

        self.extract_artifacts = bool(cfg.get('extract_artifacts', False))

        mode = str(cfg.get('search_mode') or 'compose').strip().lower()
        self.search_mode = mode if mode in ('compose', 'retrieve') else 'compose'

        raw_limit = cfg.get('search_limit', 10)
        self.search_limit = max(1, min(100, int(raw_limit if raw_limit is not None else 10)))

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            api_key = str(cfg.get('api_key') or os.environ.get('XTRACE_API_KEY', '')).strip()
            org_id = str(cfg.get('org_id') or os.environ.get('XTRACE_ORG_ID', '')).strip()
            if not api_key:
                warning('api_key is required')
            if not org_id:
                warning('org_id is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.api_key = ''
