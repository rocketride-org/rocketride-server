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

    Disconnect / drain lifecycle
    ----------------------------
    Both paths (server via accept(), client via connect()) share the same
    two-phase shutdown driven by disconnect():

      Phase 1 — Drain:
        _draining is set to True. _receive_loop keeps calling recv() but
        silently discards incoming packets without creating new _message_tasks.
        disconnect() awaits all pending _message_tasks so in-flight handlers
        can finish sending their responses.

      Phase 2 — Close:
        Server path: disconnect() closes the socket directly, which unblocks
          recv() with ConnectionClosed. accept()'s finally handles teardown.
        Client path: disconnect() cancels _receive_task, which unblocks recv()
          with CancelledError. _run_receive_task()'s finally handles teardown.

    _receive_loop is intentionally free of cleanup logic — it simply loops and
    propagates exceptions. The caller (accept or _run_receive_task) owns cleanup.
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
        self._draining: bool = False

    def get_auth(self) -> Optional[str]:
        """Return auth credential for use by connect flow (e.g. first DAP auth command)."""
        return self._auth

    def get_connection_info(self) -> Optional[str]:
        """Return connection info for the "connected" callback (URI)."""
        return self._uri

    def set_auth(self, auth: str) -> None:
        """Update auth credential. Takes effect on the next connect()."""
        self._auth = auth

    def set_uri(self, uri: str) -> None:
        """Update connection URI. Takes effect on the next connect()."""
        self._uri = uri

    def _on_message_task_done(self, task: asyncio.Task) -> None:
        """Handle completion of a message processing task."""
        self._message_tasks.discard(task)

    def _is_fastapi_websocket(self) -> bool:
        """
        Check if current websocket is a FastAPI WebSocket instance.

        Returns:
            bool: True if using FastAPI WebSocket, False if using websockets library
        """
        if not fastapi or WebSocket is None:
            return False
        return isinstance(self._websocket, WebSocket)

    async def _close_websocket(self) -> None:
        """
        Close the underlying WebSocket and null _websocket.

        Does not notify the application — call _cleanup() for that.
        Safe to call multiple times.
        """
        if self._websocket:
            try:
                await self._websocket.close()
            except Exception:
                pass
            self._websocket = None

    async def _drain_message_tasks(self) -> None:
        """
        Wait for all pending message tasks to complete.

        Called during disconnect() after _draining is set, so no new tasks
        will be added while we wait. Allows in-flight handlers to finish
        sending their responses before the socket is closed.
        """
        pending = [t for t in self._message_tasks if not t.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

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

            return

    async def _receive_loop(self) -> None:
        """
        Message receiving loop. Purely reads and dispatches — no cleanup.

        Loops until the socket is closed or an exception is raised.
        While _draining is True, incoming packets are consumed but discarded
        so recv() does not block disconnect() from closing the socket.

        Exceptions propagate to the caller (accept or _run_receive_task)
        which owns cleanup.
        """
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
                    await self._websocket.pong(message.get('bytes', b''))
                    self._debug_message('Responded to client ping')
                    continue

                elif message['type'] == 'websocket.pong':
                    self._debug_message('Received pong from client')
                    continue

                elif message['type'] == 'websocket.receive':
                    if 'text' in message:
                        data = message['text']
                    elif 'bytes' in message:
                        data = message['bytes']
                    else:
                        continue

            else:
                # websockets library receiving
                data = await self._websocket.recv()

            # While draining, discard incoming packets — don't create new tasks
            if self._draining:
                continue

            # Dispatch each message in its own task for concurrent processing
            task = asyncio.create_task(self._receive_data(data))
            self._message_tasks.add(task)
            task.add_done_callback(self._on_message_task_done)

    async def _run_receive_task(self) -> None:
        """
        Client-side receive task wrapper.

        Runs _receive_loop and owns cleanup when it exits — whether normally,
        via CancelledError (from disconnect()), or from an unexpected exception.
        """
        reason = 'Connection closed'
        has_error = False
        try:
            await self._receive_loop()

        except asyncio.CancelledError:
            # disconnect() cancelled us after draining — clean exit
            reason = 'Disconnected by application'
            has_error = False

        except Exception as e:
            if (
                websockets
                and hasattr(websockets.exceptions, 'ConnectionClosed')
                and isinstance(e, websockets.exceptions.ConnectionClosed)
            ):
                reason = 'Connection closed'
                has_error = False
            elif isinstance(e, (ConnectionResetError, ConnectionAbortedError)):
                reason = f'Connection error: {e}'
                has_error = True
            else:
                reason = f'Unexpected error: {e}'
                has_error = True

        finally:
            self._connected = False
            self._draining = False
            await self._drain_message_tasks()
            await self._close_websocket()
            await self._transport_disconnected(reason, has_error)

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Connect to WebSocket server and start receiving messages.

        Establishes WebSocket connection using websockets library and starts
        a background receive task for continuous communication.

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

            # Connect without auth on upgrade; first DAP message must be auth
            self._websocket = await websockets.connect(
                self._uri,
                ping_interval=CONST_WS_PING_INTERVAL,
                ping_timeout=CONST_WS_PING_TIMEOUT,
                close_timeout=CONST_SOCKET_TIMEOUT,
                open_timeout=effective_open_timeout,
                max_size=250 * 1024 * 1024,  # 250MB max message size
                compression=None,
            )

            self._connected = True
            self._draining = False
            self._debug_message(f'Successfully connected to {self._uri}')

            # Start background receive task — _run_receive_task owns its cleanup
            self._receive_task = asyncio.create_task(self._run_receive_task())
            self._debug_message('Started background message receiving')

        except Exception as e:
            self._debug_message(f'Failed to connect to {self._uri}: {e}')
            self._connected = False

            # Cancel receive task if it was started before the exception
            if self._receive_task and not self._receive_task.done():
                self._receive_task.cancel()
                try:
                    await self._receive_task
                except Exception:
                    pass
            self._receive_task = None

            await self._close_websocket()
            await self._transport_disconnected(f'{e}', has_error=True)
            raise ConnectionError(f'{e}')

    async def accept(self, websocket) -> None:
        """
        Accept incoming WebSocket connection and start receiving messages.

        Accepts a FastAPI WebSocket connection and blocks until the connection
        closes. Owns cleanup for the server-side path.

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

        reason = 'Connection closed'
        has_error = False
        try:
            await websocket.accept()
            self._websocket = websocket
            self._connected = True
            self._draining = False

            client_info = (
                f'ws://{websocket.client.host}:{websocket.client.port}' if websocket.client else 'ws://unknown'
            )
            await self._transport_connected(client_info)

            # Block in receive loop — propagates exceptions for us to handle below
            await self._receive_loop()

        except Exception as e:
            if fastapi and WebSocketDisconnect and isinstance(e, WebSocketDisconnect):
                reason = 'Connection closed'
                has_error = False
            elif isinstance(e, (ConnectionResetError, ConnectionAbortedError)):
                reason = f'Connection error: {e}'
                has_error = True
            else:
                reason = f'Accept error: {e}'
                has_error = True

        finally:
            # _receive_loop has exited — socket is already closed (disconnect()
            # closed it) or needs closing now (peer disconnect / error).
            # Await any in-flight message tasks so they can finish sending
            # responses before we tear down and notify disconnection.
            self._connected = False
            self._draining = False
            await self._drain_message_tasks()
            await self._close_websocket()
            await self._transport_disconnected(reason, has_error)

    async def _do_disconnect(self) -> None:
        """
        Run the two-phase drain-then-close implementation.

        _draining is already set by disconnect() before this coroutine runs,
        so no new message tasks will be created while we drain.

        Phase 1 — Drain:
          Awaits all pending _message_tasks so in-flight handlers can finish
          sending their responses before the socket closes.

        Phase 2 — Close:
          Server path: closes the socket directly, which unblocks recv() with
            ConnectionClosed. accept()'s finally handles teardown.
          Client path: cancels _receive_task, which unblocks recv() with
            CancelledError. _run_receive_task()'s finally handles teardown.
        """
        if not self._websocket:
            return

        self._debug_message('Gracefully disconnecting WebSocket')

        # Phase 1: let in-flight handlers finish (_draining already set)
        await self._drain_message_tasks()

        # Phase 2: unblock recv() so the receive loop exits
        if self._receive_task and not self._receive_task.done():
            # Client path: cancel the task — _run_receive_task owns cleanup
            self._receive_task.cancel()
            try:
                await self._receive_task
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            self._receive_task = None
        else:
            # Server path: close the socket — accept()'s finally owns cleanup
            await self._close_websocket()

        self._debug_message('WebSocket disconnected successfully')

    def disconnect(self) -> asyncio.Task:
        """
        Initiate a graceful disconnect and return the Task.

        Sets _draining immediately (synchronous) so no new message tasks are
        created from this point, then schedules _do_disconnect() as an asyncio
        Task. Returns the Task so callers choose how to handle it:

            self._transport.disconnect()          # fire-and-forget (on_* handlers)
            await self._transport.disconnect()    # wait for completion (normal callers)

        Both forms are valid — asyncio.Task is awaitable.
        Safe to call multiple times.
        """
        # Set draining synchronously before any event-loop switch so the
        # receive loop stops creating new tasks immediately.
        self._draining = True
        return asyncio.create_task(self._do_disconnect())

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

                if self._is_fastapi_websocket():
                    await self._websocket.send_bytes(combined_message)
                else:
                    await self._websocket.send(combined_message)

            else:
                # Standard JSON message
                self._debug_protocol(f'SEND: {message}')

                if self._is_fastapi_websocket():
                    await self._websocket.send_json(message)
                else:
                    await self._websocket.send(json.dumps(message))

        except asyncio.TimeoutError:
            self._connected = False
            self._debug_message(f'WebSocket send timeout after {CONST_SOCKET_TIMEOUT}s')
            raise ConnectionError(f'Send timeout after {CONST_SOCKET_TIMEOUT} seconds')

        except (ConnectionResetError, BrokenPipeError) as e:
            self._connected = False
            self._debug_message(f'Connection lost during send: {e}')
            raise ConnectionError(f'Connection lost during send: {e}')

        except Exception as e:
            self._debug_message(f'Failed to send message: {e}')
            raise

        finally:
            # Restore binary data field if it was modified
            if binary_data:
                arguments['data'] = binary_data
