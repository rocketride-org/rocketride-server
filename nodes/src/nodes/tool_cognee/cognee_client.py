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

Endpoints (verified against cognee/api/client.py + the datasets/delete routers):
  add     POST   /api/v1/add                  multipart/form-data (file upload)
  cognify POST   /api/v1/cognify              JSON, synchronous by default
  search  POST   /api/v1/search               JSON
  reset   GET    /api/v1/datasets             then DELETE /api/v1/datasets/{id}
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import requests

from ai.common.utils import post_with_retry

_ADD_PATH = '/api/v1/add'
_COGNIFY_PATH = '/api/v1/cognify'
_SEARCH_PATH = '/api/v1/search'
_DATASETS_PATH = '/api/v1/datasets'


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
    the dataset record — a subsequent add recreates it). A dataset that does not
    exist is reported as ``not_found`` rather than an error: there is nothing to
    reset.
    """
    headers = _headers(api_key)
    list_url = f'{base_url}{_DATASETS_PATH}'
    try:
        resp = requests.get(list_url, headers=headers, timeout=timeout)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise _as_runtime_error(exc, 'reset') from None

    dataset_id = _find_dataset_id(_json_of(resp), dataset)
    if not dataset_id:
        return {'dataset': dataset, 'status': 'not_found', 'deleted': False}

    delete_url = f'{base_url}{_DATASETS_PATH}/{dataset_id}'
    try:
        resp = requests.delete(delete_url, headers=headers, timeout=timeout)
        resp.raise_for_status()
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


def _as_runtime_error(exc: requests.RequestException, op: str) -> RuntimeError:
    """Convert a requests exception into a redacted RuntimeError (never leaks the key)."""
    status: Optional[int] = getattr(getattr(exc, 'response', None), 'status_code', None)
    detail = f' (HTTP {status})' if status else ''
    return RuntimeError(f'cognee: {op} request failed{detail}: {type(exc).__name__}')
