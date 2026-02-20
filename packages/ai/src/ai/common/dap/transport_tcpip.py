"""
TCP Transport Implementation for DAP Protocol.

This module provides a concrete TCP transport implementation for Debug Adapter Protocol
(DAP) communication. It extends the abstract TransportBase class with TCP-specific
functionality for both client and server scenarios using the DAP over TCP protocol.

The TCP transport handles the DAP-over-TCP message format which includes:
- Content-Length header for message framing
- Optional Content-Type header
- Blank line separator between headers and content
- JSON message body
- Support for binary data encoding within JSON

Key Features:
- Production-ready TCP message handling with DAP protocol compliance
- Content-Length based message framing for reliable parsing
- Support for DAP binary message format via base64 encoding
- Comprehensive error handling with customizable callbacks
- Protocol debugging support for development and troubleshooting
- Clean separation of transport logic from application logic
- Connection management for both client and server scenarios
- Connection lifecycle event callbacks (on_connected, on_disconnected)
- Client: Automatic background message receiving
- Server: Blocking receive loop in accept()

DAP-over-TCP Message Format:
```
Content-Length: 123(CR)(LF)
Content-Type: application/vscode-jsonrpc; charset=utf-8(CR)(LF)
(CR)(LF)
{"type": "request", "command": "initialize", ...}
```

Usage Patterns:
    For DAP servers (asyncio.start_server):
    ```python
    async def handle_client(reader, writer):
        transport = TransportTCP()
        transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=dap_server.handle_client_message)
        await transport.accept((reader, writer))  # Blocks until disconnect
        print('Client disconnected')


    server = await asyncio.start_server(handle_client, 'localhost', 8080)
    ```

    For DAP clients connecting to servers:
    ```python
    transport = TransportTCP()
    transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=dap_client.handle_server_response)
    await transport.connect('tcp://localhost:8080')
    # Messages automatically received in background
    ```

    For listening servers (reverse connection):
    ```python
    transport = TransportTCP('tcp://localhost:0')
    transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_message, on_connected=handle_connected, on_disconnected=handle_disconnected)
    actual_uri = await transport.listen()
    # Tell debugpy to connect to actual_uri
    ```

    For sending DAP messages:
    ```python
    await transport.send({'type': 'response', 'command': 'initialize', 'success': True})
    ```
"""

import json
import asyncio
import base64
from typing import Dict, Any, Optional, Tuple
from urllib.parse import urlparse
from . import TransportBase


