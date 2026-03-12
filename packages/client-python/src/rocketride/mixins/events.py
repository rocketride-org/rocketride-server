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
Event Handling and Real-time Notifications for RocketRide Client.

This module provides event handling capabilities for receiving real-time notifications
from RocketRide operations. Monitor pipeline progress, file uploads, processing status,
and other system events as they happen.

Key Features:
- Real-time event notifications from server
- Progress tracking for long-running operations
- Connection status events
- Custom event handlers for different event types
- Integration with VS Code debugging for development

Usage:
    # Define event handlers
    async def handle_upload_progress(event):
        body = event['body']
        if body['action'] == 'write':
            progress = (body['bytes_sent'] / body['file_size']) * 100
            print(f"Upload progress: {progress:.1f}%")

    # Create client with event handling
    client = RocketRideClient("ws://localhost:8080", "your_api_key", on_event=handle_upload_progress)

    # Subscribe to specific event types
    await client.set_events(token, ['apaevt_status_upload', 'apaevt_status_processing'])
"""

import sys
from typing import Callable, Dict, Any, Optional, List
from ..core import DAPClient
from ..types import EventCallback, ConnectCallback, ConnectErrorCallback, DisconnectCallback


class EventMixin(DAPClient):
    """
    Provides real-time event handling for the RocketRide client.

    This mixin adds the ability to receive and handle real-time events from
    the RocketRide server, including pipeline progress, upload status, processing
    updates, and connection events.

    Event handling allows you to:
    - Monitor progress of long-running operations
    - Respond to status changes in real-time
    - Provide user feedback during processing
    - Handle connection issues gracefully
    - Debug operations with detailed event logs

    Events are delivered asynchronously as they occur on the server, allowing
    your application to remain responsive while operations are running.

    This is automatically included when you use RocketRideClient, and you can
    configure event handlers when creating the client or call set_events()
    to subscribe to specific event types.
    """

    def __init__(
        self,
        **kwargs,
    ):
        """
        Initialize EventMixin and register optional lifecycle and event callbacks.
        
        Parameters:
            **kwargs: Supported optional keyword arguments:
                - on_event: Callable invoked for each received event with the event message.
                - on_connected: Callable awaited when a connection is established; receives connection info (optional).
                - on_disconnected: Callable awaited when the connection is closed; receives (reason, has_error).
                - on_connect_error: Callable awaited when a connection attempt fails; receives an error string.
                - on_protocol_message: Callable invoked with raw protocol packets for inspection or logging.
                - on_debug_message: Callable invoked with formatted debug messages.
        
        Notes:
            - Per-pipe SSE callbacks are stored in the instance mapping `_sse_pipe_callbacks`; use the internal
              registration helpers to manage those callbacks.
        """
        super().__init__(**kwargs)
        self._caller_on_event: Optional[EventCallback] = kwargs.get('on_event', None)
        self._caller_on_connected: Optional[ConnectCallback] = kwargs.get('on_connected', None)
        self._caller_on_disconnected: Optional[DisconnectCallback] = kwargs.get('on_disconnected', None)
        self._caller_on_connect_error: Optional[ConnectErrorCallback] = kwargs.get('on_connect_error', None)
        self._caller_on_protocol_message: Optional[Any] = kwargs.get('on_protocol_message', None)
        self._caller_on_debug_message: Optional[Any] = kwargs.get('on_debug_message', None)
        # Maps pipe_id → SSE callback for pipe-scoped real-time event dispatch
        self._sse_pipe_callbacks: Dict[int, Callable] = {}

    def debug_message(self, msg: str) -> None:
        """
        Forward a debug message to the base logger and, if configured, to the user-provided debug callback.
        
        The message is logged via the superclass implementation and then forwarded to the callback prefixed with "[{msg_type}]: ".
        
        Parameters:
            msg (str): Debug text to log and forward to the callback.
        """
        super().debug_message(msg)
        if self._caller_on_debug_message is not None:
            self._caller_on_debug_message(f'[{self._msg_type}]: {msg}')

    def debug_protocol(self, packet: str) -> None:
        """Forward protocol messages to the user callback (if set) after internal logging."""
        super().debug_protocol(packet)
        if self._caller_on_protocol_message is not None:
            self._caller_on_protocol_message(f'[{self._msg_type}]: {packet}')

    def _send_vscode_event(self, event_type: str, body: Dict[str, Any]) -> None:
        """
        Send events to VS Code debugger if available (for development).

        When running in a VS Code debugging session, this automatically
        forwards RocketRide events to the debugger for enhanced development
        experience and troubleshooting.

        Args:
            event_type: The type of event (e.g., 'apaevt_status_upload')
            body: Event data to send to the debugger
        """
        # Set up VS Code integration on first use
        if not self._dap_attempted:
            self._dap_attempted = True

            try:
                # Check if running under VS Code debugger
                if 'pydevd' not in sys.modules:
                    return

                import pydevd  # type: ignore

                if not hasattr(pydevd, 'send_json_message'):
                    return

                # Set up message sending capability
                self._dap_send = pydevd.send_json_message

            except Exception:
                # Not running under debugger - no problem
                pass

        # Send event to VS Code if available
        if self._dap_send:
            custom_event = {
                'type': 'event',
                'event': event_type,
                'body': body,
            }
            self._dap_send(custom_event)

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle connection established events.

        Called automatically when the client successfully connects to the
        RocketRide server. If you provided an on_connected callback when creating
        the client, it will be called with connection details.

        Args:
            connection_info: Optional connection details (server info, etc.)

        Example:
            async def my_connect_handler(info):
                print(f"Connected to RocketRide server: {info}")

            client = RocketRideClient(uri, auth, on_connected=my_connect_handler)
        """
        if self._caller_on_connected is not None:
            try:
                await self._caller_on_connected(connection_info)
            except Exception as e:
                self.debug_message(f'Error {e} in user connected event handler')
                raise

        await super().on_connected(connection_info)

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle disconnection events.

        Called automatically when the client disconnects from the RocketRide server,
        either gracefully or due to an error. If you provided an on_disconnected
        callback when creating the client, it will be called with disconnection details.

        Args:
            reason: Optional reason for disconnection
            has_error: True if disconnection was due to error, False for graceful shutdown

        Example:
            async def my_disconnect_handler(reason, has_error):
                if has_error:
                    print(f"Connection lost: {reason}")
                else:
                    print("Disconnected gracefully")

            client = RocketRideClient(uri, auth, on_disconnected=my_disconnect_handler)
        """
        if self._caller_on_disconnected is not None:
            try:
                await self._caller_on_disconnected(reason, has_error)
            except Exception as e:
                self.debug_message(f'Error {e} in user disconnected event handler')
                raise

        await super().on_disconnected(reason, has_error)

    async def on_connect_error(self, error: Exception) -> None:
        """
        Handle connection attempt failure.

        Called when a connection or reconnect attempt fails (e.g. in persist mode).
        If you provided an on_connect_error callback when creating the client,
        it will be called with the error message.

        Args:
            error: The exception from the failed connection attempt.

        Example:
            async def my_connect_error_handler(message):
                print(f"Connection failed: {message}")

            client = RocketRideClient(uri, auth, persist=True, on_connect_error=my_connect_error_handler)
        """
        if self._caller_on_connect_error is not None:
            try:
                await self._caller_on_connect_error(str(error))
            except Exception as e:
                self.debug_message(f'Error {e} in user on_connect_error handler')
                raise

        await super().on_connect_error(error)

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle a received server event and dispatch it to VS Code (if available), any registered per-pipe SSE callback, and the user-provided event handler.
        
        Parameters:
            message (Dict[str, Any]): Event message expected to contain at least the keys:
                - 'event': event type string (e.g., 'apaevt_sse', 'apaevt_status_upload')
                - 'body': event-specific payload (a dict)
                - 'seq': optional sequence number
        
        Notes:
            - If the event type is 'apaevt_sse' and a per-pipe callback is registered for the event's 'pipe_id', that callback is awaited.
            - The user-provided on_event callback, if present, is awaited with the full message.
            - Exceptions raised by per-pipe or user callbacks are caught and forwarded to debug_message; they are logged but not propagated to avoid disrupting the event loop.
        """
        # Extract event information
        event_type = message.get('event', 'unknown')
        event_body = message.get('body', {})
        seq_num = message.get('seq', 0)

        # Forward to VS Code debugger if available
        self._send_vscode_event(event_type=event_type, body=event_body)

        # Dispatch pipe-scoped SSE events to the registered DataPipe callback
        if event_type == 'apaevt_sse':
            pipe_id = event_body.get('pipe_id')
            callback = self._sse_pipe_callbacks.get(pipe_id)
            if callback is not None:
                try:
                    await callback(event_body)
                except Exception as e:
                    self.debug_message(f'Error in SSE callback for pipe {pipe_id}: {e}')

        # Call user-provided event handler if available
        if self._caller_on_event is not None:
            try:
                await self._caller_on_event(message)
            except Exception as e:
                # Log errors but don't let user code break the connection
                self.debug_message(f'Error in user event handler for {event_type} (seq {seq_num}): {e}')

    def _register_sse_pipe(self, pipe_id: int, callback: Callable) -> None:
        """
        Register a per-pipe server-sent-events (SSE) callback for the given pipe.
        
        Parameters:
            pipe_id (int): Identifier of the data pipe to associate the callback with.
            callback (Callable): Callable to invoke with SSE event bodies for this pipe.
        """
        self._sse_pipe_callbacks[pipe_id] = callback

    def _unregister_sse_pipe(self, pipe_id: int) -> None:
        """
        Unregister the SSE callback associated with a pipe identifier.
        
        Safely removes the callback for the given pipe if present; no error is raised when the pipe is not registered.
        
        Parameters:
            pipe_id (int): Identifier of the pipe whose SSE callback should be removed.
        """
        self._sse_pipe_callbacks.pop(pipe_id, None)

    async def set_events(self, token: str, event_types: List[str], pipe_id: int = None) -> None:
        """
        Subscribe the client to a set of server event types, optionally scoped to a specific pipe.
        
        Parameters:
            token (str): Authentication token or pipeline session identifier used for the subscription.
            event_types (List[str]): Names of event types to receive from the server.
            pipe_id (int, optional): If provided, scope the subscription to the specified pipe ID.
        
        Raises:
            RuntimeError: If the server responds indicating the subscription failed.
        """
        # Build event subscription request
        arguments: Dict[str, Any] = {'types': event_types}
        if pipe_id is not None:
            arguments['pipeId'] = pipe_id
        request = self.build_request(
            command='rrext_monitor',
            arguments=arguments,
            token=token,
        )

        # Send to server
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Event subscription failed')
            raise RuntimeError(error_msg)
