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

"""HTTP client for the Guild.ai REST API.

All knowledge of Guild's wire format lives here so ``IInstance`` stays a thin
adapter and the whole surface is unit-testable without the engine.

Guild runs agents **asynchronously**: starting a session returns immediately and
the caller polls until the session leaves its running state.

Errors are raised, never returned as ``{'success': False}`` dicts: ``ValueError``
for bad input or missing configuration, ``RuntimeError`` for API and transport
failures. Both faces let them propagate — the engine's ``run_agent`` converts a
raised exception into the structured error payload the agent sees, so catching
them here would only duplicate that plumbing.

Endpoints used (documented under docs.guild.ai/platform/triggers):

- ``POST /api/workspaces/{owner}~{workspace}/sessions`` — start a session
- ``GET  /api/sessions/{id}``                           — session status
- ``GET  /api/sessions/{id}/events``                    — session transcript (paginated)

Authentication is HTTP Basic with a Guild *trigger API key*: the key id is the
username, the key secret the password.

VERIFIED AGAINST A LIVE WORKSPACE (2026-07-23)
----------------------------------------------
Guild publishes no REST reference, so the response shapes were confirmed against
a real api_trigger session over HTTP Basic auth and pinned as regression
fixtures in the test suite. The confirmed facts, each marked ``VERIFIED:`` at its
function:

1. ``session_id_of``   — the new session's id is top-level ``id``.
2. ``session_status``  — progress is on ``root_task.status`` (``DISPATCHED`` while
   running, ``DONE`` when finished), not a top-level ``status`` field.
3. ``extract_output``  — the answer is an ``agent_notification_message`` whose
   ``content`` is a ``{"data": ..., "type": "text"}`` block.

The remaining synonym lists and nested-field lookups are deliberate tolerance for
shapes not seen in that one run, not guesses about the confirmed facts above.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional, Tuple

import requests
from requests.status_codes import codes as status_codes

# Allowlist for identifiers that become URL path segments (agent, session_id,
# owner, workspace). Permits only plain-identifier characters — letters,
# digits, and ``. _ ~ -`` (covers dotted owners, tilde-joined agent names, and
# UUIDs). Everything else — path/scheme separators, percent-encoding, query and
# fragment markers, whitespace, control characters — is rejected.
_SEGMENT_RE = re.compile(r'^[A-Za-z0-9._~-]+$')

DEFAULT_BASE_URL = 'https://app.guild.ai'
DEFAULT_TIMEOUT = 30
# Guild's documented default page size on session events is 20, which would
# silently truncate a long transcript — always ask for more.
DEFAULT_EVENT_LIMIT = 100
MAX_EVENT_LIMIT = 1000

# Poll backoff for wait_for_session: start responsive, decay to gentle.
_POLL_START = 1.0
_POLL_MAX = 5.0
_POLL_GROWTH = 1.4

# Transient statuses worth retrying on idempotent GETs.
_RETRY_STATUSES = {
    status_codes.too_many_requests,
    status_codes.internal_server_error,
    status_codes.bad_gateway,
    status_codes.service_unavailable,
    status_codes.gateway_timeout,
}
_MAX_GET_RETRIES = 2
_MAX_BACKOFF = 8.0

# Normalised session states used throughout the node.
RUNNING = 'running'
COMPLETED = 'completed'
FAILED = 'failed'

# Terminal task states. VERIFIED against a live session: a finished agent task
# reports ``root_task.status: "DONE"`` (see session_status). The other values are
# kept as tolerant synonyms. Unknown values fall through to RUNNING so a poll
# waits rather than declaring a false success — a timeout is a better failure
# than a silently empty answer.
_TERMINAL_OK = {'done', 'completed', 'complete', 'completed_successfully', 'succeeded', 'success', 'finished'}
_TERMINAL_BAD = {'failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'timed_out'}

# Event ``type`` values that carry the agent's final answer, most authoritative
# first. VERIFIED: a finished agent turn emits ``agent_notification_message``
# with ``content: {"data": "<answer>", "type": "text"}``. The rest are tolerant
# fallbacks for other agent shapes.
_OUTPUT_EVENT_TYPES = (
    'agent_notification_message',
    'agent_message',
    'agent_output',
    'agent_response',
    'assistant_message',
    'output',
    'response',
    'message',
    'agent_console',
)
# Fields that may carry an event's text, most specific first. VERIFIED: the
# answer sits at ``content.data`` (a nested ``{"data", "type"}`` block), so
# ``data`` leads the list; the others cover plainer shapes.
_TEXT_FIELDS = ('data', 'text', 'content', 'output', 'message', 'answer', 'result', 'body')

# Event ``type`` values that are never the agent's final answer. VERIFIED from a
# live transcript: the user echo, the trigger/system banners, the runtime/llm
# span markers, and the intermediate progress step all carry text but none of it
# is the answer. The output fallback skips these so a session that produced no
# real answer yields '' rather than emitting one of them as the reply.
_NOISE_EVENT_TYPES = frozenset(
    {
        'user_message',
        'trigger_message',
        'system_message',
        'runtime_start',
        'runtime_done',
        'llm_start',
        'llm_done',
        'agent_notification_progress',
    }
)


def _retry_delay(resp: requests.Response, attempt: int) -> float:
    """Honour Retry-After when present, else exponential backoff."""
    header = resp.headers.get('Retry-After') if resp is not None else None
    if header:
        try:
            return min(float(header), _MAX_BACKOFF)
        except (TypeError, ValueError):
            pass
    return min(2.0**attempt, _MAX_BACKOFF)


def _error_message(resp: requests.Response) -> str:
    """Best-effort human-readable message from a Guild error response.

    Never returns the whole body verbatim — an error body can echo the prompt
    that was sent, which must not reach logs.
    """
    try:
        data = resp.json()
    except ValueError:
        return resp.reason or 'request failed'
    if isinstance(data, dict):
        for key in ('message', 'error', 'detail', 'title'):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
    return resp.reason or 'request failed'


def call(
    base_url: str,
    key_id: str,
    key_secret: str,
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    """Make an authenticated Guild API call and return parsed JSON.

    Raises ``ValueError`` for missing credentials, and ``RuntimeError`` for a
    transport failure or a non-2xx HTTP status. Returns ``{}`` for an empty/204
    response.
    """
    if not key_id or not key_secret:
        raise ValueError(
            'Guild API key is required. Set the API Key ID and API Key Secret in the node '
            'config, or the ROCKETRIDE_GUILD_KEY_ID / ROCKETRIDE_GUILD_KEY_SECRET env vars.'
        )

    url = f'{base_url.rstrip("/")}{path}'
    auth: Tuple[str, str] = (key_id, key_secret)
    headers = {'accept': 'application/json'}
    method_u = method.upper()
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}

    # Retry transient failures, but ONLY on idempotent GETs — replaying a POST
    # would start a second Guild session and bill a second automation.
    attempt = 0
    resp = None
    while True:
        try:
            resp = requests.request(
                method_u,
                url,
                auth=auth,
                headers=headers,
                params=clean_params,
                json=body,
                timeout=timeout,
                verify=verify,
            )
        except requests.RequestException as exc:
            if method_u == 'GET' and attempt < _MAX_GET_RETRIES:
                attempt += 1
                time.sleep(min(2.0**attempt, _MAX_BACKOFF))
                continue
            raise RuntimeError(f'Guild API request failed: {exc}') from exc
        if resp.status_code in _RETRY_STATUSES and method_u == 'GET' and attempt < _MAX_GET_RETRIES:
            attempt += 1
            time.sleep(_retry_delay(resp, attempt))
            continue
        break

    if resp.status_code == status_codes.no_content:
        return {}
    if resp.status_code in (status_codes.unauthorized, status_codes.forbidden):
        raise RuntimeError(
            f'Guild API {resp.status_code}: unauthorized — check the API Key ID/Secret. '
            'Guild trigger API keys are scoped to a specific trigger, so a key created for '
            'one agent may not start sessions for another.'
        )
    if resp.status_code == status_codes.not_found:
        raise RuntimeError(f'Guild API 404: not found — check the owner, workspace, and agent names ({path}).')
    if resp.status_code == status_codes.too_many_requests:
        raise RuntimeError('Guild API 429: rate limited or automation quota exhausted — check the workspace plan.')
    if not resp.ok:
        raise RuntimeError(f'Guild API {resp.status_code}: {_error_message(resp)}')

    try:
        return resp.json()
    except ValueError:
        return {}


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def start_session(
    base_url: str,
    key_id: str,
    key_secret: str,
    owner: str,
    workspace: str,
    text: str,
    *,
    agent: str = '',
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Start a Guild agent session and return the created session object.

    ``text`` is passed through byte-exact as the agent input — it is user
    content, never normalised.
    """
    # VERIFIED: the workspace is one path segment, ``owner~workspace`` (tilde),
    # not two segments — confirmed against the live API (``guild session create``
    # hits ``/api/workspaces/<owner>~<workspace>/sessions``).
    workspace_ref = f'{safe_segment(owner, "owner")}~{safe_segment(workspace, "workspace")}'
    path = f'/api/workspaces/{workspace_ref}/sessions'
    body: Dict[str, Any] = {'session_type': 'api_trigger', 'agent_input': {'text': text}}
    if agent:
        # An API trigger is bound to a specific agent, so the selector is usually
        # implied by the key. Sent only when explicitly configured.
        body['agent'] = safe_segment(agent, 'agent')
    return call(base_url, key_id, key_secret, 'POST', path, body=body, verify=verify, timeout=timeout)


