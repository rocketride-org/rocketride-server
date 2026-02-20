# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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
It manages the WebSocket connection lifecycle and provides status checking.

The connection system automatically handles:
- WebSocket connection establishment
- Authentication with your API key
- Connection status tracking
- Automatic reconnection on disconnects (when persist=True)
- Graceful disconnection and cleanup

Usage:
    # Manual connection management
    client = RocketRideClient(auth="your_api_key", uri="https://cloud.rocketride.ai")
    await client.connect()

    # Check if connected
    if client.is_connected():
        # Do work with the client
        pass

    await client.disconnect()

    # Automatic connection management (recommended)
    async with RocketRideClient(auth="your_api_key") as client:
        # Client automatically connects here
        # Do work with connected client
        pass
    # Client automatically disconnects here

    # Persistent connection with auto-reconnect
    client = RocketRideClient(auth="your_api_key", persist=True)
    await client.connect()
    # Connection will automatically reconnect if dropped (exponential backoff)
"""

# Design: Physical connect/disconnect live in _internal_connect and _internal_disconnect.
# Non-persist mode: connect() and disconnect() call those directly.
# Persist mode: connect() uses _attempt_connection (first attempt inline); retries and
# reconnect-on-disconnect are scheduled via _schedule_reconnect / _attempt_reconnect.

import asyncio
import time
import urllib.parse
from typing import Any, Dict, Optional
from ..core import DAPClient, TransportWebSocket
from ..core.exceptions import AuthenticationException


class ConnectionMixin(DAPClient):
    """
    Handles connection and disconnection to RocketRide servers.

    This mixin provides the fundamental connection management capabilities
    for the RocketRide client. It manages WebSocket connections, handles
    authentication, and tracks connection status.

    Key Features:
    - Establishes secure WebSocket connections to RocketRide servers
    - Authenticates using your API key or access token
    - Tracks connection status for reliable operations
    - Automatic reconnection on disconnect (when persist=True)
    - Provides graceful connection cleanup
    - Supports both manual and automatic connection management

    This is automatically included when you use RocketRideClient, so you can
    call client.connect() and client.disconnect() directly without needing
    to import this mixin.
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

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle connection established event.

        Resets manual disconnect flag and delegates to parent.
        """
        # We just connected successfully; clear "user asked to disconnect" so future drops can trigger reconnect
        self._manual_disconnect = False

        # Record that we notified connected so on_disconnected only invokes user callback if we had connected
        self._did_notify_connected = True

        # Reset backoff so the next reconnect (if any) starts from the initial delay
        self._current_reconnect_delay = 0.25
        self._retry_start_time = None
        await super().on_connected(connection_info)

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle disconnection event.

        Only invokes the user's on_disconnected if on_connected had previously been called.
        Schedules reconnection if persist is enabled and not a manual disconnect.
        """
        # Only tell the user we disconnected if we had previously told them we connected
        if self._did_notify_connected:
            self._did_notify_connected = False
            await super().on_disconnected(reason, has_error)

        # Transport called us because the connection closed. If user didn't ask to disconnect
        # and we're in persist mode, schedule a reconnect (after backoff delay).
        if self._persist and not self._manual_disconnect:
            await self._schedule_reconnect()

    # --- Single place for physical connect: create transport if needed, connect, auth, on_connected ---
    async def _internal_connect(self, timeout: Optional[float] = None) -> None:
        """
        Create transport if needed, connect, send auth, and notify on_connected.
        Single place for physical connection. Raises on failure.
        """
        # Reuse existing transport if we have one (e.g. retry after failure); otherwise create with current uri/auth
        if self._transport is None:
            self._transport = TransportWebSocket(uri=self._uri, auth=self._apikey)
            self._bind_transport(self._transport)

        # DAPClient.connect does: transport.connect() (socket), then auth request, then on_connected()
        await DAPClient.connect(self, timeout)

    # --- Single place for physical disconnect: close transport; it will call on_disconnected ---
    async def _internal_disconnect(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Close and clean up the transport. Transport invokes on_disconnected when it closes.
        Single place for physical disconnect.
        """
        if self._transport is None:
            return

        # Transport will close the socket and then call our on_disconnected callback
        await self._transport.disconnect(reason, has_error)

    # --- Persist-mode: one attempt; on failure notify and maybe reschedule with backoff ---
    async def _attempt_connection(self, timeout: Optional[float] = None) -> None:
        """
        Try _internal_connect; on auth error notify and stop; on other error notify and reschedule with backoff.
        Used by persist-mode connect() and by the reconnect task.
        """
        try:
            await self._internal_connect(timeout)
            # on_connected (invoked by _internal_connect) already resets backoff and retry clock
            self._reconnect_task = None  # clear completed task reference
            self._debug_message('Reconnection successful')
        except AuthenticationException as e:
            self._debug_message(f'Reconnection failed (auth): {e}')
            await self.on_connect_error(e)

            # Auth failures won't fix themselves; don't reschedule
            return
        except Exception as e:
            self._debug_message(f'Reconnection failed: {e}')
            await self.on_connect_error(e)

            # Start the retry clock on first failure so we can enforce max_retry_time
            if self._retry_start_time is None:
                self._retry_start_time = time.monotonic()

            # Stop retrying if we've exceeded the total retry window
            if self._max_retry_time is not None:
                if time.monotonic() - self._retry_start_time >= self._max_retry_time / 1000.0:
                    return

            # Exponential backoff: next attempt will wait longer (cap at 2.5s)
            self._current_reconnect_delay = min(self._current_reconnect_delay * 2, 2.5)
            await self._schedule_reconnect()

    async def _schedule_reconnect(self) -> None:
        """Schedule a reconnection attempt with exponential backoff."""
        # Only one reconnect task at a time; cancel any existing one before scheduling again
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()

        # If we've been retrying longer than max_retry_time, give up and notify the user
        if self._max_retry_time is not None and self._retry_start_time is not None:
            if time.monotonic() - self._retry_start_time >= self._max_retry_time / 1000.0:
                await self.on_connect_error(Exception('Max retry time exceeded'))
                return

        # Run _attempt_reconnect after _current_reconnect_delay seconds (backoff)
        self._debug_message(f'Scheduling reconnection in {self._current_reconnect_delay}s')
        self._reconnect_task = asyncio.create_task(self._attempt_reconnect())

    async def _attempt_reconnect(self) -> None:
        """Sleep then call _attempt_connection (used by scheduled reconnect)."""
        # Wait before retrying so we don't hammer the server (exponential backoff)
        await asyncio.sleep(self._current_reconnect_delay)

        # User may have called disconnect() while we were sleeping; only try if still persist and not manual disconnect
        if self._persist and not self._manual_disconnect:
            self._debug_message('Attempting to reconnect...')
            await self._attempt_connection()

    async def connect(
        self,
        uri: Optional[str] = None,
        auth: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        """
        Connect to the RocketRide server.

        Must be called before executing pipelines or other operations.
        In persist mode, enables automatic reconnection and retries from initial failure
        (calls on_connect_error on each failed attempt and keeps retrying).

        Args:
            uri: Optional; if provided, updates the server URI before connecting.
            auth: Optional; if provided, updates the API key before connecting.
            timeout: Optional overall timeout in ms for the connect + auth handshake.

        Examples:
            # Manual connection management
            await client.connect()
            try:
                # do work
                pass
            finally:
                await client.disconnect()

            # Automatic connection management (preferred)
            async with client:
                # connection automatically managed
                pass
        """
        # Apply optional params so they're used for this connect (and by any new transport we create)
        if uri is not None:
            self._set_uri(uri)
        if auth is not None:
            self._set_auth(auth)

        # Fresh connect: we're not in "user asked to disconnect" state, and backoff starts from initial delay
        self._manual_disconnect = False
        self._current_reconnect_delay = 0.25
        self._retry_start_time = None

        # Idempotent connect: if already connected, disconnect first so we reconnect with current (maybe new) params
        if self.is_connected():
            await self._internal_disconnect()

        if self._persist:
            # Cancel any pending reconnect from a previous drop; we're doing an explicit connect now
            if self._reconnect_task and not self._reconnect_task.done():
                self._reconnect_task.cancel()
                self._reconnect_task = None

            # First attempt runs here; if it fails, _attempt_connection will schedule the next try
            await self._attempt_connection(timeout)
        else:
            # Non-persist: one shot; no retry scheduling
            await self._internal_connect(timeout)

    async def disconnect(self) -> None:
        """
        Disconnect from the RocketRide server and stop automatic reconnection.

        Should be called when finished with the client to clean up resources.
        Context managers handle this automatically.
        """
        # Set before we disconnect so that when the transport closes and calls on_disconnected,
        # we won't schedule a reconnect (user explicitly asked to disconnect)
        self._manual_disconnect = True

        # Stop any scheduled reconnect; user said disconnect
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            self._reconnect_task = None
        if self._transport is not None and self.is_connected():
            await self._internal_disconnect()

    def get_connection_info(self) -> Optional[str]:
        """
        Return current connection info from the transport (e.g. URI or peer details).

        Returns None if not connected or no transport. Useful for debugging or
        displaying "Connected to …" in the UI.
        """
        if self._transport is None:
            return None
        return self._transport.get_connection_info()

    def get_apikey(self) -> Optional[str]:
        """
        Return the API key in use.

        For debugging only; avoid logging or exposing in production.
        """
        return getattr(self, '_apikey', None)

    def _set_uri(self, uri: str) -> None:
        """Update the server URI (internal). Accepts HTTP/HTTPS/WS/WSS; converts to WebSocket and appends /task/service."""
        parsed = urllib.parse.urlparse(uri)
        ws_scheme = 'wss' if parsed.scheme == 'https' else 'ws'
        ws_uri = parsed._replace(scheme=ws_scheme)
        self._uri = f'{ws_uri.geturl()}/task/service'

    def _set_auth(self, auth: str) -> None:
        """Update the authentication credential (internal)."""
        self._apikey = auth

    async def set_connection_params(
        self,
        uri: Optional[str] = None,
        auth: Optional[str] = None,
    ) -> None:
        """
        Update server URI and/or auth. If currently connected, disconnects and
        reconnects with the new params. In persist mode, reconnection is scheduled
        only if we were connected (no auto-connect when params are set on a never-connected client).
        In non-persist mode, reconnects only if we were connected.
        """
        # --- Update params, tear down existing connection/transport, then reconnect (or schedule) only if appropriate ---
        if uri is not None:
            self._set_uri(uri)
        if auth is not None:
            self._set_auth(auth)

        # Remember whether we were connected so we know to disconnect and whether to reconnect at the end
        was_already_connected = self.is_connected()

        # Prevent on_disconnected (from the disconnect below) from scheduling a reconnect during teardown
        self._manual_disconnect = True
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            self._reconnect_task = None
        if was_already_connected:
            await self._internal_disconnect()

        # Drop the transport so the next connect() builds a new one with the new uri/auth
        self._transport = None
        if self._persist and was_already_connected:
            # Schedule a single reconnect attempt (after backoff); only if we were connected (no auto-connect on param set)
            await self._schedule_reconnect()
        elif was_already_connected:
            # Non-persist: only reconnect if we had been connected (same as connect() semantics)
            await self._internal_connect()

        # We're done; clear so future disconnects (e.g. drop) can trigger reconnect if persist
        self._manual_disconnect = False

    async def request(self, request: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        Send a request to the RocketRide server.

        Args:
            request: The DAP message to send
            timeout: Optional per-request timeout in ms. Overrides the default request_timeout.
        """
        # Delegate to parent class for actual request processing
        return await super().request(request, timeout=timeout)
