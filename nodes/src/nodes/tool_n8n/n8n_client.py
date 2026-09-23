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
n8n HTTP client.

Thin wrapper around requests with two distinct surfaces:

* ``call`` — the n8n public REST API (``{base_url}/api/v1/...``), authenticated
  with the ``X-N8N-API-KEY`` header. Used to list/inspect workflows and poll
  executions.
* ``trigger_webhook`` — fires a workflow's webhook (``{base_url}/webhook/...``).
  This is the ONLY way to run a workflow on demand; n8n has no synchronous
  "run-by-id" REST endpoint. Webhook auth (header/basic) is separate from the
  REST API key.

``preflight`` turns an unreachable instance into an actionable, deploy-aware
error (the localhost-in-Docker footgun). All requests thread a ``verify`` flag
so a self-signed local n8n over HTTPS can be reached with verification off.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

import requests

API_PREFIX = '/api/v1'
DEFAULT_TIMEOUT = 30
PREFLIGHT_TIMEOUT = 5

# Transient statuses worth retrying on idempotent GETs.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_GET_RETRIES = 2
_MAX_BACKOFF = 8.0
# Cap on workflows/executions paged through, to bound a runaway scan.
_MAX_PAGES = 20

# n8n's default response when a webhook fires but the workflow has no
# "Respond to Webhook" node (and isn't set to respond when the last node
# finishes). Detecting it lets us warn instead of returning a useless ack.
_STARTED_ACK = 'workflow was started'

_LOCAL_HOSTS = {'localhost', '127.0.0.1', '0.0.0.0', '::1'}


# ---------------------------------------------------------------------------
# Public REST API ({base_url}/api/v1/...)
# ---------------------------------------------------------------------------


def call(
    base_url: str,
    api_key: str,
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    """Make an authenticated n8n public-API call and return parsed JSON.

    Raises ``ValueError`` with a human-readable message on missing key,
    transport failure, or HTTP error. Returns ``{}`` for 204 No Content.
    """
    if not api_key:
        raise ValueError(
            'n8n API key is required for this operation (listing workflows or polling '
            'executions). Set it in the node config or the ROCKETRIDE_N8N_KEY env var.'
        )

    url = f'{base_url}{API_PREFIX}{path}'
    headers = {'X-N8N-API-KEY': api_key, 'accept': 'application/json'}
    method_u = method.upper()
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}

    # Retry transient failures, but ONLY on idempotent GETs (never replay a POST
    # like activate/deactivate). Honors Retry-After on 429/503.
    attempt = 0
    while True:
        try:
            resp = requests.request(
                method_u, url, headers=headers, params=clean_params, json=body, timeout=timeout, verify=verify
            )
        except requests.RequestException as exc:
            if method_u == 'GET' and attempt < _MAX_GET_RETRIES:
                attempt += 1
                time.sleep(min(2.0**attempt, _MAX_BACKOFF))
                continue
            raise ValueError(f'n8n API request failed: {exc}') from exc
        if resp.status_code in _RETRY_STATUSES and method_u == 'GET' and attempt < _MAX_GET_RETRIES:
            attempt += 1
            time.sleep(_retry_delay(resp, attempt))
            continue
        break

    if resp.status_code == 204:
        return {}

    if resp.status_code in (401, 403):
        raise ValueError(f'n8n API {resp.status_code}: unauthorized — check the API key (X-N8N-API-KEY).')

    if not resp.ok:
        raise ValueError(f'n8n API {resp.status_code}: {_error_message(resp)}')

    try:
        return resp.json()
    except ValueError:
        return {}


# ---------------------------------------------------------------------------
# Webhook trigger ({base_url}/webhook/... or /webhook-test/...)
# ---------------------------------------------------------------------------


