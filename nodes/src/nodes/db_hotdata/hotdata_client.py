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

"""REST client for the Hotdata API.

Deliberately plain ``requests`` rather than the vendor SDK: the node needs no
new dependency pins, and the shared ``post_with_retry`` helper cannot express
the one rule that matters here — retry a POST only when the request provably
never reached the server.

Retry policy mirrors the vendor SDK (``hotdata/_retry.py``, ``hotdata/query.py``)
at Hotdata's explicit request. Two tiers:

* **429 (admission shedding).** The server sheds load aggressively and tags the
  body ``OVERLOADED``. A shed request did no work, so it is safe to replay on
  any method. ``Retry-After`` is honored when present (capped), otherwise capped
  exponential backoff with jitter, all under an overall deadline budget.
* **Everything else stays idempotent-only.** A read timeout or 5xx on a POST may
  mean the server already did the work, so it propagates rather than being
  replayed. Only a pre-response connection failure — where the request never
  left — is retried on every method.
"""

from __future__ import annotations

import random
import time
from typing import Any, Dict, List, Optional

import requests

#: Default API host. Overridable for Hotdata's alternate environments.
DEFAULT_BASE_URL = 'https://api.hotdata.dev'

#: Per-request socket timeout, seconds.
DEFAULT_TIMEOUT_S = 60.0

#: Overall budget for a single logical call including all retries, seconds.
DEFAULT_RETRY_BUDGET_S = 120.0

#: Base delay for exponential backoff between 429 retries, seconds.
BASE_BACKOFF_S = 0.5

#: Cap on any single computed backoff delay, seconds.
MAX_BACKOFF_S = 30.0

#: Cap on a server-sent ``Retry-After``. Hotdata's limits are dynamic and
#: unpublished; an unbounded value would stall a pipeline indefinitely.
MAX_RETRY_AFTER_S = 120.0

#: Methods safe to replay after a response may already have been produced.
_IDEMPOTENT_METHODS = ('GET', 'DELETE')

_HTTP_TOO_MANY_REQUESTS = 429


class HotdataError(RuntimeError):
    """Any non-retryable failure talking to the Hotdata API."""


class HotdataOverloadedError(HotdataError):
    """429 retries exhausted the deadline budget."""


def _parse_retry_after(headers: Any) -> Optional[float]:
    """Seconds from a ``Retry-After`` header, capped, or None if absent/unparseable."""
    if not headers:
        return None
    raw = None
    for key in ('Retry-After', 'retry-after'):
        try:
            raw = headers.get(key)
        except AttributeError:
            return None
        if raw is not None:
            break
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        # HTTP-date form is legal but Hotdata sends deltas; ignore rather than guess.
        return None
    if seconds < 0:
        return None
    return min(seconds, MAX_RETRY_AFTER_S)


