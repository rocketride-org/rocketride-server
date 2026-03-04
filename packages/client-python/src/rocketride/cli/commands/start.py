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
RocketRide CLI Pipeline Start Command Implementation.

This module provides the StartCommand class for initiating new pipeline executions
through the RocketRide CLI. Use this command to load pipeline configurations, establish
server connections, start pipeline execution, and monitor startup progress.

The start command handles the complete pipeline startup lifecycle including configuration
validation, server connection management, pipeline initialization, and user feedback
with comprehensive error handling and status monitoring.

Key Features:
    - Pipeline configuration loading and validation
    - Server connection establishment with retry logic
    - Real-time startup progress monitoring
    - Task token generation and management
    - Comprehensive error handling and user feedback

Usage:
    rocketride start my_pipeline.json --threads 8 --apikey <key>

Components:
    StartCommand: Main command implementation for pipeline startup operations
"""

from .base import BaseCommand
from typing import TYPE_CHECKING, Optional, Dict, Any
from ..monitors.generic import GenericMonitor

if TYPE_CHECKING:
    from ..main import RocketRideClient


class StartCommand(BaseCommand):
    """
    Command implementation for starting new pipeline executions.

    Handle pipeline startup operations by loading configuration files,
    establishing server connections, and initiating pipeline execution.
    Provide status feedback and return task tokens for monitoring.

    Example:
        ```python
        # Initialize and execute start command
        command = StartCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Configuration file loading with validation
        - Server connection with progress feedback
        - Pipeline execution with parameter passing
        - Real-time status monitoring during startup
        - Task token extraction for subsequent monitoring
        - Comprehensive error handling with user feedback
    """

    def __init__(self, cli, args):
        """
        Initialize StartCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing pipeline path,
                  connection info, and execution parameters
        """
        super().__init__(cli, args)

        # Connection state tracking for auto-reconnection
        self.client: RocketRideClient = None  # Will hold the connected client instance

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle incoming DAP events during pipeline startup.

        Process status update events to provide real-time feedback about
        pipeline initialization progress and execution state changes.

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
            lines = [
                'Starting pipeline execution...',
            ]

            status = body.get('status', '')
            if status:
                lines.append('')
                lines.append(f'    {status}')

            self.monitor.set_command_status(lines)

            # Update the display
            self.monitor.draw()

    async def on_connecting(self) -> None:
        """
        Handle connection establishment attempts to the server.

        Display connection progress and attempt information to keep
        the user informed during server connection process.
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

        Set up event subscriptions and prepare for pipeline execution
        once the connection to the RocketRide server is established.

        Args:
            connection_info: Optional connection details for logging
        """
        # Subscribe to summary events for status updates
        await self.client.set_events(token=self.args.token, event_types=['summary', 'output'])

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the pipeline start command with comprehensive lifecycle management.

        Orchestrate the complete pipeline startup process including configuration
        loading, server connection, pipeline execution, and user feedback with
        comprehensive error handling and progress monitoring.

        Args:
            client: Connected RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for successful startup, 1 for any errors

        Process Flow:
            1. Initialize progress monitor for status display
            2. Load and validate pipeline configuration file
            3. Establish connection to RocketRide server
            4. Start pipeline execution with provided parameters
            5. Extract and display task token for monitoring
            6. Handle errors with appropriate user feedback
        """
        # Initialize generic monitor for status display
        self.monitor = GenericMonitor(self.cli, 'RocketRide Pipeline Management')

        try:
            # Save the client
            self.client = client

            # Configuration loading phase
            self.monitor.set_command_status('Loading pipeline configuration...')
            self.monitor.draw()

            # Load and parse pipeline configuration file
            pipeline_data = self.load_pipeline_config(self.args.pipeline_path)

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
                    'Starting pipeline execution...',
                ]
            )
            self.monitor.draw()

            # Start pipeline execution with provided parameters
            response = await self.client.use(
                pipeline=pipeline_data,  # Pipeline configuration object
                threads=self.args.threads,  # Number of execution threads
                token=self.args.token,  # Optional custom task token
                args=self.args.pipeline_args or [],  # Additional pipeline arguments
            )

            # Extract task token from response
            token = response.get('token', None)

            # Success phase - display results
            execution_lines = [
                'Pipeline execution started successfully',
                '',
                'You may use the following command to monitor status:',
                f'     rocketride status --token {token} --apikey=<your apikey>',
            ]

            self.monitor.set_command_status(execution_lines)
            self.monitor.draw()

            return 0

        except (FileNotFoundError, ValueError) as e:
            # Configuration-related errors (file not found, invalid format, etc.)
            self.monitor.set_command_status(
                [
                    'Configuration error occurred',
                    f'    {str(e)}',
                ]
            )
            self.monitor.draw()
            return 1

        except Exception as e:
            # Unexpected errors during execution
            self.monitor.set_command_status(
                [
                    'Execution error occured',
                    f'    {str(e)}',
                ]
            )
            self.monitor.draw()
            return 1

        finally:
            # Shut off the monitor
            self.monitor = None
