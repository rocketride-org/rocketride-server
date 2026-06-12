# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mem0 node instance.

Exposes two agent tools backed by the hosted Mem0 Platform REST API:

  remember — POST /v1/memories/ : ingest conversation turns. Mem0 extracts
             salient facts server-side and stores them in the project's memory
             pool, scoped by the supplied entity ids.
  recall   — POST /v1/memories/search/ : semantic search over the pool, scoped
             by the same entity ids, returning ranked rows.

Unlike the run-scoped ``memory_internal`` node, this store is persistent and
shared: every agent/run pointing at the same Mem0 project (and entity ids)
reads and writes the same memory. The store is therefore never cleared on open.

This node talks to the documented Mem0 REST API directly with ``requests``
rather than the ``mem0ai`` SDK: the SDK hard-pins ``openai<1.110``, which is
unsatisfiable alongside the engine's OpenAI nodes (``openai>=2.38``). The REST
surface is identical — the entity ids (``user_id`` / ``agent_id`` / ``run_id`` /
``app_id``) go top-level in the JSON body for both add and search.

Mem0's ``add`` is asynchronous: it queues a background extraction job and
returns a ``{status: "PENDING", event_id}`` receipt rather than the created
memories, so a ``recall`` issued immediately after would find nothing. To give
agents a synchronous ``remember`` -> ``recall`` flow, ``remember`` polls
``GET /v1/event/{event_id}/`` until the job reaches a terminal state
(``SUCCEEDED`` / ``FAILED``) or ``ingest_timeout`` elapses (gated by the ``wait``
config, default on). ``search`` returns the ranked rows (a bare list or a
``{"results": [...]}`` object). All of these shapes are handled defensively below.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, List, Optional

import requests
from tenacity import Retrying, retry_if_exception, stop_after_attempt, stop_after_delay, wait_exponential

from rocketlib import IInstanceBase, tool_function, debug

from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal

# Per-request socket timeout, in seconds.
_REQUEST_TIMEOUT = 35


