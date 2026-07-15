# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
HTTP client helpers for the cognee node.

Thin wrappers over the cognee REST API (``/api/v1/*``) so ``IInstance`` stays a
plain adapter that's unit-testable without the engine. Every call raises
``RuntimeError`` on failure (the API key is never included in the message);
callers surface that to the agent.

Why REST, not the cognee SDK: the ``cognee`` package is a heavy, fully-async
library that pulls its own LLM/embedding client stack and embedded databases,
which conflicts with the engine's provider nodes — the same reason ``tool_mem0``
talks to Mem0 over REST rather than importing ``mem0ai``. Only ``requests`` and
``tenacity`` (already engine deps) are used here.

Modern memory endpoints are ``remember``, ``recall``, dataset status, and graph
visualization. The legacy add/cognify/search/reset helpers remain temporarily so
the public tool adapter can migrate independently.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import requests
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential

from ai.common.utils import post_with_retry

_REMEMBER_PATH = '/api/v1/remember'
_RECALL_PATH = '/api/v1/recall'
_DATASETS_PATH = '/api/v1/datasets/'
_STATUS_PATH = '/api/v1/datasets/status'
_VISUALIZE_PATH = '/api/v1/visualize'

_ADD_PATH = '/api/v1/add'
_COGNIFY_PATH = '/api/v1/cognify'
_SEARCH_PATH = '/api/v1/search'


class CogneeRequestError(RuntimeError):
    """A redacted Cognee HTTP or response error safe to surface to an agent."""


def _headers(api_key: str) -> Dict[str, str]:
    """Build request headers. cognee authenticates via the ``X-Api-Key`` header.

    The key is optional: a self-hosted server with access control disabled
    accepts unauthenticated calls (which run as the seeded default user), so
    the header is only sent when a key is configured.
    """
    headers = {'accept': 'application/json'}
    if api_key:
        headers['X-Api-Key'] = api_key
    return headers


def _is_retryable(exc: BaseException) -> bool:
    """Retry transient transport failures and 429 / 5xx responses only."""
    if isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError)):
        return True
    if isinstance(exc, requests.exceptions.HTTPError):
        resp = exc.response
        return resp is not None and (resp.status_code == 429 or 500 <= resp.status_code < 600)
    return False


def _request_with_retry(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    timeout: float,
    params: Optional[Dict[str, str]] = None,
) -> requests.Response:
    """GET/DELETE with the same 429 / 5xx / timeout retry policy as ``post_with_retry``.

    The shared ``post_with_retry`` helper is POST-only, so this node-local twin
    covers the idempotent read (dataset list) and delete-by-id calls in ``reset``.
    A 4xx other than 429 (e.g. a 404 on an already-deleted dataset) is raised
    immediately without retry, and the final exception is re-raised on exhaustion.
    """

    def _attempt() -> requests.Response:
        request_kwargs: Dict[str, Any] = {'headers': headers, 'timeout': timeout}
        if params is not None:
            request_kwargs['params'] = params
        resp = requests.request(method, url, **request_kwargs)
        resp.raise_for_status()
        return resp

    return Retrying(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=2, max=60),
        retry=retry_if_exception(_is_retryable),
        reraise=True,
    )(_attempt)


def remember(
    base_url: str,
    api_key: str,
    *,
    text: str,
    dataset: str,
    run_in_background: bool,
    timeout: float,
) -> dict[str, Any]:
    """Ingest text and build its knowledge graph with one non-retried request."""
    url = f'{base_url}{_REMEMBER_PATH}'
    files = [('data', ('memory.md', text.encode('utf-8'), 'text/markdown'))]
    form = {
        'datasetName': dataset,
        'run_in_background': json.dumps(bool(run_in_background)),
    }
    try:
        response = requests.post(
            url,
            headers=_headers(api_key),
            files=files,
            data=form,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise _as_request_error(exc, 'remember') from None

    payload = _json_of(response)
    if not isinstance(payload, dict):
        raise CogneeRequestError('cognee: remember returned an invalid response')
    return payload


def recall(
    base_url: str,
    api_key: str,
    *,
    query: str,
    dataset: str,
    search_type: str,
    top_k: int,
    include_references: bool,
    timeout: float,
) -> list[dict[str, Any]]:
    """Recall ranked memory results with references using one POST attempt."""
    url = f'{base_url}{_RECALL_PATH}'
    payload = {
        'query': query,
        'datasets': [dataset],
        'searchType': search_type,
        'topK': top_k,
        'include_references': bool(include_references),
    }
    try:
        response = requests.post(
            url,
            headers=_headers(api_key),
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise _as_request_error(exc, 'recall') from None
    return _shape_results(_json_of(response))


def list_datasets(base_url: str, api_key: str, *, timeout: float) -> list[dict[str, Any]]:
    """List datasets visible to the authenticated Cognee user."""
    try:
        response = _request_with_retry(
            'GET',
            f'{base_url}{_DATASETS_PATH}',
            headers=_headers(api_key),
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise _as_request_error(exc, 'list datasets') from None

    payload = _json_of(response)
    rows = payload.get('datasets') if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise CogneeRequestError('cognee: list datasets returned an invalid response')
    return rows


def get_dataset_status(
    base_url: str,
    api_key: str,
    *,
    dataset_id: str,
    timeout: float,
) -> str:
    """Return a stable pending/running/completed/failed status for cognify."""
    try:
        response = _request_with_retry(
            'GET',
            f'{base_url}{_STATUS_PATH}',
            headers=_headers(api_key),
            timeout=timeout,
            params={'dataset': dataset_id, 'pipeline': 'cognify_pipeline'},
        )
    except requests.RequestException as exc:
        raise _as_request_error(exc, 'dataset status') from None

    payload = _json_of(response)
    remote_status = payload.get(dataset_id) if isinstance(payload, dict) else None
    if isinstance(remote_status, dict):
        remote_status = remote_status.get('cognify_pipeline')
    normalized = {
        'DATASET_PROCESSING_INITIATED': 'pending',
        'DATASET_PROCESSING_STARTED': 'running',
        'DATASET_PROCESSING_COMPLETED': 'completed',
        'DATASET_PROCESSING_ERRORED': 'failed',
    }.get(str(remote_status).upper())
    if normalized is None:
        raise CogneeRequestError('cognee: dataset status returned an invalid response')
    return normalized


def get_visualization_html(
    base_url: str,
    api_key: str,
    *,
    dataset_id: str,
    timeout: float,
) -> tuple[bytes, str]:
    """Fetch a nonempty interactive knowledge-graph HTML artifact."""
    try:
        response = _request_with_retry(
            'GET',
            f'{base_url}{_VISUALIZE_PATH}',
            headers=_headers(api_key),
            timeout=timeout,
            params={'dataset_id': dataset_id},
        )
    except requests.RequestException as exc:
        raise _as_request_error(exc, 'visualization') from None

    html = response.content
    if not html or not html.strip():
        raise CogneeRequestError('cognee: visualization returned empty HTML')
    return html, response.headers.get('Content-Type', 'text/html')


def add(
    base_url: str,
    api_key: str,
    *,
    text: str,
    dataset: str,
    run_in_background: bool = False,
    timeout: float,
) -> Dict[str, Any]:
    """Ingest ``text`` into ``dataset`` via ``POST /api/v1/add`` (multipart).

    The endpoint takes a list of uploaded files, so the content is sent as one
    in-memory text file part; ``datasetName`` and ``run_in_background`` are form
    fields. This is an ingest (non-idempotent) write, so it is a single attempt
    with no retry — a retried 5xx could double-ingest.
    """
    url = f'{base_url}{_ADD_PATH}'
    files = [('data', ('memory.txt', text.encode('utf-8'), 'text/plain'))]
    form = {'datasetName': dataset, 'run_in_background': str(bool(run_in_background)).lower()}
    try:
        resp = requests.post(url, headers=_headers(api_key), files=files, data=form, timeout=timeout)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'add') from None
    return _shape_run(_json_of(resp), dataset)


def cognify(
    base_url: str,
    api_key: str,
    *,
    dataset: str,
    run_in_background: bool = False,
    timeout: float,
) -> Dict[str, Any]:
    """Build the knowledge graph from added data via ``POST /api/v1/cognify``.

    Synchronous by default: cognee blocks until the graph is built (can take
    minutes), which is why ``request_timeout`` is generous. ``post_with_retry``
    retries only transient transport / 429 / 5xx failures.
    """
    url = f'{base_url}{_COGNIFY_PATH}'
    payload = {'datasets': [dataset], 'run_in_background': bool(run_in_background)}
    try:
        resp = post_with_retry(url, headers=_headers(api_key), json=payload, timeout=timeout)
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'cognify') from None
    return _shape_run(_json_of(resp), dataset)


def search(
    base_url: str,
    api_key: str,
    *,
    query: str,
    search_type: str,
    dataset: str,
    top_k: int,
    timeout: float,
) -> List[Any]:
    """Query cognee memory via ``POST /api/v1/search`` and return ranked results."""
    url = f'{base_url}{_SEARCH_PATH}'
    payload = {
        'query': query,
        'search_type': search_type,
        'datasets': [dataset],
        'top_k': top_k,
    }
    try:
        resp = post_with_retry(url, headers=_headers(api_key), json=payload, timeout=timeout)
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'search') from None
    return _shape_results(_json_of(resp))


def reset(
    base_url: str,
    api_key: str,
    *,
    dataset: str,
    timeout: float,
) -> Dict[str, Any]:
    """Clear a cognee dataset (graph + data + the dataset record).

    cognee has no prune-over-REST and no delete-by-name, so this resolves the
    dataset name to its id via ``GET /api/v1/datasets`` and then
    ``DELETE /api/v1/datasets/{id}`` (which empties the graph/data and removes
    the dataset record — a subsequent add recreates it). Both calls are retried
    on transient 429 / 5xx / timeout failures. A dataset that does not exist —
    or one that a 404 says is already gone by delete time — is reported as
    ``not_found`` rather than an error: there is nothing to reset.
    """
    headers = _headers(api_key)
    list_url = f'{base_url}{_DATASETS_PATH.rstrip("/")}'
    try:
        resp = _request_with_retry('GET', list_url, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'reset') from None

    dataset_id = _find_dataset_id(_json_of(resp), dataset)
    if not dataset_id:
        return {'dataset': dataset, 'status': 'not_found', 'deleted': False}

    delete_url = f'{base_url}{_DATASETS_PATH}{dataset_id}'
    try:
        _request_with_retry('DELETE', delete_url, headers=headers, timeout=timeout)
    except requests.exceptions.HTTPError as exc:
        # 404 = the dataset was already gone when the delete landed: a concurrent
        # reset, or a retry after a delete that succeeded but whose response was
        # lost to a timeout. The end state is exactly what the caller asked for,
        # so report "already cleared" instead of surfacing a false failure.
        resp = getattr(exc, 'response', None)
        if resp is not None and resp.status_code == 404:
            return {'dataset': dataset, 'status': 'not_found', 'deleted': False}
        raise _as_runtime_error(exc, 'reset') from None
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'reset') from None

    return {'dataset': dataset, 'status': 'reset', 'deleted': True}


# ---------------------------------------------------------------------------
# Response / error helpers
# ---------------------------------------------------------------------------


def _find_dataset_id(resp: Any, dataset: str) -> str:
    """Find the id of the dataset named ``dataset`` in a GET /datasets response."""
    rows = resp.get('datasets') if isinstance(resp, dict) else resp
    if not isinstance(rows, list):
        return ''
    for row in rows:
        if isinstance(row, dict) and str(row.get('name') or '') == dataset:
            return str(row.get('id') or '')
    return ''


def _json_of(resp: requests.Response) -> Any:
    """Parse a JSON response body, tolerating an empty body."""
    if not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:
        return {}


def _shape_run(resp: Any, dataset: str) -> Dict[str, Any]:
    """Normalize an add / cognify pipeline-run response into a small status dict.

    cognee returns either a run object or a dataset-keyed map of run info; pull a
    pipeline run id and status defensively from whatever shape comes back.
    """
    run: Any = resp
    if isinstance(resp, dict) and 'pipeline_run_id' not in resp and 'status' not in resp and resp:
        # cognify returns {dataset: PipelineRunInfo} — take the first entry.
        first = next(iter(resp.values()), None)
        if isinstance(first, dict):
            run = first
    run = run if isinstance(run, dict) else {}
    return {
        'dataset': dataset,
        'status': str(run.get('status') or 'ok'),
        'pipeline_run_id': str(run.get('pipeline_run_id') or run.get('run_id') or ''),
    }


def _shape_results(resp: Any) -> List[Any]:
    """Extract search results, tolerating a bare list or a ``{results: [...]}`` object.

    cognee's ``search`` returns a JSON list whose items are answer strings
    (completion search types) or row dicts (CHUNKS/SUMMARIES); each is passed
    through, with string items wrapped as ``{"text": ...}`` for a uniform shape.
    """
    rows = resp.get('results') if isinstance(resp, dict) else resp
    if rows is None and isinstance(resp, dict):
        rows = []
    if not isinstance(rows, list):
        rows = [rows] if rows else []
    out: List[Any] = []
    for row in rows:
        out.append(row if isinstance(row, dict) else {'text': row})
    return out


def _as_request_error(exc: requests.RequestException, op: str) -> CogneeRequestError:
    """Convert a requests exception into an agent-safe error with no vendor detail."""
    status: Optional[int] = getattr(getattr(exc, 'response', None), 'status_code', None)
    if status == 402:
        return CogneeRequestError(f'cognee: {op} request failed (HTTP 402): token budget exhausted')
    detail = f' (HTTP {status})' if status else ''
    return CogneeRequestError(f'cognee: {op} request failed{detail}: {type(exc).__name__}')


def _as_runtime_error(exc: requests.RequestException, op: str) -> RuntimeError:
    """Convert a requests exception into a redacted RuntimeError (never leaks the key)."""
    return _as_request_error(exc, op)
