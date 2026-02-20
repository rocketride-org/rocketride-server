# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
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
RocketRide CLI Task Termination Command Implementation.

This module provides the StopCommand class for gracefully terminating running tasks
through the RocketRide CLI. Use this command to stop pipeline executions, cancel
processing operations, and clean up running tasks with proper status feedback
and error handling.

The stop command handles task termination with server communication, progress
monitoring, and user feedback to ensure tasks are stopped cleanly without
leaving resources in inconsistent states.

Key Features:
    - Graceful task termination with server communication
    - Real-time termination progress monitoring
    - Comprehensive error handling and user feedback
    - Server connection management with status updates
    - Task validation and confirmation before termination

Usage:
    rocketride stop --token <task_token> --apikey <key>

Components:
    StopCommand: Main command implementation for task termination operations
"""

from .base import BaseCommand
from typing import TYPE_CHECKING, Optional, Dict, Any
from ..monitors.generic import GenericMonitor

if TYPE_CHECKING:
    from ..main import RocketRideClient


class StopCommand(BaseCommand):
    """
    Command implementation for terminating running tasks.

    Handle task termination operations by validating task tokens, establishing
    server connections, sending termination requests, and providing user feedback
    throughout the termination process with comprehensive error handling.

    Example:
        ```python
        # Initialize and execute stop command
        command = StopCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Task token validation before termination
        - Server connection with progress feedback
        - Graceful task termination with confirmation
        - Real-time status monitoring during termination
        - Comprehensive error handling and user feedback
    """

    def __init__(self, cli, args):
        """
        Initialize StopCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing token and connection info
        """
        super().__init__(cli, args)

        # Connection state tracking for auto-reconnection
        self.client: RocketRideClient = None  # Will hold the connected client instance

    async def on_event(self, message: Dict[str, Any]):
        """
        Handle incoming DAP events during task termination.

        Process status update events to provide real-time feedback about
        task termination progress and execution state changes.

        Args:
            message: DAP event message containing event type and status data
        """
        # If we are shutting down, skip
        if self.monitor is None:
            return

        # Only process status update events
        if message.get('event') == 'apaevt_status_update':
            body = message.get('body', {})
            # Execution phase
            self.monitor.set_command_status(
                [
                    'Starting pipeline execution...',
                    f'   {body.get("status", "Unknown status")}',
                ]
            )

            # Update the display
            self.monitor.draw()

    async def on_connecting(self) -> None:
        """
        Handle connection establishment attempts to the server.

        Display connection progress to keep the user informed during
        server connection establishment for task termination.
        """
        # If we are shutting down, skip
        if not self.monitor:
            return

        # Show connecting status with attempt count
        self.monitor.connecting(self.cli.uri)
        self.monitor.draw()

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle successful server connection establishment.

        Set up event subscriptions and prepare for task termination
        once the connection to the RocketRide server is established.

        Args:
            connection_info: Optional connection details for logging
        """
        # Subscribe to summary events for status updates
        await self.client.set_events(token=self.args.token, event_types=['summary', 'output'])

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the task termination command with comprehensive validation.

        Validate the task token, establish server connection, send termination
        request, and provide user feedback throughout the termination process
        with comprehensive error handling and status monitoring.

        Args:
            client: Connected RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for successful termination, 1 for any errors

        Process Flow:
            1. Validate required task token parameter
            2. Initialize progress monitor for status display
            3. Establish connection to RocketRide server
            4. Send task termination request
            5. Display termination confirmation
            6. Handle errors with appropriate user feedback
        """
        self.monitor = GenericMonitor(self.cli, 'RocketRide Pipeline Management')
        try:
            # Save the client
            self.client = client

            # Make sure we have a token
            if not self.args.token:
                print('Error: --token is required for stop command')
                return 1

            # Connection phase
            self.monitor.set_command_status(
                [
                    'Connecting to server...',
                ]
            )
            self.monitor.draw()

            # Establish connection to RocketRide server
            await self.cli.connect()

            # Execution phase
            self.monitor.clear()
            self.monitor.set_command_status(
                [
                    f'Terminating task {self.args.token}',
                ]
            )
            self.monitor.draw()

            # Terminate the task
            await self.client.terminate(self.args.token)

            # Success phase - display results
            stop_lines = ['Pipeline has been stopped']

            self.monitor.set_command_status(stop_lines)
            self.monitor.draw()

            return 0

        except Exception as e:
            # Unexpected errors during execution
            self.monitor.set_command_status(
                [
                    'Stop error occured',
                    f'    {str(e)}',
                ]
            )
            self.monitor.draw()
            return 1

        finally:
            # Shut off the monitor
            self.monitor = None
