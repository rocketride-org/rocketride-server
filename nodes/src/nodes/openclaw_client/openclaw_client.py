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
OpenClaw gateway client — WebSocket + HTTP transport.

WebSocket is used for:
- Connection handshake (challenge-response auth)
- Tool discovery (tools.catalog RPC)
- Message bridge (sessions.messages.subscribe + session.message events)

HTTP is used for:
- Tool invocation (POST /tools/invoke) — simpler for synchronous calls
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy-load websockets so the module can be imported before depends() runs.
# ---------------------------------------------------------------------------
_ws_module = None


def _get_ws():
    global _ws_module
    if _ws_module is None:
        from websockets.sync.client import connect  # type: ignore[import-untyped]

        _ws_module = connect
    return _ws_module


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


class OpenClawProtocolError(RuntimeError):
    pass


class OpenClawHttpError(RuntimeError):
    def __init__(self, status: int, body: str, url: str) -> None:  # noqa: D107
        self.status = status
        self.body = body
        self.url = url
        super().__init__(f'HTTP {status} from {url}: {body[:200]}')


@dataclass(frozen=True)
class OpenClawToolDef:
    name: str
    description: str
    inputSchema: Dict[str, Any]
    group: str


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class OpenClawClient:
    """Transport layer for communicating with an OpenClaw gateway."""

    def __init__(  # noqa: D107
        self,
        *,
        ws_url: str,
        http_url: str,
        token: str,
        on_message: Optional[Callable[[Dict[str, Any]], None]] = None,
        rpc_timeout_s: float = 20.0,
        http_timeout_s: float = 30.0,
    ) -> None:
        self._ws_url = ws_url.rstrip('/')
        self._http_url = http_url.rstrip('/')
        self._token = token
        self._on_message = on_message
        self._rpc_timeout_s = rpc_timeout_s
        self._http_timeout_s = http_timeout_s

        self._ws: Any = None
        self._reader_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._next_id = 1
        self._id_lock = threading.Lock()

        # RPC response routing: id -> queue with single response dict
        self._pending: Dict[str, 'queue.Queue[dict]'] = {}
        self._pending_lock = threading.Lock()

        # Special queue for the connect.challenge event during handshake
        self._challenge_queue: 'queue.Queue[dict]' = queue.Queue()

        self._connected = False
        self._subscribed_session: str | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Connect to the gateway, perform handshake."""
        if self._reader_thread is not None:
            raise RuntimeError('OpenClaw client already started')

        connect = _get_ws()
        self._stop.clear()
        self._ws = connect(self._ws_url)

        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name='OpenClawWsReader',
            daemon=True,
        )
        self._reader_thread.start()

        # Wait for connect.challenge from gateway
        try:
            self._challenge_queue.get(timeout=self._rpc_timeout_s)
        except queue.Empty:
            raise TimeoutError('Timed out waiting for connect.challenge from gateway')

        # Send connect request with auth
        import platform as _platform

        resp = self._send_rpc(
            'connect',
            {
                'auth': {'token': self._token},
                'minProtocol': 3,
                'maxProtocol': 3,
                'client': {
                    'id': 'cli',
                    'version': '0.1.0',
                    'platform': _platform.system().lower(),
                    'mode': 'cli',
                },
                'role': 'operator',
                'scopes': ['operator.read', 'operator.write'],
            },
        )

        if not isinstance(resp, dict):
            raise OpenClawProtocolError(f'connect response expected dict, got {type(resp)}')

        self._connected = True
        logger.info('OpenClaw gateway connected at %s', self._ws_url)

    def stop(self) -> None:
        """Disconnect from the gateway."""
        self._stop.set()
        self._connected = False
        self._subscribed_session = None
        try:
            if self._ws is not None:
                self._ws.close()
                self._ws = None
        except Exception:
            pass
        t = self._reader_thread
        self._reader_thread = None
        if t is not None:
            t.join(timeout=2.0)

    # ------------------------------------------------------------------
    # Tool discovery (WebSocket RPC)
    # ------------------------------------------------------------------

    def discover_tools(self, *, agent_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Discover tools via the tools.catalog RPC. Returns list of tool groups."""
        params: Dict[str, Any] = {}
        if agent_id:
            params['agentId'] = agent_id
        params['includePlugins'] = True

        result = self._send_rpc('tools.catalog', params)
        if not isinstance(result, dict):
            raise OpenClawProtocolError(f'tools.catalog expected dict, got {type(result)}')
        groups = result.get('groups', [])
        if not isinstance(groups, list):
            raise OpenClawProtocolError(f'tools.catalog groups expected list, got {type(groups)}')
        return groups

    # ------------------------------------------------------------------
    # Message bridge (WebSocket subscribe)
    # ------------------------------------------------------------------

    def subscribe_messages(self, session_key: str) -> None:
        """Subscribe to incoming messages for a session."""
        self._send_rpc('sessions.messages.subscribe', {'sessionKey': session_key})
        self._subscribed_session = session_key
        logger.info('Subscribed to messages for session %s', session_key)

    # ------------------------------------------------------------------
    # Tool invocation (HTTP)
    # ------------------------------------------------------------------

    def invoke_tool(
        self,
        tool_name: str,
        args: Dict[str, Any],
        session_key: str = 'main',
    ) -> Any:  # noqa: ANN401
        """Invoke a tool via HTTP POST /tools/invoke."""
        url = f'{self._http_url}/tools/invoke'
        payload = {
            'tool': tool_name,
            'args': args or {},
            'sessionKey': session_key,
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers = {
            'Authorization': f'Bearer {self._token}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }

        req = urllib.request.Request(url, data=body, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=self._http_timeout_s) as resp:
                resp_body = resp.read().decode('utf-8')
                result = json.loads(resp_body)
        except urllib.error.HTTPError as e:
            err_body = ''
            try:
                err_body = e.read().decode('utf-8', errors='replace')
            except Exception:
                pass
            raise OpenClawHttpError(e.code, err_body, url) from e

        if not isinstance(result, dict):
            raise OpenClawProtocolError(f'/tools/invoke returned non-dict: {type(result)}')

        if not result.get('ok', False):
            error = result.get('error', {})
            err_type = error.get('type', 'unknown') if isinstance(error, dict) else 'unknown'
            err_msg = error.get('message', str(error)) if isinstance(error, dict) else str(error)
            raise OpenClawProtocolError(f'Tool invocation failed ({err_type}): {err_msg}')

        return result.get('result')

    # ------------------------------------------------------------------
    # WebSocket RPC internals
    # ------------------------------------------------------------------

    def _next_req_id(self) -> str:
        with self._id_lock:
            req_id = str(self._next_id)
            self._next_id += 1
            return req_id

    def _send_rpc(self, method: str, params: Dict[str, Any]) -> Any:  # noqa: ANN401
        """Send a WebSocket RPC request and wait for the response."""
        req_id = self._next_req_id()
        frame = {
            'type': 'req',
            'id': req_id,
            'method': method,
            'params': params,
        }

        # Create response queue before sending
        resp_queue: 'queue.Queue[dict]' = queue.Queue()
        with self._pending_lock:
            self._pending[req_id] = resp_queue

        try:
            ws = self._ws
            if ws is None:
                raise RuntimeError('WebSocket not connected')
            ws.send(json.dumps(frame, ensure_ascii=False))

            try:
                resp = resp_queue.get(timeout=self._rpc_timeout_s)
            except queue.Empty:
                raise TimeoutError(f'RPC {method} (id={req_id}) timed out')

            if not resp.get('ok', False):
                error = resp.get('error', {})
                err_msg = error.get('message', str(error)) if isinstance(error, dict) else str(error)
                raise OpenClawProtocolError(f'RPC {method} failed: {err_msg}')

            return resp.get('payload')
        finally:
            with self._pending_lock:
                self._pending.pop(req_id, None)

    # ------------------------------------------------------------------
    # WebSocket reader thread
    # ------------------------------------------------------------------

    def _handshake_direct(self, ws: Any) -> None:
        """Perform the WebSocket handshake by reading/writing directly on the socket.

        Used during reconnect when _reader_inner is not yet running and the
        queue-based routing (_challenge_queue, _send_rpc) is unavailable.
        """
        import platform as _platform

        # Read connect.challenge directly
        raw = ws.recv(timeout=self._rpc_timeout_s)
        frame = json.loads(raw)
        if not (isinstance(frame, dict) and frame.get('event') == 'connect.challenge'):
            raise OpenClawProtocolError(f'Expected connect.challenge on reconnect, got: {frame}')

        # Send connect request directly
        req_id = self._next_req_id()
        ws.send(
            json.dumps(
                {
                    'type': 'req',
                    'id': req_id,
                    'method': 'connect',
                    'params': {
                        'auth': {'token': self._token},
                        'minProtocol': 3,
                        'maxProtocol': 3,
                        'client': {
                            'id': 'cli',
                            'version': '0.1.0',
                            'platform': _platform.system().lower(),
                            'mode': 'cli',
                        },
                        'role': 'operator',
                        'scopes': ['operator.read', 'operator.write'],
                    },
                },
                ensure_ascii=False,
            )
        )

        # Read connect response directly — loop to skip any interleaved events
        resp: dict | None = None
        for _ in range(10):
            raw = ws.recv(timeout=self._rpc_timeout_s)
            f = json.loads(raw)
            if isinstance(f, dict) and str(f.get('id', '')) == req_id:
                resp = f
                break
        if resp is None:
            raise OpenClawProtocolError('Did not receive connect response after reconnect')
        if not resp.get('ok', False):
            error = resp.get('error', {})
            msg = error.get('message', str(error)) if isinstance(error, dict) else str(error)
            raise OpenClawProtocolError(f'connect failed on reconnect: {msg}')

    def _subscribe_direct(self, ws: Any, session_key: str) -> None:
        """Send sessions.messages.subscribe directly on the socket (no reader thread)."""
        req_id = self._next_req_id()
        ws.send(
            json.dumps(
                {
                    'type': 'req',
                    'id': req_id,
                    'method': 'sessions.messages.subscribe',
                    'params': {'sessionKey': session_key},
                },
                ensure_ascii=False,
            )
        )
        # Read response, skipping interleaved events
        for _ in range(10):
            raw = ws.recv(timeout=self._rpc_timeout_s)
            f = json.loads(raw)
            if isinstance(f, dict) and str(f.get('id', '')) == req_id:
                break

    def _reader_loop(self) -> None:
        """Background thread: reads WebSocket frames, routes responses and events."""
        backoff = 1.0
        max_backoff = 30.0

        while not self._stop.is_set():
            try:
                self._reader_inner()
            except Exception:
                if self._stop.is_set():
                    return
                logger.warning(
                    'OpenClaw WebSocket disconnected, reconnecting in %.1fs',
                    backoff,
                    exc_info=True,
                )
                self._connected = False
                time.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
                # Attempt reconnect
                try:
                    connect = _get_ws()
                    self._ws = connect(self._ws_url)
                    # Re-handshake directly — _reader_inner is not yet running so
                    # _challenge_queue and _send_rpc (which both depend on the reader
                    # thread routing frames) cannot be used here.
                    self._handshake_direct(self._ws)
                    self._connected = True
                    backoff = 1.0
                    logger.info('OpenClaw WebSocket reconnected')
                    # Re-subscribe to messages if bridge was active
                    if self._subscribed_session:
                        self._subscribe_direct(self._ws, self._subscribed_session)
                except Exception:
                    if self._stop.is_set():
                        return
                    logger.warning('OpenClaw reconnect failed', exc_info=True)

    def _reader_inner(self) -> None:
        """Read frames from WebSocket until disconnect or stop."""
        ws = self._ws
        if ws is None:
            raise RuntimeError('No WebSocket connection')

        while not self._stop.is_set():
            try:
                raw = ws.recv(timeout=1.0)
            except TimeoutError:
                continue
            except Exception:
                raise

            if not raw:
                continue

            try:
                frame = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue

            if not isinstance(frame, dict):
                continue

            frame_type = frame.get('type')

            # Route response frames
            if frame_type == 'res':
                frame_id = str(frame.get('id', ''))
                with self._pending_lock:
                    resp_queue = self._pending.get(frame_id)
                if resp_queue is not None:
                    resp_queue.put(frame)
                continue

            # Route event frames
            if frame_type == 'event':
                event_name = frame.get('event', '')
                payload = frame.get('payload', {})

                if event_name == 'connect.challenge':
                    self._challenge_queue.put(payload)
                    continue

                if event_name == 'session.message' and self._on_message is not None:
                    try:
                        self._on_message(payload)
                    except Exception:
                        logger.warning('Error in on_message callback', exc_info=True)
                    continue
