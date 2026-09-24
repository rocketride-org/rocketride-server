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

"""Guarded HTTP fetcher for scraper_beautifulsoup.

Every request (and every redirect hop) is checked against an optional regex
allow-list, then resolved once by an injected ``resolve_url`` callable — in
the engine ``ai.common.utils.resolve_public_addresses``, which rejects
non-public hosts. The request is sent through ``open_session(addresses)``
(``ai.common.utils.pinned_session``), which connects only to those validated
addresses, so a second DNS answer cannot redirect it (no rebinding gap).
Redirects are followed manually so each ``Location`` is re-resolved and
re-validated; responses are streamed and capped at ``max_bytes``; requests to
the same host are paced by ``min_interval``.

This module has no engine imports so it can be unit-tested standalone.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import requests

DEFAULT_USER_AGENT = 'RocketRide-Scraper/1.0 (+https://rocketride.org)'
REDIRECT_CODES = (301, 302, 303, 307, 308)
# Headers still sent after a redirect to a different origin; all others are dropped.
SAFE_REDIRECT_HEADERS = frozenset({'user-agent', 'accept', 'accept-language'})


def _origin(url: str) -> tuple:
    parsed = urlparse(url)
    return (parsed.scheme, (parsed.hostname or '').lower(), parsed.port)


class FetchError(Exception):
    """Raised when a fetch is blocked, fails, or returns an error status."""


@dataclass
class FetchResult:
    """A completed HTTP response, body already read (and size-capped)."""

    url: str
    status: int
    headers: Dict[str, str]
    content: bytes
    truncated: bool = False

    @property
    def content_type(self) -> str:
        return self.headers.get('content-type', '').split(';')[0].strip().lower()

    def text(self) -> str:
        charset = None
        for part in self.headers.get('content-type', '').split(';')[1:]:
            key, _, value = part.strip().partition('=')
            if key.lower() == 'charset' and value:
                charset = value.strip('"\'')
        try:
            return self.content.decode(charset or 'utf-8', errors='replace')
        except LookupError:
            return self.content.decode('utf-8', errors='replace')

    def json(self) -> Any:
        return json.loads(self.text())


@dataclass
class Fetcher:
    """HTTP client enforcing the node's network policy."""

    resolve_url: Callable[[str], Any]
    open_session: Callable[[Any], requests.Session]
    timeout: float = 20.0
    max_bytes: int = 5 * 1024 * 1024
    max_redirects: int = 5
    min_interval: float = 0.0
    user_agent: str = DEFAULT_USER_AGENT
    allow_patterns: List[re.Pattern] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._last_hit: Dict[str, float] = {}

    # -- policy -----------------------------------------------------------

    def check_url(self, url: str) -> Any:
        """Validate one URL (scheme, allow-list, public host); returns the resolved addresses."""
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise FetchError(f'Only absolute http(s) URLs are allowed: {url!r}')
        if self.allow_patterns and not any(p.search(url) for p in self.allow_patterns):
            raise FetchError(f'URL is not in the allow-list: {url}')
        try:
            return self.resolve_url(url)
        except ValueError as e:
            raise FetchError(str(e)) from e

    def _pace(self, url: str) -> None:
        if self.min_interval <= 0:
            return
        host = (urlparse(url).hostname or '').lower()
        with self._lock:
            now = time.monotonic()
            wait = self._last_hit.get(host, 0.0) + self.min_interval - now
            self._last_hit[host] = now + max(wait, 0.0)
        if wait > 0:
            time.sleep(wait)

    # -- request ----------------------------------------------------------

    def fetch(
        self,
        url: str,
        *,
        method: str = 'GET',
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        json_body: Any = None,
        raise_for_status: bool = True,
    ) -> FetchResult:
        """Fetch ``url``, following redirects manually with re-validation."""
        method = (method or 'GET').upper()
        if method not in ('GET', 'POST'):
            raise FetchError(f'Unsupported method: {method}')

        send_headers = {'User-Agent': self.user_agent, 'Accept': '*/*'}
        send_headers.update({str(k): str(v) for k, v in (headers or {}).items()})

        current = url
        for _hop in range(self.max_redirects + 1):
            addresses = self.check_url(current)
            self._pace(current)
            session = self.open_session(addresses)
            try:
                resp = session.request(
                    method,
                    current,
                    headers=send_headers,
                    params=params,
                    json=json_body if method == 'POST' else None,
                    timeout=self.timeout,
                    allow_redirects=False,
                    stream=True,
                )
            except requests.RequestException as e:
                session.close()
                raise FetchError(f'{method} {current} failed: {e}') from e

            try:
                if resp.status_code in REDIRECT_CODES and resp.headers.get('location'):
                    target = urljoin(current, resp.headers['location'])
                    if _origin(target) != _origin(current):
                        # Caller headers may carry credentials (Authorization,
                        # API keys): never forward them to another origin.
                        send_headers = {k: v for k, v in send_headers.items() if k.lower() in SAFE_REDIRECT_HEADERS}
                    current = target
                    # Query params were already applied to the first URL.
                    params = None
                    if resp.status_code == 303 or (resp.status_code in (301, 302) and method == 'POST'):
                        method, json_body = 'GET', None
                    continue

                content, truncated = self._read_capped(resp)
                result = FetchResult(
                    url=current,
                    status=resp.status_code,
                    headers={k.lower(): v for k, v in resp.headers.items()},
                    content=content,
                    truncated=truncated,
                )
            finally:
                resp.close()
                session.close()

            if raise_for_status and result.status >= 400:
                raise FetchError(f'{method} {current} returned HTTP {result.status}')
            return result

        raise FetchError(f'Too many redirects (>{self.max_redirects}) starting at {url}')

    def _read_capped(self, resp: requests.Response) -> tuple[bytes, bool]:
        """Stream the body, stopping at ``max_bytes``; returns (content, truncated)."""
        chunks: List[bytes] = []
        total = 0
        try:
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                total += len(chunk)
                if total > self.max_bytes:
                    chunks.append(chunk[: len(chunk) - (total - self.max_bytes)])
                    return b''.join(chunks), True
                chunks.append(chunk)
        except requests.RequestException as e:
            raise FetchError(f'Reading {resp.url} failed: {e}') from e
        return b''.join(chunks), False


def compile_patterns(raw: Any) -> List[re.Pattern]:
    """Compile an allow-list given as a list of strings / ``{pattern}`` rows, or newline text."""
    if raw is None or raw == '':
        return []
    if isinstance(raw, str):
        items: List[Any] = [line for line in raw.splitlines()]
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError(f'urlAllowList must be a list or newline-separated text, got {type(raw).__name__}')
    patterns = []
    for item in items:
        if isinstance(item, dict):
            item = next((v for v in item.values() if isinstance(v, str)), '')
        text = str(item or '').strip()
        if not text:
            continue
        try:
            patterns.append(re.compile(text))
        except re.error as e:
            raise ValueError(f'Invalid allow-list regex {text!r}: {e}') from e
    return patterns
