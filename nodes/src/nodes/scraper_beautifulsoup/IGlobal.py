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
user agent, URL allow-list). In the tool variant they are per-call
parameters: each call takes its fetcher from :meth:`IGlobal.fetcher`, a small
cache keyed by the call's values, so calls with the same values share one
fetcher and pacing holds per host across them. The source variant's
``IEndpoint`` builds one per scan from the source parameters via
:func:`build_fetcher` and shares it across sources, so pacing holds per host
for the whole run.
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, Mapping, Optional, Tuple

from ai.common.utils import (
    canonicalize_url,
    config_int,
    pinned_session,
    resolve_public_addresses,
    url_matches_pattern,
)
from depends import depends
from rocketlib import IGlobalBase

from .IValidator import allow_patterns
from .scrape_fetch import DEFAULT_USER_AGENT, Fetcher

# scrape_extract imports bs4 at module scope, and IInstance and IEndpoint load
# it right after this module, so the requirements are installed here first.
# Validating a tool configuration imports IValidator alone and never runs
# this; the source's IEndpoint imports this module, so validating a source does.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

DEFAULT_TIMEOUT_S = 20
DEFAULT_MAX_BYTES_KB = 5 * 1024
DEFAULT_INTERVAL_MS = 250
DEFAULT_MAX_BODY_CHARS = 20000
DEFAULT_MAX_TOOL_CHARS = 20000
# Fixed bounds for the operator's ceiling on one tool result (about 50k tokens at most).
MIN_TOOL_CHARS = 1000
MAX_TOOL_CHARS = 200_000
# Fetchers one control keeps, one per distinct set of network settings its calls use.
MAX_CACHED_FETCHERS = 8


def request_interval_ms(cfg: Mapping[str, Any]) -> int:
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


def build_fetcher(cfg: Mapping[str, Any]) -> Fetcher:
    """Create a Fetcher from a call's settings or a source's (prefix-stripped) parameters."""
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


def fetcher_key(fetcher: Fetcher) -> Tuple[Any, ...]:
    """The network settings a fetcher was built with, as its cache key."""
    return (
        fetcher.timeout,
        fetcher.max_bytes,
        fetcher.min_interval,
        fetcher.user_agent,
        tuple((pattern.pattern, pattern.flags) for pattern in fetcher.allow_patterns),
    )


class IGlobal(IGlobalBase):
    """Global state for scraper_beautifulsoup: a cache of fetchers, never a call's data."""

    # Fetchers by fetcher_key (see fetcher()); created in beginGlobal.
    _fetchers: Optional[Dict[Tuple[Any, ...], Fetcher]] = None
    _fetchers_lock: Optional[threading.Lock] = None

    def beginGlobal(self) -> None:
        # Every network field is a per-call parameter, so nothing is built from
        # self.config here; the calls build (and share) their fetchers.
        self._fetchers = {}
        self._fetchers_lock = threading.Lock()

    def fetcher(self, settings: Mapping[str, Any]) -> Fetcher:
        """The guarded fetcher for one call's network settings.

        Calls with the same settings share one fetcher, so per-host pacing
        holds across them. At most ``MAX_CACHED_FETCHERS`` are kept; the
        oldest is dropped first, which only forgets its pacing times.

        Args:
            settings: The call's settings (``IInstance.settings``).

        Raises:
            RuntimeError: ``beginGlobal`` has not run.
            ValueError: An allow-list pattern is invalid or does not pin the scheme and host.
        """
        fetchers, lock = self._fetchers, self._fetchers_lock
        if fetchers is None or lock is None:
            raise RuntimeError('scraper_beautifulsoup: node is not initialised')
        built = build_fetcher(settings)
        key = fetcher_key(built)
        with lock:
            cached = fetchers.get(key)
            if cached is None:
                if len(fetchers) >= MAX_CACHED_FETCHERS:
                    fetchers.pop(next(iter(fetchers)))
                fetchers[key] = cached = built
        return cached

    def endGlobal(self) -> None:
        self._fetchers = None
        self._fetchers_lock = None
