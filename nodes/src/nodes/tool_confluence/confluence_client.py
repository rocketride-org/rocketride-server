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

"""Confluence Cloud REST client: basic auth (email + API token), retry, error
normalization, and storage-format (XHTML) <-> plain text helpers.

Endpoints targeted (Confluence Cloud, ``https://<site>.atlassian.net/wiki``):

* ``GET  /rest/api/search?cql=...``   -- CQL search (v1; CQL has no v2 equivalent)
* ``GET  /api/v2/pages/{id}?body-format=storage``
* ``GET  /api/v2/spaces?keys=KEY``    -- resolve a space key to a spaceId
* ``POST /api/v2/pages``              -- create
* ``PUT  /api/v2/pages/{id}``         -- update (requires version.number = current + 1)
"""

from __future__ import annotations

import html
import re
import time
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional

DEFAULT_TIMEOUT = 30


class ConfluenceAPIError(ValueError):
    """Raised when the Confluence API returns an error (or retries are exhausted)."""

    def __init__(self, status_code: int, message: str):
        super().__init__(f'Confluence API {status_code}: {message}')
        self.status_code = status_code


def request(
    method: str,
    path: str,
    *,
    base_url: str,
    email: str,
    api_key: str,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    max_retries: int = 3,
    base_delay: float = 2.0,
) -> Dict[str, Any]:
    """Execute one Confluence call; every failure mode raises ``ConfluenceAPIError``."""
    import requests  # lazy

    url = f'{base_url.rstrip("/")}{path}'
    headers = {'Accept': 'application/json'}
    if json_body is not None:
        headers['Content-Type'] = 'application/json'
    for attempt in range(max_retries + 1):
        try:
            resp = requests.request(
                method,
                url,
                headers=headers,
                auth=(email, api_key),
                json=json_body,
                params=params,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.exceptions.RequestException as exc:
            if attempt < max_retries:
                time.sleep(base_delay * (2**attempt))
                continue
            raise ConfluenceAPIError(0, f'{type(exc).__name__}: {exc}') from exc

        if (resp.status_code == 429 or 500 <= resp.status_code < 600) and attempt < max_retries:
            delay = base_delay * (2**attempt)
            retry_after = resp.headers.get('Retry-After')
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    pass
            time.sleep(delay)
            continue

        if resp.ok:
            if not resp.content:
                return {}
            try:
                return resp.json()
            except ValueError as exc:
                raise ConfluenceAPIError(resp.status_code, 'Expected JSON in successful response') from exc

        _raise_for_error(resp)

    raise ConfluenceAPIError(0, 'max retries exceeded')


def _raise_for_error(resp) -> None:
    try:
        body = resp.json()
        message = body.get('message') or body.get('title') or resp.text
        errors = body.get('errors')
        if errors:
            message = f'{message}: {errors}'
    except (ValueError, AttributeError):
        message = resp.text or resp.reason or 'unknown error'
    raise ConfluenceAPIError(resp.status_code, message)


# ---------------------------------------------------------------------------
# Body conversion
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre'}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: List[str] = []

    def handle_starttag(self, tag, attrs) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append('\n')

    def handle_endtag(self, tag) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append('\n')

    def handle_data(self, data) -> None:
        self.parts.append(data)


def storage_to_text(storage: str) -> str:
    """Flatten Confluence storage-format XHTML into readable plain text."""
    parser = _TextExtractor()
    parser.feed(storage or '')
    parser.close()
    text = ''.join(parser.parts)
    text = re.sub(r'[ \t]+\n', '\n', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def text_to_storage(text: str) -> str:
    """Convert plain text to storage format: blank-line separated paragraphs,
    single newlines become ``<br/>``, everything HTML-escaped.
    """
    paragraphs = [p for p in re.split(r'\n\s*\n', (text or '').strip()) if p.strip()]
    return ''.join(f'<p>{html.escape(p.strip()).replace(chr(10), "<br/>")}</p>' for p in paragraphs)


def resolve_space_id(space_key: str, **auth: Any) -> str:
    """Resolve a space key (e.g. ``ENG``) to the numeric spaceId the v2 API needs."""
    resp = request('GET', '/api/v2/spaces', params={'keys': space_key, 'limit': 1}, **auth)
    results = resp.get('results') or []
    if not results:
        raise ConfluenceAPIError(404, f'space with key {space_key!r} not found')
    return str(results[0]['id'])
