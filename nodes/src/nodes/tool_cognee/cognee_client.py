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
the shared idempotent GET helper are used here.

Modern memory endpoints are ``remember``, ``recall``, and dataset status.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import requests

from ai.common.utils import get_with_retry

_REMEMBER_PATH = '/api/v1/remember'
_RECALL_PATH = '/api/v1/recall'
_DATASETS_PATH = '/api/v1/datasets'
_STATUS_PATH = '/api/v1/datasets/status'


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

    payload = _required_json(response, 'remember')
    if not isinstance(payload, dict) or not isinstance(payload.get('status'), str) or not payload['status']:
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
    """Recall ranked memory results while requesting references in one POST attempt.

    ``include_references`` remains in the helper signature for adapter compatibility,
    but the wire contract always enables it so callers cannot disable provenance.
    """
    url = f'{base_url}{_RECALL_PATH}'
    payload = {
        'query': query,
        'datasets': [dataset],
        'searchType': search_type,
        'topK': top_k,
        'includeReferences': True,
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

    results = _required_json(response, 'recall')
    if not isinstance(results, list) or not all(isinstance(result, dict) for result in results):
        raise CogneeRequestError('cognee: recall returned an invalid response')
    return results


def list_datasets(base_url: str, api_key: str, *, timeout: float) -> list[dict[str, Any]]:
    """List datasets visible to the authenticated Cognee user."""
    try:
        response = get_with_retry(
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
    """Return a stable pending/running/completed/failed dataset status."""
    try:
        response = get_with_retry(
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


def _json_of(resp: requests.Response) -> Any:
    """Parse a JSON response body, tolerating an empty body."""
    if not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:
        return {}


def _required_json(resp: requests.Response, op: str) -> Any:
    """Parse a required JSON body without exposing response content on failure."""
    if not resp.content:
        raise CogneeRequestError(f'cognee: {op} returned an invalid response')
    try:
        return resp.json()
    except ValueError:
        raise CogneeRequestError(f'cognee: {op} returned an invalid response') from None


def _as_request_error(exc: requests.RequestException, op: str) -> CogneeRequestError:
    """Convert a requests exception into an agent-safe error with no vendor detail."""
    status: Optional[int] = getattr(getattr(exc, 'response', None), 'status_code', None)
    if status == 402:
        return CogneeRequestError(f'cognee: {op} request failed (HTTP 402): token budget exhausted')
    detail = f' (HTTP {status})' if status else ''
    return CogneeRequestError(f'cognee: {op} request failed{detail}: {type(exc).__name__}')
