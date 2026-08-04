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
Pipedrive REST API v1 client.

Thin wrapper around requests — handles auth, the Pipedrive response envelope,
rate-limit retries, error parsing, and response normalisation. All tool methods
in IInstance call through here.

Pipedrive wraps every response in ``{"success": bool, "data": ..., "additional_data":
{"pagination": {...}}}``; :func:`call` unwraps that to ``data`` and :func:`call_envelope`
returns the whole thing for callers that need pagination or ``related_objects``.
"""

from __future__ import annotations

import math
import re
from typing import Any

import requests
from tenacity import RetryCallState, Retrying, retry_if_exception_type, stop_after_attempt, wait_exponential

BASE_URL = 'https://api.pipedrive.com/api/v1'

#: Pipedrive retired the v1 search routes: ``/persons/search`` and its siblings
#: answer 404 ``Unknown method .`` (the resource still exists, the action does
#: not) and ``/itemSearch`` answers a plain 404 ``Not Found`` (no such resource
#: any more). Non-search v1 endpoints are unaffected and still route normally,
#: so only the search tools read this base. See ``tools/search.py`` and the
#: ``*_search`` methods in the per-entity mixins.
BASE_URL_V2 = 'https://api.pipedrive.com/api/v2'

DEFAULT_TIMEOUT = 30

#: Pipedrive's offset pagination caps ``limit`` at 500.
MAX_LIMIT = 500

#: Custom fields come back keyed by a 40-char hex field id mixed in with the
#: standard keys; the cleaners move them into a ``custom_fields`` sub-dict.
_CUSTOM_FIELD_KEY_RE = re.compile(r'^[0-9a-f]{40}$')


class PipedriveAPIError(ValueError):
    """Raised when the Pipedrive API returns an error response."""

    def __init__(self, status_code: int, message: str, code: str = ''):
        super().__init__(f'Pipedrive API {status_code}: {message}')
        self.status_code = status_code
        self.message = message
        self.code = code


class RateLimitError(Exception):
    """Raised when Pipedrive signals a rate limit (429, or 403 after sustained 429s)."""

    def __init__(self, response: requests.Response):
        self.response = response


# ---------------------------------------------------------------------------
# Headers
# ---------------------------------------------------------------------------


def _hdr(headers: Any, name: str) -> str | None:
    """Case-insensitive header lookup.

    ``requests`` returns a CaseInsensitiveDict, but tests (and the odd caller)
    pass a plain dict, so try the common casings before giving up.
    """
    if not headers:
        return None
    for candidate in (name, name.lower(), name.upper(), name.title()):
        value = headers.get(candidate)
        if value is not None:
            return value
    return None


def _rate_limit_hint(headers: Any) -> str:
    """Human-readable retry hint from rate-limit headers, or '' if none present."""
    retry_after = _hdr(headers, 'Retry-After')
    if retry_after:
        return f'retry after {retry_after}s'
    if _hdr(headers, 'x-daily-requests-left') == '0':
        return 'daily API token budget exhausted; it resets at midnight Pipedrive server time'
    reset = _hdr(headers, 'x-ratelimit-reset')
    if reset:
        return f'rate limit window resets in ~{reset}s'
    return ''


def _is_rate_limited(resp: requests.Response) -> bool:
    """Whether a failed response is a rate limit rather than a real error.

    429 is the documented signal. Pipedrive escalates to 403 when a client keeps
    hammering through 429s, so treat a 403 that still carries rate-limit markers
    as a rate limit too — a plain 403 (no permission) must not be retried.
    """
    if resp.status_code == 429:
        return True
    if resp.status_code != 403:
        return False
    if _hdr(resp.headers, 'Retry-After') is not None:
        return True
    if _hdr(resp.headers, 'x-ratelimit-remaining') == '0':
        return True
    return 'rate limit' in (resp.text or '').lower()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _use_bearer(token: str) -> bool:
    """Whether the configured credential is an OAuth access token.

    Personal API tokens are short opaque hex strings and go in the ``api_token``
    query parameter; OAuth access tokens are JWTs (or simply much longer) and go
    in an ``Authorization: Bearer`` header. An explicit ``Bearer `` prefix wins.
    """
    token = token.strip()
    if token.lower().startswith('bearer '):
        return True
    if token.count('.') == 2:
        return True
    return len(token) > 64


def _auth(token: str) -> tuple[dict, dict]:
    """Return ``(headers, params)`` carrying the credential."""
    token = token.strip()
    if _use_bearer(token):
        if token.lower().startswith('bearer '):
            token = token[7:].strip()
        return {'Authorization': f'Bearer {token}'}, {}
    return {}, {'api_token': token}


#: A company subdomain is a single DNS label — letters, digits and inner hyphens.
_SUBDOMAIN_RE = re.compile(r'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$')


def _company_host(company_domain: str | None) -> str | None:
    """Reduce a configured company domain to its bare subdomain.

    Accepts ``acme``, ``acme.pipedrive.com`` or ``https://acme.pipedrive.com/``
    (in any case) and returns ``acme``. Returns ``None`` when nothing usable was
    configured, so callers fall back to the generic host.

    The result is interpolated into ``https://{host}.pipedrive.com``, so anything
    that could end the host early has to be rejected rather than passed through:
    ``evil.example#`` would otherwise build ``https://evil.example#.pipedrive.com``
    and send the request — carrying the ``api_token`` or ``Authorization`` that
    :func:`call_envelope` attaches — to ``evil.example``. Cut at the first path,
    query or fragment delimiter, refuse userinfo and ports, and require what
    remains to be a single DNS label.

    Shared by both version-specific builders below: the v1 and v2 base URLs must
    always agree about which company they address.
    """
    domain = (company_domain or '').strip().lower()
    if not domain:
        return None
    domain = re.sub(r'^https?://', '', domain)
    domain = re.split(r'[/?#]', domain, maxsplit=1)[0]
    if '@' in domain or ':' in domain:
        return None
    if domain.endswith('.pipedrive.com'):
        domain = domain[: -len('.pipedrive.com')]
    return domain if _SUBDOMAIN_RE.match(domain) else None


def base_url_for(company_domain: str | None) -> str:
    """Build the v1 API base URL for an optional company domain.

    Accepts ``acme``, ``acme.pipedrive.com`` or ``https://acme.pipedrive.com/``
    and normalises all three to ``https://acme.pipedrive.com/api/v1``.
    """
    host = _company_host(company_domain)
    return f'https://{host}.pipedrive.com/api/v1' if host else BASE_URL


def base_url_v2_for(company_domain: str | None) -> str:
    """Build the v2 API base URL for an optional company domain.

    Same normalisation as :func:`base_url_for`, emitting ``/api/v2``. Only the
    search tools use this — see :data:`BASE_URL_V2`.
    """
    host = _company_host(company_domain)
    return f'https://{host}.pipedrive.com/api/v2' if host else BASE_URL_V2


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


def _raise_pipedrive_error(resp: requests.Response) -> None:
    """Parse a Pipedrive error response and raise PipedriveAPIError."""
    code = ''
    try:
        err = resp.json()
    except Exception:
        err = None
    if isinstance(err, dict):
        msg = err.get('error') or resp.text or resp.reason or 'unknown error'
        info = err.get('error_info')
        if info and info not in msg:
            msg = f'{msg} — {info}'
        code = err.get('code') or ''
        if code:
            msg = f'{msg} [{code}]'
    else:
        msg = resp.text or resp.reason or 'unknown error'
    hint = _rate_limit_hint(resp.headers)
    if hint:
        msg = f'{msg} ({hint})'
    raise PipedriveAPIError(resp.status_code, msg, code)


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
    timeout: int = DEFAULT_TIMEOUT,
) -> Any:
    """Make an authenticated Pipedrive API call and return the full response envelope.

    Returns the parsed ``{"success": ..., "data": ..., "additional_data": ...}`` dict.
    With ``raw=True`` the undecoded response body is returned instead (file downloads).
    Raises :class:`PipedriveAPIError` with a human-readable message on HTTP errors.
    """
    auth_headers, auth_params = _auth(token)
    headers = {'Accept': 'application/json', **auth_headers}

    query = {k: v for k, v in (params or {}).items() if v is not None}
    query.update(auth_params)

    url = base_url.rstrip('/') + '/' + path.lstrip('/')

    def _attempt() -> Any:
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=headers,
                params=query,
                json=body if files is None and form is None else None,
                data=form,
                files=files,
                timeout=timeout,
            )
        except requests.RequestException as exc:
            # Never let this exception near the message. On the personal-token path
            # _auth() puts the credential in the query string, so requests bakes it
            # into the URL — and a RequestException stringifies to text carrying that
            # URL. `from None` breaks the chain too: the cause holds the same URL and
            # a printed traceback would re-expose it. The exception type still names
            # the failure (ConnectTimeout / ConnectionError / SSLError / ReadTimeout),
            # and method/path are secret-free — `path` carries no query string.
            raise ValueError(f'Pipedrive request failed: {type(exc).__name__} on {method.upper()} {path}') from None

        if not resp.ok:
            if _is_rate_limited(resp):
                raise RateLimitError(resp)
            _raise_pipedrive_error(resp)

        if raw:
            return resp.content

        if resp.status_code == 204 or not (resp.content or b'').strip():
            return {'success': True, 'data': {}}

        try:
            payload = resp.json()
        except ValueError as exc:
            raise PipedriveAPIError(resp.status_code, f'response was not JSON: {resp.text[:200]}') from exc

        # A few endpoints answer 200 with success=false rather than an HTTP error.
        if isinstance(payload, dict) and payload.get('success') is False:
            _raise_pipedrive_error(resp)

        return payload

    def pipedrive_rate_limit_wait(retry_state: RetryCallState) -> float:
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

            # 1. Retry-After states exactly how many seconds to wait.
            retry_after = _hdr(hdrs, 'Retry-After')
            if retry_after is not None:
                try:
                    return _check_and_cap(float(retry_after))
                except ValueError:
                    pass

            # 2. x-ratelimit-reset is the seconds REMAINING in the current window
            #    (not an epoch timestamp, unlike GitHub's X-RateLimit-Reset).
            reset = _hdr(hdrs, 'x-ratelimit-reset')
            if reset is not None:
                try:
                    return _check_and_cap(max(1.0, float(reset)))
                except ValueError:
                    pass
        return float(wait_exponential(multiplier=2, min=2, max=timeout)(retry_state))

    try:
        return Retrying(
            stop=stop_after_attempt(3),
            wait=pipedrive_rate_limit_wait,
            retry=retry_if_exception_type(RateLimitError),
            reraise=True,
        )(_attempt)
    except RateLimitError as exc:
        _raise_pipedrive_error(exc.response)


def call(token: str, method: str, path: str, **kwargs: Any) -> Any:
    """Make a Pipedrive API call and return the unwrapped ``data`` payload.

    ``data`` is ``null`` for some successful responses (e.g. deletes that report
    only through ``success``); those come back as an empty dict.
    """
    envelope = call_envelope(token, method, path, **kwargs)
    if kwargs.get('raw'):
        return envelope
    if not isinstance(envelope, dict):
        return envelope
    data = envelope.get('data')
    return {} if data is None else data


def paginated(envelope: Any, items: list) -> dict:
    """Wrap a cleaned list plus Pipedrive's v1 offset cursor for the agent."""
    pagination = {}
    if isinstance(envelope, dict):
        pagination = ((envelope.get('additional_data') or {}).get('pagination')) or {}
    return {
        'items': items,
        'count': len(items),
        'more_items_in_collection': bool(pagination.get('more_items_in_collection', False)),
        'next_start': pagination.get('next_start'),
    }