def trigger_webhook(
    base_url: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    files: Optional[Dict[str, Any]] = None,
    method: str = 'POST',
    auth: Optional[Dict[str, str]] = None,
    test_mode: bool = False,
    verify: bool = True,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    """Fire a workflow's webhook and return the parsed response body.

    ``path`` is the webhook path configured on the workflow's Webhook node
    (not the workflow id). ``test_mode`` targets ``/webhook-test/`` (the editor's
    one-shot listener) instead of the activated production ``/webhook/`` route.

    Raises ``ValueError`` on transport failure or HTTP error; a 404 is mapped to
    a clear "activate/publish the workflow" message since a production webhook
    only exists once the workflow is active.
    """
    segment = 'webhook-test' if test_mode else 'webhook'
    url = f'{base_url}/{segment}/{path.lstrip("/")}'
    headers, basic_auth = _apply_webhook_auth(auth)

    kwargs: Dict[str, Any] = {
        'headers': headers,
        'auth': basic_auth,
        'timeout': timeout,
        'verify': verify,
    }
    if files:
        # multipart/form-data: text fields (data=) + binary parts (files=)
        kwargs['data'] = payload or {}
        kwargs['files'] = files
    elif method.upper() != 'GET':
        kwargs['json'] = payload or {}
    elif payload:
        kwargs['params'] = payload

    try:
        resp = requests.request(method.upper(), url, **kwargs)
    except requests.RequestException as exc:
        raise ValueError(f'n8n webhook request failed: {exc}') from exc

    if resp.status_code == 404:
        raise ValueError(
            f'n8n webhook not found at {url}. A production webhook only exists once the '
            'workflow is activated/published in n8n — activate it, or enable test mode while '
            'editing the workflow.'
        )

    if not resp.ok:
        raise ValueError(f'n8n webhook {resp.status_code}: {_error_message(resp)}')

    return parse_response(resp)


# Content types we treat as binary (returned to the caller as raw bytes).
_BINARY_CTYPES = {'application/octet-stream', 'application/pdf', 'application/zip'}


def parse_response(resp: 'requests.Response') -> Any:
    """Parse an n8n response: binary (image/audio/video/octet-stream) → bytes dict,
    JSON when possible, else text.
    """
    ctype = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
    if ctype.startswith(('image/', 'audio/', 'video/')) or ctype in _BINARY_CTYPES:
        return {'__rr_binary__': True, 'mime': ctype or 'application/octet-stream', 'data': resp.content}
    try:
        return resp.json()
    except ValueError:
        return resp.text


def is_started_ack(body: Any) -> bool:
    """True if ``body`` is n8n's "workflow started" ack (i.e. no result was returned).

    A workflow returns real data only when it ends in a "Respond to Webhook" node
    (or the Webhook node is set to respond when the last node finishes). Otherwise
    n8n replies with ``{"message": "Workflow was started"}`` and the caller should
    be told to add a Respond node rather than treating the ack as a result.
    """
    return isinstance(body, dict) and str(body.get('message', '')).strip().lower() == _STARTED_ACK


# ---------------------------------------------------------------------------
# Async execution polling
# ---------------------------------------------------------------------------

# Execution states that mean the run is over (n8n reports these in `status`).
_FINISHED_STATES = {'success', 'error', 'crashed', 'canceled'}


def find_workflow_id_by_path(
    base_url: str,
    api_key: str,
    path: str,
    *,
    verify: bool = True,
) -> str:
    """Resolve a webhook path to its workflow id via the public API.

    Async polling filters executions by **workflow id**, but the node is
    configured with the webhook **path** — this bridges the two. Raises
    ``ValueError`` if no workflow exposes the path (or the API key is missing).
    """
    target = path.lstrip('/')
    cursor: Optional[str] = None
    # Page through the whole catalog (cursor-paginated) instead of truncating at
    # one page — a path on workflow #300 must still resolve.
    for _ in range(_MAX_PAGES):
        params: Dict[str, Any] = {'limit': 100}
        if cursor:
            params['cursor'] = cursor
        data = call(base_url, api_key, 'GET', '/workflows', params=params, verify=verify)
        items = data.get('data', []) if isinstance(data, dict) else (data or [])
        for workflow in items:
            if not isinstance(workflow, dict):
                continue
            # The list endpoint normally embeds nodes; fall back to a detail fetch if not.
            if 'nodes' not in workflow and workflow.get('id'):
                try:
                    workflow = call(base_url, api_key, 'GET', f'/workflows/{workflow["id"]}', verify=verify)
                except ValueError:
                    continue
            if target in extract_webhook_paths(workflow):
                return str(workflow.get('id'))
        cursor = data.get('nextCursor') if isinstance(data, dict) else None
        if not cursor:
            break
    raise ValueError(
        f'No workflow with webhook path "{target}" found on the n8n instance — check the path '
        "on the workflow's Webhook node."
    )


def _parse_iso(ts: Any) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp to a tz-aware datetime (UTC when no offset).

    Tolerates a trailing ``Z`` (how n8n renders UTC) as well as ``+00:00`` (how we
    render ``started_after``), so execution timestamps compare chronologically
    instead of lexicographically. Returns ``None`` if missing or unparseable.
    """
    if not ts:
        return None
    s = str(ts)
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def wait_for_execution(
    base_url: str,
    api_key: str,
    workflow_id: str,
    *,
    correlation_id: Optional[str] = None,
    started_after: Optional[str] = None,
    timeout: float = 120,
    poll_interval: float = 2.0,
    verify: bool = True,
) -> Dict[str, Any]:
    """Poll executions for ``workflow_id`` until a matching run finishes.

    Matching: prefer an execution whose data echoes ``correlation_id`` (we inject
    it into the trigger payload, so the webhook node's recorded input contains
    it). Without a correlation id, fall back to the first finished execution with
    ``startedAt > started_after`` — documented as racy under concurrent runs.

    Returns the shaped execution (with data). Raises ``ValueError`` if the run
    finished in a non-success state or nothing matched before ``timeout``.
    """
    deadline = time.monotonic() + timeout
    interval = max(0.5, poll_interval)
    checked: set = set()
    started_dt = _parse_iso(started_after)

    while time.monotonic() < deadline:
        data = call(
            base_url, api_key, 'GET', '/executions', params={'workflowId': workflow_id, 'limit': 50}, verify=verify
        )
        items = data.get('data', []) if isinstance(data, dict) else (data or [])
        for summary in items:
            if not isinstance(summary, dict):
                continue
            eid = summary.get('id')
            if eid in checked:
                continue
            if started_dt is not None:
                summary_dt = _parse_iso(summary.get('startedAt'))
                if summary_dt is not None and summary_dt < started_dt:
                    checked.add(eid)
                    continue
            if summary.get('status') not in _FINISHED_STATES:
                continue  # still running — recheck next round

            full = call(base_url, api_key, 'GET', f'/executions/{eid}', params={'includeData': 'true'}, verify=verify)
            checked.add(eid)
            if correlation_id and correlation_id not in json.dumps(full.get('data') or {}, default=str):
                continue  # finished, but not our run

            status = full.get('status') or summary.get('status')
            if status != 'success':
                raise ValueError(f'n8n execution {eid} finished with status "{status}" — check the workflow run.')
            return clean_execution(full, base_url=base_url)

        time.sleep(interval)
        interval = min(interval * 1.5, 10.0)

    msg = (
        f'Timed out after {timeout:.0f}s waiting for the n8n execution to finish — the workflow may '
        "still be running. Check n8n's Executions view, or raise the async timeout in the node config."
    )
    if correlation_id:
        msg += (
            ' If the workflow never echoes `_rr_correlation_id` in its data, async matching cannot '
            'identify the run — pass that field through the workflow, or use sync mode.'
        )
    raise ValueError(msg)


# ---------------------------------------------------------------------------
# Reachability preflight
# ---------------------------------------------------------------------------


def preflight(base_url: str, *, verify: bool = True, timeout: float = PREFLIGHT_TIMEOUT) -> None:
    """Probe the n8n instance; raise a deploy-aware ``ValueError`` if unreachable.

    Converts the opaque connection error users hit when RocketRide runs in Docker
    (where ``localhost`` is the container, not the host) into a concrete fix.
    """
    try:
        requests.get(f'{base_url}/healthz', timeout=timeout, verify=verify)
        return
    except requests.RequestException as exc:
        raise ValueError(_unreachable_message(base_url, exc)) from exc


def _unreachable_message(base_url: str, exc: Exception) -> str:
    host = (urlparse(base_url).hostname or '').lower()
    base = f'Could not reach n8n at {base_url} ({type(exc).__name__}).'
    if host in _LOCAL_HOSTS and _in_container():
        return (
            f'{base} RocketRide appears to be running in a container, so "{host}" points at the '
            'container itself, not your machine. Use http://host.docker.internal:5678 (Docker '
            'Desktop, or add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux), or '
            'put n8n on the same Docker network and use http://n8n:5678.'
        )
    return f'{base} Is n8n running and is the Base URL correct?'


def _in_container() -> bool:
    """Best-effort detection of whether we're running inside a container."""
    if os.path.exists('/.dockerenv'):
        return True
    try:
        with open('/proc/1/cgroup', encoding='utf-8') as fh:
            contents = fh.read()
        return any(marker in contents for marker in ('docker', 'kubepods', 'containerd'))
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _retry_delay(resp: 'requests.Response', attempt: int) -> float:
    """Seconds to wait before a retry — honor Retry-After, else exponential backoff."""
    retry_after = resp.headers.get('Retry-After')
    if retry_after:
        try:
            return min(float(retry_after), _MAX_BACKOFF)
        except ValueError:
            pass
    return min(2.0**attempt, _MAX_BACKOFF)


def _apply_webhook_auth(auth: Optional[Dict[str, str]]) -> Tuple[Dict[str, str], Optional[Tuple[str, str]]]:
    """Translate a webhook-auth config dict into (headers, requests-basic-auth)."""
    headers: Dict[str, str] = {}
    if not auth:
        return headers, None
    kind = (auth.get('type') or 'none').lower()
    if kind == 'header':
        name = (auth.get('name') or '').strip()
        if name:
            headers[name] = auth.get('value', '')
    elif kind == 'basic':
        return headers, (auth.get('user', ''), auth.get('password', ''))
    elif kind in ('bearer', 'jwt'):
        # n8n's Bearer and JWT webhook auth both expect the token in the
        # Authorization header as a Bearer credential.
        token = (auth.get('value') or '').strip()
        if token:
            headers['Authorization'] = f'Bearer {token}'
    return headers, None


def _error_message(resp: requests.Response) -> str:
    """Extract a concise error message from an n8n error response."""
    try:
        data = resp.json()
        if isinstance(data, dict):
            return str(data.get('message') or data.get('error') or resp.text or resp.reason)
    except ValueError:
        pass
    return resp.text or resp.reason or 'unknown error'


# ---------------------------------------------------------------------------
# Response shapers — compact, agent-friendly output
# ---------------------------------------------------------------------------


def clean_workflow(w: Dict[str, Any]) -> Dict[str, Any]:
    """Shape an n8n workflow object, including any webhook paths it exposes."""
    if not isinstance(w, dict):
        return {}
    return {
        'id': w.get('id'),
        'name': w.get('name'),
        'active': w.get('active'),
        'createdAt': w.get('createdAt'),
        'updatedAt': w.get('updatedAt'),
        'tags': [t.get('name') for t in (w.get('tags') or []) if isinstance(t, dict)],
        'webhookPaths': extract_webhook_paths(w),
    }


def clean_execution(e: Dict[str, Any], base_url: Optional[str] = None) -> Dict[str, Any]:
    """Shape an n8n execution object (keeps ``data`` when present).

    When ``base_url`` is given and the id + workflow id are known, also include a
    ``url`` deep-link into n8n's execution view for cross-system observability.
    """
    if not isinstance(e, dict):
        return {}
    shaped = {
        'id': e.get('id'),
        'finished': e.get('finished'),
        'mode': e.get('mode'),
        'status': e.get('status'),
        'startedAt': e.get('startedAt'),
        'stoppedAt': e.get('stoppedAt'),
        'workflowId': e.get('workflowId'),
    }
    if 'data' in e:
        shaped['data'] = e.get('data')
    if base_url and shaped.get('id') and shaped.get('workflowId'):
        shaped['url'] = f'{base_url.rstrip("/")}/workflow/{shaped["workflowId"]}/executions/{shaped["id"]}'
    return shaped


def extract_webhook_paths(workflow: Dict[str, Any]) -> list:
    """Pull the configured ``path`` from any Webhook trigger nodes in a workflow.

    Useful for the config picker: a workflow id is not its webhook path, so the
    path must be read from the Webhook node's parameters.
    """
    paths = []
    for node in workflow.get('nodes') or []:
        if not isinstance(node, dict):
            continue
        if 'webhook' in str(node.get('type', '')).lower():
            path = (node.get('parameters') or {}).get('path')
            if path:
                paths.append(path)
    return paths
