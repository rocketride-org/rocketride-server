from typing import Dict, Any, Optional
from . import DAPBase


class DAPConn(DAPBase):
    """
    DAP (Debug Adapter Protocol) connection handler for WebSocket-based debugging clients.

    Manages a single DAP client connection over WebSocket, providing automatic message
    handling and dispatching. Extends DAPBase with WebSocket-specific transport functionality.

    Key Features:
    - Automatic message monitoring with background task
    - Bidirectional communication for DAP messages
    - JSON text and binary message support
    - Error handling and connection lifecycle management
    - Handler dispatch to appropriate methods

    Message Flow:
    1. Client sends DAP request over WebSocket
    2. Background task receives and parses message
    3. Message dispatched to appropriate on_{command} handler
    4. Handler processes request and returns response
    5. Response automatically sent back to client

    Attributes:
        _websocket (WebSocket): The connected WebSocket for this client
        _monitor_task (asyncio.Task): Background task monitoring incoming messages
    """

    def __init__(self, module: str, **kwargs) -> None:
        """
        Initialize the DAP connection with automatic message monitoring.

        Sets up the WebSocket-based DAP connection and starts a background task to
        monitor for incoming messages. The connection is ready to handle DAP
        communication immediately.

        Args:
            module (str): Module identifier for logging and tracking
            **kwargs: Additional configuration parameters passed to DAPBase
        """
        # Initialize base DAP functionality
        super().__init__(module, **kwargs)

    async def on_receive(self, message: Dict[str, Any] = {}) -> None:
        """
        Dispatch a received DAP message to the appropriate handler method.

        Central message routing system that takes parsed DAP messages and dispatches
        them to specific handler methods based on message type and command.

        Handler Resolution Order:
        1. on_{command} method (e.g., on_initialize for "initialize" command)
        2. on_command fallback method (generic request handler)
        3. Default success response (if no handlers found)

        Args:
            message (Dict[str, Any]): The parsed DAP message containing type, command, seq, and arguments
        """
        # Extract message type to determine handling approach
        message_type = message.get('type', '')

        if message_type == 'request':
            # Handle DAP requests (commands from client)
            command = message.get('command', '')

            # Try to find and call appropriate handler method
            handled, response = await self._call_method(message, f'on_{command}', 'on_command')

            if not handled:
                # No handler found - create default success response
                self.debug_message(f'No handler for command: {command}')
                response = self.build_response(message)

            # Send response if handler provided one
            if response is not None:
                await self.send(response)
        else:
            # Handle non-request messages (responses, events, etc.)
            self.debug_message(f'Unhandled message type: {message_type} - {message}')

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a message to the DAP server.

        Must be implemented by concrete client transport classes to handle sending
        messages over their specific transport mechanism.

        Args:
            message (Dict[str, Any]): The DAP message to send to the server
        """
        return await self._transport.send(message)

    async def send_response(self, command: Dict[str, Any], *, body: Optional[Dict[str, Any]] = None) -> None:
        """
        Build and send a successful DAP response message to the client.

        Convenience method that combines response building and transmission for
        successful responses to DAP requests.

        Args:
            command (Dict[str, Any]): The original DAP request message to respond to
            body (Optional[Dict[str, Any]]): Optional response data specific to the command

        Raises:
            Exception: If response building or WebSocket sending fails
        """
        # Build standard DAP response format using base class method
        response = self.build_response(command, body=body)

        # Send the response via WebSocket
        await self.send(response)

    async def send_event(self, event: str, *, id: str = '', body: Optional[Dict[str, Any]] = None) -> None:
        """
        Build and send a DAP event message to the client.

        Events are server-initiated notifications that inform the client about
        state changes, output, or other asynchronous occurrences during debugging.

        Args:
            event (str): The event name as defined by the DAP specification
            id (str): Optional id for event correlation
            body (Optional[Dict[str, Any]]): Event-specific data payload

        Example:
            await self.send_event("output", body={"category": "stdout", "output": "Hello, World!"})
        """
        # Build standard DAP event format using base class method
        message = self.build_event(event, id=id, body=body)

        # Send the event via WebSocket
        await self.send(message)

    async def send_error(self, request: Dict[str, Any], message: str) -> Dict[str, Any]:
        """
        Build and send a DAP error response message to the client.

        Handles failed DAP requests by building a properly formatted error response
        and sending it to the client.

        Args:
            request (Dict[str, Any]): The original DAP request that failed
            message (str): Human-readable error description

        Returns:
            Dict[str, Any]: The error response that was sent

        Raises:
            Exception: If response building or WebSocket sending fails
        """
        # Build standard DAP error response format using base class method
        response = self.build_error(request, message)

        # Send the error response via WebSocket
        await self.send(response)

        # Return the response for potential logging or further processing
        return response
