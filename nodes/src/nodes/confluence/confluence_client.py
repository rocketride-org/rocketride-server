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
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, Optional
from urllib.parse import parse_qs, urlparse

import requests
from requests.auth import HTTPBasicAuth

REQUEST_TIMEOUT_SECONDS = 30


def build_session(email: str, api_token: str) -> requests.Session:
    """Build a requests Session pre-authenticated for Confluence Cloud (Basic auth)."""
    session = requests.Session()
    session.auth = HTTPBasicAuth(email, api_token)
    session.headers.update({'Accept': 'application/json'})
    return session


def extract_cursor(next_link: str) -> str:
    """Pull the ``cursor`` query parameter out of a Confluence ``_links.next`` URL."""
    values = parse_qs(urlparse(next_link).query).get('cursor')
    return values[0] if values else ''


def iter_space_pages(session: requests.Session, base_url: str, space_key: str, limit: int) -> Iterator[Dict[str, Any]]:
    """Yield every page dict in the space, following cursor pagination.

    Calls Confluence REST API v2's ``GET /api/v2/pages`` filtered by space
    key, requesting storage-format bodies inline so no second request per
    page is needed. Follows the ``_links.next`` cursor until the API stops
    returning one.

    Args:
        session: Pre-authenticated HTTP session (see build_session).
        base_url: Confluence wiki base URL, no trailing slash.
        space_key: The space to pull pages from.
        limit: Page batch size per API call.

    Yields:
        dict: Raw Confluence page objects (id, title, body.storage.value).

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
            Callers that need a run to continue past one bad page/request
            should catch around the loop, not inside this generator.
    """
    cursor: Optional[str] = None
    while True:
        params: Dict[str, Any] = {'space-key': space_key, 'limit': limit, 'body-format': 'storage'}
        if cursor:
            params['cursor'] = cursor

        response = session.get(f'{base_url}/api/v2/pages', params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        payload = response.json()

        yield from payload.get('results', [])

        next_link = payload.get('_links', {}).get('next')
        cursor = extract_cursor(next_link) if next_link else None
        if not cursor:
            return
