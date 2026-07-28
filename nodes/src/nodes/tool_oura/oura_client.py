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
Oura API v2 client.

Thin wrapper around requests for the Oura REST API
(https://api.ouraring.com/v2). Handles bearer auth, error mapping,
next_token pagination, date-range resolution, and payload compaction
(stripping the heavy 5-minute / per-second time series unless explicitly
requested) so agents receive compact, useful output.

The API surface used here is read-only: every documented v2 usercollection
endpoint is a GET. The base URL is fixed and only whitelisted collection
names or URL-escaped document IDs are ever interpolated into the request
path, so no user- or agent-supplied value can redirect the request
elsewhere.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests
from requests.status_codes import codes as status_codes

from ai.common.utils import get_with_retry

BASE_URL = 'https://api.ouraring.com/v2'
DEFAULT_TIMEOUT = 30

# Hard cap on transparent pagination so one tool call can't loop forever on a
# huge date range (Oura pages are up to ~100 documents each).
MAX_PAGES = 10

# Every collection this node is allowed to touch. document_get validates
# against this set before building a URL, which keeps the request path fully
# server-controlled.
COLLECTIONS = frozenset(
    {
        'daily_activity',
        'daily_cardiovascular_age',
        'daily_readiness',
        'daily_resilience',
        'daily_sleep',
        'daily_spo2',
        'daily_stress',
        'enhanced_tag',
        'heartrate',
        'rest_mode_period',
        'ring_battery_level',
        'ring_configuration',
        'session',
        'sleep',
        'sleep_time',
        'vO2_max',
        'workout',
    }
)

# Heavy time-series fields stripped from documents unless the caller passes
# include_detail=true. These are minute-by-minute strings / per-second sample
# arrays that easily add tens of kilobytes per day to a response.
_DETAIL_FIELDS = frozenset(
    {
        'class_5_min',
        'met',
        'heart_rate',
        'hrv',
        'movement_30_sec',
        'sleep_phase_5_min',
        'motion_count',
    }
)


def call(token: str, path: str, *, params: dict | None = None) -> Any:
    """Make an authenticated GET request to the Oura API and return parsed JSON.

    Transport goes through the shared ``get_with_retry`` helper, which retries
    timeouts, connection errors and 429 / 5xx with exponential backoff and
    raises other 4xx immediately. This matters most for ``daily_summary``,
    which fans out four sequential collection calls — without retry a single
    transient blip fails the whole summary.

    Raises ``ValueError`` with a human-readable, status-specific message on
    HTTP errors so agents can self-correct (bad token vs. missing
    subscription vs. rate limit).
    """
    url = BASE_URL + path
    try:
        resp = get_with_retry(
            url,
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
            params={k: v for k, v in (params or {}).items() if v is not None},
            timeout=DEFAULT_TIMEOUT,
        )
    except requests.HTTPError as exc:
        # Non-retryable status, or retries exhausted on 429 / 5xx. Map the
        # response so the agent still gets the status-specific message.
        raise _map_error(exc.response) from exc
    except requests.Timeout as exc:
        raise ValueError('Oura request timed out') from exc
    except requests.RequestException as exc:
        raise ValueError(f'Oura request failed: {exc}') from exc

    try:
        return resp.json()
    except ValueError as exc:
        raise ValueError('Oura returned a non-JSON response') from exc


# Error details end up in exception messages fed to the LLM; cap them so a
# non-JSON body (e.g. an HTML 502 page from Oura's edge) can't flood the
# agent context.
_MAX_ERROR_DETAIL = 500


def _map_error(resp: requests.Response) -> ValueError:
    """Translate an Oura HTTP error into a descriptive ValueError."""
    try:
        payload = resp.json()
        detail = payload.get('detail') or payload.get('message') or resp.text
        if isinstance(detail, list):
            detail = '; '.join(str(d.get('msg', d)) if isinstance(d, dict) else str(d) for d in detail)
    except Exception:
        detail = resp.text or resp.reason or 'unknown error'

    # Classify on the full body, then truncate for the message — a scope
    # mention past the cap must still be recognized.
    full_detail = str(detail)
    detail = full_detail
    if len(detail) > _MAX_ERROR_DETAIL:
        detail = detail[:_MAX_ERROR_DETAIL] + '… (truncated)'

    status = resp.status_code
    if status == status_codes.unauthorized:
        # Oura reports missing scopes as 401 rather than 403 — surface that
        # distinctly so agents don't conclude the token itself is bad.
        if 'scope' in full_detail.lower():
            return ValueError(f'Oura scope not granted (401) — re-authorize the app with this scope: {detail}')
        return ValueError(f'Oura authentication failed (401) — check the access token: {detail}')
    if status == status_codes.forbidden:
        return ValueError(f'Oura access denied (403) — the token may lack the required scope: {detail}')
    if status == status_codes.not_found:
        return ValueError(
            f'Oura resource not found (404) — the document ID may be wrong, stale, '
            f'or from a different collection: {detail}'
        )
    if status == status_codes.unprocessable_entity:
        return ValueError(f'Oura rejected the request parameters (422): {detail}')
    if status == status_codes.upgrade_required:
        return ValueError(f'Oura subscription required (426) — this data needs an active Oura membership: {detail}')
    if status == status_codes.too_many_requests:
        # Retry-After is either delay-seconds or an HTTP-date (RFC 7231).
        retry_after = resp.headers.get('Retry-After', '')
        if retry_after.isdigit():
            wait_hint = f' Retry after {retry_after} seconds.'
        elif retry_after:
            wait_hint = f' Retry after {retry_after}.'
        else:
            wait_hint = ''
        return ValueError(f'Oura rate limit exceeded (429) — back off and retry later.{wait_hint} {detail}')
    return ValueError(f'Oura API {status}: {detail}')


def fetch_collection(
    token: str,
    collection: str,
    *,
    params: dict | None = None,
    next_token: str | None = None,
    max_pages: int = MAX_PAGES,
) -> dict:
    """Fetch documents from a usercollection endpoint, following pagination.

    Follows ``next_token`` links until the collection is exhausted or
    ``max_pages`` is reached. Returns ``{'data': [...], 'next_token': ...}``
    where ``next_token`` is non-None only when the page cap truncated the
    result (pass it back in to continue).
    """
    if collection not in COLLECTIONS:
        raise ValueError(f'Unknown Oura collection: {collection!r}')

    merged: list = []
    token_param = next_token
    pages = 0
    while True:
        page_params = dict(params or {})
        if token_param:
            # Oura ignores date filters when next_token is present; sending
            # both triggers a 422, so the token replaces the other params.
            page_params = {'next_token': token_param}
        body = call(token, f'/usercollection/{collection}', params=page_params)
        merged.extend(body.get('data') or [])
        token_param = body.get('next_token')
        pages += 1
        if not token_param or pages >= max_pages:
            break

    return {'data': merged, 'next_token': token_param}


# ---------------------------------------------------------------------------
# Date-range helpers
# ---------------------------------------------------------------------------


def _parse_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ValueError(f'{field} must be an ISO date (YYYY-MM-DD), got {value!r}') from exc


def resolve_date_range(args: dict, *, default_days: int = 7) -> tuple[str, str]:
    """Resolve start_date / end_date tool args into a validated ISO date pair.

    Missing end_date defaults to tomorrow (UTC); missing start_date defaults
    to ``default_days`` before end_date. Raises ``ValueError`` when the range
    is inverted or a date is malformed.

    The default end is UTC today **plus one day** because Oura ``day`` fields
    use the ring wearer's local timezone: for users ahead of UTC, "today"
    locally can already be tomorrow in UTC terms, and an end_date of UTC-today
    would silently exclude it. Oura accepts future end dates.
    """
    end_raw = args.get('end_date')
    start_raw = args.get('start_date')

    end = _parse_date(end_raw, 'end_date') if end_raw else datetime.now(timezone.utc).date() + timedelta(days=1)
    start = _parse_date(start_raw, 'start_date') if start_raw else end - timedelta(days=default_days)

    if start > end:
        raise ValueError(f'start_date {start} is after end_date {end}')
    return start.isoformat(), end.isoformat()


def _parse_datetime(value: str, field: str) -> datetime:
    raw = str(value).strip()
    try:
        dt = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError(f'{field} must be an ISO 8601 datetime, got {value!r}') from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def resolve_datetime_range(args: dict, *, default_hours: int = 24) -> tuple[str, str]:
    """Resolve start_datetime / end_datetime args into a validated ISO pair.

    Used by the heart-rate endpoint, which filters on timestamps rather than
    days. Missing end defaults to now (UTC); missing start defaults to
    ``default_hours`` before end.
    """
    end_raw = args.get('end_datetime')
    start_raw = args.get('start_datetime')

    end = _parse_datetime(end_raw, 'end_datetime') if end_raw else datetime.now(timezone.utc)
    start = _parse_datetime(start_raw, 'start_datetime') if start_raw else end - timedelta(hours=default_hours)

    if start > end:
        raise ValueError(f'start_datetime {start.isoformat()} is after end_datetime {end.isoformat()}')
    return start.isoformat(), end.isoformat()


# ---------------------------------------------------------------------------
# Payload compaction
# ---------------------------------------------------------------------------


def compact_document(doc: Any, *, include_detail: bool = False) -> Any:
    """Strip heavy time-series fields from an Oura document.

    Recurses into nested dicts and lists (e.g. ``sleep.readiness``) so detail
    fields are removed wherever they appear. With ``include_detail=True`` the
    document passes through untouched.
    """
    if include_detail:
        return doc
    if isinstance(doc, list):
        return [compact_document(item, include_detail=False) for item in doc]
    if not isinstance(doc, dict):
        return doc
    return {
        key: compact_document(value, include_detail=False) for key, value in doc.items() if key not in _DETAIL_FIELDS
    }


def compact_result(result: dict, *, include_detail: bool = False) -> dict:
    """Apply :func:`compact_document` across a fetch_collection result."""
    return {
        'data': [compact_document(d, include_detail=include_detail) for d in (result.get('data') or [])],
        'next_token': result.get('next_token'),
    }


# ---------------------------------------------------------------------------
# Daily summary merge
# ---------------------------------------------------------------------------

# Per-collection projections used by the daily_summary convenience tool:
# just the headline numbers an agent needs for a "how am I doing" answer.
_SUMMARY_KEYS = {
    'daily_sleep': ('score', 'contributors'),
    'daily_readiness': ('score', 'temperature_deviation', 'contributors'),
    'daily_activity': (
        'score',
        'steps',
        'active_calories',
        'total_calories',
        'target_calories',
        'sedentary_time',
        'resting_time',
    ),
    'daily_stress': ('stress_high', 'recovery_high', 'day_summary'),
}


def merge_daily_summary(collections: dict[str, list[dict]]) -> list[dict]:
    """Merge per-collection daily documents into one record per day.

    Args:
        collections: Map of collection name -> list of Oura daily documents,
            each carrying a ``day`` field (``daily_sleep``, ``daily_readiness``,
            ``daily_activity``, ``daily_stress``).

    Returns:
        A date-sorted list of ``{'day': ..., '<collection>': {...}}`` records
        with each collection projected down to its headline fields.
    """
    days: dict[str, dict] = {}
    for name, docs in collections.items():
        keys = _SUMMARY_KEYS.get(name)
        for doc in docs or []:
            if not isinstance(doc, dict):
                continue
            day = doc.get('day')
            if not day:
                continue
            entry = days.setdefault(day, {'day': day})
            if keys:
                entry[name] = {k: doc.get(k) for k in keys if doc.get(k) is not None}
            else:
                entry[name] = doc
    return [days[d] for d in sorted(days)]