class TransportTCP(TransportBase):
    """
    TCP transport implementation for DAP protocol communication.

    This class provides a concrete TCP transport that extends TransportBase
    with TCP-specific functionality using the DAP-over-TCP protocol format.
    It handles message framing using Content-Length headers, automatic format
    detection for binary data, comprehensive error handling, protocol debugging support,
    and connection lifecycle event callbacks.

    Features:
    - DAP-over-TCP protocol compliance with Content-Length framing
    - Automatic message format detection and parsing
    - Binary data support via base64 encoding in JSON
    - Background message receiving for clients (connect)
    - Blocking receive loop for servers (accept)
    - Listening server mode for reverse connections (listen)
    - Connection lifecycle callbacks (on_connected, on_disconnected)
    - Protocol-level debugging and message tracing
    - Connection management for both client and server scenarios
    - Safe callback handling through base class wrapper methods

    The class handles client and server scenarios differently:
    - Client (connect): Automatically starts background message receiving
    - Server (accept): Blocks in receive loop until connection closes
    - Listen (listen): Starts server, accepts first connection, then acts like client

    Example Usage:
        ```python
        # Server usage - asyncio TCP server
        async def handle_client(reader, writer):
            transport = TransportTCP()
            transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_message)
            await transport.accept((reader, writer))  # Blocks until disconnect
            print('Client disconnected')


        # Client usage - automatic background receiving
        transport = TransportTCP()
        transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_message)
        await transport.connect('tcp://localhost:8080')
        # Messages received automatically in background

        # Listen usage - reverse connection for debugpy
        transport = TransportTCP('tcp://localhost:0')
        transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_message, on_connected=lambda info: print(f'Connected: {info}'), on_disconnected=lambda reason, error: print(f'Disconnected: {reason}'))
        actual_uri = await transport.listen()
        debugpy.connect(parse_uri(actual_uri))

        # Send messages
        await transport.send({'type': 'response', 'command': 'initialize', 'success': True})

        # Cleanup
        await transport.disconnect()
        ```
    """

    def __init__(self, uri: str = None, **kwargs) -> None:
        """
        Initialize the TCP transport.

        The transport must be bound with callback functions using bind()
        before it can be used for communication.

        Args:
            uri (str, optional): The TCP URI to use for connections
            **kwargs: Additional transport-specific options
        """
        super().__init__()
        self._reader = None
        self._writer = None
        self._receive_task = None
        self._server = None
        self._uri = uri
        self._is_waiting_for_connection = False

    async def listen(self) -> str:
        """
        Start a TCP server and return the actual URI immediately.

        This method creates a TCP server that waits for incoming connections.
        Unlike accept(), this method returns immediately after starting the server,
        allowing the caller to use the URI (e.g., for debugpy.connect()).

        The server will accept the first incoming connection and then automatically
        start background message receiving like a client connection.

        Returns:
            str: The actual URI the server is listening on (with resolved port if 0 was used)

        Raises:
            ValueError: If the URI format is invalid
            ConnectionError: If server startup fails
            Exception: For other server setup errors

        Example:
            ```python
            transport = TransportTCP('tcp://localhost:0')
            transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_debugpy_message, on_connected=handle_connected, on_disconnected=handle_disconnected)

            # Start listening and get the actual URI
            actual_uri = await transport.listen()
            print(f'Listening on {actual_uri}')

            # Extract host/port for debugpy
            from urllib.parse import urlparse

            parsed = urlparse(actual_uri)
            debugpy.connect((parsed.hostname, parsed.port))

            # Server will automatically accept and start receiving messages
            # Connection callbacks will be triggered appropriately
            ```

        Note:
            The server will automatically accept the first incoming connection
            and start background message receiving. Only one connection is accepted.
            Connection lifecycle callbacks will be triggered when connection is
            established and when it's closed.
        """
        if not self._uri.startswith('tcp://'):
            raise ValueError('TCP transport requires tcp:// URI')

        try:
            # Parse the URI to extract host and port
            parsed = urlparse(self._uri)
            host = parsed.hostname or 'localhost'
            port = parsed.port or 0

            self._debug_message(f'Starting TCP server on {self._uri}')

            async def handle_connection(reader, writer):
                """Handle the first incoming connection."""
                try:
                    peer_info = writer.get_extra_info('peername')
                    self._debug_message(f'Accepted connection from {peer_info}')

                    # Store the connection
                    self._reader = reader
                    self._writer = writer
                    self._connected = True

                    # Shut down the server immediately after accepting the connection
                    if hasattr(self, '_server') and self._server:
                        self._server.close()
                        await self._server.wait_closed()
                        self._debug_message('Closed server after accepting connection')

                    # Start background message receiving as an async task (client-style)
                    self._receive_task = asyncio.create_task(self._receive_loop())
                    self._debug_message('Started automatic message receiving task')

                    # We have the connection, so we are no longer waiting
                    self._is_waiting_for_connection = False

                    # Call the connection established callback
                    connection_info = f'tcp://{peer_info[0]}:{peer_info[1]}'
                    await self._transport_connected(connection_info)

                except Exception as e:
                    self._debug_message(f'Error handling connection: {e}')
                    # Trigger disconnected callback with error
                    await self._transport_disconnected(str(e), has_error=True)

            # Say that we are waiting for a connection
            self._is_waiting_for_connection = True

            # Start the server
            self._server = await asyncio.start_server(handle_connection, host, port)

            # Get the actual port being used - handle IPv4 and IPv6
            sock_info = self._server.sockets[0].getsockname()

            if len(sock_info) >= 2:
                # IPv4: (host, port) or IPv6: (host, port, flow_info, scope_id)
                server_host, actual_port = sock_info[0], sock_info[1]
            else:
                # Fallback - should not happen for TCP but be safe
                raise ConnectionError(f'Unexpected socket address format: {sock_info}')

            actual_uri = f'tcp://{server_host}:{actual_port}'
            self._debug_message(f'TCP server listening on {actual_uri}')

            return actual_uri

        except Exception as e:
            self._debug_message(f'Failed to start TCP server: {e}')
            raise ConnectionError(f'TCP server startup failed: {e}')

    async def connect(self, timeout: Optional[float] = None) -> None:
        """
        Connect to a TCP server and automatically start receiving messages.

        This method establishes a TCP connection and immediately starts a
        background task to receive and process incoming messages. This is designed
        for client-side usage where automatic message handling is desired.

        Args:
            timeout: Optional timeout in ms for the connection (for API compatibility
                with DAPClient.connect). When set, the connection attempt is bounded by this time.

        Raises:
            ValueError: If the URI format is invalid
            ConnectionError: If the connection attempt fails
            Exception: For other connection-related errors

        Example:
            ```python
            transport = TransportTCP('tcp://localhost:8080')
            transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_server_message, on_connected=handle_connected, on_disconnected=handle_disconnected)

            await transport.connect()
            # Messages are now automatically received and dispatched
            # Connection callbacks will be triggered
            # Continue with other work while messages are processed in background
            ```

        Note:
            After successful connection, messages are automatically processed
            in the background using the configured receive callback.
            Connection lifecycle callbacks will be triggered appropriately.
        """
        if not self._uri.startswith('tcp://'):
            raise ValueError('TCP transport requires tcp:// URI')

        try:
            # Parse the URI to extract host and port
            parsed = urlparse(self._uri)
            host = parsed.hostname or 'localhost'
            port = parsed.port or 8080

            self._debug_message(f'Connecting to TCP server at {self._uri}')

            # Establish TCP connection (optionally with timeout in ms)
            if timeout is not None and timeout > 0:
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port), timeout=timeout / 1000.0
                )
            else:
                self._reader, self._writer = await asyncio.open_connection(host, port)
            self._connected = True
            self._debug_message(f'Successfully connected to {self._uri}')

            # Start background task to automatically receive messages for client connections
            self._receive_task = asyncio.create_task(self._receive_loop())
            self._debug_message('Started automatic message receiving')

            # Call the connection established callback
            await self._transport_connected(self._uri)

        except Exception as e:
            self._debug_message(f'Failed to connect to {self._uri}: {e}')

            # Call the connection closed callback with error
            await self._transport_disconnected(f'Connection failed: {e}', has_error=True)
            raise ConnectionError(f'TCP connection failed: {e}')

    async def accept(self, connection_info: Tuple[asyncio.StreamReader, asyncio.StreamWriter]) -> None:
        """
        Accept an incoming TCP connection and start receiving messages.

        This method accepts the TCP connection streams and immediately starts the
        message receiving loop, blocking until the connection is closed. This is
        designed for server-side usage with asyncio TCP servers.

        Args:
            connection_info (Tuple[asyncio.StreamReader, asyncio.StreamWriter]):
                The reader/writer pair from asyncio.start_server callback

        Raises:
            ValueError: If connection_info is not a valid reader/writer tuple
            ConnectionError: If accepting the connection fails

        Example:
            ```python
            async def handle_client(reader, writer):
                transport = TransportTCP()
                transport.bind(on_debug_message=logger.debug, on_debug_protocol=protocol_logger.debug, on_receive=handle_client_message, on_connected=handle_connected, on_disconnected=handle_disconnected)

                await transport.accept((reader, writer))
                # This line runs after the client disconnects
                print('Client disconnected')


            server = await asyncio.start_server(handle_client, 'localhost', 8080)
            ```

        Note:
            This method blocks until the TCP connection is closed.
            It handles all message receiving automatically during the connection
            lifetime using the configured receive callback.
            Connection lifecycle callbacks will be triggered appropriately.
        """
        if not isinstance(connection_info, tuple) or len(connection_info) != 2:
            raise ValueError('TCP transport requires (reader, writer) tuple')

        try:
            reader, writer = connection_info

            if not isinstance(reader, asyncio.StreamReader):
                raise ValueError('First element must be asyncio.StreamReader')
            if not isinstance(writer, asyncio.StreamWriter):
                raise ValueError('Second element must be asyncio.StreamWriter')

            self._debug_message('Accepting incoming TCP connection')

            self._reader = reader
            self._writer = writer
            self._connected = True

            # Get peer info for logging
            peer_info = writer.get_extra_info('peername')
            self._debug_message(f'Successfully accepted TCP connection from {peer_info}')

            # Trigger on_connected callback
            connection_info = f'tcp://{peer_info[0]}:{peer_info[1]}'
            await self._transport_connected(connection_info)

            # Start receiving messages directly (blocking until connection closes)
            await self._receive_loop()

        except Exception as e:
            self._debug_message(f'Failed to accept TCP connection: {e}')
            # Trigger disconnected callback with error
            await self._transport_disconnected(f'Accept failed: {e}', has_error=True)
            raise ConnectionError(f'TCP accept failed: {e}')

    async def disconnect(self) -> None:
        """
        Disconnect and close the TCP connection.

        This method gracefully closes the TCP connection, stops any
        background receive task, and cleans up resources. It can be called
        by both clients and servers to terminate the connection cleanly.

        The method is safe to call multiple times - subsequent calls will
        be ignored if already disconnected.

        Example:
            ```python
            # Graceful shutdown
            try:
                await transport.disconnect()
            except Exception as e:
                logger.error(f'Error during disconnect: {e}')
            ```

        Note:
            After disconnection, the transport cannot be used for communication
            until a new connection is established via connect() or accept().
            The on_disconnected callback will be triggered (graceful disconnection).
        """
        if not self._connected or not self._writer:
            return

        try:
            self._debug_message('Disconnecting TCP connection')

            # Cancel the receive task if it's running (client connections)
            if self._receive_task and not self._receive_task.done():
                self._receive_task.cancel()
                try:
                    await self._receive_task
                except asyncio.CancelledError:
                    pass
                self._debug_message('Stopped background message receiving')

            # Close the writer (which closes the connection)
            self._writer.close()

            # Handle wait_closed() safely
            try:
                close_awaitable = self._writer.wait_closed()
                if asyncio.iscoroutine(close_awaitable):
                    await close_awaitable
                # If it's already a completed future or not awaitable, skip
            except RuntimeError as e:
                if "await wasn't used with future" in str(e):
                    self._debug_message('Writer already closed, skipping wait_closed()')
                else:
                    raise

            self._connected = False
            self._reader = None
            self._writer = None
            self._receive_task = None
            self._debug_message('Successfully disconnected TCP connection')

            # Call the connection closed callback (graceful)
            await self._transport_disconnected('Disconnected by request', has_error=False)

        except (ConnectionResetError, ConnectionAbortedError):
            # Expected disconnection scenarios during graceful close
            self._debug_message('Connection closed by peer during disconnect')
            self._connected = False
            self._reader = None
            self._writer = None
            self._receive_task = None
            await self._transport_disconnected('Connection closed by peer', has_error=False)

        except Exception as e:
            # Unexpected errors during disconnect
            self._debug_message(f'Unexpected error during TCP disconnect: {e}')
            # Still mark as disconnected even if close failed
            self._connected = False
            self._reader = None
            self._writer = None
            self._receive_task = None

            # Call the connection closed callback (error)
            await self._transport_disconnected(f'Disconnect error: {e}', has_error=True)

    async def _receive_loop(self) -> None:
        """
        Message receiving loop that processes incoming TCP messages.

        This method runs either as a background task (for client connections)
        or directly/synchronously (for server connections). It handles all
        incoming TCP messages using the DAP-over-TCP protocol and dispatches
        them to the configured receive callback using self._receive().

        The loop continues until the TCP connection is closed or an error occurs.
        All parsing errors are handled gracefully without terminating the connection.

        Features:
        - Content-Length based message framing for reliable parsing
        - JSON message parsing with comprehensive error handling
        - Binary data support via base64 decoding
        - Protocol-level debugging and message tracing
        - Graceful error recovery without connection termination
        - Connection lifecycle callback integration

        Error Handling Strategy:
        - Header parsing errors: Logged and loop continues to recover
        - JSON parsing errors: Logged but loop continues
        - Connection errors: Logged and loop terminates with callback
        - Task cancellation: Handled gracefully during disconnect
        - Unexpected exceptions: Logged and loop terminates with callback
        """
        try:
            # Main message receiving loop - continues until TCP connection closes
            while self._connected:
                try:
                    # Read DAP-over-TCP message headers
                    headers = {}
                    while True:
                        # Read header line
                        line = await self._reader.readline()
                        if not line:
                            # Connection closed by remote end
                            self._debug_message('TCP connection closed during header read')
                            self._connected = False

                            # Call the connection closed callback (graceful close by peer)
                            await self._transport_disconnected('Connection closed by peer', has_error=False)
                            return

                        line = line.decode('utf-8').strip()

                        # Empty line indicates end of headers
                        if not line:
                            break

                        # Parse header (format: "Name: Value")
                        if ':' in line:
                            name, value = line.split(':', 1)
                            headers[name.strip().lower()] = value.strip()

                    # Extract content length (required for DAP-over-TCP)
                    content_length = headers.get('content-length')
                    if not content_length:
                        self._debug_message('Missing Content-Length header, skipping message')
                        continue

                    try:
                        content_length = int(content_length)
                    except ValueError:
                        self._debug_message(f'Invalid Content-Length value: {content_length}')
                        continue

                    # Read the exact amount of content
                    content_bytes = await self._reader.readexactly(content_length)
                    if not content_bytes:
                        # Connection closed by remote end
                        self._debug_message('TCP connection closed during content read')
                        self._connected = False

                        # Call the connection closed callback (graceful close by peer)
                        await self._transport_disconnected('Connection closed during read', has_error=False)
                        return

                    # Parse JSON content
                    try:
                        content_str = content_bytes.decode('utf-8')
                        json_message = json.loads(content_str)

                        # Handle base64 binary data if present
                        if 'data_base64' in json_message:
                            try:
                                base64_data = json_message.pop('data_base64')
                                binary_data = base64.b64decode(base64_data)
                                json_message['data'] = binary_data
                            except Exception as e:
                                self._debug_message(f'Failed to decode base64 data: {e}')

                        # Dispatch complete message using base class wrapper
                        await self._transport_receive(json_message)

                    except json.JSONDecodeError as e:
                        # JSON parsing failed - log error but continue processing
                        self._debug_message(f'Invalid JSON received: {e}')

                    except UnicodeDecodeError as e:
                        # Content decoding failed - log error but continue
                        self._debug_message(f'Failed to decode message content: {e}')

                except asyncio.IncompleteReadError:
                    # Connection closed during read
                    self._debug_message('TCP connection closed during message read')
                    self._connected = False

                    # Call the connection closed callback (connection closed)
                    await self._transport_disconnected('Incomplete read - connection closed', has_error=False)
                    break

                except ConnectionResetError:
                    # Connection reset by peer
                    self._debug_message('TCP connection reset by peer')
                    self._connected = False

                    # Call the connection closed callback (connection reset)
                    await self._transport_disconnected('Connection reset by peer', has_error=True)
                    break

                except Exception as e:
                    # Other error in message processing - log but continue
                    self._debug_message(f'Error processing TCP message: {e}')

        except asyncio.CancelledError:
            # Task was cancelled during disconnect
            self._debug_message('TCP receive loop cancelled')

            # Call the connection closed callback (graceful cancellation)
            await self._transport_disconnected('Receive loop cancelled', has_error=False)

        except Exception as e:
            # Unexpected error in the receiving loop
            self._debug_message(f'Unexpected error in TCP receive loop: {e}')

            # Call the connection closed callback (unexpected error)
            await self._transport_disconnected(f'Receive loop error: {e}', has_error=True)

        finally:
            # Mark as disconnected when loop exits
            self._connected = False

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a DAP message over TCP using the DAP-over-TCP protocol format.

        This method handles sending DAP messages using the standard DAP-over-TCP
        protocol format with Content-Length headers. It automatically handles
        binary data by converting it to base64 encoding within the JSON message.

        If not connected but waiting for connection (listen mode), this method
        will wait up to 15 seconds for the connection to be established.

        DAP-over-TCP Message Format:
        ```
        Content-Length: 123(CR)(LF)
        Content-Type: application/vscode-jsonrpc; charset=utf-8(CR)(LF)
        (CR)(LF)
        {"type": "request", "command": "initialize", ...}
        ```

        Args:
            message (Dict[str, Any]): The DAP message to send. Must be JSON-serializable.
                                     If contains 'data' field, will be base64 encoded.

        Raises:
            ConnectionError: If not connected when method is called
            Exception: If TCP sending fails due to connection issues, encoding errors,
                      or other communication problems. Error details are logged before re-raising.

        Data Type Conversion:
        The 'data' field supports various Python types:
        - bytes: Base64 encoded and stored as 'data_base64' field
        - str: Base64 encoded after UTF-8 encoding
        - int/list/dict/other: Converted to JSON, then base64 encoded

        Example Usage:
            ```python
            # Standard JSON message
            await transport.send({'type': 'response', 'command': 'initialize', 'request_seq': 1, 'success': True, 'body': {'capabilities': {...}}})

            # Message with binary data (will be base64 encoded)
            await transport.send({'type': 'event', 'event': 'output', 'body': {'category': 'stdout', 'output': 'Debug output'}, 'data': b'large_binary_debug_data'})
            ```

        Error Handling:
        All sending errors are logged via the debug message callback with detailed error
        information before being re-raised to the caller.
        """
        # Check if we're connected before sending
        if not self.is_connected():
            # If we are waiting for debugpy to connect (listen mode)
            wait_count = 0
            max_wait = 150  # 15 seconds in 0.1 second intervals

            while self._is_waiting_for_connection and wait_count < max_wait:
                # Wait for connection to be established
                await asyncio.sleep(0.1)
                wait_count += 1

            # If still not connected after waiting, raise error
            if not self.is_connected():
                if self._is_waiting_for_connection:
                    raise ConnectionError('Timeout: Connection not established within 15 seconds')
                else:
                    raise ConnectionError('TCP is not connected. Call connect(), accept(), or listen() first.')

        # Validate connection state throughout the operation
        if not self._writer or not self.is_connected():
            raise ConnectionError('Connection lost before send operation')

        try:
            # Handle binary data by converting to base64
            if 'data' in message:
                binary_data = message.pop('data')

                # Convert data to bytes if needed
                if isinstance(binary_data, str):
                    binary_data = binary_data.encode('utf-8')
                elif not isinstance(binary_data, bytes):
                    binary_data = json.dumps(binary_data).encode('utf-8')

                # Base64 encode the binary data
                message['data_base64'] = base64.b64encode(binary_data).decode('utf-8')

            # Log outgoing message for protocol debugging
            self._debug_protocol(f'SEND: {message}')

            # Serialize message to JSON
            json_content = json.dumps(message, separators=(',', ':'))
            content_bytes = json_content.encode('utf-8')

            # Build DAP-over-TCP message with headers
            content_length = len(content_bytes)
            headers = f'Content-Length: {content_length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n'

            # Combine headers and content
            full_message = headers.encode('utf-8') + content_bytes

            # Send the complete message
            self._writer.write(full_message)
            await self._writer.drain()

        except (ConnectionResetError, BrokenPipeError) as e:
            # Connection-related errors should update state and re-raise as ConnectionError
            self._connected = False
            self._debug_message(f'Connection lost during TCP send: {e}')
            raise ConnectionError(f'Connection lost during send: {e}')

        except Exception as e:
            # Log send failures with detailed error information for debugging
            self._debug_message(f'Failed to send message to TCP: {e}')
            raise
