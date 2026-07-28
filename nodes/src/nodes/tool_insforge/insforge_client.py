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
InsForge REST API client.

Thin wrapper around requests for an InsForge project's REST surface
(https://docs.insforge.dev/sdks/rest/overview). Handles base-URL
normalization, bearer auth, PostgREST-style filter encoding, response
envelopes, and error mapping.

Only the database (``/api/database``) and storage (``/api/storage``) surfaces
are used. Identifiers that land in a request path — table, bucket, object key,
RPC function name — are validated or URL-escaped before interpolation so no
agent-supplied value can redirect a request off the configured host.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, urlparse

import requests
from requests.status_codes import codes as status_codes

from ai.common.utils import get_with_retry, request_with_retry

DEFAULT_TIMEOUT = 30

# Cap on rows a single tool call may pull back, so one query cannot flood the
# agent's context. Callers can page with offset.
MAX_LIMIT = 1000
DEFAULT_LIMIT = 100

# PostgREST filter operators InsForge documents. A filter value must start with
# one of these followed by '.', which keeps agent-supplied filters inside the
# documented grammar instead of letting arbitrary query parameters through.
FILTER_OPERATORS = frozenset(
    {
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'like',
        'ilike',
        'in',
        'is',
    }
)

# Postgres identifiers this node is willing to put in a URL path. Deliberately
# stricter than Postgres itself (no quoted identifiers, no dots): a table or
# function name is never legitimately a path traversal.
_IDENTIFIER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

# Column references may carry a '->' / '->>' JSON path, so they get their own
# pattern. Still no slashes, spaces, or quoting.
_COLUMN_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*((->>?)[A-Za-z0-9_]+)*$')


def normalize_base_url(raw: str) -> str:
    """Return the project URL as a scheme+host origin with no trailing slash.

    Accepts what a user is likely to paste from the InsForge dashboard — with
    or without a trailing slash or an ``/api`` suffix — and reduces it to the
    origin every endpoint is built from.

    Raises:
        ValueError: If the URL is empty, not http(s), or has no host.
    """
    url = (raw or '').strip()
    if not url:
        raise ValueError('project_url is required')

    if '://' not in url:
        url = f'https://{url}'

    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f'project_url must be an http(s) URL, got: {raw}')
    if not parsed.hostname:
        raise ValueError(f'project_url has no host: {raw}')

    origin = f'{parsed.scheme}://{parsed.netloc}'
    return origin.rstrip('/')


def require_identifier(value: str, *, kind: str) -> str:
    """Validate a table / bucket / function name before it enters a URL path.

    Raises:
        ValueError: If the identifier is empty or not a bare Postgres-style name.
    """
    name = (value or '').strip()
    if not name:
        raise ValueError(f'{kind} is required')
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f'Invalid {kind}: {value!r}. Expected a bare name like "posts" or "user_profiles".')
    return name


def require_object_key(value: str) -> str:
    """Validate and escape a storage object key.

    Object keys may contain slashes (they are path-like), so this rejects
    traversal segments explicitly rather than banning the separator, then
    escapes each segment.

    Raises:
        ValueError: If the key is empty, absolute, or contains a '..' segment.
    """
    key = (value or '').strip()
    if not key:
        raise ValueError('object_key is required')
    if key.startswith('/'):
        raise ValueError(f'object_key must be relative, got: {value!r}')

    segments = key.split('/')
    if any(seg in ('.', '..') for seg in segments):
        raise ValueError(f'object_key must not contain relative path segments, got: {value!r}')

    return '/'.join(quote(seg, safe='') for seg in segments)


def encode_filters(filters: Any) -> dict:
    """Turn a {column: "op.value"} mapping into PostgREST query parameters.

    InsForge follows PostgREST's convention where a filter is expressed as a
    query parameter named after the column, e.g. ``?status=eq.active``. The
    operator is checked against the documented set so a malformed filter fails
    here with a usable message rather than being silently ignored upstream.

    Raises:
        ValueError: If ``filters`` is not an object, or a filter is malformed.
    """
    if filters in (None, '', {}):
        return {}
    if not isinstance(filters, dict):
        raise ValueError('filters must be an object mapping column -> "operator.value", e.g. {"status": "eq.active"}')

    params: dict = {}
    for column, expr in filters.items():
        col = str(column).strip()
        if not _COLUMN_RE.match(col):
            raise ValueError(f'Invalid filter column: {column!r}')

        text = str(expr).strip()
        operator, sep, value = text.partition('.')
        if not sep or operator not in FILTER_OPERATORS:
            allowed = ', '.join(sorted(FILTER_OPERATORS))
            raise ValueError(
                f'Invalid filter for column {col!r}: {expr!r}. '
                f'Expected "operator.value" where operator is one of: {allowed}.'
            )
        if not value:
            raise ValueError(f'Filter for column {col!r} has no value: {expr!r}')

        params[col] = text

    return params