class IInstance(IInstanceBase):
    """Node instance exposing Mem0 as agent tools."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'content': {
                    'type': 'string',
                    'description': 'A single statement to remember. Convenience for one user turn; ignored if "messages" is provided.',
                },
                'role': {
                    'type': 'string',
                    'description': 'Role for the "content" convenience field (default "user").',
                },
                'messages': {
                    'type': 'array',
                    'description': 'Conversation turns to ingest. Each item is {role, content}. Preferred over "content".',
                    'items': {
                        'type': 'object',
                        'required': ['role', 'content'],
                        'properties': {
                            'role': {'type': 'string', 'description': 'e.g. "user" or "assistant"'},
                            'content': {'type': 'string'},
                        },
                    },
                },
                'user_id': {
                    'type': 'string',
                    'description': 'User whose memory this belongs to. Defaults to the node config value.',
                },
                'run_id': {
                    'type': 'string',
                    'description': 'Optional session/run scope for this memory. Defaults to the node config value.',
                },
                'metadata': {
                    'type': 'object',
                    'description': 'Optional key/value metadata stamped on the extracted memories.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'status': {'type': 'string', 'description': 'succeeded | queued | failed'},
                'event_id': {'type': 'string', 'description': 'Set when Mem0 queues extraction asynchronously.'},
                'memories_created': {'type': 'array', 'items': {'type': 'object'}},
                'error': {'type': 'string'},
            },
        },
        description='Store conversation turns in shared, persistent memory. Mem0 extracts salient facts server-side so they can be recalled later by this or other agents pointing at the same project and entity ids.',
    )
    def remember(self, args):
        """Ingest conversation turns into Mem0."""
        args = normalize_tool_input(args, tool_name='remember')
        cfg = self.IGlobal

        messages = _coerce_messages(args.get('messages'), args.get('content'), args.get('role'))
        if not messages:
            return {
                'success': False,
                'status': 'failed',
                'error': 'provide "messages" (array of {role, content}) or "content"',
            }

        # Entity ids go top-level in the request body; at least one is required.
        scope = self._scope(args.get('user_id'), args.get('run_id'))
        if not scope:
            return {
                'success': False,
                'status': 'failed',
                'error': 'a scope is required — set user_id (or agent_id/run_id/app_id) on the call or in node config',
            }

        payload: Dict[str, Any] = {
            'messages': messages,
            'output_format': 'v1.1',
            'version': 'v2',
            'infer': cfg.infer,
        }
        payload.update(scope)
        metadata = args.get('metadata')
        if isinstance(metadata, dict) and metadata:
            payload['metadata'] = metadata

        url = f'{cfg.base_url}/v1/memories/'
        try:
            # Ingest is a non-idempotent write (no idempotency key in the API),
            # so don't retry on ambiguous 5xx/timeout — only on 429.
            resp = _request_with_retry('POST', url, _headers(cfg), payload=payload, idempotent=False)
        except RuntimeError as exc:
            return {'success': False, 'status': 'failed', 'error': str(exc)}

        # add() queues background extraction and returns an event id; optionally
        # wait for it to finish so a following recall can see the memory.
        event_id = _event_id_of(resp)
        if cfg.wait and event_id:
            resp = self._await_event(event_id, cfg)
        return _shape_add(resp, event_id)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'Natural-language query describing what context you need.',
                },
                'user_id': {
                    'type': 'string',
                    'description': 'Scope to one user. Defaults to the node config value.',
                },
                'run_id': {
                    'type': 'string',
                    'description': 'Optional session/run scope. Defaults to the node config value.',
                },
                'limit': {
                    'type': 'integer',
                    'description': 'Max rows to retrieve. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'count': {'type': 'integer'},
                'error': {'type': 'string'},
            },
        },
        description='Search shared memory for facts relevant to a query. Returns the ranked memories (text + relevance score) scoped to the configured user/agent/run.',
    )
    def recall(self, args):
        """Search Mem0 and return relevant memories."""
        args = normalize_tool_input(args, tool_name='recall')
        cfg = self.IGlobal

        query = (args.get('query') or '').strip()
        if not query:
            return {
                'success': False,
                'results': [],
                'count': 0,
                'error': 'query is required and must be a non-empty string',
            }

        # Entity ids go top-level in the search body, same as add().
        scope = self._scope(args.get('user_id'), args.get('run_id'))
        if not scope:
            return {
                'success': False,
                'results': [],
                'count': 0,
                'error': 'a scope is required — set user_id (or agent_id/run_id/app_id) on the call or in node config',
            }

        raw_limit = args.get('limit', cfg.search_limit)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
            raw_limit = cfg.search_limit
        limit = max(1, min(100, raw_limit))

        payload: Dict[str, Any] = {'query': query, 'top_k': limit}
        payload.update(scope)

        url = f'{cfg.base_url}/v1/memories/search/'
        try:
            resp = _request_with_retry('POST', url, _headers(cfg), payload=payload)
        except RuntimeError as exc:
            return {'success': False, 'results': [], 'count': 0, 'error': str(exc)}

        results = _shape_results(resp)
        return {'success': True, 'results': results, 'count': len(results)}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _scope(self, user_id: Any, run_id: Any) -> Dict[str, str]:
        """Build the entity-id scope from per-call overrides falling back to config.

        Spread top-level into both the add and search request bodies. agent_id
        and app_id come from config only.
        """
        cfg = self.IGlobal
        scope: Dict[str, str] = {}
        uid = str(user_id or cfg.user_id or '').strip()
        if uid:
            scope['user_id'] = uid
        if cfg.agent_id:
            scope['agent_id'] = cfg.agent_id
        rid = str(run_id or cfg.run_id or '').strip()
        if rid:
            scope['run_id'] = rid
        if cfg.app_id:
            scope['app_id'] = cfg.app_id
        return scope

    def _await_event(self, event_id: str, cfg: IGlobal) -> Dict[str, Any]:
        """Poll the add event until it reaches a terminal state or times out.

        Returns the latest event payload. On timeout (or poll error) it returns
        the last non-terminal payload seen, which ``_shape_add`` renders as
        ``queued`` — the write was accepted, extraction just hasn't finished.
        """
        url = f'{cfg.base_url}/v1/event/{event_id}/'
        deadline = time.monotonic() + cfg.ingest_timeout
        delay = 0.5
        event: Dict[str, Any] = {'status': 'PENDING', 'event_id': event_id}
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(delay, remaining))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                # Clamp the socket timeout to the remaining budget so one slow
                # poll can't overrun ingest_timeout.
                polled = _request_with_retry('GET', url, _headers(cfg), timeout=min(_REQUEST_TIMEOUT, remaining))
            except RuntimeError as exc:
                debug(f'mem0: event poll failed: {exc}')
                break
            if isinstance(polled, dict):
                event = polled
            if str(event.get('status') or '').strip().upper() in ('SUCCEEDED', 'FAILED'):
                break
            delay = min(delay * 2, 5.0)
        return event


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _headers(cfg: IGlobal) -> Dict[str, str]:
    """Auth + content headers, mirroring the mem0ai SDK's hosted client.

    The ``Mem0-User-ID`` header (an MD5 of the API key) is what the SDK sends;
    it identifies the caller and is harmless to replicate.
    """
    return {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': f'Token {cfg.api_key}',
        # usedforsecurity=False: this digest is just an opaque caller id, not a
        # security primitive — without it md5() raises on FIPS-enabled builds.
        'Mem0-User-ID': hashlib.md5(cfg.api_key.encode(), usedforsecurity=False).hexdigest(),
    }


def _coerce_messages(messages: Any, content: Any, role: Any) -> List[Dict[str, str]]:
    """Normalize tool input into a list of {role, content} message dicts."""
    out: List[Dict[str, str]] = []
    if isinstance(messages, list):
        for m in messages:
            if isinstance(m, dict) and str(m.get('content') or '').strip():
                out.append({'role': str(m.get('role') or 'user'), 'content': str(m['content'])})
    if not out and content is not None and str(content).strip():
        out.append({'role': str(role or 'user'), 'content': str(content)})
    return out


def _event_id_of(resp: Any) -> str:
    """Pull the add event id from the response (top-level or wrapped in results)."""
    if not isinstance(resp, dict):
        return ''
    if resp.get('event_id'):
        return str(resp['event_id'])
    results = resp.get('results')
    if isinstance(results, list) and results and isinstance(results[0], dict):
        return str(results[0].get('event_id') or '')
    return ''


def _shape_add(resp: Any, event_id: str = '') -> Dict[str, Any]:
    """Map a Mem0 add / event response into the tool's output schema.

    Handles every shape this node can see:

    * a terminal event payload (``{status: SUCCEEDED, results: [...memories]}``)
      from ``_await_event``,
    * a non-terminal event / queue receipt (``status`` PENDING/RUNNING, or
      ``{"results": [{event_id, status}]}``) -> reported as ``queued``,
    * a synchronous create (``{"results": [...memories]}`` or a bare list).

    ``event_id`` is the id captured from the original add, used when the payload
    itself does not carry one.
    """
    if isinstance(resp, list):
        return {'success': True, 'status': 'succeeded', 'event_id': event_id, 'memories_created': resp}
    if not isinstance(resp, dict):
        return {'success': True, 'status': 'succeeded', 'event_id': event_id, 'memories_created': []}

    results = resp.get('results')
    results = results if isinstance(results, list) else []
    status_raw = str(resp.get('status') or '').strip().upper()
    event_id = event_id or str(resp.get('event_id') or resp.get('id') or '')

    if status_raw == 'SUCCEEDED':
        return {'success': True, 'status': 'succeeded', 'event_id': event_id, 'memories_created': results}
    if status_raw == 'FAILED':
        return {'success': False, 'status': 'failed', 'event_id': event_id, 'memories_created': []}
    if status_raw in ('PENDING', 'RUNNING', 'PROCESSING', 'QUEUED'):
        return {'success': True, 'status': 'queued', 'event_id': event_id, 'memories_created': []}

    # No event-style status: either an async receipt wrapped in results, or a
    # synchronous create whose results are the actual memories.
    if results and isinstance(results[0], dict) and results[0].get('event_id') and 'memory' not in results[0]:
        receipt = results[0]
        event_id = event_id or str(receipt.get('event_id') or '')
        failed = str(receipt.get('status') or '').strip().upper() == 'FAILED'
        return {
            'success': not failed,
            'status': 'failed' if failed else 'queued',
            'event_id': event_id,
            'memories_created': [],
        }

    return {'success': True, 'status': 'succeeded', 'event_id': event_id, 'memories_created': results}


def _shape_results(resp: Any) -> List[Dict[str, Any]]:
    """Extract ranked memory rows from a Mem0 search response.

    search returns a bare list of rows; tolerate a ``{"results": [...]}`` object too.
    """
    rows = resp.get('results') if isinstance(resp, dict) else resp
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                'id': row.get('id', ''),
                'memory': row.get('memory') or row.get('text') or '',
                'score': row.get('score'),
                'metadata': row.get('metadata') or {},
                'categories': row.get('categories') or [],
            }
        )
    return out


def _request_with_retry(
    method: str,
    url: str,
    headers: Dict[str, str],
    *,
    payload: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    max_retries: int = 3,
    idempotent: bool = True,
    timeout: float = _REQUEST_TIMEOUT,
) -> Any:
    """Execute an HTTP request to the Mem0 API with bounded retries (via tenacity).

    Args:
        method: HTTP verb, e.g. ``'GET'`` or ``'POST'``.
        url: Fully-qualified request URL.
        headers: Request headers (auth + content type).
        payload: JSON body to send, or ``None``.
        params: Query-string parameters, or ``None``.
        max_retries: Retries after the first try (total attempts = ``max_retries + 1``).
        idempotent: When ``True``, retry on 5xx and timeouts. When ``False`` (writes such
            as ingest), retry only on 429 — which means the request was not processed —
            and never on 5xx/timeout, to avoid duplicate side effects.
        timeout: Per-request socket timeout in seconds. Callers that poll against a
            deadline (e.g. ingest wait) pass the remaining budget so a single request
            can't overrun it.

    Returns:
        The parsed JSON response body (a dict or a list; ``{}`` when the body is empty).

    Raises:
        RuntimeError: If the request ultimately fails (retries exhausted or a
            non-retryable error).
    """

    def _is_retryable(exc: BaseException) -> bool:
        """Return True when the failed attempt is safe to retry under this policy."""
        if isinstance(exc, requests.exceptions.Timeout):
            return idempotent
        if isinstance(exc, requests.exceptions.HTTPError):
            status = getattr(getattr(exc, 'response', None), 'status_code', 0)
            return status == 429 or (idempotent and 500 <= status < 600)
        return False

    def _attempt() -> Any:
        """Perform one HTTP request and return the parsed JSON body."""
        resp = requests.request(method, url, headers=headers, json=payload, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    try:
        return Retrying(
            # Bound retries by both attempt count and the caller's time budget so
            # the backoff can't push a deadline-driven call (e.g. ingest poll)
            # past `timeout`.
            stop=stop_after_attempt(max_retries + 1) | stop_after_delay(timeout),
            wait=wait_exponential(multiplier=2, min=min(2, timeout), max=min(16, timeout)),
            retry=retry_if_exception(_is_retryable),
            reraise=True,
        )(_attempt)
    except requests.RequestException as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        detail = f' (HTTP {status})' if status else ''
        raise RuntimeError(f'mem0: request failed{detail}: {type(exc).__name__}') from None