def paginated_v2(envelope: Any, items: list) -> dict:
    """Wrap a cleaned list plus Pipedrive's v2 opaque cursor for the agent.

    v2 replaced offset pagination with cursors: ``additional_data.next_cursor``
    holds an opaque string to pass back as ``cursor``, and is absent or null on
    the last page. Running v2 responses through :func:`paginated` instead would
    read the v1 ``additional_data.pagination`` key, find nothing, and silently
    report a single page — so the two wrappers stay separate.
    """
    additional = {}
    if isinstance(envelope, dict):
        additional = envelope.get('additional_data') or {}
    next_cursor = additional.get('next_cursor')
    return {
        'items': items,
        'count': len(items),
        'more_items_in_collection': bool(next_cursor),
        'next_cursor': next_cursor,
    }


# ---------------------------------------------------------------------------
# Response cleaners — Pipedrive payloads are very wide (every custom field, plus
# *_flat duplicates and picture blobs), so trim them to what an agent can use.
# ---------------------------------------------------------------------------


def _pick(obj: Any, keys: tuple[str, ...]) -> dict:
    if not isinstance(obj, dict):
        return {}
    return {k: obj[k] for k in keys if k in obj}


def split_custom_fields(obj: dict) -> dict:
    """Move 40-char-hex custom field keys into a ``custom_fields`` sub-dict."""
    custom = {k: v for k, v in obj.items() if _CUSTOM_FIELD_KEY_RE.match(k)}
    return custom


