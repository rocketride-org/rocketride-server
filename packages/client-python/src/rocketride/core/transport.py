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
Transport Base Classes for DAP Protocol Communication.

This module provides abstract base classes for implementing different transport
mechanisms in Debug Adapter Protocol (DAP) implementations. Transport classes
handle the actual network communication between clients and servers.

The transport layer is responsible for:
- Establishing and maintaining network connections
- Serializing and deserializing messages
- Handling connection events and errors
- Providing consistent interfaces across different protocols

This is an internal implementation detail used by the RocketRide client to
communicate with servers. Most users won't interact with these classes
directly - they're part of the underlying communication infrastructure.

Key Features:
- Abstract base class defining standard transport interface
- Connection lifecycle management with callbacks
- Message handling with debugging support
- Support for both client and server connection patterns
- Extensible design for different transport types (WebSocket, TCP, etc.)
"""

import asyncio
from abc import ABC, abstractmethod
from typing import Dict, Any, Callable, Awaitable, Optional


class TransportBase(ABC):
    """
    Abstract base class for DAP transport implementations.

    This class defines the standard interface that all transport implementations
    must follow for DAP communication. It provides common functionality for
    callback management and connection state tracking while requiring concrete
    implementations to handle transport-specific details.

    Transport implementations handle the actual network communication including:
    - Connection establishment and management
    - Message serialization and transmission
    - Error handling and recovery
    - Connection lifecycle events

    This ensures a consistent API across different transport types while allowing
    each implementation to optimize for its specific protocol requirements.
    """

    def __init__(self) -> None:
        """
        Initialize the transport base without callback functions.

        Callback functions must be set using bind() before using the transport.
        """
        self._on_caller_debug_message = None
        self._on_caller_debug_protocol = None
        self._on_caller_receive = None
        self._on_caller_connected = None
        self._on_caller_disconnected = None

        self._connected = False

    def _debug_message(self, message: str) -> None:
        """
        Send debug message to callback if available.

        Args:
            message: Debug message to send
        """
        if self._on_caller_debug_message:
            self._on_caller_debug_message(message)

    def _debug_protocol(self, message: str) -> None:
        """
        Send protocol debug message to callback if available.

        Args:
            message: Protocol debug message to send
        """
        if self._on_caller_debug_protocol:
            self._on_caller_debug_protocol(message)

    async def _transport_receive(self, message: Dict[str, Any]) -> None:
        """
        Forward received message to callback if available.

        Args:
            message: Message received from transport
        """
        self._debug_protocol(f'RECV: {message}')
        if self._on_caller_receive:
            await self._on_caller_receive(message)

    async def _transport_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Notify about connection establishment.

        Args:
            connection_info: Optional connection details
        """
        self._debug_message(f'Connected, info={connection_info}')

        if callback := self._on_caller_connected:
            await callback(connection_info)

    async def _transport_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Notify about connection closure.

        Args:
            reason: Optional reason for disconnection
            has_error: Whether disconnection was due to error
        """
        self._debug_message(f'Disconnected, reason={reason}, error={has_error}')

        if callback := self._on_caller_disconnected:
            await callback(reason, has_error)

    def bind(
        self,
        *,
        on_debug_message: Optional[Callable[[str], None]] = None,
        on_debug_protocol: Optional[Callable[[str], None]] = None,
        on_receive: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
        on_connected: Optional[Callable[[Optional[str]], Awaitable[None]]] = None,
        on_disconnected: Optional[Callable[[Optional[str], bool], Awaitable[None]]] = None,
    ) -> None:
        """
        Bind callback functions to the transport.

        This must be called before using the transport for communication.
        The callbacks handle debugging, connection events, and message processing.

        Args:
            on_debug_message: Callback for general debug messages and status
            on_debug_protocol: Callback for detailed protocol message tracing
            on_receive: Async callback for received and parsed messages
            on_connected: Async callback for connection established events
            on_disconnected: Async callback for connection closed events

        Example:
            transport = WebSocketTransport("http://localhost:8080")

            async def handle_message(message):
                print(f"Received: {message}")

            async def handle_connected(info):
                print(f"Connected to {info}")

            transport.bind(
                on_debug_message=print,
                on_receive=handle_message,
                on_connected=handle_connected
            )

            await transport.connect()
        """
        if on_debug_message is not None:
            self._on_caller_debug_message = on_debug_message
        if on_debug_protocol is not None:
            self._on_caller_debug_protocol = on_debug_protocol
        if on_receive is not None:
            self._on_caller_receive = on_receive
        if on_connected is not None:
            self._on_caller_connected = on_connected
        if on_disconnected is not None:
            self._on_caller_disconnected = on_disconnected

    def get_connection_info(self) -> Optional[str]:
        """Return connection info for the "connected" callback (e.g. URI). Default none."""
        return None

    def set_auth(self, auth: str) -> None:
        """Update auth credential. Takes effect on the next connect()."""
        pass

    def set_uri(self, uri: str) -> None:
        """Update connection URI. Takes effect on the next connect()."""
        pass

    def is_connected(self) -> bool:
        """
        Check if the transport is currently connected.

        Returns:
            bool: True if connected and ready for communication
        """
        return self._connected

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Establish connection to remote endpoint (client-side).

        This method must be implemented by concrete transport classes to handle
        connection establishment. For client connections, this typically starts
        background message receiving and returns immediately.

        Args:
            timeout: Optional connection timeout in milliseconds. Falls back to
                transport-specific default when not provided.

        Raises:
            ConnectionError: If connection fails
            ValueError: If configuration is invalid
            NotImplementedError: If not supported by this transport

        Example Implementation:
            async def connect(self, timeout=None) -> None:
                # Parse connection parameters
                # Establish connection
                # Set self._connected = True
                # Start background receiving
                # Call self._transport_connected()
        """
        pass

    async def accept(self, connection_info: Any) -> None:
        """
        Accept incoming connection (server-side).

        This method must be implemented by concrete transport classes to handle
        accepting incoming connections. Unlike connect(), this should block until
        the connection closes, making it suitable for server frameworks.

        Args:
            connection_info: Transport-specific connection information

        Raises:
            ConnectionError: If accepting fails
            ValueError: If connection_info is invalid
            NotImplementedError: If not supported by this transport

        Example Implementation:
            async def accept(self, websocket) -> None:
                # Complete connection handshake
                # Set self._connected = True
                # Call self._transport_connected()
                # Block in receive loop until connection closes
        """
        pass

    @abstractmethod
    def disconnect(self) -> 'asyncio.Task':
        """
        Initiate graceful connection closure and return the Task.

        Sets _draining synchronously then schedules the actual drain-and-close.
        Returns an asyncio.Task so callers choose how to handle it:

            transport.disconnect()          # fire-and-forget
            await transport.disconnect()    # wait for completion

        Should be safe to call multiple times.
        """
        pass

    @abstractmethod
    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a message over the transport.

        This method must be implemented by concrete transport classes to handle
        message transmission. Should support both standard JSON messages and
        binary messages with data payloads.

        Args:
            message: The message to send (must be JSON-serializable)

        Raises:
            ConnectionError: If not connected or sending fails
            ValueError: If message format is invalid

        Example Implementation:
            async def send(self, message: Dict[str, Any]) -> None:
                if not self.is_connected():
                    raise ConnectionError('Not connected')

                self._debug_protocol(f'SEND: {message}')

                # Handle binary data if present
                # Serialize message
                # Send over transport
                # Handle errors appropriately
        """
        pass
