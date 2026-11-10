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
resolved node config. Tool logic lives on IInstance via @tool_function;
pipeline lane handlers live there too (dual node).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Dict, Optional

from rocketlib import IGlobalBase

DEFAULT_BASE_URL = 'http://localhost:5678'


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
        # The resolved config: the selected result mode's timeout and the
        # selected webhook auth's credential flattened beside the shared leaves,
        # every value typed and ranged by the schema. The credentials arrive as
        # ${ROCKETRIDE_N8N_*} references resolved per call, no process-env fallback.
        cfg = self.config

        # NOTE: deliberately NOT validated via validate_public_url: n8n is
        # commonly self-hosted on localhost / a private IP, which that SSRF guard
        # rejects. Like the database / vector-store nodes, we accept the user's
        # host as-is. SSRF is contained at the tool face instead (IInstance).
        self.base_url = cfg.baseUrl.strip().rstrip('/')
        self.api_key = str(cfg.apiKey or '').strip()
        self.default_workflow = str(cfg.workflow or '').strip()
        self.mode = cfg.mode
        self.payload_mode = cfg.payloadMode
        # Only the selected mode's timeout is in the view; the other keeps its class default.
        self.sync_timeout = cfg.get('syncTimeout', self.sync_timeout)
        self.async_timeout = cfg.get('asyncTimeout', self.async_timeout)
        self.verify_tls = cfg.verifyTls
        self.read_only = cfg.readOnly
        self.webhook_auth = self._build_webhook_auth(cfg)

    @staticmethod
    def _build_webhook_auth(cfg: Mapping) -> Optional[Dict[str, str]]:
        """Assemble the per-webhook auth dict (separate from the REST API key) from the active branch."""
        kind = cfg['webhookAuth']
        # The schema's `required` refuses a missing or empty value but lets a
        # whitespace-only one through; refuse it here so the failure names the
        # field instead of surfacing as an invalid header or a bare "Bearer ".
        if kind == 'header':
            name = cfg['webhookHeaderName'].strip()
            if not name:
                raise ValueError('tool_n8n: webhookHeaderName must not be blank')
            return {'type': 'header', 'name': name, 'value': str(cfg['webhookHeaderValue'])}
        if kind == 'basic':
            return {'type': 'basic', 'user': str(cfg['webhookUser']), 'password': str(cfg.get('webhookPassword') or '')}
        if kind in ('bearer', 'jwt'):
            token = str(cfg['webhookToken']).strip()
            if not token:
                raise ValueError('tool_n8n: webhookToken must not be blank')
            return {'type': kind, 'value': token}
        return None

    def endGlobal(self) -> None:
        self.api_key = ''
        self.webhook_auth = None