def _ref(value: Any, name_key: str = 'name') -> Any:
    """Flatten Pipedrive's ``{"value": id, "name": "..."}`` reference objects."""
    if isinstance(value, dict):
        out = {'id': value.get('value', value.get('id'))}
        if name_key in value:
            out[name_key] = value[name_key]
        if 'email' in value:
            out['email'] = value['email']
        return out
    return value


def clean_deal(d: Any) -> dict:
    if not isinstance(d, dict):
        return {}
    out = _pick(
        d,
        (
            'id',
            'title',
            'value',
            'currency',
            'status',
            'probability',
            'stage_id',
            'pipeline_id',
            'expected_close_date',
            'won_time',
            'lost_time',
            'lost_reason',
            'close_time',
            'add_time',
            'update_time',
            'stage_change_time',
            'next_activity_date',
            'next_activity_subject',
            'activities_count',
            'done_activities_count',
            'undone_activities_count',
            'email_messages_count',
            'notes_count',
            'files_count',
            'products_count',
            'weighted_value',
            'label',
            'visible_to',
            'active',
            'deleted',
        ),
    )
    out['person'] = _ref(d.get('person_id'))
    out['organization'] = _ref(d.get('org_id'))
    out['owner'] = _ref(d.get('user_id'))
    out['creator'] = _ref(d.get('creator_user_id'))
    custom = split_custom_fields(d)
    if custom:
        out['custom_fields'] = custom
    return out


