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

Reads config and stores security guardrails (allowed methods + URL whitelist)
and rate limiter for IInstance tool methods.
"""

from __future__ import annotations

import re
from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .rate_limiter import DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_PER_MINUTE, DEFAULT_MAX_PER_SECOND, RateLimiter

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

    enabled_methods: set[str] | None = None
    url_patterns: list[re.Pattern] | None = None
    rate_limiter: RateLimiter | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.enabled_methods, self.url_patterns = self._build_guardrails(cfg)
        self.rate_limiter = self._build_rate_limiter(cfg)

    @staticmethod
    def _build_guardrails(cfg: dict) -> tuple[set[str], list[re.Pattern]]:
        """Read allowed-methods checkboxes and URL whitelist from the config."""
        enabled: set[str] = set()
        for method, flag in _METHOD_FLAGS.items():
            if cfg.get(flag, method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')):
                enabled.add(method)

        raw_whitelist = cfg.get('urlWhitelist') or []
        if not isinstance(raw_whitelist, list):
            import json

            try:
                raw_whitelist = json.loads(str(raw_whitelist))
                if not isinstance(raw_whitelist, list):
                    raise ValueError(f'urlWhitelist must be a JSON array, got {type(raw_whitelist).__name__}')
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                raise ValueError(f'urlWhitelist is malformed and cannot be parsed: {e}') from e
        patterns: list[re.Pattern] = []
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

    @staticmethod
    def _build_rate_limiter(cfg: dict) -> RateLimiter:
        """Create a ``RateLimiter`` from the node configuration."""

        def _int_or_default(key: str, default: int) -> int:
            raw = cfg.get(key)
            if raw is None:
                return default
            try:
                val = int(raw)
                return val if val > 0 else default
            except (TypeError, ValueError):
                return default

        return RateLimiter(
            max_per_second=_int_or_default('rateLimitPerSecond', DEFAULT_MAX_PER_SECOND),
            max_per_minute=_int_or_default('rateLimitPerMinute', DEFAULT_MAX_PER_MINUTE),
            max_concurrent=_int_or_default('maxConcurrentRequests', DEFAULT_MAX_CONCURRENT),
        )

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
        self.enabled_methods = set()
        self.url_patterns = []
        self.rate_limiter = None
