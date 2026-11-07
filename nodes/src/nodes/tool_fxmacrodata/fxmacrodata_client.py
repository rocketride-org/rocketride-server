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
FXMacroData REST API client.

Thin wrapper around the shared ``get_with_retry`` helper for the read-only
FXMacroData API (https://api.fxmacrodata.com/v1). It owns everything that is
about the transport rather than about a particular tool:

- the API key, held in :class:`ApiKey` so it never shows up in a repr, a log
  line or an error message, and is only sent when one is configured;
- redirects, which are never followed: ``requests`` forwards custom headers
  such as ``X-API-Key`` to whatever host a redirect points at;
- error mapping, so HTTP errors, HTTP 200 bodies that carry an error, non-JSON
  bodies and unexpected shapes all become a clean :class:`FXMacroDataError`;
- ``pagination`` validation (``has_more`` / ``next_offset``) and the keyless
  ``freemium_window`` / ``freemium_delay`` notices.

Only fixed path templates are used and every interpolated value is validated
(three-letter currency codes, lowercase slugs) before a URL is built.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import requests

from ai.common.utils import get_with_retry

BASE_URL = 'https://api.fxmacrodata.com/v1'
SUBSCRIBE_URL = 'https://fxmacrodata.com/subscribe'
DEFAULT_TIMEOUT = 30
MAX_ATTEMPTS = 3

# List endpoints return 20 rows by default and accept at most 100.
DEFAULT_LIMIT = 20
MAX_LIMIT = 100

# Error details end up in text fed to the LLM; cap them.
_MAX_ERROR_DETAIL = 300

_KEY_PATTERN = re.compile(r'[\x21-\x7e]+')
_CURRENCY_PATTERN = re.compile(r'[A-Za-z]{3}')
_SLUG_PATTERN = re.compile(r'[a-z0-9][a-z0-9_]*')
_DATE_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}')

_KEY_ERROR_CODES = ('api_key_required', 'invalid_api_key', 'subscription_required')

KEYLESS_SCOPE = (
    'Without a key, USD announcements (most recent 90 days, 15-minute delay), the USD release '
    'calendar and the data catalogue are available.'
)


class FXMacroDataError(ValueError):
    """A request or response problem, with a message that is safe to show an agent."""


# ---------------------------------------------------------------------------
# API key
# ---------------------------------------------------------------------------


class ApiKey:
    """An optional FXMacroData API key that never prints its value."""

    __slots__ = ('_value',)

    def __init__(self, value: Optional[str] = '') -> None:
        """Trim and validate ``value``; an empty value means keyless access."""
        if value is None:
            value = ''
        if not isinstance(value, str):
            raise ValueError('apikey must be a string')
        value = value.strip()
        if value and not _KEY_PATTERN.fullmatch(value):
            raise ValueError('apikey contains whitespace or non-printable characters')
        self._value = value

    def reveal(self) -> str:
        """Return the raw key, for building the request header only."""
        return self._value

    def scrub(self, text: str) -> str:
        """Replace any occurrence of the key in ``text``."""
        if not self._value:
            return text
        return text.replace(self._value, '***')

    def __bool__(self) -> bool:
        """Return True when a key is configured."""
        return bool(self._value)

    def __repr__(self) -> str:
        """Show whether a key is set, never its value."""
        return 'ApiKey(<set>)' if self._value else 'ApiKey(<empty>)'

    __str__ = __repr__


def scrub_value(value: Any, api_key: ApiKey) -> Any:
    """Return ``value`` with the key removed from every nested string."""
    if not api_key:
        return value
    if isinstance(value, str):
        return api_key.scrub(value)
    if isinstance(value, dict):
        return {key: scrub_value(item, api_key) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub_value(item, api_key) for item in value]
    return value


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def validate_currency(value: Any, field: str = 'currency') -> str:
    """Return a three-letter currency code in lowercase, or raise."""
    if not isinstance(value, str) or not _CURRENCY_PATTERN.fullmatch(value.strip()):
        raise FXMacroDataError(f'"{field}" must be a three-letter currency code such as "USD"')
    return value.strip().lower()


def validate_slug(value: Any, field: str = 'indicator') -> str:
    """Return a lowercase indicator slug such as ``inflation``, or raise."""
    if not isinstance(value, str) or not value.strip():
        raise FXMacroDataError(f'"{field}" is required and must be a non-empty string')
    slug = value.strip().lower()
    if not _SLUG_PATTERN.fullmatch(slug):
        raise FXMacroDataError(
            f'"{field}" must be an indicator slug of letters, digits and underscores (see data_catalogue)'
        )
    return slug


