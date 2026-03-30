# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
HTTP Request tool node - global (shared) state.

Reads the node configuration and creates an ``HttpDriver`` that exposes a
single ``http_request`` tool for agent invocation.  The config panel only
provides security guardrails (allowed methods + URL whitelist); the agent
is responsible for supplying the full request details.
"""

from __future__ import annotations

import re
from typing import List, Set

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .http_driver import HttpDriver

_METHOD_FLAGS = {
    'GET': 'allowGET',
    'POST': 'allowPOST',
    'PUT': 'allowPUT',
    'PATCH': 'allowPATCH',
    'DELETE': 'allowDELETE',
    'HEAD': 'allowHEAD',
    'OPTIONS': 'allowOPTIONS',
}


class IGlobal(IGlobalBase):
    """Global state for http_request."""

    driver: HttpDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        server_name = str((cfg.get('serverName') or 'http')).strip()

        enabled_methods, url_patterns = self._build_guardrails(cfg)

        try:
            self.driver = HttpDriver(
                server_name=server_name,
                enabled_methods=enabled_methods,
                url_patterns=url_patterns,
            )
        except Exception as e:
            warning(str(e))
            raise

    @staticmethod
    def _build_guardrails(cfg: dict) -> tuple[Set[str], List[re.Pattern]]:
        """Read allowed-methods checkboxes and URL whitelist from the config."""
        enabled: Set[str] = set()
        for method, flag in _METHOD_FLAGS.items():
            if cfg.get(flag, method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')):
                enabled.add(method)

        raw_whitelist = cfg.get('urlWhitelist') or []
        if not isinstance(raw_whitelist, list):
            import json

            try:
                raw_whitelist = json.loads(str(raw_whitelist))
            except (json.JSONDecodeError, TypeError, ValueError):
                raw_whitelist = []
        patterns: List[re.Pattern] = []
        for row in raw_whitelist:
            if not hasattr(row, 'get'):
                continue
            pat_str = str(row.get('whitelistPattern') or '').strip()
            if pat_str:
                try:
                    patterns.append(re.compile(pat_str))
                except re.error as e:
                    warning(f'Invalid URL whitelist regex {pat_str!r}: {e}')

        return enabled, patterns

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            server_name = str((cfg.get('serverName') or '')).strip()
            if not server_name:
                warning('serverName is required')

            _, patterns = self._build_guardrails(cfg)
            if not patterns:
                warning('URL whitelist is empty — all URLs will be allowed')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
