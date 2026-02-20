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
RocketRide CLI Task Events Monitoring Command Implementation.

This module provides the EventsCommand class for monitoring all task events with
configurable event type filtering through the RocketRide CLI. Use this command to
monitor real-time events, debug task execution, analyze processing flows, and
track detailed task behavior with comprehensive event logging and display.

The events command provides live monitoring of all task events with timestamp
tracking, event filtering, scrollable history, detailed event data display,
and optional file logging for debugging and analysis purposes with automatic
reconnection handling.

Key Features:
    - Real-time event monitoring with live updates and timestamps
    - Configurable event type filtering (DETAIL, SUMMARY, OUTPUT, etc.)
    - Optional file logging for persistent event storage and analysis
    - Scrollable event history with automatic pruning
    - Detailed event data display with structured formatting
    - Automatic reconnection handling for network interruptions
    - Event correlation and indexing for analysis
    - Comprehensive error handling and graceful recovery

Usage:
    rocketride events SUMMARY,OUTPUT --token <task_token> --apikey <key>
    rocketride events ALL --token <task_token> --apikey <key> --log events.log
    rocketride events DETAIL --token <task_token> --apikey <key> --log /path/to/events.json

Components:
    EventsCommand: Main command implementation for event monitoring operations
"""

import asyncio
import json
import aiofiles
from datetime import datetime
from typing import TYPE_CHECKING, Optional, Dict, Any
from .base import BaseCommand
from ..monitors.events import EventsMonitor

if TYPE_CHECKING:
    from ..main import RocketRideClient


class EventsCommand(BaseCommand):
    """
    Command implementation for monitoring task events with configurable filtering.

    Monitor all events for a specified task with configurable event type filtering,
    real-time display updates, event history management, optional file logging,
    and automatic reconnection handling for comprehensive task event analysis and debugging.

    Example:
        ```python
        # Initialize and execute events monitoring with logging
        command = EventsCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Configurable event type filtering for focused monitoring
        - Real-time event processing with timestamp tracking
        - Optional file logging for persistent event storage
        - Scrollable event history with automatic size management
        - Detailed event data formatting and display
        - Automatic reconnection on connection failures
        - Event correlation with indexing for analysis
        - Comprehensive error handling and recovery
    """

    def __init__(self, cli, args):
        """
        Initialize EventsCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing token, event types,
                  log file path, and connection configuration
        """
        super().__init__(cli, args)

        # Connection state tracking for auto-reconnection
        self._attempt = 0  # Number of reconnection attempts for display
        self.client: RocketRideClient = None  # Will hold the connected client instance

        # Event storage and management
        self.events_log = []  # List of event entries with timestamps
        self.max_events = 25  # Maximum events to keep in memory
        self.index = 0  # The relative index of this event

        # File logging configuration
        self.log_file = None  # File handle for logging events
        self.log_filename = getattr(args, 'log', None)  # Log file path from args

    async def _initialize_logging(self) -> bool:
        """
        Initialize file logging if log filename is provided.

        Creates or opens the log file for writing events and handles
        any file system errors that may occur during initialization.

        Returns:
            bool: True if logging was successfully initialized or not needed,
                  False if there was an error setting up logging

        File Format:
            Events are logged as JSON objects, one per line, with timestamp
            and complete event data for analysis and debugging.
        """
        if not self.log_filename:
            return True

        try:
            # Open log file in append mode with UTF-8 encoding
            self.log_file = await aiofiles.open(self.log_filename, 'a', encoding='utf-8')

            # Write initialization marker to log
            init_entry = {'timestamp': datetime.now().isoformat(), 'event_type': 'LOG_INIT', 'message': f'Event logging initialized for token {self.args.token}', 'event_types': self.args.event_types}
            await self.log_file.write(json.dumps(init_entry) + '\n')
            await self.log_file.flush()

            return True

        except Exception as e:
            # Handle file system errors gracefully
            if self.monitor:
                self.monitor.add_box('Logging Error', [f'Failed to initialize log file: {str(e)}'])
                self.monitor.draw()
            else:
                print(f'Error: Failed to initialize log file {self.log_filename}: {e}')
            return False

    async def _log_event_to_file(self, event_entry: Dict[str, Any]) -> None:
        """
        Write an event entry to the log file if logging is enabled.

        Formats the event as JSON and writes it to the log file with
        error handling for file system issues.

        Args:
            event_entry: Complete event entry with timestamp and message data
        """
        if not self.log_file:
            return

        try:
            # Create log entry with full event data
            log_entry = {'timestamp': event_entry['timestamp'], 'iso_timestamp': datetime.now().isoformat(), 'index': event_entry['index'], 'event': event_entry['message']}

            # Write to file as JSON line
            await self.log_file.write(json.dumps(log_entry) + '\n')
            await self.log_file.flush()

        except Exception as e:
            # Handle logging errors without stopping event monitoring
            if self.monitor:
                self.monitor.add_box('Logging Error', [f'Failed to write to log file: {str(e)}'])

    async def _finalize_logging(self) -> None:
        """
        Clean up file logging resources and write completion marker.

        Closes the log file handle and writes a completion marker
        to indicate the end of the logging session.
        """
        if not self.log_file:
            return

        try:
            # Write completion marker to log
            completion_entry = {'timestamp': datetime.now().isoformat(), 'event_type': 'LOG_COMPLETE', 'message': f'Event logging completed. Total events logged: {self.index}', 'total_events': self.index}
            await self.log_file.write(json.dumps(completion_entry) + '\n')
            await self.log_file.flush()

            # Close the file handle
            await self.log_file.close()
            self.log_file = None

        except Exception:
            # Ignore errors during cleanup
            pass

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle incoming events and add them to the display log and file log.

        Process new DAP events by adding timestamps, storing in event log,
        managing log size limits, writing to file if enabled, and triggering
        display refresh for real-time event monitoring and analysis.

        Args:
            message: DAP event message containing event type and data
        """
        # Create timestamp for this event (millisecond precision)
        timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]

        # Store event with timestamp for display
        event_entry = {'timestamp': timestamp, 'message': message, 'index': self.index}
        self.events_log.append(event_entry)

        # Write to log file if enabled
        await self._log_event_to_file(event_entry)

        # Increase the index for next event
        self.index += 1

        # Maintain log size limit by removing oldest events
        if len(self.events_log) > self.max_events:
            self.events_log = self.events_log[-self.max_events :]

        # If we are shutting down, skip display update
        if self.monitor is None:
            return

        # Refresh display with new event
        self.monitor.display_events(events_log=self.events_log, total_received=self.index)

    async def on_connecting(self) -> None:
        """
        Handle connection establishment attempts with retry feedback.

        Display connection progress including retry attempt counts to
        keep users informed during connection establishment or recovery
        for event monitoring sessions.
        """
        # If we are shutting down, skip
        if self.monitor is None:
            return

        # Show connecting status with attempt count
        self.monitor.connecting(self.cli.uri, self._attempt)
        self.monitor.draw()

    async def on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Handle successful connection and initialize event monitoring.

        Set up event subscriptions, reset connection counters, and initialize
        the event monitoring display once connected to the RocketRide server.

        Args:
            connection_info: Optional connection details for logging
        """
        # Mark connection as established
        self._attempt = 0

        # If we are shutting down, skip
        if self.monitor is None:
            return

        try:
            # Subscribe to events using the specified event types
            await self.client.set_events(token='*', event_types=self.args.parsed_event_types)

            # Prepare command status messages
            status_messages = [f'Token: {self.args.token}', f'Event Types: {self.args.event_types}', 'Events monitoring active...']

            # Add log file info if logging is enabled
            if self.log_filename:
                status_messages.append(f'Logging to: {self.log_filename}')

            # Update monitor display with active monitoring status
            self.monitor.set_command_status(status_messages)

            # Start displaying events in the monitor UI
            self.monitor.display_events(self.events_log)

        except Exception as e:
            # Handle errors during event subscription setup
            self.monitor.set_command_status('Failed to initialize events')
            self.monitor.add_box('Initialization Error', [str(e)])
            self.monitor.draw()

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute continuous event monitoring with automatic reconnection.

        Run the main event monitoring loop that validates arguments, sets up
        monitoring, handles connection lifecycle, initializes file logging,
        and manages automatic reconnection on connection failures with
        comprehensive error handling.

        Args:
            client: RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for successful completion, 1 for errors

        Process Flow:
            1. Validate required token and event type parameters
            2. Initialize events monitoring display
            3. Set up file logging if requested
            4. Enter main monitoring loop with auto-reconnection
            5. Handle connection establishment and retries
            6. Maintain monitoring session until cancelled
            7. Handle graceful shutdown and cleanup
        """
        # Initialize the events monitor for display and event handling
        self.monitor = EventsMonitor(self.cli, self.args.token, self.args.event_types)

        try:
            # Validate required token parameter
            if not self.args.token:
                print('Error: --token is required for events command')
                return 1

            # Validate required event types parameter
            if self.args.parsed_event_types is None:
                print('Error: event types (numeric) is required for events command')
                return 1

            # Initialize file logging if specified
            if not await self._initialize_logging():
                return 1

            # Store the client instance for event callbacks
            self.client = client

            # Main monitoring loop with auto-reconnection
            while not self.cli.is_cancelled():
                # Check if we need to establish or re-establish connection
                if not self.cli.client.is_connected():
                    try:
                        # Attempt to create client and connect
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

                # Small delay to prevent busy loop while connected
                await asyncio.sleep(0.1)

            return 0

        except KeyboardInterrupt:
            # Handle user interruption gracefully
            print('\n\nStopping monitoring...')
            return 0

        except Exception as e:
            # Handle unexpected errors
            if self.monitor:
                self.monitor.set_command_status(
                    [
                        'Monitoring error occurred',
                        f'    {str(e)}',
                    ]
                )
                self.monitor.draw()
            else:
                print(f'Error: {e}')
            return 1

        finally:
            # Clean up file logging
            await self._finalize_logging()

            # Shut down the monitor
            self.monitor = None
