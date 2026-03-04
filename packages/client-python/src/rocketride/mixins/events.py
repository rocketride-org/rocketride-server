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
from typing import Dict, Any, Optional, List
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
        Initialize event handling with optional callback functions.

        Args:
            **kwargs: Configuration including optional event callbacks:
                - on_event: Function to handle general events
                - on_connected: Function called when connected to server
                - on_disconnected: Function called when disconnected
                - on_connect_error: Function called when a connection attempt fails (persist mode)
        """
        super().__init__(**kwargs)
        self._caller_on_event: Optional[EventCallback] = kwargs.get('on_event', None)
        self._caller_on_connected: Optional[ConnectCallback] = kwargs.get('on_connected', None)
        self._caller_on_disconnected: Optional[DisconnectCallback] = kwargs.get('on_disconnected', None)
        self._caller_on_connect_error: Optional[ConnectErrorCallback] = kwargs.get('on_connect_error', None)
        self._caller_on_protocol_message: Optional[Any] = kwargs.get('on_protocol_message', None)
        self._caller_on_debug_message: Optional[Any] = kwargs.get('on_debug_message', None)

    def debug_message(self, msg: str) -> None:
        """Forward debug messages to the user callback (if set) after internal logging."""
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
        Handle incoming events from the RocketRide server.

        Called automatically when events are received from the server. Events
        include progress updates, status changes, completion notifications, and
        other real-time information about your operations.

        Args:
            message: Complete event message with type, body, and metadata

        Event Structure:
            {
                "event": "apaevt_status_upload",  # Event type
                "body": {                         # Event-specific data
                    "action": "write",
                    "filepath": "/path/to/file.pdf",
                    "bytes_sent": 1048576,
                    "file_size": 5242880
                },
                "seq": 123,                       # Sequence number
                "type": "event"                   # Message type
            }

        Common Event Types:
            - apaevt_status_upload: File upload progress
            - apaevt_status_processing: Pipeline processing updates
            - apaevt_status_completion: Operation completion
            - apaevt_status_error: Error notifications

        Example Event Handler:
            async def handle_events(event):
                event_type = event['event']
                body = event['body']

                if event_type == 'apaevt_status_upload':
                    if body['action'] == 'write':
                        progress = (body['bytes_sent'] / body['file_size']) * 100
                        print(f"Upload {body['filepath']}: {progress:.1f}%")
                    elif body['action'] == 'complete':
                        print(f"Upload completed: {body['filepath']}")

            client = RocketRideClient(uri, auth, on_event=handle_events)
        """
        # Extract event information
        event_type = message.get('event', 'unknown')
        event_body = message.get('body', {})
        seq_num = message.get('seq', 0)

        # Forward to VS Code debugger if available
        self._send_vscode_event(event_type=event_type, body=event_body)

        # Call user-provided event handler if available
        if self._caller_on_event is not None:
            try:
                await self._caller_on_event(message)
            except Exception as e:
                # Log errors but don't let user code break the connection
                self.debug_message(f'Error in user event handler for {event_type} (seq {seq_num}): {e}')

    async def set_events(self, token: str, event_types: List[str]) -> None:
        """
        Subscribe to specific types of events from the server.

        Tell the server which events you want to receive. This filters the
        event stream to only include events you're interested in, reducing
        network traffic and processing overhead.

        Args:
            token: Your pipeline or session token for authentication
            event_types: List of event type names to subscribe to

        Raises:
            RuntimeError: If event subscription fails

        Available Event Types:
            - 'apaevt_status_upload': File upload progress and completion
            - 'apaevt_status_processing': Pipeline processing updates
            - 'apaevt_status_completion': Operation completion events
            - 'apaevt_status_error': Error and warning notifications
            - 'apaevt_status_pipeline': Pipeline lifecycle events

        Example:
            # Subscribe to upload and processing events
            await client.set_events(token, [
                'apaevt_status_upload',
                'apaevt_status_processing'
            ])

            # Now upload files and receive progress events
            results = await client.send_files(files, token)

            # Subscribe to all status events
            await client.set_events(token, [
                'apaevt_status_upload',
                'apaevt_status_processing',
                'apaevt_status_completion',
                'apaevt_status_error'
            ])
        """
        # Build event subscription request
        request = self.build_request(
            command='rrext_monitor',
            arguments={'types': event_types},
            token=token,
        )

        # Send to server
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Event subscription failed')
            raise RuntimeError(error_msg)
