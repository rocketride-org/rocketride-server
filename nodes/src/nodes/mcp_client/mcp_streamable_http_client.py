# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Minimal MCP Streamable HTTP client (no external SDK dependency).

Spec reference:
  MCP spec 2025-03-26: Streamable HTTP transport
  - single MCP endpoint path supporting POST/GET
  - client POSTs JSON-RPC messages to endpoint
  - server responds with application/json OR text/event-stream
  - server may return Mcp-Session-Id header at initialization

This client supports:
- initialize + notifications/initialized
- tools/list
- tools/call

It supports both response modes:
- Content-Type: application/json
- Content-Type: text/event-stream (SSE stream)
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional


class McpProtocolError(RuntimeError):
    pass


class McpHttpStatusError(RuntimeError):
    def __init__(self, *, status: int, body: bytes | None = None, url: str | None = None) -> None:
        """Create an HTTP status error with response context."""
        super().__init__(f'HTTP status={status} url={url!r} body={(body or b"")[:200]!r}')
        self.status = int(status)
        self.body = body
        self.url = url


@dataclass(frozen=True)
class McpToolDef:
    name: str
    description: str
    inputSchema: Dict[str, Any]


class McpStreamableHttpClient:
    def __init__(
        self,
        *,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        protocol_version: str = '2025-11-25',
        client_name: str = 'RocketRideToolsMcpClient',
        client_version: str = '0.1.0',
        timeout_s: float = 20.0,
    ) -> None:
        """Create an MCP streamable HTTP client."""
        self._endpoint = str(endpoint).strip()
        if not self._endpoint:
            raise ValueError('endpoint is required')

        self._timeout_s = float(timeout_s)
        self._protocol_version = protocol_version
        self._client_info = {'name': client_name, 'version': client_version}

        self._headers = {str(k): str(v) for k, v in (headers or {}).items()}
        # Required by the Streamable HTTP spec: list both content types.
        self._headers.setdefault('Accept', 'application/json, text/event-stream')

        self._next_id = 1
        self._session_id: str | None = None
        self._started = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        if self._started:
            raise RuntimeError('MCP streamable-http client already started')

        init_result, resp_headers = self._request_with_headers(
            'initialize',
            {
                'protocolVersion': self._protocol_version,
                'capabilities': {'roots': {'listChanged': False}, 'sampling': {}},
                'clientInfo': self._client_info,
            },
        )
        if not isinstance(init_result, dict):
            raise McpProtocolError(f'initialize result expected object, got {type(init_result)}')

        # Session management (optional).
        sid = _get_header(resp_headers, 'Mcp-Session-Id')
        if sid:
            self._session_id = sid

        # notifications/initialized (a notification only; expect 202 if accepted).
        self._notify('notifications/initialized', None)
        self._started = True

    def stop(self) -> None:
        # Optional: explicitly terminate session if supported.
        sid = self._session_id
        self._session_id = None
        self._started = False
        if not sid:
            return

        headers = self._build_headers()
        headers['Mcp-Session-Id'] = sid
        req = urllib.request.Request(self._endpoint, headers=headers, method='DELETE')
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                _ = resp.read()
        except urllib.error.HTTPError as e:
            # 405 is allowed by spec (server may not allow clients to terminate).
            if int(getattr(e, 'code', 0)) == 405:
                return
        except Exception:
            # Best-effort only.
            return

    # ------------------------------------------------------------------
    # MCP operations
    # ------------------------------------------------------------------
    def list_tools(self) -> List[McpToolDef]:
        result = self._request('tools/list', {'cursor': None})
        if not isinstance(result, dict):
            raise McpProtocolError(f'tools/list result expected object, got {type(result)}')
        tools = result.get('tools', [])
        if not isinstance(tools, list):
            raise McpProtocolError(f'tools/list result.tools expected list, got {type(tools)}')

        out: List[McpToolDef] = []
        for t in tools:
            if not isinstance(t, dict):
                continue
            name = t.get('name')
            if not isinstance(name, str) or not name:
                continue
            desc = t.get('description') if isinstance(t.get('description'), str) else ''
            schema = t.get('inputSchema') if isinstance(t.get('inputSchema'), dict) else {'type': 'object'}
            out.append(McpToolDef(name=name, description=desc, inputSchema=schema))
        return out

    def call_tool(self, *, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        result = self._request('tools/call', {'name': name, 'arguments': arguments or {}})
        if not isinstance(result, dict):
            raise McpProtocolError(f'tools/call result expected object, got {type(result)}')
        return result

    # ------------------------------------------------------------------
    # JSON-RPC internals
    # ------------------------------------------------------------------
    def _notify(self, method: str, params: Any) -> None:  # noqa: ANN401
        msg: Dict[str, Any] = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        self._post_notification(msg)

    def _request(self, method: str, params: Any) -> Any:  # noqa: ANN401
        result, _headers = self._request_with_headers(method, params)
        return result

    def _request_with_headers(self, method: str, params: Any) -> tuple[Any, Dict[str, str]]:  # noqa: ANN401
        req_id = self._next_id
        self._next_id += 1
        msg: Dict[str, Any] = {'jsonrpc': '2.0', 'id': req_id, 'method': method}
        if params is not None:
            msg['params'] = params

        return self._post_request_and_wait(req_id=req_id, payload=msg)

    def _post_notification(self, payload: Dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers = self._build_headers()
        headers['Content-Type'] = 'application/json'
        if self._session_id:
            headers['Mcp-Session-Id'] = self._session_id

        req = urllib.request.Request(self._endpoint, data=data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                status = int(getattr(resp, 'status', 200))
                body = resp.read() or b''
                # For notifications/responses-only, spec requires 202 on accept (no body).
                if status == 202:
                    return
                if 200 <= status < 300 and not body:
                    return
                # Some servers may return 200 with empty body; accept it.
                if 200 <= status < 300 and body == b'':
                    return
        except urllib.error.HTTPError as e:
            raise McpHttpStatusError(status=int(e.code), body=_safe_read_http_error(e), url=self._endpoint) from e

    def _post_request_and_wait(self, *, req_id: int, payload: Dict[str, Any]) -> tuple[Any, Dict[str, str]]:  # noqa: ANN401
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers = self._build_headers()
        headers['Content-Type'] = 'application/json'
        if self._session_id:
            headers['Mcp-Session-Id'] = self._session_id

        req = urllib.request.Request(self._endpoint, data=data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                status = int(getattr(resp, 'status', 200))
                resp_headers = {k: v for (k, v) in (resp.headers.items() if resp.headers else [])}
                if status == 202:
                    # Shouldn't happen for a request, but tolerate.
                    return None, resp_headers

                ctype = (resp.headers.get('Content-Type') or '').lower() if resp.headers else ''
                if 'text/event-stream' in ctype:
                    result = self._read_sse_until_response(resp, req_id=req_id)
                    return result, resp_headers

                body = resp.read() or b''
                result = _parse_jsonrpc_response_body(body=body, req_id=req_id)
                return result, resp_headers
        except urllib.error.HTTPError as e:
            raise McpHttpStatusError(status=int(e.code), body=_safe_read_http_error(e), url=self._endpoint) from e

    def _read_sse_until_response(self, resp, *, req_id: int) -> Any:  # noqa: ANN401
        deadline = time.time() + self._timeout_s

        event_data_lines: List[str] = []
        # Note: Streamable HTTP doesn't require named events; parse "data:" generically.
        while True:
            if time.time() > deadline:
                raise TimeoutError(f'SSE stream timed out waiting for response id={req_id}')
            raw = resp.readline()
            if not raw:
                # Stream ended; if no response seen, error.
                raise TimeoutError(f'SSE stream ended before response id={req_id}')

            try:
                line = raw.decode('utf-8', errors='replace')
            except Exception:
                line = str(raw)
            line = line.rstrip('\r\n')

            if not line:
                # end of SSE event
                if event_data_lines:
                    data = '\n'.join(event_data_lines)
                    for msg in _iter_jsonrpc_messages_from_sse_data(data):
                        maybe = _match_jsonrpc_id(msg, req_id=req_id)
                        if maybe is not None:
                            return maybe
                event_data_lines = []
                continue

            if line.startswith(':'):
                continue
            if line.startswith('data:'):
                event_data_lines.append(line.split(':', 1)[1].lstrip())
                continue
            # ignore event:, id:, retry:

    def _build_headers(self) -> Dict[str, str]:
        # Make a fresh headers dict per request.
        return dict(self._headers)


def _safe_read_http_error(e: urllib.error.HTTPError) -> bytes:
    try:
        return e.read()  # type: ignore[no-any-return]
    except Exception:
        return b''


def _get_header(headers: Dict[str, str], name: str) -> str | None:
    lname = name.lower()
    for k, v in headers.items():
        if str(k).lower() == lname:
            s = str(v).strip()
            return s or None
    return None


def _parse_jsonrpc_response_body(*, body: bytes, req_id: int) -> Any:  # noqa: ANN401
    if not body:
        raise McpProtocolError('Empty response body for JSON-RPC request')
    try:
        obj = json.loads(body.decode('utf-8'))
    except Exception as e:
        raise McpProtocolError(f'Invalid JSON response: {body[:200]!r}') from e

    # Body may be a single response or a batch.
    for msg in _iter_jsonrpc_messages(obj):
        maybe = _match_jsonrpc_id(msg, req_id=req_id)
        if maybe is not None:
            return maybe
    raise McpProtocolError(f'No JSON-RPC response found for id={req_id}')


def _iter_jsonrpc_messages(obj: Any) -> Iterable[dict]:  # noqa: ANN401
    if isinstance(obj, dict):
        yield obj
    elif isinstance(obj, list):
        for it in obj:
            if isinstance(it, dict):
                yield it


def _iter_jsonrpc_messages_from_sse_data(data: str) -> Iterable[dict]:
    if not data:
        return
    try:
        obj = json.loads(data)
    except Exception:
        return
    for msg in _iter_jsonrpc_messages(obj):
        yield msg


def _match_jsonrpc_id(msg: dict, *, req_id: int) -> Any | None:  # noqa: ANN401
    if not isinstance(msg, dict):
        return None
    if msg.get('id') != req_id:
        return None
    if 'error' in msg and isinstance(msg['error'], dict):
        code = msg['error'].get('code')
        message = msg['error'].get('message')
        raise McpProtocolError(f'MCP error (id={req_id}) code={code} message={message}')
    return msg.get('result')

