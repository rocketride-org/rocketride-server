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
n8n tool node - global (shared) state.

Reads the n8n instance URL, API key, webhook auth, and run options from the
node config. Tool logic lives on IInstance via @tool_function; pipeline lane
handlers live there too (dual node).
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
N8N_URL_ENV = 'ROCKETRIDE_N8N_URL'
N8N_API_KEY_ENV = 'ROCKETRIDE_N8N_KEY'
N8N_WORKFLOW_ENV = 'ROCKETRIDE_N8N_WORKFLOW'

DEFAULT_BASE_URL = 'http://localhost:5678'


def _as_bool(value: Any, default: bool) -> bool:
    """Coerce a config value to bool, tolerating string forms ('true'/'false')."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


class IGlobal(IGlobalBase):
    """Global state for tool_n8n."""

    base_url: str = DEFAULT_BASE_URL
    api_key: str = ''
    default_workflow: str = ''
    mode: str = 'sync'
    payload_mode: str = 'simple'
    sync_timeout: int = 30
    async_timeout: int = 120
    verify_tls: bool = True
    read_only: bool = True
    webhook_auth: Optional[Dict[str, str]] = None

    def beginGlobal(self) -> None:
        # Opened only to render the config UI — never touch the network or read
        # secrets here (the contract/test harness opens nodes in CONFIG mode).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # NOTE: deliberately NOT validated via validate_public_url — n8n is
        # commonly self-hosted on localhost / a private IP, which that SSRF guard
        # rejects. Like the database / vector-store nodes, we accept the user's
        # host as-is. SSRF is contained at the tool face instead (IInstance).
        base_url = str(cfg.get('baseUrl') or '').strip() or os.environ.get(N8N_URL_ENV, '').strip()
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip('/')

        self.api_key = str(cfg.get('apiKey') or '').strip() or os.environ.get(N8N_API_KEY_ENV, '').strip()
        self.default_workflow = str(cfg.get('workflow') or '').strip() or os.environ.get(N8N_WORKFLOW_ENV, '').strip()
        self.mode = 'async' if str(cfg.get('mode') or 'sync').strip().lower() == 'async' else 'sync'
        self.payload_mode = (
            'structured' if str(cfg.get('payloadMode') or 'simple').strip().lower() == 'structured' else 'simple'
        )
        try:
            self.sync_timeout = max(1, min(3600, int(cfg.get('syncTimeout') or 30)))
        except (ValueError, TypeError):
            self.sync_timeout = 30
        try:
            self.async_timeout = max(5, min(3600, int(cfg.get('asyncTimeout') or 120)))
        except (ValueError, TypeError):
            self.async_timeout = 120
        self.verify_tls = _as_bool(cfg.get('verifyTls'), True)
        self.read_only = _as_bool(cfg.get('readOnly'), True)
        self.webhook_auth = self._build_webhook_auth(cfg)

    def _build_webhook_auth(self, cfg: Dict[str, Any]) -> Optional[Dict[str, str]]:
        """Assemble the per-webhook auth dict (separate from the REST API key)."""
        kind = str(cfg.get('webhookAuth') or 'none').strip().lower()
        if kind == 'header':
            name = str(cfg.get('webhookHeaderName') or '').strip()
            if name:
                return {'type': 'header', 'name': name, 'value': str(cfg.get('webhookHeaderValue') or '')}
        elif kind == 'basic':
            return {
                'type': 'basic',
                'user': str(cfg.get('webhookUser') or ''),
                'password': str(cfg.get('webhookPassword') or ''),
            }
        elif kind in ('bearer', 'jwt'):
            token = str(cfg.get('webhookToken') or '').strip()
            if token:
                return {'type': kind, 'value': token}
        return None

    def validateConfig(self) -> None:
        # Config-only checks (no network) so this is safe to run during canvas
        # config rendering. Catches the misconfigs that would otherwise only
        # surface at runtime.
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            base_url = str(cfg.get('baseUrl') or '').strip() or os.environ.get(N8N_URL_ENV, '').strip()
            if not base_url:
                warning('n8n Base URL is empty — defaulting to http://localhost:5678')
            mode = str(cfg.get('mode') or 'sync').strip().lower()
            api_key = str(cfg.get('apiKey') or '').strip() or os.environ.get(N8N_API_KEY_ENV, '').strip()
            if mode == 'async' and not api_key:
                warning(
                    'n8n: async result mode needs an API key (it polls executions via the public API) — set it or switch to sync.'
                )
            webhook_auth = str(cfg.get('webhookAuth') or 'none').strip().lower()
            if webhook_auth in ('bearer', 'jwt') and not str(cfg.get('webhookToken') or '').strip():
                warning(f'n8n: Webhook auth "{webhook_auth}" selected but no token provided.')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.api_key = ''
        self.webhook_auth = None
