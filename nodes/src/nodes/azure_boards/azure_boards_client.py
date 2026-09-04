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

"""Standalone Azure DevOps REST API v7.1 client: WIQL query + batch fetch.

Has no rocketlib/engine dependency, so it can be loaded directly (bypassing
the nodes.azure_boards package __init__, which pulls in the engine) — this
is what lets nodes/test/azure_boards/test_live.py exercise the real Azure
DevOps API without a running engine. Raises on request/HTTP failure rather
than swallowing errors; IEndpoint.py is responsible for catching around the
pull loop and reporting failures the way the engine expects.

``requests`` is imported lazily inside build_session() rather than at module
top, so merely importing this module never requires it to be installed —
IGlobal.beginGlobal() is what installs it via depends() before any of this
runs for real; only actually building a session does.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Dict, Iterator, List, Optional

if TYPE_CHECKING:
    import requests

REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRY_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 30
API_VERSION = '7.1'
BATCH_SIZE = 200  # workitemsbatch's hard per-call limit


def build_session(personal_access_token: str) -> 'requests.Session':
    """Build a requests Session pre-authenticated for Azure DevOps (PAT via Basic auth).

    Azure DevOps PATs are sent as HTTP Basic auth with an empty username and
    the PAT as the password — there is no separate username to supply.
    """
    import requests
    from requests.auth import HTTPBasicAuth

    session = requests.Session()
    session.auth = HTTPBasicAuth('', personal_access_token)
    session.headers.update({'Accept': 'application/json'})
    return session


def _request_with_retry(session: 'requests.Session', method: str, url: str, **kwargs: Any) -> 'requests.Response':
    """Request with bounded retry on 429, honoring the ``Retry-After`` header.

    Mirrors confluence_client.py's _get_with_retry, generalized to any HTTP
    method since Azure DevOps's WIQL and batch endpoints are both POST.
    """
    for attempt in range(MAX_RETRY_ATTEMPTS):
        response = session.request(method, url, timeout=REQUEST_TIMEOUT_SECONDS, **kwargs)
        if response.status_code != 429 or attempt == MAX_RETRY_ATTEMPTS - 1:
            return response

        try:
            delay = max(0.0, min(float(response.headers.get('Retry-After', 1)), MAX_RETRY_AFTER_SECONDS))
        except (TypeError, ValueError):
            delay = 1.0
        time.sleep(delay)

    return response


def query_work_item_ids(session: 'requests.Session', organization: str, project: str, wiql: str) -> List[int]:
    """Run a WIQL query and return the matching work item IDs (no fields).

    WIQL only returns ``{id, url}`` references — full field data requires a
    separate batch fetch (see fetch_work_items_batch).

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
    """
    url = f'https://dev.azure.com/{organization}/{project}/_apis/wit/wiql'
    response = _request_with_retry(session, 'POST', url, params={'api-version': API_VERSION}, json={'query': wiql})
    response.raise_for_status()
    return [item['id'] for item in response.json().get('workItems', [])]


def fetch_work_items_batch(session: 'requests.Session', organization: str, ids: List[int]) -> Iterator[Dict[str, Any]]:
    """Fetch full field data for a list of work item IDs, chunked at BATCH_SIZE.

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
    """
    url = f'https://dev.azure.com/{organization}/_apis/wit/workitemsbatch'
    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start : start + BATCH_SIZE]
        response = _request_with_retry(
            session, 'POST', url, params={'api-version': API_VERSION}, json={'ids': chunk, '$expand': 'all'}
        )
        response.raise_for_status()
        yield from response.json().get('value', [])


def iter_work_items(
    session: 'requests.Session', organization: str, project: str, wiql: str, max_records: Optional[int] = None
) -> Iterator[Dict[str, Any]]:
    """Run the WIQL query, then yield full work item records, capped at max_records.

    Args:
        session: Pre-authenticated HTTP session (see build_session).
        organization: Azure DevOps organization name.
        project: Project to query.
        wiql: Work Item Query Language query text; must select System.Id.
        max_records: Stop after this many work items total. ``None`` means
            no cap (bounded only by whatever the WIQL query itself matches).

    Yields:
        dict: Raw Azure DevOps work item objects (id, fields, etc.).

    Raises:
        requests.RequestException: on a network failure or non-2xx response.
    """
    ids = query_work_item_ids(session, organization, project, wiql)
    if max_records is not None:
        ids = ids[:max_records]
    yield from fetch_work_items_batch(session, organization, ids)