def validate_date(value: Any, field: str) -> Optional[str]:
    """Return a real ``YYYY-MM-DD`` calendar date, ``None`` when absent, or raise."""
    if value is None:
        return None
    if not isinstance(value, str) or not _DATE_PATTERN.fullmatch(value.strip()):
        raise FXMacroDataError(f'"{field}" must be a date in YYYY-MM-DD format')
    try:
        return date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        raise FXMacroDataError(f'"{field}" is not a real calendar date') from None


def validate_date_range(args: Dict[str, Any]) -> Dict[str, str]:
    """Return the validated ``start_date`` / ``end_date`` query parameters."""
    start_date = validate_date(args.get('start_date'), 'start_date')
    end_date = validate_date(args.get('end_date'), 'end_date')
    if start_date and end_date and start_date > end_date:
        raise FXMacroDataError('"start_date" must be on or before "end_date"')
    params: Dict[str, str] = {}
    if start_date:
        params['start_date'] = start_date
    if end_date:
        params['end_date'] = end_date
    return params


def validate_base_url(base_url: str) -> str:
    """Return ``base_url`` without a trailing slash if it is https with a host, or raise."""
    parts = urlsplit(base_url or '')
    if parts.scheme != 'https' or not parts.hostname:
        raise ValueError('base URL must be an https URL with a host')
    return base_url.rstrip('/')


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


def require_rows(body: Dict[str, Any], key: str = 'data') -> List[Dict[str, Any]]:
    """Return the list of row objects under ``key``, or raise on a wrong shape."""
    rows = body.get(key)
    if not isinstance(rows, list):
        raise FXMacroDataError(f'unexpected FXMacroData response: "{key}" is not a list')
    return [row for row in rows if isinstance(row, dict)]


def project(row: Dict[str, Any], fields: tuple) -> Dict[str, Any]:
    """Keep only ``fields`` that are present and not null."""
    return {field: row[field] for field in fields if row.get(field) is not None}


def _optional_int_field(raw: Dict[str, Any], field: str) -> Optional[int]:
    value = raw.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise FXMacroDataError(f'unexpected FXMacroData response: "pagination.{field}" is not an integer')
    return value


def parse_pagination(body: Dict[str, Any], offset: int) -> Optional[Dict[str, Any]]:
    """Validate the optional ``pagination`` object of a list response.

    Missing or null means the response is not paginated. When present it must
    be an object with a boolean ``has_more``; when ``has_more`` is true,
    ``next_offset`` must be an integer greater than the offset just requested.
    """
    raw = body.get('pagination')
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise FXMacroDataError('unexpected FXMacroData response: "pagination" is not an object')
    has_more = raw.get('has_more')
    if not isinstance(has_more, bool):
        raise FXMacroDataError('unexpected FXMacroData response: "pagination.has_more" is not a boolean')
    total_count = _optional_int_field(raw, 'total_count')
    if not has_more:
        return {'has_more': False, 'next_offset': None, 'total_count': total_count}
    next_offset = _optional_int_field(raw, 'next_offset')
    if next_offset is None:
        raise FXMacroDataError('unexpected FXMacroData response: "pagination.next_offset" is missing')
    if next_offset <= offset:
        raise FXMacroDataError('unexpected FXMacroData response: "pagination.next_offset" did not advance')
    return {'has_more': True, 'next_offset': next_offset, 'total_count': total_count}


def _notices_from_block(block: Any) -> List[str]:
    if not isinstance(block, dict) or block.get('applied') is False:
        return []
    notices: List[str] = []
    message = block.get('message')
    if isinstance(message, str) and message.strip():
        notices.append(message.strip())
    withheld = block.get('withheld_count')
    if isinstance(withheld, int) and not isinstance(withheld, bool) and withheld > 0:
        notices.append(
            f'{withheld} recently published release(s) are withheld from this keyless response, '
            'so the newest value shown here is not the latest published one.'
        )
    return notices


def collect_notices(body: Dict[str, Any]) -> List[str]:
    """Return the keyless-tier notices (90-day window, 15-minute delay) in a response."""
    return _notices_from_block(body.get('freemium_window')) + _notices_from_block(body.get('freemium_delay'))


def _error_detail(body: Any) -> str:
    """Pull a short human-readable message out of an error body."""
    if not isinstance(body, dict):
        return ''
    detail = body.get('detail') or body.get('message') or body.get('error') or ''
    detail = (detail if isinstance(detail, str) else str(detail)).strip()
    if len(detail) > _MAX_ERROR_DETAIL:
        detail = detail[:_MAX_ERROR_DETAIL] + '... (truncated)'
    return detail


def _key_required_message(has_key: bool) -> str:
    if has_key:
        return 'FXMacroData did not accept the configured API key for this request (check the key and its plan).'
    return f'This request needs an FXMacroData API key. {KEYLESS_SCOPE} Get a key at {SUBSCRIBE_URL}'