def clamp_limit(value: Any, *, default: int = DEFAULT_LIMIT) -> int:
    """Coerce a caller-supplied row limit into the 1..MAX_LIMIT range."""
    if value in (None, ''):
        return default
    try:
        limit = int(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f'limit must be an integer, got: {value!r}') from e
    return max(1, min(limit, MAX_LIMIT))


def _headers(token: str, *, extra: dict | None = None) -> dict:
    """Build the standard auth headers, plus any request-specific additions."""
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/json',
    }
    if extra:
        headers.update(extra)
    return headers


def _describe_error(exc: requests.exceptions.HTTPError) -> str:
    """Map an InsForge HTTP error onto a message an agent can act on."""
    resp = exc.response
    if resp is None:
        return f'InsForge request failed: {exc}'

    code = resp.status_code
    detail = ''
    try:
        body = resp.json()
        if isinstance(body, dict):
            detail = str(body.get('message') or body.get('error') or '').strip()
    except ValueError:
        detail = (resp.text or '').strip()[:300]

    suffix = f' ({detail})' if detail else ''

    if code == status_codes.unauthorized:
        return f'InsForge rejected the credentials (401). Check the API key or JWT.{suffix}'
    if code == status_codes.forbidden:
        return (
            f'InsForge denied the request (403). The key may lack permission, '
            f'or a row-level security policy blocked it.{suffix}'
        )
    if code == status_codes.not_found:
        return f'InsForge resource not found (404). Check the table, bucket, or object key.{suffix}'
    if code == status_codes.unprocessable:
        return f'InsForge rejected the payload (422). Check column names and value types.{suffix}'
    if code == status_codes.too_many_requests:
        return f'InsForge rate limit exceeded (429). Retry later.{suffix}'
    if 500 <= code < 600:
        return f'InsForge server error ({code}). Retry later.{suffix}'
    return f'InsForge request failed ({code}).{suffix}'


def _parse(resp: requests.Response) -> Any:
    """Return the parsed JSON body, or None when the response carries no body."""
    if resp.status_code == status_codes.no_content or not (resp.content or b'').strip():
        return None
    try:
        return resp.json()
    except ValueError:
        return {'raw': (resp.text or '')[:2000]}


def call(
    token: str,
    base_url: str,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: Any = None,
    extra_headers: dict | None = None,
) -> Any:
    """Make an authenticated request to an InsForge project and return JSON.

    Transport goes through the shared retry helpers, which retry timeouts,
    connection errors and 429 / 5xx with exponential backoff and raise other
    4xx immediately.

    Raises:
        ValueError: With a human-readable, status-specific message on HTTP
            errors, so agents can distinguish a bad key from a missing table
            from an RLS denial and self-correct.
    """
    url = f'{base_url}{path}'
    headers = _headers(token, extra=extra_headers)
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}

    try:
        verb = method.upper()
        if verb == 'GET':
            resp = get_with_retry(url, headers=headers, params=clean_params, timeout=DEFAULT_TIMEOUT)
        elif verb == 'POST':
            # POST is not retried here: inserts and RPC calls are not idempotent,
            # and a retried insert would silently duplicate rows.
            resp = requests.post(url, headers=headers, params=clean_params, json=json, timeout=DEFAULT_TIMEOUT)
            resp.raise_for_status()
        else:
            resp = request_with_retry(
                verb,
                url,
                headers=headers,
                params=clean_params,
                json=json,
                timeout=DEFAULT_TIMEOUT,
            )
    except requests.exceptions.HTTPError as e:
        raise ValueError(_describe_error(e)) from e
    except requests.exceptions.Timeout as e:
        raise ValueError('InsForge request timed out. Retry later.') from e
    except requests.exceptions.ConnectionError as e:
        raise ValueError(f'Could not reach the InsForge project at {base_url}. Check the project URL.') from e

    return _parse(resp)


def rows_envelope(rows: Any, *, query: dict) -> dict:
    """Wrap a record list in a uniform envelope with the query that produced it.

    Every database tool returns this shape so an agent can rely on one contract
    regardless of which tool it called.
    """
    if rows is None:
        items: list = []
    elif isinstance(rows, list):
        items = rows
    else:
        items = [rows]

    return {'count': len(items), 'rows': items, 'query': query}