def get_session(
    base_url: str,
    key_id: str,
    key_secret: str,
    session_id: str,
    *,
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Fetch a session's current state."""
    path = f'/api/sessions/{safe_segment(session_id, "session_id")}'
    data = call(base_url, key_id, key_secret, 'GET', path, verify=verify, timeout=timeout)
    return data if isinstance(data, dict) else {}


def get_session_events(
    base_url: str,
    key_id: str,
    key_secret: str,
    session_id: str,
    *,
    limit: int = DEFAULT_EVENT_LIMIT,
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> List[Dict[str, Any]]:
    """Fetch a session's event log (its transcript), following pagination.

    The events endpoint is paginated and returns events **oldest-first**, so the
    agent's answer is on the last page. ``limit`` is the page size; pages are
    followed via ``offset`` until the response reports no more, bounded by
    ``MAX_EVENT_LIMIT`` so a runaway transcript can't loop forever. Reading only
    the first page would drop the answer of any run past one page.
    """
    path = f'/api/sessions/{safe_segment(session_id, "session_id")}/events'
    page_size = max(1, min(int(limit or DEFAULT_EVENT_LIMIT), MAX_EVENT_LIMIT))
    events: List[Dict[str, Any]] = []
    offset = 0
    while len(events) < MAX_EVENT_LIMIT:
        data = call(
            base_url,
            key_id,
            key_secret,
            'GET',
            path,
            params={'limit': page_size, 'offset': offset},
            verify=verify,
            timeout=timeout,
        )
        page = _as_event_list(data)
        if not page:
            break
        events.extend(page)
        if not _has_more(data, offset, len(page)):
            break
        offset += len(page)
    return events[:MAX_EVENT_LIMIT]


def _has_more(data: Any, offset: int, page_len: int) -> bool:
    """Whether another page of events follows, from the ``pagination`` block.

    Reads ``has_more`` when present; else infers from ``total_count`` vs what has
    been read; else falls back to "a full page probably has a successor".
    """
    if isinstance(data, dict):
        pagination = data.get('pagination')
        if isinstance(pagination, dict):
            more = pagination.get('has_more')
            if isinstance(more, bool):
                return more
            total = pagination.get('total_count')
            limit = pagination.get('limit')
            if isinstance(total, int):
                read = offset + page_len
                return read < total
            if isinstance(limit, int) and limit > 0:
                return page_len >= limit
    return False


def wait_for_session(
    base_url: str,
    key_id: str,
    key_secret: str,
    session_id: str,
    *,
    timeout: float,
    verify: bool = True,
) -> Dict[str, Any]:
    """Poll a session until it reaches a terminal state.

    Raises ``RuntimeError`` when the session fails or the deadline passes. The
    timeout message carries the session id: a RocketRide-side timeout does NOT
    cancel the session on Guild, so the run must stay traceable.
    """
    deadline = time.monotonic() + max(1.0, float(timeout))
    interval = _POLL_START
    session: Dict[str, Any] = {}

    while True:
        session = get_session(base_url, key_id, key_secret, session_id, verify=verify)
        state = session_status(session)
        if state == COMPLETED:
            return session
        if state == FAILED:
            raise RuntimeError(f'Guild session {session_id} failed: {session_error(session)}')
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f'Guild session {session_id} did not finish within {int(timeout)}s. It is still '
                'running on Guild — raise the Session timeout, or inspect the session in the Guild app.'
            )
        time.sleep(min(interval, max(0.0, deadline - time.monotonic())))
        interval = min(interval * _POLL_GROWTH, _POLL_MAX)


# ---------------------------------------------------------------------------
# Response shaping — the parts that need live verification
# ---------------------------------------------------------------------------


def safe_segment(value: str, field: str) -> str:
    """Validate an identifier used as a URL path segment.

    Agent-supplied values (agent name, session id) reach the URL, so reject
    anything that could escape the path or redirect the request off the
    configured host.
    """
    text = (value or '').strip()
    if not text:
        raise ValueError(f'{field} is required')
    if text in ('.', '..') or not _SEGMENT_RE.match(text):
        raise ValueError(f'Invalid {field} "{text}": provide a plain identifier, not a path or URL.')
    return text


def session_id_of(session: Dict[str, Any]) -> str:
    """Extract a session's id.

    VERIFIED: the created session carries its id at top-level ``id``.
    """
    if not isinstance(session, dict):
        return ''
    for key in ('id', 'session_id', 'sessionId', 'uuid'):
        value = session.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    # Some APIs nest the created resource one level down.
    nested = session.get('session') or session.get('data')
    if isinstance(nested, dict):
        return session_id_of(nested)
    return ''


def session_status(session: Dict[str, Any]) -> str:
    """Normalise a session's state to RUNNING / COMPLETED / FAILED.

    VERIFIED: the session's progress lives on ``root_task.status`` — ``DISPATCHED``
    while the agent runs, ``DONE`` when it finishes — not on a top-level ``status``
    field. A top-level status is still checked first for forward-compatibility. An
    unrecognised value is reported as RUNNING so that a poll keeps waiting instead
    of returning an empty answer as if it had succeeded.
    """
    if not isinstance(session, dict):
        return RUNNING
    raw = ''
    for key in ('status', 'state', 'session_status', 'sessionStatus'):
        value = session.get(key)
        if isinstance(value, str) and value.strip():
            raw = value.strip().lower()
            break
    if not raw:
        # The verified location: the root task's status.
        root_task = session.get('root_task')
        if isinstance(root_task, dict):
            value = root_task.get('status')
            if isinstance(value, str) and value.strip():
                raw = value.strip().lower()
    if not raw:
        nested = session.get('session') or session.get('data')
        if isinstance(nested, dict):
            return session_status(nested)
        return RUNNING
    if raw in _TERMINAL_OK:
        return COMPLETED
    if raw in _TERMINAL_BAD:
        return FAILED
    return RUNNING


def session_error(session: Dict[str, Any]) -> str:
    """Best-effort failure reason from a failed session."""
    if not isinstance(session, dict):
        return 'unknown error'
    for key in ('error', 'error_message', 'errorMessage', 'failure_reason', 'message', 'result'):
        value = session.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:300]
        if isinstance(value, dict):
            for inner in ('message', 'error', 'detail'):
                nested = value.get(inner)
                if isinstance(nested, str) and nested.strip():
                    return nested.strip()[:300]
    return 'unknown error'


