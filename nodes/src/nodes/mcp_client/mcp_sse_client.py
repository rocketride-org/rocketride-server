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
Minimal MCP SSE client (no external SDK dependency).

Implements the MCP JSON-RPC lifecycle and the two server tool methods we need:
- initialize + notifications/initialized
- tools/list
- tools/call

Transport:
- GET an SSE stream from `sse_endpoint`
  - wait for initial `endpoint` event that supplies a relative POST URL (with session id)
  - receive server JSON-RPC responses as SSE `message` events
- POST client JSON-RPC requests to the discovered message endpoint URL
"""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from library.ssrf_protection import validate_url


class McpProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class McpToolDef:
    name: str
    description: str
    inputSchema: Dict[str, Any]


class McpSseClient:
    def __init__(
        self,
        *,
        sse_endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        protocol_version: str = '2025-11-25',
        client_name: str = 'RocketRideToolsMcpClient',
        client_version: str = '0.1.0',
        timeout_s: float = 20.0,
    ) -> None:
        """Create an MCP SSE client."""
        self._sse_endpoint = str(sse_endpoint).strip()
        if not self._sse_endpoint:
            raise ValueError('sse_endpoint is required')

        self._timeout_s = float(timeout_s)
        self._protocol_version = protocol_version
        self._client_info = {'name': client_name, 'version': client_version}

        self._headers = {str(k): str(v) for k, v in (headers or {}).items()}
        # Recommended by SSE servers; harmless if already set.
        self._headers.setdefault('Accept', 'text/event-stream')
        self._headers.setdefault('User-Agent', f'{client_name}/{client_version}')

        self._reader_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._incoming: 'queue.Queue[dict]' = queue.Queue()
        self._endpoint_url: str | None = None
        self._resp = None

        self._next_id = 1
        self._pending: Dict[int, dict] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        if self._reader_thread is not None:
            raise RuntimeError('MCP SSE client already started')

        # SSRF protection: validate the user-supplied SSE endpoint before any requests
        validate_url(self._sse_endpoint)

        self._stop.clear()
        self._reader_thread = threading.Thread(target=self._reader_loop, name='McpSseReader', daemon=True)
        self._reader_thread.start()

        endpoint_url = self._wait_for_endpoint()
        self._endpoint_url = endpoint_url

        # MCP lifecycle: initialize then notifications/initialized
        init_result = self._request(
            'initialize',
            {
                'protocolVersion': self._protocol_version,
                'capabilities': {'roots': {'listChanged': False}, 'sampling': {}},
                'clientInfo': self._client_info,
            },
        )
        if not isinstance(init_result, dict):
            raise McpProtocolError(f'initialize result expected object, got {type(init_result)}')

        self._notify('notifications/initialized', None)

    def stop(self) -> None:
        self._stop.set()
        try:
            resp = self._resp
            self._resp = None
            try:
                if resp is not None:
                    resp.close()
            except Exception:
                pass
        finally:
            t = self._reader_thread
            self._reader_thread = None
            if t is not None:
                t.join(timeout=1.0)

    # ------------------------------------------------------------------
    # MCP operations
    # ------------------------------------------------------------------
    def list_tools(self) -> List[McpToolDef]:
        result = self._request('tools/list', {})
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
        self._post_json(msg)

    def _request(self, method: str, params: Any) -> Any:  # noqa: ANN401
        req_id = self._next_id
        self._next_id += 1
        msg: Dict[str, Any] = {'jsonrpc': '2.0', 'id': req_id, 'method': method}
        if params is not None:
            msg['params'] = params
        self._post_json(msg)
        return self._recv_response(req_id=req_id)

    def _post_json(self, msg: Dict[str, Any]) -> None:
        if self._endpoint_url is None:
            raise RuntimeError('MCP SSE client not started (missing endpoint_url)')
        data = json.dumps(msg, ensure_ascii=False).encode('utf-8')
        headers = dict(self._headers)
        headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self._endpoint_url, data=data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                # The MCP SSE transport uses 202 Accepted; accept any 2xx.
                status = getattr(resp, 'status', 200)
                if not (200 <= int(status) < 300):
                    raise RuntimeError(f'POST {self._endpoint_url} failed status={status}')
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'POST {self._endpoint_url} failed status={e.code} body={e.read()!r}') from e

    def _recv_response(self, *, req_id: int) -> Any:  # noqa: ANN401
        deadline = time.time() + self._timeout_s

        # First, see if we already buffered it.
        if req_id in self._pending:
            msg = self._pending.pop(req_id)
            return self._unwrap_result(req_id=req_id, msg=msg)

        while True:
            if time.time() > deadline:
                raise TimeoutError(f'MCP request {req_id} timed out waiting for response')

            try:
                msg = self._incoming.get(timeout=0.1)
            except queue.Empty:
                continue

            if not isinstance(msg, dict):
                continue
            msg_id = msg.get('id')
            if not isinstance(msg_id, int):
                # ignore notifications
                continue
            if msg_id != req_id:
                self._pending[msg_id] = msg
                continue
            return self._unwrap_result(req_id=req_id, msg=msg)

    def _unwrap_result(self, *, req_id: int, msg: dict) -> Any:  # noqa: ANN401
        if 'error' in msg and isinstance(msg['error'], dict):
            code = msg['error'].get('code')
            message = msg['error'].get('message')
            raise McpProtocolError(f'MCP error (id={req_id}) code={code} message={message}')
        return msg.get('result')

    # ------------------------------------------------------------------
    # SSE reader
    # ------------------------------------------------------------------
    def _wait_for_endpoint(self) -> str:
        deadline = time.time() + self._timeout_s
        while True:
            if time.time() > deadline:
                raise TimeoutError('Timed out waiting for SSE endpoint event')
            if self._stop.is_set():
                raise RuntimeError('MCP SSE client stopped while waiting for endpoint')
            endpoint = self._endpoint_url
            if endpoint:
                return endpoint
            time.sleep(0.01)

    def _reader_loop(self) -> None:
        try:
            req = urllib.request.Request(self._sse_endpoint, headers=dict(self._headers), method='GET')
            self._resp = urllib.request.urlopen(req, timeout=self._timeout_s)

            event_name: str | None = None
            data_lines: List[str] = []

            while not self._stop.is_set():
                raw = self._resp.readline()
                if not raw:
                    break

                try:
                    line = raw.decode('utf-8', errors='replace')
                except Exception:
                    line = str(raw)
                line = line.rstrip('\r\n')

                # Blank line ends the event.
                if not line:
                    if event_name:
                        data = '\n'.join(data_lines)
                        self._handle_sse_event(event=event_name, data=data)
                    event_name = None
                    data_lines = []
                    continue

                # Comment / keepalive.
                if line.startswith(':'):
                    continue

                if line.startswith('event:'):
                    event_name = line.split(':', 1)[1].strip()
                    continue

                if line.startswith('data:'):
                    data_lines.append(line.split(':', 1)[1].lstrip())
                    continue

                # Ignore other SSE fields (id:, retry:, etc.)

        except Exception:
            # Best-effort: reader errors will surface as timeouts on requests.
            return
        finally:
            try:
                if self._resp is not None:
                    self._resp.close()
            except Exception:
                pass

    def _handle_sse_event(self, *, event: str, data: str) -> None:
        if event == 'endpoint':
            # The server provides a relative URL; resolve against the SSE origin.
            base = self._origin(self._sse_endpoint)
            resolved = urllib.parse.urljoin(base, data)
            # Validate the resolved URL stays on the same origin to prevent
            # auth-token theft via malicious absolute-URL redirects.
            if self._origin(resolved) != base:
                raise McpProtocolError(f'MCP endpoint redirect rejected: resolved origin {self._origin(resolved)!r} does not match SSE origin {base!r}')
            # SSRF protection: validate the server-provided endpoint URL
            validate_url(resolved)
            self._endpoint_url = resolved
            return

        if event != 'message':
            return

        if not data:
            return

        try:
            msg = json.loads(data)
        except Exception:
            return

        if isinstance(msg, dict):
            self._incoming.put(msg)

    @staticmethod
    def _origin(url: str) -> str:
        p = urllib.parse.urlparse(url)
        scheme = p.scheme or 'http'
        netloc = p.netloc
        if not netloc:
            # If user passed a bare host/path, best-effort treat as http://<url>
            p2 = urllib.parse.urlparse('http://' + url)
            scheme = p2.scheme
            netloc = p2.netloc
        # Normalize default ports so that e.g. https://host and https://host:443
        # are treated as the same origin.
        if scheme == 'https' and netloc.endswith(':443'):
            netloc = netloc[:-4]
        elif scheme == 'http' and netloc.endswith(':80'):
            netloc = netloc[:-3]
        return f'{scheme}://{netloc}'
