"""
Task Engine Stdio Debug Client Module.

This module provides a DAP (Debug Adapter Protocol) client that communicates with
task engine subprocesses via stdio streams using a custom protocol. It serves as
a bridge between the debugging infrastructure and task engines that communicate
through standard input/output streams.

This refactored version uses the TransportStdio transport layer for consistent
architecture with other DAP components, providing better separation of concerns
and unified connection lifecycle management.

Communication Flow:
    External DAP System ← DbgStdio (Client) ← TransportStdio ← JSON Commands ← stdin ← Task Engine Process
    External DAP System → DbgStdio (Client) → TransportStdio → Custom Protocol → stdout/stderr → Task Engine Process

    - DbgStdio acts as a DAP client using TransportStdio for subprocess communication
    - TransportStdio handles stream monitoring and protocol message parsing
    - DbgStdio focuses on DAP client functionality and command translation
    - Provides unified connection lifecycle callbacks through transport layer

Key Features:
    - Consistent transport architecture with other DAP components
    - Connection lifecycle management through transport callbacks
    - Automatic protocol message parsing and event generation
    - Command translation from DAP to subprocess JSON
    - Unified error handling and debugging support
    - Clean separation between transport and application logic

Classes:
    DbgStdio: DAP client using TransportStdio for subprocess communication

Dependencies:
    - asyncio: For asynchronous processing
    - TransportStdio: For subprocess communication transport
    - ai.common.dap: Base DAP client infrastructure

Usage Pattern:
    1. Create instance with subprocess: client = DbgStdio(process=subprocess, token="TASK1")
    2. Start client: await client.connect()
    3. External DAP system can send commands through this client
    4. Client uses TransportStdio to communicate with subprocess
    5. Transport handles protocol parsing and forwards events to client
    6. Stop client: await client.disconnect()
"""

import asyncio
from ai.common.dap import DAPClient
from ai.common.dap import TransportStdio


class DbgStdio(DAPClient):
    """
    DAP client that provides debugging interface for task engine subprocesses via stdio.

    This refactored class extends DAPClient and uses TransportStdio to provide a complete
    debugging interface for task engine processes. It leverages the transport layer for
    subprocess communication while focusing on DAP client functionality and command translation.

    Architecture Role:
    - Extends DAPClient to provide standard DAP debugging interface
    - Uses TransportStdio for subprocess communication and protocol handling
    - Translates external DAP commands to JSON commands via transport
    - Receives protocol events from transport and forwards as DAP events
    - Manages complete debugging session lifecycle with transport callbacks

    Transport Integration:
    - TransportStdio handles all subprocess stream monitoring and protocol parsing
    - DbgStdio receives parsed protocol events through transport callbacks
    - Commands are sent to subprocess through transport.send()
    - Connection lifecycle is managed through transport callbacks
    - Consistent error handling and debugging through transport layer

    DAP Client Functionality:
    - Connects to external DAP systems for debugging coordination
    - Processes DAP commands from external systems
    - Sends DAP events (stopped, continued, output, terminated, etc.) to external systems
    - Maintains debugging session state and correlation
    - Forwards subprocess communications as DAP events through transport integration

    Protocol Translation:
        Inbound:  External DAP System → DAP Commands → JSON Commands → TransportStdio → stdin → Task Engine
        Outbound: Task Engine → stdout/stderr → TransportStdio → Protocol Events → DAP Events → External DAP System

    Connection Lifecycle:
        The transport provides connection lifecycle callbacks:
        - on_connected: When subprocess monitoring begins
        - on_disconnected: When subprocess terminates or errors occur
        - Enables automatic DAP session management

    Example Usage:
        ```python
        # Create subprocess
        process = await asyncio.create_subprocess_exec(
            'python',
            'task_engine.py',
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Create DAP client with transport
        client = DbgStdio(process=process, token='TASK1')

        # Start debugging session
        await client.connect()  # Starts DAP client and subprocess monitoring

        # External DAP systems can now send commands
        # Commands are automatically translated and sent to subprocess
        # Protocol events are automatically converted to DAP events

        # Stop debugging session
        await client.disconnect()
        ```

    Integration with Custom Commands:
        ```python
        class CustomDbgStdio(DbgStdio):
            async def on_pause_command(self, command):
                # Translate DAP pause to subprocess command
                await self.send_to_subprocess({'command': 'pause'})

            async def on_continue_command(self, command):
                # Translate DAP continue to subprocess command
                await self.send_to_subprocess({'command': 'continue'})
        ```

    Attributes:
        _transport (TransportStdio): The stdio transport for subprocess communication
        _process (asyncio.subprocess.Process): The monitored subprocess
        _token (str): Unique identifier for this debugging session
    """

    def __init__(self, **kwargs) -> None:
        """
        Initialize the stdio DAP client with a subprocess and transport.

        Sets up the client to use TransportStdio for subprocess communication and
        protocol handling. The transport will handle all stream monitoring and
        protocol parsing, while this client focuses on DAP functionality.

        Args:
            process (asyncio.subprocess.Process): The subprocess to communicate with.
                Must have stdout and stderr streams available for reading protocol
                messages, and stdin available for sending JSON commands.
            token (str, optional): Unique identifier for this debugging session.
                Used for logging and identification. Defaults to 'UNKNOWN'.
            **kwargs: Additional arguments passed to parent DAPClient

        Raises:
            TypeError: If process is not an asyncio subprocess
            AttributeError: If required stdio streams are not available

        Setup Process:
        1. Initializes parent DAPClient for DAP protocol handling
        2. Stores subprocess reference and token
        3. Creates TransportStdio instance for subprocess communication
        4. Binds transport callbacks for protocol event handling
        5. Prepares connection lifecycle management

        Note:
            After initialization, call connect() to begin the DAP client and start
            subprocess monitoring through the transport layer.

        Example:
            ```python
            # Basic usage
            client = DbgStdio(process=subprocess, token='TASK1')
            await client.connect()


            # With custom DAP event handling
            class MyStdioClient(DbgStdio):
                async def on_pause_command(self, command):
                    await self.send_to_subprocess({'command': 'pause'})


            client = MyStdioClient(process=subprocess, token='TASK1')
            await client.connect()
            ```
        """
        # Get the token for identification
        self._id = kwargs.get('id', 'UNKNOWN')
        self._token = kwargs.get('token', 'UNKNOWN')

        # Get and validate the subprocess
        self._process = kwargs.get('process', None)
        if not self._process or not isinstance(self._process, asyncio.subprocess.Process):
            raise TypeError('DbgStdio requires an asyncio subprocess.Process instance')

        # Save the transport
        self._transport = TransportStdio(self._process)

        # Initialize the base DAP protocol handler
        super().__init__(module=f'DBIO-{self._id}', transport=self._transport, **kwargs)