def _as_event_list(data: Any) -> List[Dict[str, Any]]:
    """Coerce an events response into a plain list of event dicts."""
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict)]
    if isinstance(data, dict):
        for key in ('events', 'data', 'items', 'results'):
            value = data.get(key)
            if isinstance(value, list):
                return [e for e in value if isinstance(e, dict)]
    return []


def _event_type(event: Dict[str, Any]) -> str:
    """Normalised event ``type`` (falls back to ``event_type``), lowercased."""
    return str(event.get('type') or event.get('event_type') or '').strip().lower()


def _event_text(event: Dict[str, Any]) -> str:
    """Pull the text out of one event, looking one level into a nested payload."""
    for key in _TEXT_FIELDS:
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, dict):
            for inner in _TEXT_FIELDS:
                nested = value.get(inner)
                if isinstance(nested, str) and nested.strip():
                    return nested
    return ''


def extract_output(events: List[Dict[str, Any]]) -> str:
    """Extract the agent's answer from a session transcript.

    VERIFIED against a live session: the final answer arrives as an
    ``agent_notification_message`` event whose ``content`` is a ``{"data": ...,
    "type": "text"}`` block. The same turn also emits a streaming-delta
    ``agent_notification_message`` with empty text and an ``agent_notification_progress``
    (the ``ui_notify`` tool) carrying the same text; taking the last output-type
    event with non-empty text lands on the real answer and skips the empty delta.

    If no known output type is present the fallback takes the last event with
    text **whose type is not known noise** (the user echo, banners, span markers,
    progress steps). A session that produced no real answer returns '' rather
    than emitting noise as the reply — an empty answer is a better failure than a
    wrong one, the same reasoning ``session_status`` follows.
    """
    if not events:
        return ''

    for wanted in _OUTPUT_EVENT_TYPES:
        matches = [e for e in events if _event_type(e) == wanted]
        if matches:
            # Last match wins: the final answer, not an intermediate turn.
            for event in reversed(matches):
                text = _event_text(event)
                if text:
                    return text

    # No known output type: take the last text-bearing event that is not a known
    # non-answer (user echo, banner, span marker, progress step). Never emit noise.
    for event in reversed(events):
        if _event_type(event) in _NOISE_EVENT_TYPES:
            continue
        text = _event_text(event)
        if text:
            return text
    return ''
