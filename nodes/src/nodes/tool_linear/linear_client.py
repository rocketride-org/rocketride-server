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
# SOFTWARE.
# =============================================================================

"""Linear GraphQL client: one ``post()``, six documents, filter builders and
rate-limit handling. No engine imports.

Basis (https://linear.app/developers): ``POST https://api.linear.app/graphql``;
a personal API key is sent raw in ``Authorization`` (no ``Bearer``). A rate
limited request returns HTTP 400 with ``errors[].extensions.code ==
"RATELIMITED"`` (not 429). Pagination is Relay cursors (``first``/``after``).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

API_URL = 'https://api.linear.app/graphql'
DEFAULT_TIMEOUT = 30
MAX_PAGE = 100
MAX_TEXT_BYTES = 32 * 1024
LOW_REMAINING = 50
MAX_BACKOFF_SECONDS = 30.0

PRIORITY_LABELS = {0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low'}


class LinearAPIError(ValueError):
    """Raised for any Linear failure: transport, HTTP, GraphQL ``errors[]`` or a failed mutation."""

    def __init__(self, message: str, *, code: str = '', status_code: int = 0, reset_at: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.reset_at = reset_at


# ---------------------------------------------------------------------------
# GraphQL documents (one level of nesting only, to keep complexity low)
# ---------------------------------------------------------------------------

_ISSUE_FIELDS = (
    'id identifier title priority priorityLabel updatedAt url state { name type } assignee { name } team { key }'
)

Q_VIEWER = 'query { viewer { id name } }'

Q_TEAMS = 'query { teams(first: 100) { nodes { id key name } } }'

Q_ISSUES = (
    'query($filter: IssueFilter, $first: Int, $after: String) { '
    'issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { '
    'nodes { ' + _ISSUE_FIELDS + ' } pageInfo { hasNextPage endCursor } } }'
)

Q_ISSUE_BY_ID = (
    'query($id: String!, $comments: Int) { issue(id: $id) { ' + _ISSUE_FIELDS + ' description '
    'comments(first: $comments) { nodes { id body createdAt user { name } } } } }'
)

Q_ISSUE_BY_IDENTIFIER = (
    'query($filter: IssueFilter, $comments: Int) { issues(filter: $filter, first: 1) { nodes { '
    + _ISSUE_FIELDS
    + ' description comments(first: $comments) { nodes { id body createdAt user { name } } } } } }'
)

Q_STATES = (
    'query($filter: WorkflowStateFilter) { workflowStates(filter: $filter, first: 100) { nodes { id name type } } }'
)

Q_TEAM_BY_KEY = 'query($filter: TeamFilter) { teams(filter: $filter, first: 1) { nodes { id key name } } }'

M_ISSUE_CREATE = (
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url '
    'team { key } } } }'
)

M_COMMENT_CREATE = (
    'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }'
)

M_ISSUE_UPDATE = (
    'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { '
    'id identifier url } } }'
)


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def _format_reset(epoch_ms: Any) -> Optional[str]:
    try:
        return datetime.fromtimestamp(float(epoch_ms) / 1000.0, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _maybe_backoff(headers: Any) -> None:
    """Sleep until the rate-limit reset when few requests remain (bounded)."""
    try:
        remaining = int(headers.get('X-RateLimit-Requests-Remaining'))
        reset_ms = float(headers.get('X-RateLimit-Requests-Reset'))
    except (TypeError, ValueError, AttributeError):
        return
    if remaining >= LOW_REMAINING:
        return
    wait = reset_ms / 1000.0 - time.time()
    if wait > 0:
        time.sleep(min(wait, MAX_BACKOFF_SECONDS))


def post(
    query: str,
    variables: Optional[Dict[str, Any]] = None,
    *,
    api_key: str,
    retry: bool = True,
    max_retries: int = 2,
    base_delay: float = 2.0,
) -> Dict[str, Any]:
    """POST one GraphQL document and return ``data``.

    Every failure raises ``LinearAPIError``. Only reads pass ``retry=True``
    (connection errors / 5xx); writes never retry, since Linear has no
    idempotency key and a retry could duplicate an issue or comment.
    """
    import requests  # lazy

    headers = {'Authorization': api_key, 'Content-Type': 'application/json'}
    body = {'query': query, 'variables': variables or {}}
    attempts = max_retries if retry else 0
    for attempt in range(attempts + 1):
        try:
            resp = requests.post(API_URL, headers=headers, json=body, timeout=DEFAULT_TIMEOUT)
        except requests.exceptions.RequestException as exc:
            if attempt < attempts:
                time.sleep(base_delay * (2**attempt))
                continue
            raise LinearAPIError(
                f'Linear connection error: {type(exc).__name__}: {exc}', code='connection_error'
            ) from exc

        if 500 <= resp.status_code < 600 and attempt < attempts:
            time.sleep(base_delay * (2**attempt))
            continue

        if resp.status_code == 401:
            raise LinearAPIError('Linear rejected the API key (HTTP 401); check the apiKey setting', status_code=401)

        try:
            payload = resp.json()
        except ValueError as exc:
            if resp.ok:
                raise LinearAPIError('Expected JSON in Linear response', status_code=resp.status_code) from exc
            raise LinearAPIError(f'Linear HTTP {resp.status_code}', status_code=resp.status_code) from exc

        errors = payload.get('errors') if isinstance(payload, dict) else None
        if errors:
            first = errors[0] if isinstance(errors[0], dict) else {}
            code = (first.get('extensions') or {}).get('code', '')
            message = first.get('message') or f'Linear HTTP {resp.status_code}'
            if code == 'RATELIMITED':
                reset = _format_reset(resp.headers.get('X-RateLimit-Requests-Reset'))
                suffix = f' (resets at {reset})' if reset else ''
                raise LinearAPIError(
                    f'Linear rate limit reached{suffix}: {message}',
                    code='RATELIMITED',
                    status_code=resp.status_code,
                    reset_at=reset,
                )
            raise LinearAPIError(message, code=code, status_code=resp.status_code)

        if not resp.ok:
            raise LinearAPIError(f'Linear HTTP {resp.status_code}', status_code=resp.status_code)

        _maybe_backoff(resp.headers)
        data = payload.get('data') if isinstance(payload, dict) else None
        if data is None:
            raise LinearAPIError('Linear response had no data', status_code=resp.status_code)
        return data

    raise LinearAPIError('Linear request failed', code='retries_exhausted')  # pragma: no cover


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def clamp_first(value: Any, default: int) -> int:
    """Clamp a page size to 1-100; non-ints fall back to ``default`` (itself clamped)."""
    if isinstance(value, bool) or not isinstance(value, int):
        value = default
    return max(1, min(MAX_PAGE, value))


def parse_identifier(identifier: str) -> Optional[tuple]:
    """Split ``ENG-123`` into ``('ENG', 123)``; None when it is not an identifier."""
    if not isinstance(identifier, str) or '-' not in identifier:
        return None
    key, _, num = identifier.strip().rpartition('-')
    if not key or not num.isdigit():
        return None
    return key.upper(), int(num)


def team_allowed(team_key: Optional[str], allowed: List[str]) -> bool:
    """True when no allowlist is set, or ``team_key`` is on it."""
    return not allowed or (team_key or '').upper() in allowed


def build_issue_filter(
    *,
    allowed_teams: List[str],
    team_key: Optional[str] = None,
    state: Optional[str] = None,
    assignee: Optional[str] = None,
    text: Optional[str] = None,
) -> Dict[str, Any]:
    """Build an ``IssueFilter``. The allowlist is always applied; a requested
    ``team_key`` outside it raises (it must never widen access).
    """
    flt: Dict[str, Any] = {}
    if team_key:
        key = team_key.strip().upper()
        if not team_allowed(key, allowed_teams):
            raise LinearAPIError(f"Team '{key}' is not in the node's teams allowlist")
        flt['team'] = {'key': {'eq': key}}
    elif allowed_teams:
        flt['team'] = {'key': {'in': list(allowed_teams)}}
    if state:
        flt['state'] = {'name': {'eqIgnoreCase': state}}
    if assignee:
        if assignee.strip().lower() == 'me':
            flt['assignee'] = {'isMe': {'eq': True}}
        else:
            flt['assignee'] = {'name': {'containsIgnoreCase': assignee}}
    if text:
        flt['title'] = {'containsIgnoreCase': text}
    return flt


def shape_issue(node: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten an issue node into the tool-facing shape."""
    return {
        'id': node.get('id'),
        'identifier': node.get('identifier'),
        'title': node.get('title'),
        'state': (node.get('state') or {}).get('name'),
        'assignee': (node.get('assignee') or {}).get('name'),
        'priority_label': node.get('priorityLabel'),
        'updated_at': node.get('updatedAt'),
        'url': node.get('url'),
    }


def check_text(name: str, value: str) -> str:
    """Reject text over the 32 KB cap rather than silently truncating it."""
    if len(value.encode('utf-8')) > MAX_TEXT_BYTES:
        raise LinearAPIError(f'{name} exceeds the 32 KB limit')
    return value


def ensure_success(payload: Optional[Dict[str, Any]], what: str) -> Dict[str, Any]:
    """A mutation payload with ``success: false`` (or missing) is an error."""
    if not payload or not payload.get('success'):
        raise LinearAPIError(f'Linear {what} did not succeed')
    return payload
