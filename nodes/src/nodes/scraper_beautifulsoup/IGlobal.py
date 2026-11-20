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
scraper_beautifulsoup — global (shared) state.

Builds the guarded :class:`Fetcher` from the node configuration. Both
variants share the network-policy fields (timeout, size cap, request pacing,
user agent, URL allow-list); the tool variant keeps its fetcher here, the
source variant's ``IEndpoint`` builds one per scan from the source parameters
via :func:`build_fetcher` and shares it across sources, so pacing holds per
host for the whole run.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ai.common.config import Config
from ai.common.utils import (
    canonicalize_url,
    check_allow_pattern,
    config_int,
    pinned_session,
    resolve_public_addresses,
    url_matches_pattern,
)
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .scrape_fetch import DEFAULT_USER_AGENT, Fetcher, compile_patterns

DEFAULT_TIMEOUT_S = 20
DEFAULT_MAX_BYTES_KB = 5 * 1024
DEFAULT_INTERVAL_MS = 250
DEFAULT_MAX_BODY_CHARS = 20000
DEFAULT_MAX_TOOL_CHARS = 20000
# Fixed bounds for the operator's ceiling on one tool result (about 50k tokens at most).
MIN_TOOL_CHARS = 1000
MAX_TOOL_CHARS = 200_000


def allow_patterns(cfg: Dict[str, Any]) -> List[re.Pattern]:
    """Compile the URL allow-list; every pattern must pin the scheme and host (``ValueError`` otherwise)."""
    patterns = compile_patterns(cfg.get('urlAllowList'))
    for pattern in patterns:
        check_allow_pattern(pattern)
    return patterns


def request_interval_ms(cfg: Dict[str, Any]) -> int:
    """The per-host pacing gap in ms; an explicit 0 disables pacing.

    ``config_int`` reads 0 as "unset" and returns the default, but this
    setting documents 0 as "no pacing".
    """
    try:
        if float(cfg.get('requestIntervalMs')) == 0:
            return 0
    except (TypeError, ValueError):
        pass
    return config_int(cfg, 'requestIntervalMs', DEFAULT_INTERVAL_MS, min_value=0, max_value=60000)


def build_fetcher(cfg: Dict[str, Any]) -> Fetcher:
    """Create a Fetcher from a (prefix-stripped) node config dict."""
    return Fetcher(
        resolve_url=resolve_public_addresses,
        open_session=pinned_session,
        timeout=float(config_int(cfg, 'timeout', DEFAULT_TIMEOUT_S, min_value=1, max_value=120)),
        max_bytes=config_int(cfg, 'maxResponseKB', DEFAULT_MAX_BYTES_KB, min_value=16, max_value=50 * 1024) * 1024,
        min_interval=request_interval_ms(cfg) / 1000.0,
        user_agent=str(cfg.get('userAgent') or '').strip() or DEFAULT_USER_AGENT,
        allow_patterns=allow_patterns(cfg),
        allow_match=url_matches_pattern,
        canonicalize=canonicalize_url,
    )


class IGlobal(IGlobalBase):
    """Global state for scraper_beautifulsoup."""

    fetcher: Optional[Fetcher] = None
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS
    # Ceiling on the characters one tool call returns; the agent's max_chars can only lower it.
    max_tool_chars: int = DEFAULT_MAX_TOOL_CHARS

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.fetcher = build_fetcher(cfg)
        self.max_body_chars = config_int(cfg, 'maxBodyChars', DEFAULT_MAX_BODY_CHARS, min_value=200)
        self.max_tool_chars = config_int(
            cfg, 'maxToolChars', DEFAULT_MAX_TOOL_CHARS, min_value=MIN_TOOL_CHARS, max_value=MAX_TOOL_CHARS
        )

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            allow_patterns(cfg)
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.fetcher = None
