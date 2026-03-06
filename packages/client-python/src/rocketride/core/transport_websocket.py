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
WebSocket Transport Implementation for Debug Adapter Protocol.

This module provides WebSocket transport for DAP communication between RocketRide
clients and servers. It handles WebSocket connections, message serialization,
and the DAP binary message format for efficient data transfer.

Key Features:
- Client and server WebSocket support
- Automatic message format detection (JSON text vs binary)
- DAP binary message format (JSON header + binary payload)
- Connection management with timeout handling
- Comprehensive error handling and recovery
- Protocol debugging and message tracing

This is used internally by the RocketRide client for server communication.
Most users won't interact with this directly - it's part of the underlying
transport infrastructure that enables reliable client-server communication.

Dependencies:
- websockets: Required for client connections (pip install websockets)
- fastapi: Required for server connections (pip install fastapi)

Usage (Internal):
    # Client connection
    transport = TransportWebSocket("ws://localhost:8080", auth="api_key")
    transport.bind(on_receive=handle_message)
    await transport.connect()

    # Send messages
    await transport.send({"command": "execute", "arguments": {...}})
"""

import json
import asyncio
from typing import Dict, Any, Union, Optional
from urllib.parse import urlencode, urlparse, parse_qs
from .constants import CONST_DEFAULT_SERVICE, CONST_SOCKET_TIMEOUT, CONST_WS_PING_INTERVAL, CONST_WS_PING_TIMEOUT

# Optional dependency handling for websockets library
try:
    import websockets
    import websockets.exceptions
except ImportError:
    websockets = None

# Optional dependency handling for FastAPI
try:
    import fastapi
    from fastapi import WebSocket, WebSocketDisconnect
except ImportError:
    fastapi = None
    WebSocket = None
    WebSocketDisconnect = None

from .transport import TransportBase


class TransportWebSocket(TransportBase):
    """
    WebSocket transport implementation for DAP protocol communication.

    Provides WebSocket-based communication between RocketRide clients and servers
    with support for both text and binary message formats. Handles connection
    management, message serialization, and error recovery.

    Key Capabilities:
    - WebSocket client connections using websockets library
    - WebSocket server connections using FastAPI WebSocket
    - Automatic message format detection and parsing
    - DAP binary message support for large data payloads
    - Connection timeout handling for reliability
    - Background message receiving for client connections
    - Blocking receive loop for server connections

    Message Formats Supported:
    - JSON text messages for commands and responses
    - Binary messages using DAP format (JSON header + newline + binary data)
    - Automatic format detection based on message content

    This is used internally by RocketRideClient to communicate with servers
    over WebSocket connections. The transport handles all low-level details
    while providing a clean interface to higher-level client code.
    """

    def __init__(self, uri: str = CONST_DEFAULT_SERVICE, **kwargs) -> None:
        """
        Initialize WebSocket transport.

        Args:
            uri: WebSocket URI for client connections (e.g., "http://localhost:8080")
            **kwargs: Additional configuration including authentication
        """
        super().__init__()

        self._websocket: Union[object, None] = None
        self._receive_task = None
        self._uri = uri
        self._auth = kwargs.get('auth', None)
        self._message_tasks: set = set()

    def get_auth(self) -> str | None:
        """Auth credential for use by connect flow (e.g. first DAP auth command)."""
        return self._auth

    def get_connection_info(self) -> str | None:
        """Connection info for the "connected" callback (URI)."""
        return self._uri

    def set_auth(self, auth: str) -> None:
        """Update auth credential. Takes effect on the next connect()."""
        self._auth = auth

    def set_uri(self, uri: str) -> None:
        """Update connection URI. Takes effect on the next connect()."""
        self._uri = uri

    def _is_fastapi_websocket(self) -> bool:
        """
        Check if current websocket is a FastAPI WebSocket instance.

        Returns:
            bool: True if using FastAPI WebSocket, False if using websockets library
        """
        if not fastapi or WebSocket is None:
            return False
        return isinstance(self._websocket, WebSocket)

    async def _receive_data(self, data: Union[str, bytes]) -> None:
        """
        Process raw WebSocket data into structured messages.

        Handles both JSON text messages and DAP binary format messages.
        Binary messages use format: JSON header + newline + binary payload.

        Args:
            data: Raw message data from WebSocket
        """
        try:
            if not self._connected:
                return

            if isinstance(data, str):
                # JSON text message
                json_message = json.loads(data)
                await super()._transport_receive(json_message)

            elif isinstance(data, bytes):
                # Binary message - look for JSON header separator
                newline_pos = data.find(b'\n')

                if newline_pos == -1:
                    # No separator - treat as JSON text
                    json_message = json.loads(data.decode('utf-8'))
                    await super()._transport_receive(json_message)
                else:
                    # DAP binary format: JSON header + newline + binary data
                    json_header = data[:newline_pos]
                    binary_data = data[newline_pos + 1 :]

                    # Parse JSON header
                    json_message = json.loads(json_header.decode('utf-8'))

                    # Add binary data to message arguments
                    if 'arguments' not in json_message:
                        json_message['arguments'] = {}

                    json_message['arguments']['data'] = binary_data
                    await super()._transport_receive(json_message)

        except asyncio.CancelledError:
            # Task cancellation during disconnect is expected
            pass
        except Exception as e:
            # Only log errors if still connected
            if self._connected:
                self._debug_message(f'Error processing WebSocket message: {e}')

    async def _receive_loop(self) -> None:
        """
        Message receiving loop for WebSocket connections.

        Continuously receives and processes messages until disconnection.
        Handles different WebSocket implementations and connection events.
        """
        try:
            while self._connected:
                if self._is_fastapi_websocket():
                    # FastAPI WebSocket receiving
                    message = await self._websocket.receive()

                    if message['type'] == 'websocket.disconnect':
                        if fastapi and WebSocketDisconnect:
                            raise WebSocketDisconnect('Connection closed')
                        else:
                            raise ConnectionError('Connection closed')

                    elif message['type'] == 'websocket.ping':
                        # Respond to ping
                        await self._websocket.pong(message.get('bytes', b''))
                        self._debug_message('Responded to client ping')
                        continue

                    elif message['type'] == 'websocket.pong':
                        # Pong response received
                        self._debug_message('Received pong from client')
                        continue

                    elif message['type'] == 'websocket.receive':
                        # Extract message data
                        if 'text' in message:
                            data = message['text']
                        elif 'bytes' in message:
                            data = message['bytes']
                        else:
                            continue

                else:
                    # websockets library receiving
                    data = await self._websocket.recv()

                # Process each message in its own task so others can be processed concurrently
                task = asyncio.create_task(self._receive_data(data))
                self._message_tasks.add(task)
                task.add_done_callback(lambda t: self._message_tasks.discard(t))

        except asyncio.CancelledError:
            self._debug_message('WebSocket receive loop cancelled')
            self._connected = False
            await self._transport_disconnected('Cancelled by application', has_error=False)

        except Exception as e:
            # Handle different exception types
            if fastapi and WebSocketDisconnect and isinstance(e, WebSocketDisconnect):
                self._connected = False
                await self._transport_disconnected('Connection closed', has_error=False)

            elif websockets and hasattr(websockets.exceptions, 'ConnectionClosed') and isinstance(e, websockets.exceptions.ConnectionClosed):
                self._connected = False
                await self._transport_disconnected('Connection closed', has_error=False)

            elif isinstance(e, (ConnectionResetError, ConnectionAbortedError)):
                self._connected = False
                await self._transport_disconnected(f'Connection error: {e}', has_error=True)

            else:
                self._connected = False
                await self._transport_disconnected(f'Unexpected error: {e}', has_error=True)

        finally:
            self._connected = False

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Connect to WebSocket server and start receiving messages.

        Establishes WebSocket connection using websockets library and starts
        background message receiving task for continuous communication.

        Args:
            timeout: Optional connection timeout in milliseconds. Falls back to
                CONST_SOCKET_TIMEOUT (seconds) when not provided.

        Raises:
            ImportError: If websockets library not installed
            ConnectionError: If connection fails
            ValueError: If URI is invalid
        """
        if not websockets:
            error_msg = 'websockets library required for client connections. Install: pip install websockets'
            self._debug_message(error_msg)
            await self._transport_disconnected(error_msg, has_error=True)
            raise ImportError(error_msg)

        try:
            self._debug_message(f'Connecting to WebSocket server at {self._uri}')

            # Convert ms to seconds for websockets library, or use default
            effective_open_timeout = timeout / 1000.0 if timeout is not None else CONST_SOCKET_TIMEOUT

            # Server requires auth at WebSocket upgrade (header or query). Pass auth as query param
            # so the upgrade request is accepted; DAP auth command is still sent after connect.
            connect_uri = self._uri
            if self._auth:
                parsed = urlparse(self._uri)
                qs = parse_qs(parsed.query)
                qs['auth'] = [self._auth]
                new_query = urlencode(qs, doseq=True)
                connect_uri = parsed._replace(query=new_query).geturl()

            self._websocket = await websockets.connect(
                connect_uri,
                ping_interval=CONST_WS_PING_INTERVAL,  # Send ping every 15 seconds
                ping_timeout=CONST_WS_PING_TIMEOUT,  # Wait up to 60 seconds for pong
                close_timeout=CONST_SOCKET_TIMEOUT,
                open_timeout=effective_open_timeout,
                max_size=250 * 1024 * 1024,  # 250MB max message size
                compression=None,
            )

            self._connected = True
            self._debug_message(f'Successfully connected to {self._uri}')

            # Start background message receiving
            self._receive_task = asyncio.create_task(self._receive_loop())
            self._debug_message('Started background message receiving')
            # Do not notify connected here; DAP client will call on_connected after auth

        except Exception as e:
            self._debug_message(f'Failed to connect to {self._uri}: {e}')
            
            # Clean up websocket if it was created
            if self._websocket:
                try:
                    await self._websocket.close()
                except Exception:
                    pass
                self._websocket = None
            
            # Clean up receive task if started
            if self._receive_task and not self._receive_task.done():
                self._receive_task.cancel()
                try:
                    await self._receive_task
                except Exception:
                    pass
                self._receive_task = None
            
            self._connected = False
            
            # Always notify about disconnection to enable reconnection logic
            await self._transport_disconnected(f'{e}', has_error=True)
            raise ConnectionError(f'{e}')

    async def accept(self, websocket) -> None:
        """
        Accept incoming WebSocket connection and start receiving messages.

        Accepts FastAPI WebSocket connection and blocks in message receiving
        loop until connection closes or fails.

        Args:
            websocket: FastAPI WebSocket instance

        Raises:
            ImportError: If FastAPI not installed
            ValueError: If websocket is invalid
            ConnectionError: If accepting fails
        """
        if not fastapi:
            error_msg = 'FastAPI required for server connections. Install: pip install fastapi'
            self._debug_message(error_msg)
            await self._transport_disconnected(error_msg, has_error=True)
            raise ImportError(error_msg)

        if not isinstance(websocket, WebSocket):
            error_msg = 'WebSocket transport requires FastAPI WebSocket instance'
            self._debug_message(error_msg)
            raise ValueError(error_msg)

        try:
            # Accept the WebSocket connection
            await websocket.accept()
            self._websocket = websocket
            self._connected = True

            # Determine client info for connection callback
            client_info = f'ws://{websocket.client.host}:{websocket.client.port}' if websocket.client else 'ws://unknown'

            # Notify about accepted connection
            await self._transport_connected(client_info)

            # Block in receive loop until connection closes
            await self._receive_loop()

        except Exception as e:
            self._debug_message(f'Failed to accept WebSocket connection: {e}')
            await self._transport_disconnected(f'Accept failed: {e}', has_error=True)
            raise ConnectionError(f'WebSocket accept failed: {e}')

    async def disconnect(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Disconnect and close the WebSocket connection gracefully.

        Cancels background tasks, closes the connection, and cleans up resources.
        Safe to call multiple times.

        Args:
            reason: Optional reason for disconnection (reported to on_disconnected).
            has_error: If True, report as error to on_disconnected.
        """
        if not self._connected or not self._websocket:
            return

        callback_called = False

        try:
            self._debug_message('Gracefully disconnecting WebSocket')

            # Cancel background receive task
            if self._receive_task and not self._receive_task.done():
                self._receive_task.cancel()
                try:
                    await self._receive_task
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
                self._debug_message('Background receiving stopped')

            # Close WebSocket connection
            if self._websocket:
                await self._websocket.close()

            self._debug_message('WebSocket disconnected successfully')

            # Notify about disconnection (use caller-provided reason/has_error when given)
            await self._transport_disconnected(reason or 'Disconnected by request', has_error)
            callback_called = True

        except asyncio.TimeoutError:
            self._debug_message('Timeout during disconnect - forcing close')
            if not callback_called:
                await self._transport_disconnected('Disconnect timeout', has_error=True)
                callback_called = True

        except (ConnectionResetError, ConnectionAbortedError):
            self._debug_message('Connection closed by peer during disconnect')
            if not callback_called:
                await self._transport_disconnected('Connection closed by peer', has_error=False)
                callback_called = True

        except Exception as e:
            self._debug_message(f'Error during disconnect: {e}')
            if not callback_called:
                await self._transport_disconnected(f'Disconnect error: {e}', has_error=True)
                callback_called = True

        finally:
            # Always clean up resources
            self._connected = False
            self._websocket = None
            self._receive_task = None
            if hasattr(self, '_message_tasks'):
                self._message_tasks.clear()

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a DAP message with automatic format selection.

        Handles both standard JSON messages and DAP binary messages with
        data payloads. Automatically chooses appropriate WebSocket message
        format based on message content.

        Args:
            message: DAP message to send

        Raises:
            ConnectionError: If not connected
            ValueError: If message is invalid
        """
        if not self.is_connected():
            raise ConnectionError('WebSocket not connected. Call connect() or accept() first.')

        if not self._websocket:
            raise ConnectionError('WebSocket connection lost before send')

        binary_data = None
        arguments = message.get('arguments', {})

        try:
            if 'data' in arguments:
                # Binary message - use DAP binary format
                binary_data = bytes(arguments['data'])

                # Convert to bytes if needed
                if isinstance(binary_data, str):
                    binary_data = binary_data.encode('utf-8')
                elif not isinstance(binary_data, bytes):
                    binary_data = json.dumps(binary_data).encode('utf-8')

                # Create debug version for logging
                arguments['data'] = f'<{len(binary_data)} bytes>'
                self._debug_protocol(f'SEND: {message}')
                arguments.pop('data', None)

                # Create DAP binary message: JSON header + newline + binary data
                json_header = json.dumps(message).encode('utf-8')
                combined_message = json_header + b'\n' + binary_data

                # Send based on WebSocket type
                if self._is_fastapi_websocket():
                    # FastAPI WebSocket
                    await self._websocket.send_bytes(combined_message)
                else:
                    # websockets library
                    await self._websocket.send(combined_message)

            else:
                # Standard JSON message
                self._debug_protocol(f'SEND: {message}')

                # Send based on WebSocket type
                if self._is_fastapi_websocket():
                    # FastAPI WebSocket - use send_json
                    await self._websocket.send_json(message)
                else:
                    # websockets library - use send with JSON string
                    await self._websocket.send(json.dumps(message))

        except asyncio.TimeoutError:
            # Send timeout - connection lost
            self._connected = False
            self._debug_message(f'WebSocket send timeout after {CONST_SOCKET_TIMEOUT}s')
            raise ConnectionError(f'Send timeout after {CONST_SOCKET_TIMEOUT} seconds')

        except (ConnectionResetError, BrokenPipeError) as e:
            # Connection errors should update state
            self._connected = False
            self._debug_message(f'Connection lost during send: {e}')
            raise ConnectionError(f'Connection lost during send: {e}')

        except Exception as e:
            # Log send failures for debugging
            self._debug_message(f'Failed to send message: {e}')
            raise

        finally:
            # Restore binary data field if it was modified
            if binary_data:
                arguments['data'] = binary_data
