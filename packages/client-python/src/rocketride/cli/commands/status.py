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
RocketRide CLI Task Status Monitoring Command Implementation.

This module provides the StatusCommand class for continuous monitoring of task execution
status through the RocketRide CLI. Use this command to track pipeline progress, view
processing statistics, monitor errors and warnings, and maintain real-time visibility
into task execution with automatic reconnection handling.

The status command provides comprehensive task monitoring with automatic reconnection,
event subscription management, graceful error recovery, and detailed status displays
including pipeline state, processing metrics, and error reporting.

Key Features:
    - Real-time task status monitoring with live updates
    - Automatic reconnection handling for network interruptions
    - Comprehensive status display with metrics and statistics
    - Error and warning tracking with detailed reporting
    - Processing progress tracking with rates and completion data
    - Graceful handling of connection failures and recovery

Usage:
    rocketride status --token <task_token> --apikey <key>

Components:
    StatusCommand: Main command implementation for task status monitoring
"""

import asyncio
from typing import TYPE_CHECKING, Dict, Any, Optional
from .base import BaseCommand
from ..monitors.status import StatusMonitor

if TYPE_CHECKING:
    from ..main import RocketRideClient


class StatusCommand(BaseCommand):
    """
    Command implementation for continuous task status monitoring.

    Provide real-time monitoring of task execution status with automatic
    reconnection handling, event subscription management, and graceful
    error recovery. Display comprehensive status information including
    pipeline state, processing statistics, and error messages.

    Example:
        ```python
        # Initialize and execute status monitoring
        command = StatusCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Continuous status monitoring with live updates
        - Automatic reconnection on connection failures
        - Real-time event processing and display
        - Comprehensive status information display
        - Graceful error handling and recovery
        - User-friendly progress and statistics reporting
    """

    def __init__(self, cli, args):
        """
        Initialize StatusCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing token and connection info
        """
        super().__init__(cli, args)

        # Connection state tracking for auto-reconnection
        self._attempt = 0  # Number of reconnection attempts for display
        self.client: RocketRideClient = None  # Will hold the connected client instance

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle incoming task status update events.

        Process status update events to refresh the monitoring display
        with current task information, metrics, and execution state.

        Args:
            message: DAP event message containing status update data
        """
        # If we are shutting down, skip
        if not self.monitor:
            return

        # Only process status update events
        if message.get('event') == 'apaevt_status_update':
            status = message.get('body', {})
            self.monitor.display_status(status)

    async def on_connecting(self) -> None:
        """
        Handle connection establishment attempts with retry feedback.

        Display connection progress including retry attempt counts to
        keep users informed during connection establishment or recovery.
        """
        # If we are shutting down, skip
        if not self.monitor:
            return

        # Show connecting status with attempt count
        self.monitor.connecting(self.cli.uri, self._attempt)
        self.monitor.draw()

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle successful connection establishment and setup monitoring.

        Initialize the monitoring display, reset connection counters,
        and subscribe to task events for real-time status updates.

        Args:
            connection_info: Optional connection details for logging
        """
        # If we are shutting down, skip
        if not self.monitor:
            return

        # Reset attempt counter on successful connection
        self._attempt = 0

        # Initialize display with empty status
        self.monitor.display_status({})

        # Subscribe to summary events for status updates
        await self.client.set_events(token=self.args.token, event_types=['summary'])

    async def on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Handle connection loss and prepare for reconnection.

        Reset the monitoring display and prepare for automatic
        reconnection attempts when the server connection is lost.

        Args:
            reason: Optional description of disconnection cause
            has_error: Whether disconnection was due to an error
        """
        # If we are shutting down, skip
        if not self.monitor:
            return

        # Initialize display with empty status
        self.monitor.display_status({})

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute continuous task status monitoring with automatic reconnection.

        Run the main monitoring loop that validates arguments, sets up monitoring,
        handles connection lifecycle, and manages automatic reconnection on
        connection failures with comprehensive error handling.

        Args:
            client: RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for successful completion, 1 for errors

        Process Flow:
            1. Validate required token parameter
            2. Initialize status monitoring display
            3. Enter main monitoring loop with auto-reconnection
            4. Handle connection establishment and retries
            5. Maintain monitoring session until cancelled
            6. Handle graceful shutdown and cleanup
        """
        # Initialize status monitor for display
        self.monitor = StatusMonitor(self.cli, self.args.token)

        try:
            # Validate required token parameter
            if not self.args.token:
                print('Error: --token is required for status command')
                return 1

            # Store the client instance for event callbacks
            self.client = client

            # Main monitoring loop with auto-reconnection
            while not self.cli.is_cancelled():
                # Check if we need to establish or re-establish connection
                if not self.cli.client.is_connected():
                    try:
                        # Attempt the connection
                        await self.cli.connect()

                    except Exception:
                        # Connection failed - increment attempt counter and retry after delay
                        self._attempt += 1

                        # Delay up to 2.5 seconds
                        iteration_count = 0
                        while not self.cli.is_cancelled() and iteration_count < 25:
                            await asyncio.sleep(0.1)
                            iteration_count += 1
                        continue

                # Monitoring interval while connected
                await asyncio.sleep(1)

            return 0

        except KeyboardInterrupt:
            # Handle user interruption gracefully
            print('\n\nStopping monitoring...')
            return 0

        except Exception as e:
            # Handle unexpected errors
            self.monitor.set_command_status(
                [
                    'Status monitoring error occurred',
                    f'    {str(e)}',
                ]
            )
            self.monitor.draw()
            return 1

        finally:
            # Shut off the monitor
            self.monitor = None
