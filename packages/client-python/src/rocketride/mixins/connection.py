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
import time
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
            persist: Enable automatic reconnection on disconnect
            max_retry_time: Max total time in ms to keep retrying (None = forever)
            **kwargs: Additional arguments passed to parent class
        """
        super().__init__(**kwargs)
        self._persist = persist
        self._max_retry_time = max_retry_time  # ms; None = retry forever
        self._retry_start_time: Optional[float] = None  # when first failure occurred; used to enforce max_retry_time
        self._current_reconnect_delay: float = 0.25  # seconds until next retry; doubled each failure, capped at 2.5s
        self._manual_disconnect = False  # True only after user calls disconnect(); stops on_disconnected from scheduling reconnect
        self._reconnect_task: Optional[asyncio.Task] = None  # task that sleeps then calls _attempt_connection
        self._did_notify_connected = False  # True after we called on_connected; gates whether we invoke user on_disconnected
        self._connect_result: Optional[ConnectResult] = None  # stored on successful connect

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """Handle connection established event."""
        self._manual_disconnect = False
        self._did_notify_connected = True
        self._current_reconnect_delay = 0.25
        self._retry_start_time = None
        await super().on_connected(connection_info)

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle disconnection event.

        Clears stored ConnectResult, notifies user if we had connected,
        and schedules reconnection in persist mode.
        """
        self._transport = None
        self._connect_result = None

        if self._did_notify_connected:
            self._did_notify_connected = False
            await super().on_disconnected(reason, has_error)

        if self._persist and not self._manual_disconnect:
            await self._schedule_reconnect()

    # =========================================================================
    # INTERNAL CONNECTION PRIMITIVES
    # =========================================================================

    async def _internal_connect(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        Create transport if needed, connect, send auth, and notify on_connected.
        Returns the auth response body (ConnectResult fields). Raises on failure.
        """
        if self._transport is None:
            self._transport = TransportWebSocket(uri=self._uri, auth=self._apikey)
            self._bind_transport(self._transport)

        return await DAPClient.connect(self, timeout)

    async def _internal_disconnect(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """Close and clean up the transport. Transport invokes on_disconnected when it closes."""
        if self._transport is None:
            return
        await self._transport.disconnect(reason, has_error)

    async def _attempt_connection(self, timeout: Optional[float] = None) -> Optional[ConnectResult]:
        """
        Try _internal_connect once; on auth error stop; on other error reschedule with backoff.
        Used by persist-mode connect() and by the reconnect task.
        Returns ConnectResult on success, None on failure.
        """
        try:
            body = await self._internal_connect(timeout)
            connect_result: ConnectResult = body  # type: ignore[assignment]
            self._connect_result = connect_result
            # Persist mode: store userToken so reconnects use the durable rr_ key
            if connect_result.get('userToken'):
                self._apikey = connect_result['userToken']
            self._reconnect_task = None
            self._debug_message('Connection successful')
            return connect_result
        except AuthenticationException as e:
            self._debug_message(f'Connection failed (auth): {e}')
            await self.on_connect_error(e)
            return None
        except Exception as e:
            self._debug_message(f'Connection failed: {e}')
            await self.on_connect_error(e)

            if self._retry_start_time is None:
                self._retry_start_time = time.monotonic()

            if self._max_retry_time is not None:
                if time.monotonic() - self._retry_start_time >= self._max_retry_time / 1000.0:
                    return None

            self._current_reconnect_delay = min(self._current_reconnect_delay * 2, 2.5)
            await self._schedule_reconnect()
            return None

    async def _schedule_reconnect(self) -> None:
        """Schedule a reconnection attempt with exponential backoff."""
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()

        if self._max_retry_time is not None and self._retry_start_time is not None:
            if time.monotonic() - self._retry_start_time >= self._max_retry_time / 1000.0:
                await self.on_connect_error(Exception('Max retry time exceeded'))
                return

        self._debug_message(f'Scheduling reconnection in {self._current_reconnect_delay}s')
        self._reconnect_task = asyncio.create_task(self._attempt_reconnect())

    async def _attempt_reconnect(self) -> None:
        """Sleep then call _attempt_connection (used by scheduled reconnect)."""
        await asyncio.sleep(self._current_reconnect_delay)
        if self._persist and not self._manual_disconnect:
            self._debug_message('Attempting to reconnect...')
            await self._attempt_connection()

    # =========================================================================
    # PUBLIC API
    # =========================================================================

    async def connect(
        self,
        credential: Optional[str] = None,
        *,
        timeout: Optional[float] = None,
    ) -> ConnectResult:
        """
        Connect to the RocketRide server and authenticate in a single call.

        Sends the credential as the first DAP message and returns the full
        ConnectResult (user identity + organizations + teams) on success.

        If `credential` is omitted, falls back to: the `auth` passed at construction
        time, then the `ROCKETRIDE_APIKEY` environment variable.

        In persist mode, enables automatic reconnection. After the first successful
        connect the stored `userToken` is replayed automatically on reconnect.

        Args:
            credential: API key / Zitadel access_token / rr_ user token.
                        Falls back to construction-time auth, then ROCKETRIDE_APIKEY env var.
            timeout: Optional overall timeout in ms covering the WebSocket handshake
                     and auth request.

        Returns:
            ConnectResult with user identity, organizations, and teams.
        """
        resolved = credential or self._apikey or os.environ.get('ROCKETRIDE_APIKEY', '')
        self._set_auth(resolved)

        self._manual_disconnect = False
        self._current_reconnect_delay = 0.25
        self._retry_start_time = None

        if self.is_connected():
            await self._internal_disconnect()

        result: Optional[ConnectResult] = None
        if self._persist:
            if self._reconnect_task and not self._reconnect_task.done():
                self._reconnect_task.cancel()
                self._reconnect_task = None
            result = await self._attempt_connection(timeout)
        else:
            body = await self._internal_connect(timeout)
            result = body  # type: ignore[assignment]
            self._connect_result = result
            if result and result.get('userToken'):
                self._apikey = result['userToken']

        return result or {}  # type: ignore[return-value]

    def get_account_info(self) -> Optional[ConnectResult]:
        """
        Return the ConnectResult from the last successful connect().
        Returns None if not connected or not yet authenticated.
        """
        return self._connect_result

    async def disconnect(self) -> None:
        """
        Disconnect from the RocketRide server and stop automatic reconnection.

        Should be called when finished with the client to clean up resources.
        """
        self._manual_disconnect = True

        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            self._reconnect_task = None

        if self._transport is not None and self.is_connected():
            await self._internal_disconnect()

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

        if not parsed.port and 'rocketride.ai' not in (parsed.hostname or ''):
            hostname = parsed.hostname
            if not hostname:
                raise ValueError(f"Invalid URI '{uri}': missing hostname")
            parsed = parsed._replace(netloc=f'{hostname}:{CONST_DEFAULT_WEB_PORT}')

        return parsed.geturl()

    @staticmethod
    def _get_websocket_uri(uri: str) -> str:
        """Normalize a user-provided URI into a fully-formed WebSocket address."""
        normalized = ConnectionMixin.normalize_uri(uri)
        parsed = urllib.parse.urlparse(normalized)

        ws_scheme = 'wss' if parsed.scheme in ('https', 'wss') else 'ws'
        ws_uri = parsed._replace(scheme=ws_scheme)
        return f'{ws_uri.geturl()}/task/service'

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