def clean_person(p: Any) -> dict:
    if not isinstance(p, dict):
        return {}
    out = _pick(
        p,
        (
            'id',
            'name',
            'first_name',
            'last_name',
            'label',
            'add_time',
            'update_time',
            'open_deals_count',
            'closed_deals_count',
            'won_deals_count',
            'lost_deals_count',
            'activities_count',
            'notes_count',
            'files_count',
            'last_activity_date',
            'next_activity_date',
            'visible_to',
            'active_flag',
        ),
    )
    out['emails'] = [e.get('value') for e in (p.get('email') or []) if isinstance(e, dict)]
    out['phones'] = [e.get('value') for e in (p.get('phone') or []) if isinstance(e, dict)]
    out['organization'] = _ref(p.get('org_id'))
    out['owner'] = _ref(p.get('owner_id'))
    custom = split_custom_fields(p)
    if custom:
        out['custom_fields'] = custom
    return out


def clean_organization(o: Any) -> dict:
    if not isinstance(o, dict):
        return {}
    out = _pick(
        o,
        (
            'id',
            'name',
            'address',
            'address_formatted_address',
            'label',
            'add_time',
            'update_time',
            'people_count',
            'open_deals_count',
            'closed_deals_count',
            'won_deals_count',
            'lost_deals_count',
            'activities_count',
            'notes_count',
            'files_count',
            'last_activity_date',
            'next_activity_date',
            'visible_to',
            'active_flag',
            'cc_email',
        ),
    )
    out['owner'] = _ref(o.get('owner_id'))
    custom = split_custom_fields(o)
    if custom:
        out['custom_fields'] = custom
    return out