def _json_or_none(resp: Any) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def http_error_message(resp: Any, has_key: bool) -> str:
    """Translate an HTTP error response into a message for the agent."""
    status = getattr(resp, 'status_code', None)
    if status in (401, 403):
        return _key_required_message(has_key)
    if status == 429:
        return 'FXMacroData rate limit reached (HTTP 429). Keyless access allows 100 requests per day; retry later.'
    detail = _error_detail(_json_or_none(resp)) if resp is not None else ''
    suffix = f': {detail}' if detail else ''
    if status == 404:
        return f'FXMacroData resource not found (HTTP 404){suffix}'
    if status in (400, 422):
        return f'FXMacroData rejected the request parameters (HTTP {status}){suffix}'
    return f'FXMacroData API error (HTTP {status})'


def raise_for_error_body(body: Dict[str, Any], has_key: bool) -> None:
    """Raise when a successful HTTP status still carries an error body."""
    error = body.get('error')
    if not error:
        return
    code = body.get('code') if isinstance(body.get('code'), str) else error
    if code in _KEY_ERROR_CODES:
        raise FXMacroDataError(_key_required_message(has_key))
    detail = _error_detail(body)
    raise FXMacroDataError(f'FXMacroData returned an error: {detail}' if detail else 'FXMacroData returned an error')


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class FXMacroDataClient:
    """Read-only FXMacroData REST client."""

    def __init__(self, api_key: ApiKey, base_url: str = BASE_URL, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Validate the base URL and keep the key for the ``X-API-Key`` header."""
        if not isinstance(api_key, ApiKey):
            raise TypeError('api_key must be an ApiKey')
        self._api_key = api_key
        self._base_url = validate_base_url(base_url)
        self._timeout = timeout

    @property
    def has_key(self) -> bool:
        """Return True when requests are authenticated."""
        return bool(self._api_key)

    def _headers(self) -> Dict[str, str]:
        headers = {'Accept': 'application/json'}
        if self._api_key:
            headers['X-API-Key'] = self._api_key.reveal()
        return headers

    def _send(self, url: str, params: Optional[Dict[str, Any]]) -> Any:
        try:
            return get_with_retry(
                url,
                headers=self._headers(),
                params=params,
                timeout=self._timeout,
                max_attempts=MAX_ATTEMPTS,
                allow_redirects=False,
            )
        except requests.exceptions.HTTPError as exc:
            message = http_error_message(exc.response, self.has_key)
        except requests.exceptions.Timeout:
            message = 'FXMacroData request timed out'
        except requests.exceptions.RequestException as exc:
            message = f'FXMacroData request failed: {type(exc).__name__}'
        raise FXMacroDataError(self._api_key.scrub(message))

    def get_json(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """GET ``path`` (relative to the base URL) and return the JSON object body."""
        resp = self._send(self._base_url + path, params)
        status = getattr(resp, 'status_code', 0)
        if 300 <= status < 400:
            raise FXMacroDataError(
                f'FXMacroData answered with a redirect (HTTP {status}); redirects are not followed '
                'so the API key is never sent to another location'
            )
        try:
            body = resp.json()
        except ValueError:
            raise FXMacroDataError('FXMacroData returned a non-JSON response body') from None
        if not isinstance(body, dict):
            raise FXMacroDataError('unexpected FXMacroData response: expected a JSON object')
        try:
            raise_for_error_body(body, self.has_key)
        except FXMacroDataError as exc:
            raise FXMacroDataError(self._api_key.scrub(str(exc))) from None
        return body

    def get_pages(
        self, path: str, params: Dict[str, Any], *, offset: int, limit: int, max_pages: int
    ) -> Dict[str, Any]:
        """Fetch up to ``max_pages`` pages of a list endpoint, following ``next_offset``.

        Returns ``{'first': body, 'rows': [...], 'pagination': {...} | None,
        'notices': [...]}`` where ``pagination`` describes the last page read.
        """
        rows: List[Dict[str, Any]] = []
        notices: List[str] = []
        first: Optional[Dict[str, Any]] = None
        pagination: Optional[Dict[str, Any]] = None
        current = offset
        for _ in range(max_pages):
            body = self.get_json(path, {**params, 'limit': limit, 'offset': current})
            first = body if first is None else first
            rows.extend(require_rows(body))
            notices.extend(notice for notice in collect_notices(body) if notice not in notices)
            pagination = parse_pagination(body, current)
            if pagination is None or not pagination['has_more']:
                break
            current = pagination['next_offset']
        return {'first': first, 'rows': rows, 'pagination': pagination, 'notices': notices}