def _encode_params(params: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Normalize query params for the API.

    ``requests`` renders a Python ``True`` as the string ``"True"``, which the
    server rejects with "provided string was not `true` or `false`". Booleans
    must go over the wire lowercase.
    """
    if not params:
        return params
    encoded: Dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        encoded[key] = 'true' if value is True else 'false' if value is False else value
    return encoded


def _backoff_delay(attempt: int) -> float:
    """Capped exponential backoff with equal jitter for retry number ``attempt`` (1-based)."""
    ceiling = min(BASE_BACKOFF_S * (2 ** max(0, attempt - 1)), MAX_BACKOFF_S)
    return (ceiling / 2.0) + random.uniform(0.0, ceiling / 2.0)


class HotdataClient:
    """Thin REST client scoped to one workspace."""

    def __init__(
        self,
        apikey: str,
        workspace_id: str,
        base_url: str = '',
        timeout: float = DEFAULT_TIMEOUT_S,
        retry_budget_s: float = DEFAULT_RETRY_BUDGET_S,
    ) -> None:
        self.apikey = apikey
        self.workspace_id = workspace_id
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip('/')
        self.timeout = timeout
        self.retry_budget_s = retry_budget_s

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        return {
            'Authorization': f'Bearer {self.apikey}',
            'X-Workspace-Id': self.workspace_id,
            'Accept': 'application/json',
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Issue one API call, applying the retry policy described in the module docstring."""
        method = method.upper()
        idempotent = method in _IDEMPOTENT_METHODS
        url = f'{self.base_url}{path}'
        deadline = time.monotonic() + self.retry_budget_s
        attempt = 0
        headers = self._headers()
        if extra_headers:
            headers.update(extra_headers)
        params = _encode_params(params)

        while True:
            attempt += 1
            try:
                response = requests.request(
                    method,
                    url,
                    headers=headers,
                    json=json_body,
                    params=params,
                    timeout=self.timeout,
                )
            except requests.exceptions.ReadTimeout as exc:
                # The request reached the server; replaying a POST could double-execute.
                if not idempotent:
                    raise HotdataError(f'hotdata: {method} {path} timed out awaiting response') from exc
                if not self._sleep_before_retry(None, attempt, deadline):
                    raise HotdataError(f'hotdata: {method} {path} timed out awaiting response') from exc
                continue
            except (requests.exceptions.ConnectTimeout, requests.exceptions.ConnectionError) as exc:
                # Pre-response: the request never left, so any method may be replayed.
                if not self._sleep_before_retry(None, attempt, deadline):
                    raise HotdataError(f'hotdata: cannot reach {url}: {exc}') from exc
                continue
            except requests.exceptions.RequestException as exc:
                raise HotdataError(f'hotdata: {method} {path} failed: {exc}') from exc

            status = getattr(response, 'status_code', 0)

            if status == _HTTP_TOO_MANY_REQUESTS:
                retry_after = _parse_retry_after(getattr(response, 'headers', None))
                if not self._sleep_before_retry(retry_after, attempt, deadline):
                    raise HotdataOverloadedError(
                        f'hotdata: {method} {path} still shedding load after {self.retry_budget_s:g}s (HTTP 429)'
                    )
                continue

            if status >= 500:
                if idempotent and self._sleep_before_retry(None, attempt, deadline):
                    continue
                raise HotdataError(f'hotdata: {method} {path} failed with HTTP {status}: {_body_snippet(response)}')

            if status >= 400:
                raise HotdataError(f'hotdata: {method} {path} failed with HTTP {status}: {_body_snippet(response)}')

            return _parse_json(response)

    def _sleep_before_retry(self, retry_after: Optional[float], attempt: int, deadline: float) -> bool:
        """Sleep before the next attempt. Returns False when the budget is spent."""
        delay = retry_after if retry_after is not None else _backoff_delay(attempt)
        if time.monotonic() + delay > deadline:
            return False
        time.sleep(delay)
        return True

    # ------------------------------------------------------------------
    # Databases
    # ------------------------------------------------------------------

    def create_database(
        self,
        name: str,
        expires_at: str,
        schemas: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Create a managed database.

        ``expires_at`` is required by this client even though the API treats it as
        optional: a database created without a TTL outlives the pipeline run and
        bills until someone notices.
        """
        if not expires_at:
            raise ValueError('hotdata: expires_at is required — refusing to create a database with no TTL')
        body: Dict[str, Any] = {'name': name, 'expires_at': expires_at}
        if schemas:
            body['schemas'] = schemas
        return self._request('POST', '/v1/databases', json_body=body)

    def delete_database(self, database_id: str) -> None:
        self._request('DELETE', f'/v1/databases/{database_id}')

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(
        self,
        sql: str,
        database_id: str,
        async_after_ms: int = 5000,
        default_catalog: str = '',
        default_schema: str = '',
    ) -> Dict[str, Any]:
        """Run one SQL statement. May return rows inline or a ``query_run_id`` to poll."""
        body: Dict[str, Any] = {
            'sql': sql,
            'database_id': database_id,
            'async': True,
            'async_after_ms': async_after_ms,
        }
        if default_catalog:
            body['default_catalog'] = default_catalog
        if default_schema:
            body['default_schema'] = default_schema
        return self._request('POST', '/v1/query', json_body=body)

    def get_query_run(self, query_run_id: str) -> Dict[str, Any]:
        return self._request('GET', f'/v1/query-runs/{query_run_id}')

    def get_result(self, result_id: str, offset: int = 0, limit: Optional[int] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {'offset': offset}
        if limit is not None:
            params['limit'] = limit
        return self._request('GET', f'/v1/results/{result_id}', params=params)

    def information_schema(
        self,
        connection_id: str,
        schema: str = '',
        table: str = '',
        include_columns: bool = True,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Introspect via the REST endpoint.

        ``SHOW TABLES`` / ``SHOW COLUMNS`` error on this engine, so REST
        introspection (or ``information_schema`` in SQL) is the only route.

        Scoped by **connection_id**, not database_id - a database's connection is
        its ``default_connection_id``. Passing database_id here is silently
        ignored by the server and yields an empty table list.
        """
        params: Dict[str, Any] = {'connection_id': connection_id, 'include_columns': include_columns}
        if schema:
            params['schema'] = schema
        if table:
            params['table'] = table
        if limit is not None:
            params['limit'] = limit
        return self._request('GET', '/v1/information_schema', params=params)

    # ------------------------------------------------------------------
    # Uploads
    # ------------------------------------------------------------------

    def create_upload(
        self,
        filename: str,
        content_type: str = 'application/json',
        declared_size_bytes: int = 0,
        part_size: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Reserve an upload slot.

        The response's ``mode`` decides the path: ``single`` gives one presigned
        ``url``, otherwise ``part_urls`` plus ``part_size`` for a multipart PUT.
        """
        body: Dict[str, Any] = {
            'filename': filename,
            'content_type': content_type,
            'declared_size_bytes': declared_size_bytes,
        }
        if part_size is not None:
            body['part_size'] = part_size
        return self._request('POST', '/v1/uploads', json_body=body)

    def _put_presigned(self, url: str, headers: Optional[Dict[str, str]], data: bytes) -> None:
        """PUT bytes straight to object storage.

        Presigned PUTs carry their own auth in the URL, so our bearer token must
        NOT be attached. Re-PUTting the same object key is idempotent, so unlike
        an API POST this is safe to retry.
        """
        deadline = time.monotonic() + self.retry_budget_s
        attempt = 0
        while True:
            attempt += 1
            try:
                response = requests.request(
                    'PUT',
                    url,
                    headers=dict(headers or {}),
                    data=data,
                    timeout=self.timeout,
                )
            except (
                requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectTimeout,
                requests.exceptions.ConnectionError,
            ) as exc:
                if not self._sleep_before_retry(None, attempt, deadline):
                    raise HotdataError(f'hotdata: upload PUT failed: {exc}') from exc
                continue
            except requests.exceptions.RequestException as exc:
                raise HotdataError(f'hotdata: upload PUT failed: {exc}') from exc

            status = getattr(response, 'status_code', 0)
            if status == _HTTP_TOO_MANY_REQUESTS or status >= 500:
                retry_after = _parse_retry_after(getattr(response, 'headers', None))
                if self._sleep_before_retry(retry_after, attempt, deadline):
                    continue
            if status >= 400:
                raise HotdataError(f'hotdata: upload PUT failed with HTTP {status}: {_body_snippet(response)}')
            return

    def get_part_urls(self, upload_id: str, finalize_token: str, part_numbers: List[int]) -> Dict[str, Any]:
        return self._request(
            'POST',
            f'/v1/uploads/{upload_id}/parts',
            json_body={'part_numbers': part_numbers},
            extra_headers={'X-Upload-Finalize-Token': finalize_token},
        )

    def finalize_upload(self, upload_id: str, finalize_token: str) -> Dict[str, Any]:
        return self._request(
            'POST',
            f'/v1/uploads/{upload_id}/finalize',
            json_body={},
            extra_headers={'X-Upload-Finalize-Token': finalize_token},
        )

    def upload_bytes(self, payload: bytes, filename: str, content_type: str = 'application/json') -> str:
        """Run the whole upload dance and return the finalized ``upload_id``."""
        slot = self.create_upload(
            filename=filename,
            content_type=content_type,
            declared_size_bytes=len(payload),
        )
        upload_id = slot.get('upload_id')
        token = slot.get('finalize_token')
        if not upload_id or not token:
            raise HotdataError('hotdata: upload slot response missing upload_id or finalize_token')

        mode = str(slot.get('mode') or 'single').lower()
        headers = slot.get('headers') or {}

        if mode == 'single' or slot.get('url'):
            self._put_presigned(slot.get('url'), headers, payload)
        else:
            part_size = int(slot.get('part_size') or 0) or len(payload) or 1
            chunks = [payload[i : i + part_size] for i in range(0, len(payload), part_size)] or [b'']
            urls = slot.get('part_urls') or []
            if len(urls) < len(chunks):
                fetched = self.get_part_urls(upload_id, token, list(range(1, len(chunks) + 1)))
                urls = [p.get('url') if isinstance(p, dict) else p for p in (fetched.get('parts') or [])]
            if len(urls) < len(chunks):
                raise HotdataError('hotdata: server returned fewer part URLs than parts to upload')
            for url, chunk in zip(urls, chunks):
                self._put_presigned(url, headers, chunk)

        self.finalize_upload(upload_id, token)
        return upload_id

    # ------------------------------------------------------------------
    # Schemas, tables, loads
    # ------------------------------------------------------------------

    def create_schema(
        self,
        database_id: str,
        name: str,
        tables: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {'name': name}
        if tables:
            body['tables'] = tables
        return self._request('POST', f'/v1/databases/{database_id}/schemas', json_body=body)

    def create_table(
        self,
        database_id: str,
        schema: str,
        name: str,
        key: Optional[List[str]] = None,
        partition_by: Optional[List[str]] = None,
        sorted_by: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Declare a table over REST.

        ``CREATE TABLE`` is rejected by the SQL surface, so this is the only way
        a table comes into existence.
        """
        body: Dict[str, Any] = {'name': name}
        if key:
            body['key'] = key
        if partition_by:
            body['partition_by'] = partition_by
        if sorted_by:
            body['sorted_by'] = sorted_by
        return self._request('POST', f'/v1/databases/{database_id}/schemas/{schema}/tables', json_body=body)

    def load_table(
        self,
        database_id: str,
        schema: str,
        table: str,
        mode: str = 'append',
        upload_id: str = '',
        result_id: str = '',
        data_format: str = '',
        key: Optional[List[str]] = None,
        async_after_ms: int = 5000,
    ) -> Dict[str, Any]:
        """Load an upload or a previous query result into a table.

        Exactly one of ``upload_id`` / ``result_id``. Loading straight from a
        prior ``result_id`` skips the upload round trips entirely.
        """
        if bool(upload_id) == bool(result_id):
            raise ValueError('hotdata: load_table needs exactly one of upload_id or result_id')
        body: Dict[str, Any] = {'mode': mode, 'async': True, 'async_after_ms': async_after_ms}
        if upload_id:
            body['upload_id'] = upload_id
        if result_id:
            body['result_id'] = result_id
        if data_format:
            body['format'] = data_format
        if key:
            body['key'] = key
        return self._request(
            'POST',
            f'/v1/databases/{database_id}/schemas/{schema}/tables/{table}/loads',
            json_body=body,
        )

    # ------------------------------------------------------------------
    # Indexes and jobs
    # ------------------------------------------------------------------

    def create_index(
        self,
        connection_id: str,
        schema: str,
        table: str,
        index_name: str,
        columns: List[str],
        index_type: str = 'bm25',
        embedding_provider_id: str = '',
        metric: str = '',
        dimensions: Optional[int] = None,
        output_column: str = '',
        async_after_ms: int = 5000,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            'index_name': index_name,
            'columns': columns,
            'index_type': index_type,
            'async': True,
            'async_after_ms': async_after_ms,
        }
        if embedding_provider_id:
            body['embedding_provider_id'] = embedding_provider_id
        if metric:
            body['metric'] = metric
        if dimensions is not None:
            body['dimensions'] = dimensions
        if output_column:
            body['output_column'] = output_column
        return self._request(
            'POST',
            f'/v1/connections/{connection_id}/tables/{schema}/{table}/indexes',
            json_body=body,
        )

    def get_job(self, job_id: str) -> Dict[str, Any]:
        return self._request('GET', f'/v1/jobs/{job_id}')


def _parse_json(response: Any) -> Dict[str, Any]:
    """Parse a JSON body, tolerating an empty 204-style response."""
    try:
        body = response.json()
    except Exception:
        return {}
    if body is None:
        return {}
    if not isinstance(body, dict):
        return {'data': body}
    return body


def _body_snippet(response: Any, limit: int = 500) -> str:
    """A short, safe excerpt of an error body for log and exception text."""
    try:
        text = response.text
    except Exception:
        return '<unreadable body>'
    if not isinstance(text, str):
        return '<unreadable body>'
    text = text.strip()
    return text[:limit] if text else '<empty body>'