def clean_activity(a: Any) -> dict:
    if not isinstance(a, dict):
        return {}
    out = _pick(
        a,
        (
            'id',
            'subject',
            'type',
            'due_date',
            'due_time',
            'duration',
            'done',
            'busy_flag',
            'note',
            'public_description',
            'location',
            'add_time',
            'update_time',
            'marked_as_done_time',
            'deal_id',
            'person_id',
            'org_id',
            'lead_id',
            'project_id',
            'user_id',
            'owner_name',
            'person_name',
            'org_name',
            'deal_title',
            'active_flag',
        ),
    )
    if a.get('participants'):
        out['participants'] = a['participants']
    if a.get('attendees'):
        out['attendees'] = a['attendees']
    return out


def clean_pipeline(p: Any) -> dict:
    return _pick(p, ('id', 'name', 'order_nr', 'active', 'deal_probability', 'add_time', 'update_time', 'selected'))


def clean_stage(s: Any) -> dict:
    return _pick(
        s,
        (
            'id',
            'name',
            'order_nr',
            'pipeline_id',
            'pipeline_name',
            'deal_probability',
            'rotten_flag',
            'rotten_days',
            'active_flag',
            'add_time',
            'update_time',
        ),
    )


def clean_note(n: Any) -> dict:
    if not isinstance(n, dict):
        return {}
    out = _pick(
        n,
        (
            'id',
            'content',
            'add_time',
            'update_time',
            'deal_id',
            'person_id',
            'org_id',
            'lead_id',
            'project_id',
            'user_id',
            'pinned_to_deal_flag',
            'pinned_to_person_flag',
            'pinned_to_organization_flag',
            'pinned_to_lead_flag',
            'active_flag',
        ),
    )
    if isinstance(n.get('user'), dict):
        out['user'] = _pick(n['user'], ('id', 'name', 'email'))
    return out


def clean_lead(lead: Any) -> dict:
    if not isinstance(lead, dict):
        return {}
    out = _pick(
        lead,
        (
            'id',
            'title',
            'owner_id',
            'creator_id',
            'label_ids',
            'person_id',
            'organization_id',
            'source_name',
            'origin',
            'channel',
            'is_archived',
            'was_seen',
            'expected_close_date',
            'next_activity_id',
            'add_time',
            'update_time',
            'visible_to',
            'cc_email',
        ),
    )
    if isinstance(lead.get('value'), dict):
        out['value'] = lead['value']
    return out


def clean_product(p: Any) -> dict:
    if not isinstance(p, dict):
        return {}
    out = _pick(
        p,
        (
            'id',
            'name',
            'code',
            'description',
            'unit',
            'tax',
            'category',
            'active_flag',
            'selectable',
            'visible_to',
            'owner_id',
            'add_time',
            'update_time',
            'billing_frequency',
            'billing_frequency_cycles',
        ),
    )
    if p.get('prices'):
        out['prices'] = [_pick(pr, ('id', 'price', 'currency', 'cost', 'overhead_cost')) for pr in p['prices']]
    custom = split_custom_fields(p)
    if custom:
        out['custom_fields'] = custom
    return out


def clean_file(f: Any) -> dict:
    return _pick(
        f,
        (
            'id',
            'name',
            'file_name',
            'file_type',
            'file_size',
            'description',
            'url',
            'remote_location',
            'remote_id',
            'deal_id',
            'person_id',
            'org_id',
            'lead_id',
            'product_id',
            'activity_id',
            'add_time',
            'update_time',
            'active_flag',
        ),
    )


def clean_user(u: Any) -> dict:
    return _pick(
        u,
        (
            'id',
            'name',
            'email',
            'active_flag',
            'is_admin',
            'role_id',
            'timezone_name',
            'locale',
            'lang',
            'created',
            'modified',
            'last_login',
        ),
    )


