# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
xTrace Memory node - global (per-pipe) state.

Reads the xTrace API key, org id, default memory scope and ingest/recall
options from the resolved node config. The two instance tools reuse this state.
"""

from __future__ import annotations

from typing import List

from rocketlib import IGlobalBase


def _split_group_ids(raw: object) -> List[str]:
    """Accept a comma-separated string or a list and return a clean id list."""
    if isinstance(raw, list):
        return [str(g).strip() for g in raw if str(g).strip()]
    if isinstance(raw, str):
        return [g.strip() for g in raw.split(',') if g.strip()]
    return []


class IGlobal(IGlobalBase):
    """Global state for xtrace_memory."""

    api_key: str = ''
    org_id: str = ''
    base_url: str = 'https://api.production.xtrace.ai'
    user_id: str = ''
    agent_id: str = ''
    app_id: str = ''
    group_ids: List[str] = []
    wait: bool = True
    ingest_timeout: int = 30
    extract_artifacts: bool = False
    search_mode: str = 'compose'
    search_limit: int = 10

    def beginGlobal(self) -> None:
        # The resolved config: the key and org id required by the schema (the key
        # a ${ROCKETRIDE_XTRACE_APIKEY} reference resolved per call, no process-env
        # fallback), bounds and enums validated
        cfg = self.config

        self.api_key = str(cfg.api_key or '').strip()
        self.org_id = cfg.org_id.strip()
        self.base_url = cfg.base_url.strip().rstrip('/')
        self.user_id = str(cfg.user_id or '').strip()
        self.agent_id = str(cfg.agent_id or '').strip()
        self.app_id = str(cfg.app_id or '').strip()
        self.group_ids = _split_group_ids(cfg.group_ids)
        self.wait = cfg.wait
        self.ingest_timeout = cfg.ingest_timeout
        self.extract_artifacts = cfg.extract_artifacts
        self.search_mode = cfg.search_mode
        self.search_limit = cfg.search_limit

    def endGlobal(self) -> None:
        self.api_key = ''
