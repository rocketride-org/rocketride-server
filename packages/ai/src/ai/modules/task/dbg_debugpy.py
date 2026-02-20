"""
Debugpy Debug Adapter Protocol (DAP) Client Module.

This module provides a DAP client implementation that connects to debugpy servers
running in target processes. The debugpy server is embedded in the target process
and this client establishes a connection to communicate with it.

Communication Flow:
    External DAP Client (this) → TCP Connection → Target Process (debugpy server)

    - self.request(): Sends a request to the debugpy server and waits for response
    - self.on_recv(): Callback for processing received messages from debugpy server

Protocol Details:
    - Uses DAP (Debug Adapter Protocol) wire format with Content-Length headers
    - Supports standard DAP message types: requests, responses, and events
    - Maintains request/response correlation through sequence numbers
    - Single server connection model with automatic connection management

Key Features:
    - Acts as a DAP client connecting to debugpy servers in target processes
    - Full DAP protocol compliance for debugpy integration
    - Asynchronous message handling with asyncio
    - Robust error handling and connection management
    - Integration with DAPClient for protocol implementation
    - Support for debugging isolated task processes

Classes:
    DbgDebugpy: DAP client that connects to debugpy servers

Dependencies:
    - DAPClient: Base class providing DAP protocol implementation
    - asyncio: For asynchronous network operations
    - json: For DAP message serialization/deserialization

Note:
    This is a client that connects to debugpy servers running in target processes.
    The debugpy server is embedded in the target process using debugpy.listen() or
    similar mechanisms, and this client establishes a connection to that server.
"""

from ai.common.dap import DAPClient, TransportTCP
from .types import LAUNCH_TYPE


class DbgDebugpy(DAPClient):
    """
    DAP client for connecting to debugpy servers running in target processes.

    This client extends DAPClient to provide a complete DAP endpoint that connects
    to debugpy servers embedded in target processes. It handles the DAP wire format
    and integrates with the DAPClient protocol handling infrastructure.

    Communication Pattern:
        - Target processes run debugpy servers using debugpy.connect() or similar
        - This client connects to those servers using TCP connections
        - Messages flow bidirectionally for full debugging session support

    Key Features:
        - Inherits full DAP protocol support from DAPClient
        - DAP wire protocol support (Content-Length headers + JSON messages)
        - Non-blocking asyncio-based client architecture
        - Single server connection model with automatic handshake
        - Request/response correlation and event handling via DAPClient
        - Robust error handling and connection recovery

    Architecture:
        External System → DbgDebugpy (DAPClient) → TCP Socket → Target Process (debugpy server)

    Attributes:
        _host (str): Host address where the debugpy server is running
        _port (int): Port number where the debugpy server is listening
        _server (Optional[asyncio.Server]): TCP server accepting connections
        _reader (Optional[asyncio.StreamReader]): Stream for reading from debugpy server
        _writer (Optional[asyncio.StreamWriter]): Stream for writing to debugpy server
        _connected (bool): Flag indicating if client is connected to debugpy server
        _read_task (Optional[asyncio.Task]): Background task for reading server messages
    """

    def __init__(self, **kwargs) -> None:
        """
        Initialize the debugpy DAP client with connection parameters.

        Creates a client that will connect to a debugpy server running in a target
        process. The debugpy server should already be listening when this client
        attempts to connect.

        Args:
            host (str): Host address where the debugpy server is running (typically 'localhost')
            port (int): Port number where the debugpy server is listening for DAP connections.

        Note:
            The client doesn't connect until connect() is called.
            This allows for setup and configuration before establishing the connection.
        """
        # Get the token
        self._id = kwargs.get('id', 'UNKNOWN')
        self._token = kwargs.get('token', 'UNKNOWN')

        # Store uri for the debugpy server
        self._uri = kwargs.get('uri', 'tcp://localhost:5678')

        # Save the transport
        self._transport = TransportTCP(uri=self._uri)

        # Save our launch arguments
        self._launch_args = kwargs.get('launch_args', {})
        self._launch_type = kwargs.get('launch_type', LAUNCH_TYPE.LAUNCH)

        # Initialize the base DAP protocol handler
        super().__init__(module=f'DBPY-{self._id}', transport=self._transport, **kwargs)

    async def on_connected(self, connection_info: str) -> None:
        """
        Perform initial DAP handshake sequence with the debugpy server.

        This method sends the necessary DAP commands to the debugpy server to
        establish a debugging session. The sequence varies based on launch type.

        Handshake Sequence:
        1. Send 'initialize' request to establish capabilities with debugpy
        2. Send 'attach' request to begin debugging session with debugpy
        3. Handle launch-type-specific operations:
        - ATTACH/LAUNCH: Allow VS Code handshaking to continue normally
        - EXECUTE: Send configurationDone and disconnect to allow execution without debugging

        For ATTACH/LAUNCH, we are connected and ready to send VSCode debug commands
        For EXECUTE, the debugger available, but we are disconnected and must send an Attach request to re-establish the connection.

        Args:
            connection_info: Connection information (currently unused in implementation)

        Raises:
            RuntimeError: If any step of the handshake fails
        """
        try:
            # Call our super first
            await super().on_connected(connection_info)

            # VS Code has already sent us an initialize request, but now we need
            # to forward our own initialize request to the underlying debugpy server
            initialize_request = self.build_request(
                'initialize',
                arguments={
                    'clientID': 'rocketlib-client',
                    'clientName': 'RocketRide DAP Client',
                    'adapterID': 'rocketlib',
                    'linesStartAt1': True,
                    'columnsStartAt1': True,
                    'pathFormat': 'path',
                    'supportsVariableType': True,
                    'supportsVariablePaging': True,
                    'supportsRunInTerminalRequest': False,
                },
            )

            initialize_response = await self.request(initialize_request)
            if self.did_fail(initialize_response):
                raise RuntimeError(f'Initialize request failed: {initialize_response.get("message", "Unknown error")}')

            self.debug_message('Debugpy server initialized successfully')

            # Send attach request to begin debugging session with debugpy
            justMyCode = self._launch_args.get('justMyCode', True)
            attach_response = await self.request(
                self.build_request(
                    'attach',  #
                    arguments={
                        'justMyCode': justMyCode,
                        'redirectOutput': False,
                    },
                )
            )
            if self.did_fail(attach_response):
                raise RuntimeError(f'Attach request failed: {attach_response.get("message", "Unknown error")}')
            self.debug_message('Attached to debug process')

        except Exception as e:
            self.debug_message(f'Error during debugpy handshake: {e}')
            raise  # Re-raise handshake failures as they indicate setup problems

    async def listen(self) -> str:
        return await self._transport.listen()
