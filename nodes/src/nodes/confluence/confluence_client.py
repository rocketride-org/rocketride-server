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

"""Standalone Confluence Cloud REST API v2 client: session + pagination.

Has no rocketlib/engine dependency, so it can be loaded directly (bypassing
the nodes.confluence package __init__, which pulls in the engine) — this is
what lets nodes/test/confluence/test_live.py exercise the real Confluence API
without a running engine. Raises on request/HTTP failure rather than
swallowing errors; IEndpoint.py is responsible for catching around the
pagination loop and reporting failures the way the engine expects.

``requests`` is imported lazily inside build_session() rather than at module
top, so merely importing this module never requires it to be installed —
IGlobal.beginGlobal() is what installs it via depends() before any of this
runs for real; only actually building a session does.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Dict, Iterator, Optional
from urllib.parse import parse_qs, urlparse

if TYPE_CHECKING:
    import requests

REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRY_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 30


def build_session(email: str, api_token: str) -> 'requests.Session':
    """Build a requests Session pre-authenticated for Confluence Cloud (Basic auth)."""
    import requests
    from requests.auth import HTTPBasicAuth

    session = requests.Session()
    session.auth = HTTPBasicAuth(email, api_token)
    session.headers.update({'Accept': 'application/json'})
    return session


def _get_with_retry(session: 'requests.Session', url: str, params: Dict[str, Any]) -> 'requests.Response':
    """GET with bounded retry on 429, honoring the ``Retry-After`` header.

    Confluence Cloud rate-limits aggressively; a naive raise on the first 429
    would abort an otherwise-healthy pull. Retries up to MAX_RETRY_ATTEMPTS
    times, sleeping for the server-specified Retry-After (capped at
    MAX_RETRY_AFTER_SECONDS so a misbehaving response can't stall the node
    indefinitely). Any other status is left to raise_for_status() as before.
    """
    for attempt in range(MAX_RETRY_ATTEMPTS):
        response = session.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        if response.status_code != 429 or attempt == MAX_RETRY_ATTEMPTS - 1:
            return response

        try:
            delay = max(0.0, min(float(response.headers.get('Retry-After', 1)), MAX_RETRY_AFTER_SECONDS))
        except (TypeError, ValueError):
            delay = 1.0
        time.sleep(delay)

    return response


def extract_cursor(next_link: str) -> str:
    """Pull the ``cursor`` query parameter out of a Confluence ``_links.next`` URL."""
    values = parse_qs(urlparse(next_link).query).get('cursor')
    return values[0] if values else ''


def resolve_space_id(session: 'requests.Session', base_url: str, space_key: str) -> str:
    """Resolve a Confluence space key to its numeric space ID.

    Confluence REST API v2 has no ``space-key`` filter on ``/api/v2/pages`` —
    only the v1 API supported that. v2 requires the numeric space ID, so the
    key must first be resolved via ``GET /api/v2/spaces?keys=<key>``.

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
        ValueError: if no space with that key is visible to this account.
    """
    response = _get_with_retry(session, f'{base_url}/api/v2/spaces', {'keys': space_key})
    response.raise_for_status()
    results = response.json().get('results', [])
    if not results:
        raise ValueError(f'no Confluence space found for key {space_key!r}')
    return str(results[0]['id'])


def iter_space_pages(
    session: 'requests.Session', base_url: str, space_key: str, limit: int, max_pages: Optional[int] = None
) -> Iterator[Dict[str, Any]]:
    """Yield every page dict in the space, following cursor pagination.

    Resolves the space key to a numeric space ID (see resolve_space_id), then
    calls Confluence REST API v2's ``GET /api/v2/spaces/{id}/pages``,
    requesting storage-format bodies inline so no second request per page is
    needed. Follows the ``_links.next`` cursor until the API stops returning
    one, or until ``max_pages`` total pages have been yielded — a hard cap so
    a large corporate space doesn't get fully re-ingested (and re-embedded
    downstream) on every run by default.

    A 429 response is retried with bounded backoff honoring ``Retry-After``
    (see _get_with_retry) before this raises.

    Args:
        session: Pre-authenticated HTTP session (see build_session).
        base_url: Confluence wiki base URL, no trailing slash.
        space_key: The space to pull pages from.
        limit: Page batch size per API call.
        max_pages: Stop after yielding this many pages total, regardless of
            how many more the space has. ``None`` means no cap.

    Yields:
        dict: Raw Confluence page objects (id, title, body.storage.value).

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
        ValueError: if space_key doesn't resolve to a real space.
            Callers that need a run to continue past one bad page/request
            should catch around the loop, not inside this generator.
    """
    space_id = resolve_space_id(session, base_url, space_key)

    cursor: Optional[str] = None
    yielded = 0
    while True:
        params: Dict[str, Any] = {'limit': limit, 'body-format': 'storage'}
        if cursor:
            params['cursor'] = cursor

        response = _get_with_retry(session, f'{base_url}/api/v2/spaces/{space_id}/pages', params)
        response.raise_for_status()
        payload = response.json()

        for page in payload.get('results', []):
            if max_pages is not None and yielded >= max_pages:
                return
            yield page
            yielded += 1

        next_link = payload.get('_links', {}).get('next')
        cursor = extract_cursor(next_link) if next_link else None
        if not cursor:
            return
