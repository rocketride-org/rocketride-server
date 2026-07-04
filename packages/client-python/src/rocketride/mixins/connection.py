# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Connection Management for RocketRide Client.

This module handles connecting to and disconnecting from RocketRide servers.
It manages the WebSocket connection lifecycle, authentication, and status tracking.

The connection system automatically handles:
- WebSocket connection establishment
- Authentication with your credential (API key, Zitadel access_token, or rr_ user token)
- Connection status tracking
- Automatic reconnection on disconnects (when persist=True)
- Graceful disconnection and cleanup

Usage:
    client = RocketRideClient(uri="http://localhost:8080")
    result = await client.connect("your_api_key")
    # result is a ConnectResult with full user identity and organizations

    if client.is_connected():
        # Do work with the client
        pass

    await client.disconnect()
"""

# Design: Physical connect/disconnect live in _internal_connect and _internal_disconnect.
# Non-persist mode: connect() and disconnect() call those directly.
# Persist mode: connect() uses _attempt_connection (first attempt inline); retries and
# reconnect-on-disconnect are scheduled via _schedule_reconnect / _attempt_reconnect.

import asyncio
import os
import urllib.parse
from typing import Any, Dict, Optional
from ..core import DAPClient, TransportWebSocket, CONST_DEFAULT_WEB_PORT, CONST_DEFAULT_WEB_PROTOCOL
from ..core.exceptions import AuthenticationException
from ..types.client import ConnectResult


class ConnectionMixin(DAPClient):
    """
    Handles connection and disconnection to RocketRide servers.

    This mixin provides the fundamental connection management capabilities
    for the RocketRide client. It manages WebSocket connections, handles
    authentication, and tracks connection status.

    Key Features:
    - Establishes secure WebSocket connections to RocketRide servers
    - Single connect(credential) call authenticates and returns ConnectResult
    - Tracks connection status for reliable operations
    - Automatic reconnection on disconnect (when persist=True)
    - Provides graceful connection cleanup
    """

    def __init__(self, persist: bool = False, max_retry_time: Optional[float] = None, **kwargs):
        """
        Initialize connection management.

        Args:
            persist: Enable automatic reconnection on disconnect.
            max_retry_time: Deprecated — accepted but ignored. Reconnection
                uses linear backoff (0.25s increments, 15s cap) and never gives up.
            **kwargs: Additional arguments passed to parent class.
        """
        super().__init__(**kwargs)
        self._persist = persist
        # Desired state model — replaces old flag soup
        self._desired_state: str = 'detached'  # 'detached' | 'attached' | 'authenticated'
        self._authenticated: bool = False
        self._reconnect_timer: Optional[asyncio.Task] = None
        self._current_reconnect_delay: float = 0.25  # seconds; +0.25 per failure, cap 15s

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """Handle transport-level connection event (before auth)."""
        await super().on_connected(connection_info)

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle transport disconnection.

        Clears transport and auth state, chains to parent, then consults
        ``_desired_state`` to decide whether to reconnect.
        """
        self._transport = None
        self._connect_result = None
        self._authenticated = False

        await super().on_disconnected(reason, has_error)

        # Reconnect engine: honour _desired_state
        if self._desired_state == 'detached':
            return
        if not self._persist:
            self._desired_state = 'detached'
            return
        if self._reconnect_timer and not self._reconnect_timer.done():
            return  # engine already active

        self._current_reconnect_delay = 0.25
        self._schedule_reconnect()

    # =========================================================================
    # INTERNAL HELPERS
    # =========================================================================

    async def _internal_attach(self, timeout: Optional[float] = None) -> None:
        """Create transport if needed and open the WebSocket. No auth."""
        if self._transport is None:
            self._transport = TransportWebSocket(uri=self._uri)
            self._bind_transport(self._transport)
        await DAPClient.connect(self, timeout)

    async def _internal_login(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Send the ``auth`` DAP command over the open transport."""
        auth_args: Dict[str, Any] = {'auth': self._apikey or ''}
        if getattr(self, '_client_display_name', None):
            auth_args['clientName'] = self._client_display_name
        if getattr(self, '_client_display_version', None):
            auth_args['clientVersion'] = self._client_display_version

        request = {
            'type': 'request',
            'command': 'auth',
            'seq': self._next_seq(),
            'arguments': auth_args,
        }
        try:
            response = await self.request(request, timeout=timeout)
        except Exception:
            raise
        if not response.get('success', False):
            message = response.get('message', 'Authentication failed')
            raise AuthenticationException({'message': message})

        auth_body = response.get('body') or {}
        self._connect_result = auth_body  # type: ignore[assignment]
        self._authenticated = True

        # Store userToken for future reconnects
        if auth_body.get('userToken'):
            self._apikey = auth_body['userToken']

        connection_info = self._transport.get_connection_info() if self._transport else None
        await super().on_connected(connection_info)
        return auth_body

    async def _internal_logout(self) -> None:
        """Send ``deauth`` DAP command to revert to unauthenticated."""
        if not self._authenticated or not self._transport or not self._transport.is_connected():
            return
        try:
            request = {'type': 'request', 'command': 'deauth', 'seq': self._next_seq(), 'arguments': {}}
            await self.request(request)
        except Exception:
            pass  # Best-effort
        self._connect_result = None
        self._authenticated = False

    async def _internal_disconnect(self) -> None:
        """Close and clean up the transport."""
        if self._transport is None:
            return
        await self._transport.disconnect()

    def _clear_reconnect_timer(self) -> None:
        """Cancel the reconnect task if active."""
        if self._reconnect_timer and not self._reconnect_timer.done():
            self._reconnect_timer.cancel()
            self._reconnect_timer = None

    def _schedule_reconnect(self) -> None:
        """Schedule a reconnect attempt driven by ``_desired_state``."""
        self._debug_message(f'Scheduling reconnect in {self._current_reconnect_delay}s')
        self._reconnect_timer = asyncio.create_task(self._do_reconnect())

    async def _do_reconnect(self) -> None:
        """Reconnect engine: sleep, re-attach, optionally re-login."""
        await asyncio.sleep(self._current_reconnect_delay)
        try:
            await self._internal_attach()
            if self._desired_state == 'detached':
                self._reconnect_timer = None
                return

            if self._desired_state == 'authenticated':
                await self._internal_login()
                if self._desired_state == 'detached':
                    self._reconnect_timer = None
                    return

            # Success — reset backoff
            self._reconnect_timer = None
            self._current_reconnect_delay = 0.25
            self._debug_message('Reconnect successful')
        except AuthenticationException as e:
            # Auth rejected — downgrade to attached, stop retrying auth
            if self._desired_state == 'detached':
                self._reconnect_timer = None
                return
            self._desired_state = 'attached'
            self._reconnect_timer = None
            await self.on_connect_error(e)
        except Exception as e:
            if self._desired_state == 'detached':
                self._reconnect_timer = None
                return
            # Transient failure — linear backoff, cap at 15s
            self._current_reconnect_delay = min(self._current_reconnect_delay + 0.25, 15.0)
            await self.on_connect_error(e)
            self._schedule_reconnect()  # replaces timer

    # =========================================================================
    # PUBLIC API — TRANSPORT
    # =========================================================================

    async def attach(self, uri: Optional[str] = None, *, timeout: Optional[float] = None) -> None:
        """
        Attach to a RocketRide server (open WebSocket, no auth).

        If ``uri`` is provided and differs from the current URI, detaches
        first. If already attached to the same URI, this is a no-op.
        """
        if uri:
            normalised = self._get_websocket_uri(uri) if hasattr(self, '_get_websocket_uri') else uri
            if normalised != self._uri:
                if self.is_attached():
                    await self.detach()
                self._set_uri(normalised)
        if self.is_attached():
            if self._desired_state == 'detached':
                self._desired_state = 'attached'
            return
        self._desired_state = 'attached'
        await self._internal_attach(timeout)

    async def detach(self) -> None:
        """Detach from the server (close WebSocket, cancel reconnection)."""
        self._desired_state = 'detached'
        self._clear_reconnect_timer()
        self._authenticated = False
        self._connect_result = None
        if self._transport and self._transport.is_connected():
            await self._internal_disconnect()

    def is_attached(self) -> bool:
        """True when the WebSocket transport is connected (regardless of auth)."""
        return self._transport is not None and self._transport.is_connected()

    # =========================================================================
    # PUBLIC API — AUTH
    # =========================================================================

    async def login(
        self,
        credential: Optional[str] = None,
        *,
        uri: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> ConnectResult:
        """
        Authenticate over an attached transport.

        If ``uri`` is provided and differs, detaches and re-attaches first.
        If ``credential`` is provided and differs from the current credential,
        logs out (best-effort) before logging in with the new credential.
        If already authenticated with the same credential, this is a no-op.
        """
        resolved = credential or self._apikey or os.environ.get('ROCKETRIDE_APIKEY', '')

        # URI change → detach + re-attach
        if uri:
            normalised = self._get_websocket_uri(uri) if hasattr(self, '_get_websocket_uri') else uri
            if normalised != self._uri:
                await self.detach()
                self._set_uri(normalised)
                await self._internal_attach(timeout)

        # Ensure attached
        if not self.is_attached():
            await self._internal_attach(timeout)

        # Auth change → logout first (best-effort)
        if resolved != self._apikey and self._authenticated:
            try:
                await self._internal_logout()
            except Exception:
                pass
        self._set_auth(resolved)

        # Already authenticated with same credential → no-op
        if self._authenticated:
            self._desired_state = 'authenticated'
            return self._connect_result or {}  # type: ignore[return-value]

        self._desired_state = 'authenticated'
        return await self._internal_login(timeout)

    async def logout(self) -> None:
        """Deauthenticate: sends ``deauth`` to server, clears client auth state."""
        await self._internal_logout()
        self._desired_state = 'attached'

    def is_authenticated(self) -> bool:
        """True when the auth handshake has succeeded on the current connection."""
        return self._authenticated

    # =========================================================================
    # COMPAT API — connect() / disconnect()
    # =========================================================================

    async def connect(
        self,
        credential: Optional[str] = None,
        *,
        timeout: Optional[float] = None,
    ) -> ConnectResult:
        """
        Connect and authenticate in a single call (backward compatible).

        Wraps ``attach()`` + ``login()``. Sends the credential as the first
        DAP message and returns the full ConnectResult on success.
        """
        self._current_reconnect_delay = 0.25
        await self.attach(timeout=timeout)
        return await self.login(credential, timeout=timeout)

    def get_account_info(self) -> Optional[ConnectResult]:
        """Return the ConnectResult from the last successful login()."""
        return self._connect_result

    async def disconnect(self) -> None:
        """Disconnect (backward compatible). Wraps ``logout()`` + ``detach()``."""
        await self.logout()
        await self.detach()

    # =========================================================================
    # HELPERS
    # =========================================================================

    def get_connection_info(self) -> dict:
        """Return current connection state and URI."""
        return {
            'connected': self.is_connected(),
            'transport': 'WebSocket',
            'uri': getattr(self, '_uri', ''),
        }

    def get_apikey(self) -> Optional[str]:
        """Return the API key in use. For debugging only."""
        return getattr(self, '_apikey', None)

    @staticmethod
    def normalize_uri(uri: str) -> str:
        """Normalize a user-provided URI into a fully-formed HTTP/HTTPS URL."""
        if uri and '://' not in uri:
            uri = f'{CONST_DEFAULT_WEB_PROTOCOL}{uri}'

        parsed = urllib.parse.urlparse(uri)

        # Use `is None` (not `not parsed.port`) so port=0 stays as 0 instead of
        # being silently rewritten to CONST_DEFAULT_WEB_PORT. Port 0 reaching this
        # code is a caller bug; the substitution would mask it as a connection
        # error against the wrong host.
        if parsed.port is None and 'rocketride.ai' not in (parsed.hostname or ''):
            hostname = parsed.hostname
            if not hostname:
                raise ValueError(f"Invalid URI '{uri}': missing hostname")
            parsed = parsed._replace(netloc=f'{hostname}:{CONST_DEFAULT_WEB_PORT}')

        return parsed.geturl()

    @staticmethod
    def _get_websocket_uri(uri: str, ws_path: str = '/task/service') -> str:
        """Normalize a user-provided URI into a fully-formed WebSocket address.

        Args:
            uri: Raw URI (bare host:port, http://, https://, ws://, wss://).
            ws_path: WebSocket endpoint path (default: '/task/service').
                     Use '/models' for the model server.
        """
        normalized = ConnectionMixin.normalize_uri(uri)
        parsed = urllib.parse.urlparse(normalized)

        ws_scheme = 'wss' if parsed.scheme in ('https', 'wss') else 'ws'
        normalized_ws_path = f'/{ws_path.lstrip("/")}'
        ws_uri = parsed._replace(scheme=ws_scheme, path=normalized_ws_path, params='', query='', fragment='')
        return ws_uri.geturl()

    def _set_uri(self, uri: str) -> None:
        """Update the server URI (internal)."""
        self._uri = self._get_websocket_uri(uri)

    def _set_auth(self, auth: str) -> None:
        """Update the authentication credential (internal)."""
        self._apikey = auth

    def set_env(self, env: Dict[str, str]) -> None:
        """Update the environment variables used for pipeline substitution."""
        self._env = dict(env)

    async def request(self, request: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        """Send a request to the RocketRide server."""
        return await super().request(request, timeout=timeout)
