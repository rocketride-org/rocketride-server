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


"""
GoHighLevel REST API v2 client.

Thin wrapper around requests that handles auth, the per-operation ``Version`` header,
rate-limit retries, error parsing and pagination. Every tool method in IInstance calls
through here. The module is deliberately framework-free (no ``ai.common`` import) so the
stubbed unit suite can exercise it without the engine.

Spec baseline: GoHighLevel/highlevel-api-docs @ 0af86a4 (2026-06-19). Re-diff the specs on
any vendor SDK or spec upgrade: breaking changes have shipped in minor SDK releases.

Three GoHighLevel facts shape this file, and each is the opposite of the Pipedrive client
it was ported from:

1. There is no response envelope. Pipedrive wraps everything in
   ``{"success": ..., "data": ..., "additional_data": ...}``; GoHighLevel gives every
   endpoint its own top-level key (``contacts``, ``contact``, ``events``, ``pipelines``,
   ``groups``), returns bare arrays from some calendar routes and a date-keyed map from
   free-slots. :func:`call` therefore does not unwrap anything and each tool names its own
   key. There is no derivable rule, so do not add one.
2. ``Version`` is required on every request and its value is per operation, not global:
   ``2021-04-15`` for /calendars and /conversations, ``2021-07-28`` everywhere else. See
   :func:`version_for`. Sending one value globally breaks the whole calendars and
   conversations family with a 4xx that reads like an auth failure. ``v3`` is also a header
   value rather than a URL prefix, and this client never sends it.
3. Rate-limit budgets are read from response headers, never assumed. A trial Private
   Integration Token measured 25 requests per 10s and 10,000 per day, not the 100 per 10s
   and 200,000 per day published for marketplace apps.

Why this hand-rolls tenacity instead of using ``ai.common.utils.post_with_retry``:
that helper retries every 5xx and every 429 on a fixed exponential schedule and cannot see
response headers. GoHighLevel needs three things it cannot express. It must read
``x-ratelimit-interval-milliseconds`` to wait exactly one burst window rather than guessing.
It must circuit-break instead of retrying when ``x-ratelimit-daily-remaining`` reaches 0,
because backing off does not help until the daily bucket resets. And it must not retry 5xx,
which GoHighLevel declares on 32 operations with no documented idempotency story. The shared
helper is also POST-only, while most of this surface is GET. Retry policy here is: 429 only,
three attempts, and never a 403 (GoHighLevel uses 403 for a missing locationId and for
agency-scope refusal, and retrying those burns budget and hides the real error).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import Any

import requests
from tenacity import RetryCallState, Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential

#: The only ``servers[].url`` across all 83 spec files. There is no white-label API host:
#: white-label domains serve the browser OAuth consent screen, not the API.
BASE_URL = 'https://services.leadconnectorhq.com'
DEFAULT_TIMEOUT = 30

#: ``Version`` header values. Both are required by the spec on every operation, with a
#: single-value enum per operation, so neither is a user-facing setting.
VERSION_2021_07_28 = '2021-07-28'
VERSION_2021_04_15 = '2021-04-15'
DEFAULT_VERSION = VERSION_2021_07_28

#: First path segment to ``Version`` value, for the segments that are not on the default.
#: Exposed so a mixin can override it for a path this map does not cover.
PATH_VERSIONS: dict[str, str] = {
    'calendars': VERSION_2021_04_15,
    'conversations': VERSION_2021_04_15,
}

#: Maximum page size per tool. There is no global maximum: the documented maxima are
#: per endpoint and span two orders of magnitude, and sending a larger value is a 400
#: rather than a silent clamp.
#:
#: Every paged tool must be registered here or in :data:`PAGE_LIMIT_DEFAULTED`.
#: :func:`page_limit` raises on a name in neither, because a silent fallback to 100 is a
#: hard 400 on the endpoints capped below it (appointment notes cap at 20) and it also
#: mis-states the range in the schema the agent reads.
DEFAULT_PAGE_LIMIT = 100
PAGE_LIMITS: dict[str, int] = {
    'appointment_notes_list': 20,
    'contact_list': 100,
    'contact_search': 100,
    'message_export': 500,
    'opportunity_search': 100,
    'opportunity_search_advanced': 100,
}

#: Paged tools whose endpoint publishes no maximum, so :data:`DEFAULT_PAGE_LIMIT` applies.
#: Registering them by name is what lets :func:`page_limit` reject a name it has never seen
#: instead of treating a typo as an undocumented endpoint.
#:
#: These endpoints document a *default* page size and nothing else. A default is not a
#: ceiling, so it is not copied into :data:`PAGE_LIMITS`: doing so would advertise a
#: maximum GoHighLevel never promised and cap the agent below what the endpoint serves.
PAGE_LIMIT_DEFAULTED: frozenset[str] = frozenset(
    {
        'business_list',
        'contact_list_by_business',
        'conversation_search',
        'location_tasks_search',
        'message_list',
        'user_search',
    }
)

#: Minimum page size per tool, for the one endpoint that declares a floor.
PAGE_MINIMUMS: dict[str, int] = {'message_export': 10}

#: Keys of the free-slots response that are actual dates. The payload is a map keyed by
#: ``YYYY-MM-DD`` and ``traceId`` can land beside them as a sibling key.
_DATE_KEY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

#: Error-body keys that name a record the agent can act on: ``id`` itself, or anything
#: ending in ``Id``. GoHighLevel answers some conflicts with the id of the thing that
#: already exists, and the id is the whole way forward. ``POST /conversations/`` for a
#: contact created through the API answers HTTP 400 with
#: ``{"message": "Conversation already exists", "canonicalCode":
#: "CONVERSATIONS_CONVERSATION_ALREADY_EXISTS", "conversationId": "..."}``, because creating
#: a contact creates its conversation too. Reading only ``message`` throws away the id and
#: leaves the agent with a dead end.
#:
#: Top level only, and any key matching the pattern rather than a list of the ones seen so
#: far: an error body is small, GoHighLevel adds fields without notice, and the cost of
#: surfacing one extra id is a longer message rather than a wrong one.
_ID_KEY_RE = re.compile(r'(?:^id|Id)$')

#: Reported on its own, so it is kept out of :func:`error_details` despite matching.
_TRACE_KEY = 'traceId'

#: GoHighLevel's error taxonomy code, for example
#: ``CONVERSATIONS_CONVERSATION_ALREADY_EXISTS``. Absent from most error bodies, and stable
#: where the prose of ``message`` is not, so it is the field worth branching on.
_CANONICAL_CODE_KEY = 'canonicalCode'

#: Words a GoHighLevel 401 uses when it really is complaining about the credential.
#:
#: The 401 fall-through may only claim a credential problem when one of these is present or
#: the body carries no message at all. A 401 was captured live with the body text
#: ``Command timed out``, which is the gateway in front of the API failing rather than the
#: credential being wrong, and answering that with "your token may be revoked" sends the
#: user to rotate a token that works.
_CREDENTIAL_401_MARKERS = (
    'unauthorized',
    'not authorized',
    'authentication',
    'authenticate',
    'token',
    'credential',
    'api key',
    'apikey',
    'jwt',
    'expired',
    'iam',
    'signature',
)

#: The three spellings GoHighLevel uses for a success flag. ``succeded`` (one "e") is the
#: real field name on contacts, opportunities, users and locations deletes; reading only
#: ``succeeded`` returns None, which is falsy, so success reads as failure.
_SUCCESS_KEYS = ('succeded', 'succeeded', 'success')

#: Rate-limit headers, verbatim as returned. All six are lowercase on the wire.
_RL_MAX = 'x-ratelimit-max'
_RL_INTERVAL_MS = 'x-ratelimit-interval-milliseconds'
_RL_REMAINING = 'x-ratelimit-remaining'
_RL_DAILY_LIMIT = 'x-ratelimit-limit-daily'
_RL_DAILY_REMAINING = 'x-ratelimit-daily-remaining'
#: A DURATION IN MILLISECONDS until the daily bucket resets (observed: 86343000, about 24h).
#: It is not an epoch timestamp. Nothing in this file ever sleeps on it: treating it as a
#: timestamp produces a sleep of roughly 55 years.
_RL_DAILY_RESET = 'x-ratelimit-daily-reset'

_REDACTED = '[redacted]'

#: Cap for message text taken from an unstructured body. GoHighLevel sits behind a CDN, so a
#: 502 or 503 is an HTML gateway page rather than JSON, and the whole page would otherwise
#: become the exception message an agent reads.
MAX_ERROR_CHARS = 200


class GoHighLevelAPIError(ValueError):
    """Raised when the GoHighLevel API returns an error response.

    ``canonical_code`` and ``details`` carry the half of an error body that is not prose.
    ``details`` holds every id the body named, keyed as GoHighLevel keyed it, so a caller that
    wants to recover from a conflict can read ``exc.details['conversationId']`` rather than
    parsing it back out of the message. Both are empty on the error bodies that carry neither,
    which is most of them.
    """

    def __init__(
        self,
        status_code: int,
        message: str,
        trace_id: str = '',
        canonical_code: str = '',
        details: dict[str, str] | None = None,
    ):
        super().__init__(f'GoHighLevel API {status_code}: {message}')
        self.status_code = status_code
        self.message = message
        self.trace_id = trace_id
        self.canonical_code = canonical_code
        self.details = dict(details or {})


class RateLimitError(Exception):
    """Raised when GoHighLevel signals a burst rate limit (429). Internal to this module."""

    def __init__(self, response: requests.Response):
        self.response = response


# ---------------------------------------------------------------------------
# Credential hygiene
# ---------------------------------------------------------------------------


def _redact(text: Any, token: str) -> str:
    """Replace the credential with a placeholder anywhere it appears in an error message.

    This covers error messages only: :func:`_raise_ghl_error`, the unparseable-body branch of
    :func:`call_envelope` and its ``RequestException`` wrapper. Success payloads are returned
    verbatim, because walking every response body to find a string GoHighLevel has no reason
    to echo would cost a full traversal per call.

    The one place a success payload can carry the credential back is the raw ``request``
    escape hatch, which takes a caller-supplied path and returns the whole response. That tool
    is the consumer of :func:`redact_payload`, and it must call it before returning.
    """
    out = '' if text is None else str(text)
    secret = (token or '').strip()
    if secret and len(secret) >= 8:
        out = out.replace(secret, _REDACTED)
    return out


def redact_payload(payload: Any, token: str) -> Any:
    """Strip the credential out of a decoded success payload, structure preserved.

    For the raw ``request`` tool, which returns a whole undeclared response to the agent.
    Every other tool projects a known key allowlist, so nothing unexpected reaches the agent
    and none of them needs this.
    """
    secret = (token or '').strip()
    if not secret or len(secret) < 8:
        return payload
    if isinstance(payload, str):
        return payload.replace(secret, _REDACTED)
    if isinstance(payload, dict):
        return {redact_payload(key, secret): redact_payload(value, secret) for key, value in payload.items()}
    if isinstance(payload, (list, tuple)):
        return [redact_payload(item, secret) for item in payload]
    return payload


# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------


def version_for(path: str) -> str:
    """Return the ``Version`` header value for a request path.

    /calendars and /conversations are on 2021-04-15; everything else is on 2021-07-28.
    Hardcoding one value globally is the single most expensive mistake available here: it
    surfaces as a 4xx on the whole calendars and conversations family that reads like an
    authentication failure.
    """
    root = (path or '').strip().lstrip('/').split('?')[0].split('/')[0].lower()
    return PATH_VERSIONS.get(root, DEFAULT_VERSION)


# ---------------------------------------------------------------------------
# Headers
# ---------------------------------------------------------------------------


def _hdr(headers: Any, name: str) -> str | None:
    """Case-insensitive header lookup.

    ``requests`` returns a CaseInsensitiveDict, but tests (and the odd caller) pass a plain
    dict, so try the common casings before giving up.
    """
    if not headers:
        return None
    for candidate in (name, name.lower(), name.upper(), name.title()):
        value = headers.get(candidate)
        if value is not None:
            return value
    return None


def _int_hdr(headers: Any, name: str) -> int | None:
    """Read a header as an int, or None when it is absent or not a number."""
    raw = _hdr(headers, name)
    if raw is None:
        return None
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return None


def daily_budget_exhausted(headers: Any) -> bool:
    """Whether the daily request bucket is empty.

    When it is, retrying is pointless until the bucket resets, so callers fail fast rather
    than backing off.
    """
    return _int_hdr(headers, _RL_DAILY_REMAINING) == 0


def _rate_limit_hint(headers: Any) -> str:
    """Human-readable rate-limit context for an error message, or '' when there is none.

    Only for a 429 or an exhausted daily bucket. ``x-ratelimit-interval-milliseconds`` is on
    every response, including every 404 and every 422, so calling this unconditionally puts a
    burst-window sentence on errors that have nothing to do with rate limiting and invites the
    agent to sleep and retry a request that will never succeed. :func:`_raise_ghl_error` owns
    that gate.
    """
    # RFC 9110 allows delay-seconds or an HTTP-date here. Only a sane seconds form
    # renders; a date would read "retry after Wed, 21 Oct 2026 ...s", and "nan", "inf"
    # or a negative would be garbled the same way. The retry path applies the same two
    # checks (float, then finite and non-negative), so the two stay consistent.
    retry_after = _hdr(headers, 'Retry-After')
    if retry_after is not None:
        try:
            seconds = float(retry_after)
        except (TypeError, ValueError):
            seconds = None
        if seconds is not None and math.isfinite(seconds) and seconds >= 0:
            return f'retry after {seconds:g}s'
    if daily_budget_exhausted(headers):
        limit = _hdr(headers, _RL_DAILY_LIMIT) or 'the account'
        return f'the daily request budget ({limit} requests) is exhausted, so retrying will not help until it resets'
    interval_ms = _int_hdr(headers, _RL_INTERVAL_MS)
    if interval_ms:
        burst = _hdr(headers, _RL_MAX)
        seconds = interval_ms / 1000.0
        if burst:
            return f'the burst window allows {burst} requests per {seconds:g}s'
        return f'the burst window is {seconds:g}s'
    return ''


def _is_rate_limited(resp: requests.Response) -> bool:
    """Whether a failed response is a burst rate limit rather than a real error.

    429 is the only signal. Do not add Pipedrive's "a 403 carrying rate-limit markers counts
    too" branch: GoHighLevel answers 403 for a missing locationId and for agency-scope
    refusal, both of which are permanent, so retrying them burns the budget and buries the
    error the user needs to see.
    """
    return resp.status_code == 429


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


def _stringify(value: Any) -> str:
    """Render one error field as a message, or '' when it carries nothing usable.

    ``message`` is a string on most responses and a list of strings on validation failures,
    where ``str(value)`` would produce an unreadable Python repr for the agent.
    """
    if value is None or isinstance(value, (dict, bool)):
        return ''
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        parts = [_stringify(item) for item in value]
        return ', '.join(part for part in parts if part)
    return str(value).strip()


def error_details(payload: Any) -> dict[str, str]:
    """Pull the ids an error body names out of it, keyed as GoHighLevel keyed them.

    ``message`` is only half of some error bodies. A conflict answers with the id of the
    record that already exists, and that id is the caller's way forward::

        {
            'message': 'Conversation already exists',
            'canonicalCode': 'CONVERSATIONS_CONVERSATION_ALREADY_EXISTS',
            'conversationId': 'hzB0N9v0FmRoW3B2ZM4d',
        }

    Reading ``message`` alone turns that into "Conversation already exists" and a dead end.

    Kept general on purpose: any top-level key that is ``id`` or ends in ``Id``, rather than a
    per-endpoint rule. ``traceId`` is skipped because it is reported separately, and container
    and boolean values are skipped because an id is a scalar. ``canonicalCode`` is read by the
    caller, not here, since it is not an id.
    """
    if not isinstance(payload, dict):
        return {}
    details: dict[str, str] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or key == _TRACE_KEY or not _ID_KEY_RE.search(key):
            continue
        if value is None or isinstance(value, (dict, list, tuple, bool)):
            continue
        text = _stringify(value)
        if text:
            details[key] = text
    return details


def _error_message(payload: Any, resp: requests.Response) -> str:
    """Pull a message out of any of the six observed error body shapes.

    Observed live on one trial account::

        {"message": "Forbidden resource", "error": "Forbidden", "statusCode": 403}
        {"message": ["companyId must be a string", "..."], "error": "Unprocessable Entity", ...}
        {"error": "Contact with id X not found", "status": 400}
        {"error": "Task with id search not found"}
        {"statusCode": 429, "message": "Too Many Requests"}
        {"message": "Conversation already exists", "canonicalCode": "...", "conversationId": "..."}

    The 429 carries no ``error`` key at all, so ``message`` has to be read first rather than as
    a fallback to ``error``. The last shape carries more than a message, and the rest of it is
    read by :func:`error_details` rather than here.

    An unknown path answers 404 with an empty body, so the fall-through to ``reason`` is a
    real path rather than a defensive one. Both fall-throughs are capped: an unstructured body
    here is a CDN error page, not a message anyone wants in full.
    """
    if isinstance(payload, dict):
        for key in ('message', 'msg', 'error', 'detail'):
            text = _stringify(payload.get(key))
            if text:
                return text
    else:
        text = _stringify(payload)
        if text:
            return text[:MAX_ERROR_CHARS]
    return (resp.text or '').strip()[:MAX_ERROR_CHARS] or (resp.reason or '').strip() or 'unknown error'


def _looks_like_a_credential_complaint(lowered: str) -> bool:
    """Whether a 401 body is actually complaining about the credential.

    An empty body counts: a bare 401 with nothing in it is a credential problem until
    something says otherwise. A body that names something else does not, which is the point.
    See :data:`_CREDENTIAL_401_MARKERS`.
    """
    if not lowered:
        return True
    return any(marker in lowered for marker in _CREDENTIAL_401_MARKERS)


def _guidance(status_code: int, message: str) -> str:
    """Turn a known-misleading vendor message into one that names the real cause."""
    lowered = (message or '').lower()
    if status_code == 403:
        if 'does not have access to this location' in lowered:
            return (
                'the token is probably fine and locationId is missing or mismatched: set '
                'gohighlevel.locationId to the sub-account this Private Integration Token belongs to'
            )
        if 'forbidden resource' in lowered:
            return (
                'this is an agency-scoped endpoint and a sub-account Private Integration Token '
                'cannot call it, so no configuration change will grant access'
            )
    if status_code == 401:
        if 'not authorized for this scope' in lowered:
            return (
                'the token authenticates but is missing a scope this operation requires; scopes are '
                'edited on the Private Integration itself and existing tokens keep working after an edit'
            )
        if 'e01 - unauthorized request' in lowered:
            return (
                'some endpoints answer 401 for a missing required parameter rather than a bad token, '
                'for example GET /users/search requires companyId; the same call answers 422 naming the '
                'parameter once locationId is supplied, so add the parameters before touching the token'
            )
        if 'timed out' in lowered or 'timeout' in lowered:
            return (
                'this is an upstream timeout wearing a 401 rather than a credential problem: the gateway in '
                'front of the API was captured answering 401 with the body "Command timed out", so retry the '
                'call rather than rotating anything'
            )
        if not _looks_like_a_credential_complaint(lowered):
            # Only claim a credential problem when the body actually complains about one.
            # GoHighLevel's 401 covers a missing parameter and a gateway failure too, and
            # sending someone to rotate a working token over either costs them the afternoon.
            return (
                'this 401 names no credential, so read the message before rotating anything: GoHighLevel also '
                'answers 401 for a missing required parameter, for an upstream gateway failure, and for a '
                'mis-cased path, for example /locations/customvalues instead of /locations/customValues'
            )
        return (
            'the token may be invalid, expired or revoked, and a rotated Private Integration Token keeps '
            'working for exactly 7 days before it stops with no warning; a mis-cased path also answers 401 '
            'here rather than 404, for example /locations/customvalues instead of /locations/customValues'
        )
    return ''


def _raise_ghl_error(resp: requests.Response, token: str = '') -> None:
    """Parse a GoHighLevel error response and raise GoHighLevelAPIError.

    The status code always comes from the HTTP response. The body's own ``statusCode`` can
    disagree with it (``POST /contacts/`` with only a locationId answers HTTP 400 with a body
    saying 422), so nothing here or downstream may branch on the body field.
    """
    try:
        payload = resp.json()
    except Exception:
        payload = None

    status_code = resp.status_code
    message = _error_message(payload, resp)

    trace_id = ''
    canonical_code = ''
    details: dict[str, str] = {}
    if isinstance(payload, dict):
        trace_id = _stringify(payload.get(_TRACE_KEY))
        canonical_code = _stringify(payload.get(_CANONICAL_CODE_KEY))
        details = {key: _redact(value, token) for key, value in error_details(payload).items()}

    # Facts the body carried, ahead of the advice this module adds. An id in an error body is
    # the way out of the error ("Conversation already exists" plus the id of the conversation
    # that exists), so it leads; canonicalCode follows because it is what to branch on.
    facts = [f'{key}: {value}' for key, value in details.items()]
    if canonical_code:
        facts.append(f'{_CANONICAL_CODE_KEY}: {canonical_code}')

    # The rate-limit clause belongs on a rate-limit error and nowhere else. The burst-window
    # header is on every response, so appending it unconditionally would put "the burst window
    # allows 25 requests per 10s" on every 404 and every 422 the agent ever sees. The daily
    # branch is worth surfacing on any status, because nothing succeeds until that bucket resets.
    candidates = [_guidance(status_code, message)]
    if status_code == 429 or daily_budget_exhausted(resp.headers):
        candidates.append(_rate_limit_hint(resp.headers))

    hints = facts + [hint for hint in candidates if hint]
    if hints:
        joined = '; '.join(hints)
        message = f'{message} ({joined})'
    if trace_id:
        message = f'{message} [traceId: {trace_id}]'

    raise GoHighLevelAPIError(status_code, _redact(message, token), trace_id, canonical_code, details)


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def call_envelope(
    token: str,
    method: str,
    path: str,
    *,
    base_url: str = BASE_URL,
    params: dict | None = None,
    body: dict | None = None,
    files: dict | None = None,
    form: dict | None = None,
    raw: bool = False,
    version: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Any:
    """Make an authenticated GoHighLevel API call and return the parsed response body.

    ``version`` overrides the header derived from the path; pass it for a path
    :func:`version_for` does not classify. With ``raw=True`` the undecoded body is returned
    instead. Raises :class:`GoHighLevelAPIError` with a human-readable message on HTTP errors.

    Trailing slashes in ``path`` are load-bearing (``POST /contacts/``, ``POST /opportunities/``,
    ``GET /calendars/`` and others all carry one) and are passed through untouched. Path casing
    is passed through untouched as well: GoHighLevel answers a mis-cased path with a 401.
    """
    credential = (token or '').strip()
    headers = {
        'Accept': 'application/json',
        'Authorization': f'Bearer {credential}',
        'Version': version or version_for(path),
    }
    send_json = body is not None and files is None and form is None
    if send_json:
        headers['Content-Type'] = 'application/json'

    query = {k: v for k, v in (params or {}).items() if v is not None}
    url = base_url.rstrip('/') + '/' + path.lstrip('/')

    def _attempt() -> Any:
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=headers,
                params=query,
                json=body if send_json else None,
                data=form,
                files=files,
                timeout=timeout,
            )
        except requests.RequestException as exc:
            raise ValueError(_redact(f'GoHighLevel request failed: {exc}', token)) from exc

        if not resp.ok:
            # Retry the burst limit, but never the daily one: it resets in about 24h, so
            # backing off inside a pipeline run cannot help.
            if _is_rate_limited(resp) and not daily_budget_exhausted(resp.headers):
                raise RateLimitError(resp)
            _raise_ghl_error(resp, token)

        if raw:
            return resp.content

        if resp.status_code == 204 or not (resp.content or b'').strip():
            return {}

        try:
            payload = resp.json()
        except ValueError as exc:
            text = _redact(resp.text, token)
            raise GoHighLevelAPIError(resp.status_code, f'response was not JSON: {text[:MAX_ERROR_CHARS]}') from exc

        # No success-flag check here. GoHighLevel has no response envelope: the flag is
        # absent from nearly every payload, and where it exists it is spelled three
        # different ways. Callers read it per resource through normalize_success.
        return payload

    def gohighlevel_rate_limit_wait(retry_state: RetryCallState) -> float:
        exc = retry_state.outcome.exception()
        if isinstance(exc, RateLimitError):
            hdrs = exc.response.headers

            def _check_and_cap(w: float) -> float:
                if not math.isfinite(w) or w < 0:
                    raise ValueError()
                if w > timeout:
                    # Fail fast if the server requires waiting longer than the local cap
                    raise exc
                return w

            # 1. Retry-After states exactly how many seconds to wait. It has never been
            #    observed on a GoHighLevel response, including on a real captured 429, and
            #    the official SDK ignores it. Read it opportunistically, expect its absence.
            retry_after = _hdr(hdrs, 'Retry-After')
            if retry_after is not None:
                try:
                    return _check_and_cap(float(retry_after))
                except ValueError:
                    pass

            # 2. x-ratelimit-interval-milliseconds is the length of the burst window
            #    (10000 on every observed response), so waiting one window clears it.
            #    x-ratelimit-daily-reset is deliberately not consulted: it is a duration in
            #    milliseconds, about 24h, and is never a legitimate sleep.
            interval_ms = _hdr(hdrs, _RL_INTERVAL_MS)
            if interval_ms is not None:
                try:
                    window = float(interval_ms) / 1000.0
                    if not math.isfinite(window) or window < 0:
                        # A malformed window is no information at all, so fall through to
                        # exponential backoff rather than flooring nonsense to one second.
                        raise ValueError()
                    return _check_and_cap(max(1.0, window))
                except ValueError:
                    pass
        return float(wait_exponential(multiplier=2, min=2, max=timeout)(retry_state))

    try:
        return Retrying(
            stop=stop_after_attempt(3),
            wait=gohighlevel_rate_limit_wait,
            retry=retry_if_exception_type(RateLimitError),
            reraise=True,
        )(_attempt)
    except RateLimitError as exc:
        _raise_ghl_error(exc.response, token)


def call(token: str, method: str, path: str, **kwargs: Any) -> Any:
    """Make a GoHighLevel API call and return the parsed payload.

    This is near-identity by design and the absence of an unwrap here is the point, not an
    oversight. GoHighLevel has no response envelope: ``GET /contacts/`` answers ``contacts``,
    ``GET /contacts/{id}`` answers ``contact``, ``GET /contacts/{id}/appointments`` answers
    ``events``, ``GET /calendars/resources/{type}`` answers a bare array and
    ``GET /calendars/{id}/free-slots`` answers a map keyed by date. Each tool names its own
    key. The only normalisation is a JSON ``null`` body becoming an empty dict.
    """
    payload = call_envelope(token, method, path, **kwargs)
    if kwargs.get('raw'):
        return payload
    return {} if payload is None else payload


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


def page_limit(tool: str) -> int:
    """Maximum page size for a tool. Raises on a tool this module has never heard of.

    A silent fallback to :data:`DEFAULT_PAGE_LIMIT` is not safe here. The tool name is a
    hand-typed literal repeated at every call site, the documented maxima run from 20 to 500,
    and GoHighLevel answers a value above the maximum with a 400 rather than clamping. A
    misspelled name would therefore send 100 to an endpoint capped at 20 and 400 on every
    call, and it would also print the wrong range in the schema the agent reads.
    """
    if tool in PAGE_LIMITS:
        return PAGE_LIMITS[tool]
    if tool in PAGE_LIMIT_DEFAULTED:
        return DEFAULT_PAGE_LIMIT
    raise ValueError(
        f'{tool}: no page-size entry in gohighlevel_client. Add the maximum the endpoint documents to '
        f'PAGE_LIMITS, or add the tool name to PAGE_LIMIT_DEFAULTED when the endpoint documents none.'
    )


def check_page_limits(tool_names: Iterable[str], paged_tools: Iterable[str] | None = None) -> list[str]:
    """Reconcile the page-size tables against the tools actually published. [] when clean.

    Two directions, both of which drift silently otherwise:

    1. Every key in :data:`PAGE_LIMITS`, :data:`PAGE_LIMIT_DEFAULTED` and
       :data:`PAGE_MINIMUMS` must name a real published tool, so a typo in a table entry is
       caught rather than sitting there shadowing nothing.
    2. Every tool that publishes a ``limit`` property must have an entry, which is the same
       condition :func:`page_limit` enforces at call time, moved to import or test time.

    Kept framework-free and caller-driven on purpose: this module cannot import IInstance.
    Call it from the unit suite (or from IInstance after composition) with the tool method
    names and, for the second check, the subset whose input schema declares ``limit``.
    """
    published = {str(name) for name in tool_names or ()}
    problems: list[str] = []
    for table, label in (
        (set(PAGE_LIMITS), 'PAGE_LIMITS'),
        (set(PAGE_LIMIT_DEFAULTED), 'PAGE_LIMIT_DEFAULTED'),
        (set(PAGE_MINIMUMS), 'PAGE_MINIMUMS'),
    ):
        for name in sorted(table - published):
            problems.append(f'{label} names {name!r}, which is not a published tool')
    for name in sorted({str(t) for t in paged_tools or ()} - set(PAGE_LIMITS) - set(PAGE_LIMIT_DEFAULTED)):
        problems.append(f'{name} takes a limit but has no PAGE_LIMITS or PAGE_LIMIT_DEFAULTED entry')
    for name in sorted(set(PAGE_MINIMUMS) & (set(PAGE_LIMITS) | set(PAGE_LIMIT_DEFAULTED))):
        if PAGE_MINIMUMS[name] > page_limit(name):
            problems.append(f'{name}: PAGE_MINIMUMS is above its maximum')
    return problems


def clamp_limit(tool: str, value: Any) -> int:
    """Clamp a requested page size into the range the endpoint accepts.

    The limits are per endpoint, from appointment notes at 20 up to the message export at
    500, and GoHighLevel answers a 400 rather than clamping for you.
    """
    ceiling = page_limit(tool)
    floor = PAGE_MINIMUMS.get(tool, 1)
    try:
        requested = int(value)
    except (TypeError, ValueError):
        return min(DEFAULT_PAGE_LIMIT, ceiling)
    return max(floor, min(requested, ceiling))


def paginated(
    items: list,
    *,
    total: Any = None,
    next_cursor: Any = None,
    has_more: Any = None,
    requested_limit: Any = None,
) -> dict:
    """Wrap a cleaned list plus its cursor for the agent.

    ``next`` is whatever the tool's pagination style uses: a cursor, an offset, a page
    number or None. ``total`` stays None wherever GoHighLevel does not return one, which is
    most endpoints; do not synthesise it.

    ``requested_limit`` is the page size actually sent, after clamping. Pass it from every
    cursor-paged tool. GoHighLevel carries its cursors on the records themselves rather than
    on the response root, so a cursor is present on the last non-empty page too and cursor
    presence alone reports ``has_more: true`` on every listing that fits in one page. That is
    one wasted request per traversal against a measured 25-request/10s budget, and it
    contradicts the count the agent can see. A short page means there is no next page.

    ``has_more`` still wins when a tool knows the answer outright (an endpoint that returns
    its own ``hasMore``, or an offset style that already compared the count to the limit).
    With neither argument the field falls back to cursor presence.
    """
    records = list(items or [])
    try:
        counted = int(total) if total is not None else None
    except (TypeError, ValueError):
        counted = None

    try:
        page_size = int(requested_limit) if requested_limit is not None else None
    except (TypeError, ValueError):
        page_size = None

    if has_more is not None:
        more = bool(has_more)
    elif page_size is not None:
        more = bool(next_cursor) and len(records) >= page_size
    else:
        more = next_cursor is not None and next_cursor != ''
    return {
        'items': records,
        'count': len(records),
        'total': counted,
        # Reported only when it leads somewhere. GoHighLevel carries cursors on the records, so
        # the last page has one too, and an agent that trusts ``next`` over ``has_more`` would
        # spend a request discovering the empty page. The two fields must not disagree.
        'next': next_cursor if more else None,
        'has_more': more,
    }


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


def _pick(obj: Any, keys: tuple[str, ...]) -> dict:
    if not isinstance(obj, dict):
        return {}
    return {k: obj[k] for k in keys if k in obj}


def normalize_success(payload: Any) -> bool:
    """Read a delete or status response's success flag across all three spellings.

    ``succeded`` (one "e") is the real field on contacts, opportunities, users and locations
    deletes; ``success`` on calendars, businesses and conversations; ``succeeded`` on
    ``DELETE /calendars/events/{eventId}``. Six v3 DTOs declare two of them at once, so read
    every spelling unconditionally rather than switching on the version. A 2xx with no flag
    at all counts as success, because most endpoints send none.
    """
    if not isinstance(payload, dict):
        return True
    for key in _SUCCESS_KEYS:
        if key in payload:
            return bool(payload[key])
    return True


def bulk_succeeded(payload: Any) -> bool:
    """Whether a bulk write actually succeeded for every item.

    Bulk endpoints answer 2xx with a top-level success flag alongside per-item failures, so
    the flag alone is inconclusive: check ``errorCount`` and the per-item ``type`` too.
    """
    if not isinstance(payload, dict):
        return True
    if not normalize_success(payload):
        return False
    try:
        if int(payload.get('errorCount') or 0) > 0:
            return False
    except (TypeError, ValueError):
        return False
    for item in payload.get('responses') or []:
        if isinstance(item, dict) and item.get('type') == 'error':
            return False
    return True


def date_keyed(payload: Any) -> dict:
    """Keep only the ``YYYY-MM-DD`` keys of a date-keyed map.

    ``GET /calendars/{calendarId}/free-slots`` answers a map keyed by date rather than a
    list, and ``traceId`` can arrive as a sibling key, so filter rather than iterating every
    key.
    """
    if not isinstance(payload, dict):
        return {}
    return {k: v for k, v in payload.items() if isinstance(k, str) and _DATE_KEY_RE.match(k)}


def split_custom_fields(value: Any) -> dict:
    """Project GoHighLevel's custom-field array into ``{field_id: value}``.

    Custom fields are an array of objects, not top-level keys, and the object differs by
    direction and by resource: contacts write ``{id, key, field_value}`` and read
    ``{id, value}``, opportunities write ``field_value`` and read ``fieldValue``. A GET
    response therefore cannot be fed back into a PUT unchanged. The value is polymorphic
    across nine declared types (string, number, string array, and a file object keyed by
    random UUID), so it is passed through untouched rather than coerced.
    """
    if not isinstance(value, list):
        return {}
    out: dict = {}
    for entry in value:
        if not isinstance(entry, dict):
            continue
        key = entry.get('id') or entry.get('key') or entry.get('fieldKey')
        if not isinstance(key, str) or not key:
            continue
        out[key] = None
        for name in ('field_value', 'fieldValue', 'value'):
            if name in entry:
                out[key] = entry[name]
                break
    return out
