# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
xTrace Memory node instance.

Exposes two agent tools backed by the xTrace Memory Manager HTTP API:

  remember — POST /v1/memories : ingest conversation turns. xTrace extracts
             facts (and optionally artifacts) and episodes server-side and
             stores them in the org's memory pool.
  recall   — POST /v1/memories/search : agentic search over the pool. In
             'compose' mode the server returns a ready-to-inject markdown
             ``context`` block; in 'retrieve' mode it returns ranked rows.

Unlike the run-scoped ``memory_internal`` node, this store is persistent and
shared: every agent/run pointing at the same org (and groups) reads and writes
the same memory. The store is therefore never cleared on open.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

import requests

from rocketlib import IInstanceBase, tool_function, debug

from ai.common.utils import normalize_tool_input

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Node instance exposing xTrace Memory as agent tools."""

    IGlobal: IGlobal
    _conv_id: str = ''

    def beginInstance(self) -> None:
        self._conv_id = ''

    def open(self, _obj: Any) -> None:
        """Anchor a fresh conversation id per client session (no store wipe)."""
        self._conv_id = f'conv_{uuid.uuid4().hex}'

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
                'conv_id': {
                    'type': 'string',
                    'description': 'Conversation anchor. Defaults to a per-session id.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'status': {'type': 'string', 'description': 'succeeded | failed | pending'},
                'job_id': {'type': 'string'},
                'memories_created': {'type': 'array', 'items': {'type': 'object'}},
                'error': {'type': 'string'},
            },
        },
        description='Store conversation turns in shared, persistent memory. xTrace extracts facts and episodes server-side so they can be recalled later by this or other agents in the same org/group.',
    )
    def remember(self, args):
        """Ingest conversation turns into xTrace memory."""
        args = normalize_tool_input(args, tool_name='remember')
        cfg = self.IGlobal

        messages = _coerce_messages(args.get('messages'), args.get('content'), args.get('role'))
        if not messages:
            return {
                'success': False,
                'status': 'failed',
                'error': 'provide "messages" (array of {role, content}) or "content"',
            }

        user_id = str(args.get('user_id') or cfg.user_id or '').strip()
        if not user_id:
            return {
                'success': False,
                'status': 'failed',
                'error': 'user_id is required — set it on the call or in node config',
            }

        conv_id = str(args.get('conv_id') or self._conv_id or '').strip()
        if not conv_id:
            conv_id = f'conv_{uuid.uuid4().hex}'
            self._conv_id = conv_id

        payload: Dict[str, Any] = {
            'messages': messages,
            'user_id': user_id,
            'conv_id': conv_id,
            'extract_artifacts': cfg.extract_artifacts,
        }
        if cfg.agent_id:
            payload['agent_id'] = cfg.agent_id
        if cfg.app_id:
            payload['app_id'] = cfg.app_id
        if cfg.group_ids:
            payload['group_ids'] = cfg.group_ids

        url = f'{cfg.base_url}/v1/memories'
        params = {'wait': 'true'} if cfg.wait else None

        try:
            job = _request_with_retry('POST', url, _headers(cfg), payload=payload, params=params)
        except RuntimeError as exc:
            return {'success': False, 'status': 'failed', 'error': str(exc)}

        job = self._await_terminal(job, cfg)
        status = str(job.get('status') or 'pending')
        result = job.get('result') or {}
        return {
            'success': status != 'failed',
            'status': status,
            'job_id': job.get('id', ''),
            'memories_created': result.get('memories_created', []),
            'error': (job.get('error') or {}).get('message', '') if status == 'failed' else '',
        }

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
                'group_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Scope to shared groups (any-of). Defaults to the node config value.',
                },
                'mode': {
                    'type': 'string',
                    'enum': ['compose', 'retrieve'],
                    'description': '"compose" returns a ready-to-inject context block; "retrieve" returns ranked rows only. Defaults to node config.',
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
                'context': {'type': 'string', 'description': 'Ready-to-inject markdown (compose mode), or empty.'},
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'count': {'type': 'integer'},
                'error': {'type': 'string'},
            },
        },
        description='Search shared memory for context relevant to a query. In compose mode returns a ready-to-inject context block plus the ranked memories behind it.',
    )
    def recall(self, args):
        """Search xTrace memory and return relevant context."""
        args = normalize_tool_input(args, tool_name='recall')
        cfg = self.IGlobal

        query = (args.get('query') or '').strip()
        if not query:
            return {
                'success': False,
                'context': '',
                'results': [],
                'count': 0,
                'error': 'query is required and must be a non-empty string',
            }

        user_id = str(args.get('user_id') or cfg.user_id or '').strip()
        group_ids = args.get('group_ids')
        if not isinstance(group_ids, list) or not group_ids:
            group_ids = cfg.group_ids

        # At least one scope axis is required by the API.
        if not user_id and not group_ids and not cfg.agent_id and not cfg.app_id:
            return {
                'success': False,
                'context': '',
                'results': [],
                'count': 0,
                'error': 'a scope is required — set user_id or group_ids on the call or in node config',
            }

        mode = str(args.get('mode') or cfg.search_mode).strip().lower()
        if mode not in ('compose', 'retrieve'):
            mode = cfg.search_mode

        raw_limit = args.get('limit', cfg.search_limit)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
            raw_limit = cfg.search_limit
        limit = max(1, min(100, raw_limit))

        payload: Dict[str, Any] = {'query': query, 'mode': mode, 'limit': limit}
        if user_id:
            payload['user_id'] = user_id
        if group_ids:
            payload['group_ids'] = group_ids
        if cfg.agent_id:
            payload['agent_id'] = cfg.agent_id
        if cfg.app_id:
            payload['app_id'] = cfg.app_id

        url = f'{cfg.base_url}/v1/memories/search'
        try:
            resp = _request_with_retry('POST', url, _headers(cfg), payload=payload)
        except RuntimeError as exc:
            return {'success': False, 'context': '', 'results': [], 'count': 0, 'error': str(exc)}

        data = resp.get('data') or []
        results = [
            {
                'id': row.get('id', ''),
                'type': row.get('type', ''),
                'text': row.get('text', ''),
                'score': row.get('score'),
            }
            for row in data
            if isinstance(row, dict)
        ]
        return {
            'success': True,
            'context': resp.get('context') or '',
            'results': results,
            'count': len(results),
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _await_terminal(self, job: Dict[str, Any], cfg: IGlobal) -> Dict[str, Any]:
        """Poll the ingest job until it reaches a terminal state or times out."""
        status = str(job.get('status') or '')
        if status in ('succeeded', 'failed') or not cfg.wait:
            return job

        job_id = job.get('id')
        if not job_id:
            return job

        deadline = time.monotonic() + cfg.ingest_timeout
        delay = 0.5
        url = f'{cfg.base_url}/v1/memories/jobs/{job_id}'
        while time.monotonic() < deadline:
            time.sleep(delay)
            try:
                job = _request_with_retry('GET', url, _headers(cfg))
            except RuntimeError as exc:
                debug(f'xtrace_memory: poll failed: {exc}')
                break
            if str(job.get('status') or '') in ('succeeded', 'failed'):
                break
            delay = min(delay * 2, 5.0)
        return job


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _headers(cfg: IGlobal) -> Dict[str, str]:
    return {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-api-key': cfg.api_key,
        'X-Org-Id': cfg.org_id,
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


def _request_with_retry(
    method: str,
    url: str,
    headers: Dict[str, str],
    *,
    payload: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    max_retries: int = 3,
    base_delay: float = 2.0,
) -> Dict[str, Any]:
    """Execute an HTTP request to the xTrace API with retry on 429/5xx/timeout."""
    for attempt in range(max_retries + 1):
        try:
            resp = requests.request(method, url, headers=headers, json=payload, params=params, timeout=35)

            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                if attempt < max_retries:
                    delay = base_delay * (2**attempt)
                    debug(
                        f'xtrace_memory: HTTP {resp.status_code}, retrying in {delay}s (attempt {attempt + 1}/{max_retries})'
                    )
                    time.sleep(delay)
                    continue
                resp.raise_for_status()

            resp.raise_for_status()
            return resp.json() if resp.content else {}

        except requests.exceptions.Timeout:
            if attempt < max_retries:
                delay = base_delay * (2**attempt)
                debug(f'xtrace_memory: request timeout, retrying in {delay}s (attempt {attempt + 1}/{max_retries})')
                time.sleep(delay)
                continue
            raise RuntimeError('xtrace_memory: request timed out after all retries') from None

        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            raise RuntimeError(f'xtrace_memory: request failed{detail}: {type(exc).__name__}') from None

    raise RuntimeError('xtrace_memory: max retries exceeded')
