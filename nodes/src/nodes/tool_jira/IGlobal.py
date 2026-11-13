# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================
"""
Jira tool node - global (shared) state.

Reads the site, account and API token from the node config, falling back to
the ROCKETRIDE_JIRA_* environment variables (config wins), plus the guardrails:
read-only mode, the project allowlist, the result cap and a label for created
issues. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os
from typing import Any, List, Optional

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

from . import jira_client

SITE_URL_ENV = 'ROCKETRIDE_JIRA_SITE_URL'
EMAIL_ENV = 'ROCKETRIDE_JIRA_EMAIL'
API_TOKEN_ENV = 'ROCKETRIDE_JIRA_API_TOKEN'
DEFAULT_MAX_RESULTS = 25


def _as_bool(value: Any, default: bool) -> bool:
    """Coerce a config value to bool, tolerating string forms ('true'/'false')."""
    if isinstance(value, bool):
        return value
    text = '' if value is None else str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on'):
        return True
    if text in ('0', 'false', 'no', 'off'):
        return False
    return default  # empty or unrecognized: keep the default, so a typo can't turn readOnly off


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _setting(cfg: dict, key: str, env: str) -> str:
    return str(cfg.get(key) or '').strip() or os.environ.get(env, '').strip()


class IGlobal(IGlobalBase):
    """Global state for tool_jira."""

    auth: Optional[jira_client.Auth] = None
    read_only: bool = True
    projects: List[str] = []
    max_results: int = DEFAULT_MAX_RESULTS
    created_label: str = ''

    def _read(self) -> None:
        """Parse the config into this object, raising on anything missing or invalid."""
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        site_url = _setting(cfg, 'siteUrl', SITE_URL_ENV)
        email = _setting(cfg, 'email', EMAIL_ENV)
        api_token = _setting(cfg, 'apiToken', API_TOKEN_ENV)
        missing = [
            name for name, value in (('siteUrl', site_url), ('email', email), ('apiToken', api_token)) if not value
        ]
        if missing:
            raise ValueError(
                f'tool_jira: {", ".join(missing)} required (node config or {SITE_URL_ENV}, {EMAIL_ENV}, {API_TOKEN_ENV})'
            )
        try:
            self.auth = jira_client.Auth(jira_client.normalize_site_url(site_url), email, api_token)
            self.projects = jira_client.parse_projects(str(cfg.get('projects') or ''))
        except jira_client.JiraAPIError as exc:
            raise ValueError(f'tool_jira: {exc}') from exc
        self.read_only = _as_bool(cfg.get('readOnly'), True)
        self.max_results = max(1, min(jira_client.MAX_RESULTS_CAP, _as_int(cfg.get('maxResults'), DEFAULT_MAX_RESULTS)))
        self.created_label = str(cfg.get('createdLabel') or '').strip()

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        try:
            self._read()
        except ValueError as exc:
            error(str(exc))
            raise

    def validateConfig(self) -> None:
        try:
            self._read()
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.auth = None