def clean_field(f: Any) -> dict:
    if not isinstance(f, dict):
        return {}
    out = _pick(
        f,
        (
            'id',
            'key',
            'name',
            'field_type',
            'mandatory_flag',
            'edit_flag',
            'active_flag',
            'add_visible_flag',
            'important_flag',
            'bulk_edit_allowed',
            'searchable_flag',
            'add_time',
            'update_time',
        ),
    )
    if f.get('options'):
        out['options'] = f['options']
    return out


def clean_search_item(item: Any) -> dict:
    """Search results wrap the record in ``{"result_score": n, "item": {...}}``."""
    if not isinstance(item, dict):
        return {}
    inner = item.get('item') if isinstance(item.get('item'), dict) else item
    out = _pick(inner, ('id', 'type', 'name', 'title', 'status', 'value', 'currency', 'visible_to'))
    for key in ('person', 'organization', 'owner', 'phones', 'emails', 'custom_fields'):
        if inner.get(key):
            out[key] = inner[key]
    if 'result_score' in item:
        out['result_score'] = item['result_score']
    return out


def clean_project(p: Any) -> dict:
    return _pick(
        p,
        (
            'id',
            'title',
            'board_id',
            'phase_id',
            'description',
            'status',
            'owner_id',
            'start_date',
            'end_date',
            'deal_ids',
            'org_id',
            'person_id',
            'labels',
            'add_time',
            'update_time',
            'archive_time',
        ),
    )


def clean_task(t: Any) -> dict:
    return _pick(
        t,
        (
            'id',
            'title',
            'project_id',
            'parent_task_id',
            'description',
            'assignee_id',
            'creator_id',
            'done',
            'due_date',
            'add_time',
            'update_time',
            'marked_as_done_time',
        ),
    )


def clean_mail_thread(t: Any) -> dict:
    return _pick(
        t,
        (
            'id',
            'subject',
            'snippet',
            'read_flag',
            'has_attachments_flag',
            'deal_id',
            'lead_id',
            'person_id',
            'org_id',
            'message_count',
            'last_message_timestamp',
            'add_time',
            'update_time',
            'parties',
        ),
    )


def clean_mail_message(m: Any) -> dict:
    return _pick(
        m,
        (
            'id',
            'subject',
            'snippet',
            'body_url',
            'from',
            'to',
            'cc',
            'bcc',
            'message_time',
            'has_body_flag',
            'read_flag',
            'draft_flag',
            'sent_flag',
            'mail_thread_id',
        ),
    )


def clean_call_log(c: Any) -> dict:
    return _pick(
        c,
        (
            'id',
            'subject',
            'duration',
            'outcome',
            'from_phone_number',
            'to_phone_number',
            'start_time',
            'end_time',
            'person_id',
            'org_id',
            'deal_id',
            'lead_id',
            'user_id',
            'activity_id',
            'note',
            'has_recording',
        ),
    )


def clean_goal(g: Any) -> dict:
    return _pick(
        g,
        ('id', 'title', 'type', 'assignee', 'interval', 'duration', 'expected_outcome', 'is_active', 'report_ids'),
    )


def clean_filter(f: Any) -> dict:
    return _pick(f, ('id', 'name', 'type', 'active_flag', 'user_id', 'visible_to', 'add_time', 'update_time'))


def clean_webhook(w: Any) -> dict:
    return _pick(
        w,
        (
            'id',
            'subscription_url',
            'event_action',
            'event_object',
            'user_id',
            'active_flag',
            'add_time',
            'update_time',
            'last_delivery_time',
            'last_http_status',
        ),
    )


def clean_subscription(s: Any) -> dict:
    return _pick(
        s,
        (
            'id',
            'deal_id',
            'currency',
            'description',
            'cadence_type',
            'cycles_count',
            'cycle_amount',
            'infinite',
            'is_active',
            'start_date',
            'end_date',
            'final_status',
            'lifetime_value',
            'add_time',
            'update_time',
        ),
    )


def clean_team(t: Any) -> dict:
    return _pick(t, ('id', 'name', 'description', 'manager_id', 'users', 'active_flag', 'add_time'))


def clean_role(r: Any) -> dict:
    return _pick(r, ('id', 'parent_role_id', 'name', 'active_flag', 'assignment_count', 'sub_role_count', 'level'))
