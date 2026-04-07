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
Debug Adapter Protocol (DAP) Client Implementation.

This module provides the DAP client implementation that handles communication
with RocketRide servers using the Debug Adapter Protocol. It manages connection
lifecycle, request/response correlation, and message handling.

This is an internal implementation detail that supports the higher-level
RocketRide client functionality. Most users won't need to interact with this
directly - it's used internally by RocketRideClient for server communication.

Key Features:
- WebSocket-based communication with servers
- Request/response correlation using sequence numbers
- Connection lifecycle management
- Message serialization and deserialization
- Error handling and recovery
"""

import asyncio
import time
from typing import Dict, Any, Optional
from .dap_base import DAPBase
from .exceptions import AuthenticationException


class DAPClient(DAPBase):
    """
    DAP (Debug Adapter Protocol) client for communicating with RocketRide servers.

    This class implements the client side of the DAP communication protocol,
    handling connection management, message correlation, and protocol compliance.
    It provides the underlying communication infrastructure used by the
    higher-level RocketRide client functionality.

    Key Responsibilities:
    - Establishing and maintaining connections to DAP servers
    - Correlating requests with their responses using sequence numbers
    - Handling connection events and state changes
    - Managing the message sending and receiving lifecycle
    - Providing error handling and recovery mechanisms

    This is used internally by RocketRideClient and its mixins to communicate
    with RocketRide servers reliably and efficiently.
    """

    def __init__(self, **kwargs) -> None:
        """
        Initialize the DAP client infrastructure.

        Sets up the client communication system, initializes request/response
        correlation, and prepares connection state management.

        Args:
            **kwargs: Configuration parameters including transport setup
        """
        # Initialize parent class for DAP functionality
        super().__init__(**kwargs)

        # Request/response correlation system for async operations
        self._pending_requests: Dict[int, asyncio.Future] = {}
        # Default request timeout in ms (None = no timeout); converted to seconds for asyncio
        self._request_timeout: Optional[float] = kwargs.get('request_timeout', None)
        # True only after auth has succeeded (set in connect(), cleared in on_disconnected)
        self._authenticated: bool = False

    async def _send(self, message: Dict[str, Any]) -> None:
        """
        Send a message to the DAP server through the transport layer.

        Args:
            message: The DAP message to send
        """
        return await self._transport.send(message)

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle connection established event.

        Called when the transport layer successfully connects to the server.
        Updates connection state and notifies parent classes.

        Args:
            connection_info: Optional connection details from transport
        """
        await super().on_connected(connection_info)

    def is_connected(self) -> bool:
        """
        Check whether the transport is connected and authenticated.

        The transport may be socket-connected before auth; we are not "connected"
        until both the socket is up and the DAP auth handshake has completed.
        """
        if self._transport is None:
            return False
        if not self._transport.is_connected():
            return False
        return self._authenticated

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle disconnection event and clean up pending requests.

        Called when the transport layer disconnects from the server.
        Fails all pending requests and cleans up connection state.

        Args:
            reason: Optional reason for disconnection
            has_error: Whether disconnection was due to error
        """
        self._authenticated = False
        # Fail all pending requests since connection is lost
        connection_error = ConnectionError(reason)

        for seq, future in self._pending_requests.items():
            if not future.done():
                future.set_exception(connection_error)

        # Clear pending requests
        self._pending_requests.clear()

        # Notify parent classes
        await super().on_disconnected(reason, has_error)

    async def on_connect_error(self, error: Exception) -> None:
        """
        Handle connection attempt failure.

        Forwards to parent classes in the mixin chain.
        """
        await super().on_connect_error(error)

    async def on_receive(self, message: Dict[str, Any]) -> None:
        """
        Handle received messages from the transport layer.

        Processes incoming DAP messages, correlating responses with their
        originating requests and forwarding events to handlers.

        Args:
            message: Complete DAP message received from server
        """
        message_type = message.get('type', '')

        if message_type == 'response':
            # Handle response correlation
            request_seq = message.get('request_seq')

            if request_seq is not None and request_seq in self._pending_requests:
                future = self._pending_requests.pop(request_seq)

                if not future.done():
                    future.set_result(message)
                else:
                    self.debug_message(f'Response received for already completed request: {message}')

        elif message_type == 'event':
            # Forward events to event handler
            await self.on_event(message)

        else:
            # Unknown message type
            self.debug_message(f'Unhandled message type: {message}')

    async def request(self, message: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        Send a request and wait for the corresponding response.

        Provides synchronous-style request/response communication over async
        transport by correlating requests and responses using sequence numbers.

        Args:
            message: Request message with required DAP fields
            timeout: Optional per-request timeout in ms. Overrides the default request_timeout.

        Returns:
            dict: Response message from the server

        Raises:
            RuntimeError: If request is missing required fields or fails
            ConnectionError: If connection fails during request
            asyncio.TimeoutError: If response times out
        """
        # Validate required fields
        if 'command' not in message:
            self.raise_exception(RuntimeError("Request message must include a 'command' field"))

        if 'type' not in message:
            self.raise_exception(RuntimeError("Request message must include a 'type' field"))

        if 'seq' not in message:
            self.raise_exception(RuntimeError("Request message must include a 'seq' field"))

        # Verify connection
        if not self._transport.is_connected():
            self.raise_exception(RuntimeError('Server is not connected'))

        # Get sequence number for correlation
        seq = message['seq']

        # Create future for response correlation
        future = asyncio.Future()
        self._pending_requests[seq] = future

        try:
            # Send request through transport
            await self._send(message)
        except Exception:
            self.raise_exception(ConnectionError('Could not send request'))

        try:
            # Wait for correlated response, with optional timeout (ms → seconds)
            effective_timeout = timeout if timeout is not None else self._request_timeout
            if effective_timeout is not None:
                response = await asyncio.wait_for(future, timeout=effective_timeout / 1000.0)
            else:
                response = await future
            return response

        except (ConnectionError, ConnectionResetError) as e:
            # Connection errors trigger cleanup
            await self.disconnect()
            self.raise_exception(ConnectionError(f'{e}'))

        except asyncio.TimeoutError:
            # Handle timeouts specifically
            self.raise_exception(asyncio.TimeoutError('Connection time out'))

        except Exception as e:
            # Handle other errors
            self.raise_exception(RuntimeError(f'Request failed: {e}'))

        finally:
            # Always clean up the pending request
            self._pending_requests.pop(seq, None)

    async def dap_request(
        self,
        command: str,
        arguments: Optional[Dict[str, Any]] = None,
        token: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Send an arbitrary DAP command with command name, arguments, and optional token.

        Convenience method that builds the request and sends it in one call.
        Equivalent to ``build_request(command, ...)`` + ``request(...)``.

        Args:
            command: The DAP command name (e.g. 'rrext_services', 'rrext_monitor', 'initialize').
            arguments: Optional arguments for the command.
            token: Optional task/session token.
            timeout: Optional per-request timeout in ms. Overrides the default request_timeout.

        Returns:
            The response message (DAP dict) from the server.

        Example:
            response = await client.dap_request('rrext_services', {}, timeout=5000)
            if client.did_fail(response):
                raise RuntimeError(response.get('message', 'Request failed'))
        """
        request = self.build_request(
            command,
            token=token,
            arguments=arguments or {},
        )
        return await self.request(request, timeout=timeout)

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Establish connection to the DAP server.

        When the transport exposes get_auth (e.g. task service), sends auth as the first
        DAP command and fails connect if authentication fails.

        Args:
            timeout: Optional overall timeout in milliseconds covering both the
                WebSocket handshake and auth request.

        Raises:
            ConnectionError: If connection fails
            TimeoutError: If connection times out
        """
        # Track elapsed time so remaining budget can be passed to the auth request
        start = time.monotonic() if timeout is not None else 0

        # Establish transport connection (socket open; no auth on the wire)
        await self._transport.connect(timeout)

        # Calculate remaining timeout for auth request
        auth_timeout: Optional[float] = None
        if timeout is not None:
            elapsed_ms = (time.monotonic() - start) * 1000.0
            auth_timeout = max(timeout - elapsed_ms, 0)

        # Send auth as first DAP message only if the transport provides credentials
        # (e.g. WebSocket to a task server). Transports without get_auth (e.g. stdio
        # to a subprocess) skip auth entirely — the subprocess doesn't speak DAP.
        if hasattr(self._transport, 'get_auth'):
            auth = self._transport.get_auth() or ''
            auth_args = {'auth': auth}
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
                response = await self.request(request, timeout=auth_timeout)
            except Exception:
                await self._transport.disconnect('Auth request failed', True)
                raise
            if not response.get('success', False):
                message = response.get('message', 'Authentication failed')
                await self._transport.disconnect(message, True)
                raise AuthenticationException({'message': message})

        # Only now are we connected (transport up + authenticated)
        self._authenticated = True
        connection_info = self._transport.get_connection_info()
        await self.on_connected(connection_info)

    async def disconnect(self) -> None:
        """
        Close connection to the DAP server and clean up resources.

        Gracefully closes the transport connection and cleans up any
        remaining connection state or pending operations.
        """
        # Close transport connection
        await self._transport.disconnect()
