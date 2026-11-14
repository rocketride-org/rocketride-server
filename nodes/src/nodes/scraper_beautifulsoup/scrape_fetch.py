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
allow-list (matched by an injected ``allow_match``, in the engine
``ai.common.utils.url_matches_pattern``, which only trusts patterns that pin
the scheme and host), then resolved once by an injected ``resolve_url`` callable — in
the engine ``ai.common.utils.resolve_public_addresses``, which rejects
non-public hosts. The request is sent through ``open_session(addresses)``
(``ai.common.utils.pinned_session``), which connects only to those validated
addresses, so a second DNS answer cannot redirect it (no rebinding gap).
Redirects are followed manually so each ``Location`` is re-resolved and
re-validated; responses are streamed and capped at ``max_bytes``; requests to
the same host are paced by ``min_interval``. ``timeout`` bounds the whole
fetch (every hop, connect and body read), not each socket operation. Error
messages carry the URL without its query string, so keys in a query never
reach the logs.

This module has no engine imports so it can be unit-tested standalone.
"""

from __future__ import annotations

import json
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urljoin, urlparse, urlsplit

import requests

DEFAULT_USER_AGENT = 'RocketRide-Scraper/1.0 (+https://rocketride.org)'
REDIRECT_CODES = (301, 302, 303, 307, 308)
# Headers still sent after a redirect to a different origin; all others are dropped.
SAFE_REDIRECT_HEADERS = frozenset({'user-agent', 'accept', 'accept-language'})


def redact_url(url: str) -> str:
    """``url`` without query string, fragment or userinfo, for error messages."""
    try:
        parts = urlsplit(url)
        netloc = parts.netloc.rpartition('@')[2]
        return parts._replace(netloc=netloc, query='', fragment='').geturl()
    except ValueError:
        return '<invalid URL>'


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
        if self.truncated:
            # Parsing half a document would report a syntax error, hiding the size limit.
            raise ValueError('the response is larger than "Max response size" and was cut off')
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
    allow_match: Optional[Callable[[re.Pattern, str], bool]] = None

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._last_hit: Dict[str, float] = {}

    # -- policy -----------------------------------------------------------

    def check_url(self, url: str) -> Any:
        """Validate one URL (scheme, allow-list, public host); returns the resolved addresses."""
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise FetchError(f'Only absolute http(s) URLs are allowed: {redact_url(url)!r}')
        if self.allow_patterns:
            if self.allow_match is None:
                # Fail closed: a plain re.search would accept the pattern anywhere in the URL.
                raise FetchError('URL allow-list is set but no allow-list matcher is configured')
            if not any(self.allow_match(p, url) for p in self.allow_patterns):
                raise FetchError(f'URL is not in the allow-list: {redact_url(url)}')
        try:
            return self.resolve_url(url)
        except ValueError as e:
            raise FetchError(str(e)) from e

    def _pace(self, url: str) -> float:
        """Sleep out the per-host interval; returns the seconds slept."""
        if self.min_interval <= 0:
            return 0.0
        host = (urlparse(url).hostname or '').lower()
        with self._lock:
            now = time.monotonic()
            wait = self._last_hit.get(host, 0.0) + self.min_interval - now
            self._last_hit[host] = now + max(wait, 0.0)
        if wait > 0:
            time.sleep(wait)
            return wait
        return 0.0

    def _remaining(self, deadline: float, url: str) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError(f'Fetching {redact_url(url)} timed out after {self.timeout:g}s')
        return remaining

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
        """Fetch ``url``, following redirects manually with re-validation.

        ``timeout`` covers the whole call: every redirect hop, each connect
        attempt and the body read share one deadline. Time spent pacing is
        politeness, not network time, and extends the deadline.
        """
        method = (method or 'GET').upper()
        if method not in ('GET', 'POST'):
            raise FetchError(f'Unsupported method: {method}')

        send_headers = {'User-Agent': self.user_agent, 'Accept': '*/*'}
        send_headers.update({str(k): str(v) for k, v in (headers or {}).items()})
        if any(k.lower() == 'host' for k in send_headers):
            raise FetchError('The Host header is derived from the validated URL and cannot be overridden')

        deadline = time.monotonic() + self.timeout
        current = url
        for _hop in range(self.max_redirects + 1):
            self._remaining(deadline, current)
            addresses = self.check_url(current)
            deadline += self._pace(current)
            timeout = self._remaining(deadline, current)
            session = self.open_session(addresses)
            try:
                resp = session.request(
                    method,
                    current,
                    headers=send_headers,
                    params=params,
                    json=json_body if method == 'POST' else None,
                    timeout=timeout,
                    allow_redirects=False,
                    stream=True,
                )
            except requests.RequestException as e:
                session.close()
                # The exception text repeats the URL (query included): report its type only.
                raise FetchError(f'{method} {redact_url(current)} failed: {type(e).__name__}') from e

            try:
                if resp.status_code in REDIRECT_CODES and resp.headers.get('location'):
                    target = urljoin(current, resp.headers['location'])
                    if _origin(target) != _origin(current):
                        if json_body is not None and resp.status_code in (307, 308):
                            # 307/308 resend the body, which can carry a key: never to another origin.
                            raise FetchError('Refusing to forward a request body to a different origin')
                        # Caller headers may carry credentials (Authorization,
                        # API keys): never forward them to another origin.
                        send_headers = {k: v for k, v in send_headers.items() if k.lower() in SAFE_REDIRECT_HEADERS}
                    current = target
                    # Query params were already applied to the first URL.
                    params = None
                    if resp.status_code == 303 or (resp.status_code in (301, 302) and method == 'POST'):
                        method, json_body = 'GET', None
                    continue

                content, truncated = self._read_capped(resp, deadline, current)
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
                raise FetchError(f'{method} {redact_url(current)} returned HTTP {result.status}')
            return result

        raise FetchError(f'Too many redirects (>{self.max_redirects}) starting at {redact_url(url)}')

    def _read_capped(self, resp: requests.Response, deadline: float, url: str) -> tuple[bytes, bool]:
        """Stream the body, stopping at ``max_bytes`` or the deadline; returns (content, truncated).

        A read blocks until a whole chunk arrives, so a server trickling bytes
        could hold it far past the deadline. A watchdog therefore shuts the
        socket down at the deadline, which ends the blocked read.
        """
        timed_out = threading.Event()
        sock = _response_socket(resp)

        def abort() -> None:
            timed_out.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        watchdog = threading.Timer(self._remaining(deadline, url), abort) if sock is not None else None
        if watchdog is not None:
            watchdog.daemon = True
            watchdog.start()
        chunks: List[bytes] = []
        total = 0
        try:
            for chunk in resp.iter_content(chunk_size=65536):
                self._remaining(deadline, url)
                if not chunk:
                    continue
                total += len(chunk)
                if total > self.max_bytes:
                    chunks.append(chunk[: len(chunk) - (total - self.max_bytes)])
                    return b''.join(chunks), True
                chunks.append(chunk)
        except Exception as e:
            if timed_out.is_set():
                raise FetchError(f'Fetching {redact_url(url)} timed out after {self.timeout:g}s') from e
            if isinstance(e, (requests.RequestException, OSError)):
                raise FetchError(f'Reading {redact_url(url)} failed: {type(e).__name__}') from e
            raise
        finally:
            if watchdog is not None:
                watchdog.cancel()
        if timed_out.is_set():
            # A body without Content-Length ends "normally" when the socket closes.
            raise FetchError(f'Fetching {redact_url(url)} timed out after {self.timeout:g}s')
        return b''.join(chunks), False


def _response_socket(resp: requests.Response) -> Optional[socket.socket]:
    """The socket under a streamed response, or None if it cannot be reached."""
    connection = getattr(resp.raw, 'connection', None) or getattr(resp.raw, '_connection', None)
    sock = getattr(connection, 'sock', None)
    if not isinstance(sock, socket.socket):
        # When the response closes the connection, http.client drops
        # ``connection.sock`` and the socket lives on in the response's file
        # (urllib3 response -> http.client response -> BufferedReader -> SocketIO).
        fp = getattr(getattr(resp.raw, '_fp', None), 'fp', None)
        sock = getattr(getattr(fp, 'raw', None), '_sock', None)
    return sock if isinstance(sock, socket.socket) else None


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
