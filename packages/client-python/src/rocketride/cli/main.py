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
Main CLI Class and Entry Point for RocketRide Command-Line Tool.

This module provides the primary interface for the RocketRide command-line tool,
handling argument parsing, command routing, signal management, and event
forwarding. Use this as the main entry point for all RocketRide CLI operations
including pipeline management, file uploads, status monitoring, and task control.

The CLI supports multiple commands with comprehensive argument parsing, graceful
signal handling, automatic reconnection, and event-driven communication with
the RocketRide server through WebSocket connections.

Key Features:
    - Multi-command CLI with comprehensive argument parsing
    - Graceful signal handling for clean interruption
    - Event-driven communication with automatic reconnection
    - Command routing with standardized error handling
    - Environment variable support for common parameters
    - Cross-platform compatibility and robust error recovery

Usage:
    python main.py start my_pipeline.json --threads 8 --uri http://server:5565
    python main.py upload *.txt --token <token> --uri http://server:5565
    python main.py status --token <token> --uri http://server:5565

Components:
    RocketRideCLI: Main CLI class with command routing and lifecycle management
    main: Entry point function for the CLI application
"""

import os
import sys
import signal
import argparse
import asyncio
import time
from typing import Dict, Any, List, Optional

from .commands.start import StartCommand
from .commands.upload import UploadCommand
from .commands.status import StatusCommand
from .commands.stop import StopCommand
from .commands.events import EventsCommand
from .commands.list import ListCommand
from .commands.store import StoreCommand

try:
    # Try importing from installed package first
    from rocketride import RocketRideClient
except ImportError:
    # Fall back to local development path
    from rocketride import RocketRideClient


class RocketRideCLI:
    """
    Main CLI class with command routing.

    Provides the primary interface for the RocketRide command-line tool, handling
    argument parsing, command routing, signal management, and event forwarding.
    Supports multiple commands including pipeline start, file upload, status
    monitoring, task termination, and event monitoring.

    Example:
        ```python
        # Create and run CLI
        cli = RocketRideCLI()
        exit_code = await cli.run()
        ```

    Key Features:
        - Comprehensive argument parsing with subcommands
        - Graceful signal handling for clean shutdown
        - Event-driven communication with server
        - Automatic reconnection handling
        - Command lifecycle management
        - Environment variable integration
    """

    def __init__(self):
        """
        Initialize RocketRideCLI with default values and signal handlers.

        Sets up the CLI instance with empty state and configures signal handlers
        for graceful shutdown on interrupt signals.

        Initialization:
            - Configures signal handlers for clean interruption
            - Initializes connection state tracking
            - Sets up command and client instance variables
            - Prepares event handling system
        """
        # Parsed command line arguments - populated by setup_parser()
        self.args = None

        # WebSocket URI for server connection - constructed from host/port args
        self.uri = ''

        # Current command being processed
        self.command = None

        # Cancellation flag for graceful shutdown - set by signal handlers
        self._cancelled = False

        # Configure signal handlers for clean interrupt handling
        self._setup_signal_handlers()

        # Connection time we started the .connect function
        self._connect_start = 0

        # RocketRideClient instance for server communication
        self.client: RocketRideClient = None  # Will hold the connected client instance

    async def _on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle DAP events and forward to current command.

        Receives events from the RocketRideClient and forwards them to the currently
        active command's monitor for display or processing.

        Args:
            message: DAP event message containing event type and data

        Event Flow:
            1. Receive event from RocketRideClient
            2. Check if command has event handler
            3. Forward event to command's on_event method
            4. Command processes event for display/action
        """
        # Forward event to active command if one exists
        if self.command and hasattr(self.command, 'on_event'):
            await self.command.on_event(message)

    async def _on_connecting(self) -> None:
        """
        Issue an on connecting to the command handler.

        Notifies the current command that a connection attempt is in progress,
        allowing commands to display appropriate connection status to users.
        """
        # Forward event to active command if one exists
        if self.command and hasattr(self.command, 'on_connecting'):
            await self.command.on_connecting()

    async def _on_connected(self, connection_info: Optional[str] = None) -> None:
        """
        Issue an on connected to the command handler.

        Notifies the current command that connection has been established,
        with a minimum delay to ensure users can see connection status updates.

        Args:
            connection_info: Optional connection details for logging
        """
        # Forward event to active command if one exists
        if self.command and hasattr(self.command, 'on_connected'):
            # Allow at least 2 seconds to see any popup
            current = time.time()
            delay = max(0, 2 - (current - self._connect_start))

            # Just in case...
            if delay > 2:
                delay = 2

            # Sleep on it...
            await asyncio.sleep(delay)

            # Signal disconnected
            await self.command.on_connected(connection_info)

    async def _on_disconnecting(self) -> None:
        """
        Issue an on disconnecting to the command handler.

        Notifies the current command that disconnection is in progress,
        allowing commands to display appropriate status during shutdown.
        """
        # Forward event to active command if one exists
        if self.command and hasattr(self.command, 'on_disconnecting'):
            await self.command.on_disconnecting()

    async def _on_disconnected(self, reason: Optional[str] = None, has_error: bool = False) -> None:
        """
        Issue an on disconnected to the command handler.

        Notifies the current command that connection has been lost,
        providing reason and error status for appropriate user feedback.

        Args:
            reason: Optional description of disconnection cause
            has_error: Whether disconnection was due to an error
        """
        # Forward event to active command if one exists
        if self.command and hasattr(self.command, 'on_disconnected'):
            await self.command.on_disconnected(reason, has_error)

    async def connect(self) -> None:
        """
        Connect.

        Establishes connection to the RocketRide server with proper event
        notification to the current command for status display.
        """
        # Issue on connecting event
        await self._on_connecting()

        self._connect_start = time.time()

        # Establish connection to the server
        await self.client.connect()

    def cancel(self) -> None:
        """
        Mark CLI as cancelled.

        Sets the cancellation flag that commands can check to stop execution
        gracefully when the user interrupts the process.

        Usage:
            Called by signal handlers or when graceful shutdown is needed
            to allow commands to clean up resources and exit cleanly.
        """
        self._cancelled = True

    def is_cancelled(self) -> None:
        """
        Check if CLI is cancelled.

        Returns:
            bool: True if cancellation has been requested, False otherwise

        Usage:
            Commands should check this regularly to respond to user
            interruption requests and perform graceful shutdown.
        """
        return self._cancelled

    def _setup_signal_handlers(self) -> None:
        """
        Set up signal handlers for graceful shutdown.

        Configures SIGINT handler to set cancellation flag when user presses Ctrl+C,
        allowing commands to shut down cleanly rather than terminating abruptly.

        Signal Handling:
            - SIGINT (Ctrl+C): Sets cancellation flag for graceful shutdown
            - Preserves existing signal handlers where appropriate
            - Cross-platform signal handling support
        """

        def signal_handler(signum, frame):
            """Handle interrupt signals by marking CLI as cancelled."""
            self.cancel()

        # Register handler for keyboard interrupt (Ctrl+C)
        signal.signal(signal.SIGINT, signal_handler)

    def _parse_event_types(self, event_types_str: str) -> List[str]:
        """
        Parse comma-separated event types string into list.

        Converts a comma-separated string of event type names into a clean list
        of uppercase event type strings, filtering out empty entries.

        Args:
            event_types_str: Comma-separated string of event types

        Returns:
            List[str]: Clean list of uppercase event type names

        Processing:
            - Splits on commas and removes whitespace
            - Converts to uppercase for consistency
            - Filters out empty strings from extra commas
            - Returns empty list for None/empty input
        """
        # Handle empty or None input
        if not event_types_str:
            return []

        # Split by comma and clean up whitespace, convert to uppercase
        event_types = [s.strip().upper() for s in event_types_str.split(',')]

        # Filter out empty strings that might result from extra commas
        event_types = [et for et in event_types if et]

        return event_types

    def setup_parser(self) -> argparse.ArgumentParser:
        """
        Set up the argument parser with subcommands.

        Creates and configures the main argument parser with all supported
        subcommands (start, upload, status, stop, events) and their respective
        arguments and options.

        Returns:
            argparse.ArgumentParser: Configured parser ready for parse_args()

        Subcommands:
            - start: Launch new pipeline execution
            - upload: Upload files to existing or new pipeline
            - status: Monitor task execution status
            - stop: Terminate running task
            - events: Monitor task events with filtering
        """
        # Create main parser with description and help text
        parser = argparse.ArgumentParser(
            description='RocketRide Pipeline and File Management CLI',
            epilog='Use "rocketride <command> --help" for command-specific help',
        )

        # Create subparser for individual commands
        subparsers = parser.add_subparsers(dest='command', help='Available commands', metavar='COMMAND')

        def add_common_args(subparser):
            """
            Add common arguments shared across all commands.

            Args:
                subparser: Subparser to add common arguments to
            """
            # Server connection argument
            subparser.add_argument(
                '--uri',
                default=os.getenv('ROCKETRIDE_URI', 'https://cloud.rocketride.ai'),
                help='RocketRide server URI (default: %(default)s)',
            )

            # Authentication argument with environment variable fallback
            subparser.add_argument(
                '--apikey',
                default=os.getenv('ROCKETRIDE_APIKEY'),
                help='API key for authentication',
            )

            # Task token argument with environment variable fallback
            subparser.add_argument(
                '--token',
                default=os.getenv('ROCKETRIDE_TOKEN'),
                help='Optional existing task token',
            )

        # Start command - launches new pipeline execution
        start_parser = subparsers.add_parser('start', help='Start a new pipeline')
        add_common_args(start_parser)

        # Pipeline file as positional argument with environment fallback
        start_parser.add_argument(
            'pipeline_path',
            nargs='?',
            default=os.getenv('ROCKETRIDE_PIPELINE'),
            help='Path to .pipeline file (or set ROCKETRIDE_PIPELINE env var)',
        )

        # Execution configuration options
        start_parser.add_argument(
            '--threads',
            type=int,
            default=4,
            help='Number of threads (default: %(default)s)',
        )

        # Additional pipeline arguments passed through
        start_parser.add_argument(
            '--args',
            dest='pipeline_args',
            nargs=argparse.REMAINDER,
            help='Additional pipeline arguments',
        )

        # Upload command - uploads files to existing or new pipeline
        upload_parser = subparsers.add_parser('upload', help='Upload files')
        add_common_args(upload_parser)

        # Pipeline file for creating new task if no token provided
        upload_parser.add_argument(
            '--pipeline_path',
            default=os.getenv('ROCKETRIDE_PIPELINE'),
            help='Pipeline file to start new task',
        )

        # Thread configuration for concurrent uploads
        upload_parser.add_argument(
            '--threads',
            type=int,
            default=4,
            help='Number of threads (default: %(default)s)',
        )

        # Files to upload - supports multiple files, wildcards, directories
        upload_parser.add_argument(
            'files',
            nargs='+',
            help='Files, wildcards, or directories to upload',
        )

        # Additional pipeline arguments for new task creation
        upload_parser.add_argument(
            '--args',
            dest='pipeline_args',
            nargs=argparse.REMAINDER,
            help='Additional pipeline arguments',
        )

        # Status command - monitors task execution status
        status_parser = subparsers.add_parser('status', help='Monitor task status continuously')
        add_common_args(status_parser)

        # Stop command - terminates running task
        stop_parser = subparsers.add_parser('stop', help='Stop a running task')
        add_common_args(stop_parser)

        # Events command - monitors task events with configurable types
        events_parser = subparsers.add_parser('events', help='Monitor all events for a task')
        add_common_args(events_parser)

        # Event types as optional positional argument
        events_parser.add_argument(
            'event_types',
            nargs='?',
            help='Comma-separated list of event types (e.g., DETAIL,SUMMARY,OUTPUT or ALL)',
        )

        # Log file option for events command
        events_parser.add_argument(
            '--log',
            help='Optional log file to write all events (e.g., --log=events.log)',
        )

        # List command - lists all active tasks
        list_parser = subparsers.add_parser('list', help='List all active tasks')
        add_common_args(list_parser)

        # Optional JSON output format
        list_parser.add_argument(
            '--json',
            action='store_true',
            help='Output results in JSON format',
        )

        # Store command - manages project storage
        # Create a parent parser with common args that will be inherited by subcommands
        store_common_parser = argparse.ArgumentParser(add_help=False)
        add_common_args(store_common_parser)

        store_parser = subparsers.add_parser('apaext_store', help='Manage project storage', parents=[store_common_parser])

        # Create subparser for store subcommands
        store_subparsers = store_parser.add_subparsers(
            dest='store_subcommand',
            help='Storage operations',
            metavar='STORE_COMMAND',
        )

        # save_project subcommand (inherits common args from parent)
        save_project_parser = store_subparsers.add_parser(
            'save_project',
            help='Save a project to storage',
            parents=[store_common_parser],
        )
        save_project_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID',
        )
        save_project_parser.add_argument(
            '--expected-version',
            help='Expected version for atomic update (optional)',
        )
        save_project_group = save_project_parser.add_mutually_exclusive_group(required=True)
        save_project_group.add_argument(
            '--project-file',
            help='Path to pipeline JSON file',
        )
        save_project_group.add_argument(
            '--project-json',
            help='Pipeline JSON as string',
        )

        # get_project subcommand (inherits common args from parent)
        get_project_parser = store_subparsers.add_parser(
            'get_project',
            help='Get a project from storage',
            parents=[store_common_parser],
        )
        get_project_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID to retrieve',
        )

        # delete_project subcommand (inherits common args from parent)
        delete_project_parser = store_subparsers.add_parser(
            'delete_project',
            help='Delete a project from storage',
            parents=[store_common_parser],
        )
        delete_project_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID to delete',
        )
        delete_project_parser.add_argument(
            '--expected-version',
            help='Expected version for atomic delete (required)',
        )

        # get_all_projects subcommand (inherits common args from parent)
        store_subparsers.add_parser(
            'get_all_projects',
            help='List all projects for authenticated user',
            parents=[store_common_parser],
        )

        # =====================================================================
        # Template subcommands (system-wide templates accessible to all users)
        # =====================================================================

        # save_template subcommand (inherits common args from parent)
        save_template_parser = store_subparsers.add_parser(
            'save_template',
            help='Save a template to storage (system-wide)',
            parents=[store_common_parser],
        )
        save_template_parser.add_argument(
            '--template-id',
            required=True,
            help='Template ID',
        )
        save_template_parser.add_argument(
            '--expected-version',
            help='Expected version for atomic update (optional)',
        )
        save_template_group = save_template_parser.add_mutually_exclusive_group(required=True)
        save_template_group.add_argument(
            '--template-file',
            help='Path to pipeline JSON file',
        )
        save_template_group.add_argument(
            '--template-json',
            help='Pipeline JSON as string',
        )

        # get_template subcommand (inherits common args from parent)
        get_template_parser = store_subparsers.add_parser(
            'get_template',
            help='Get a template from storage',
            parents=[store_common_parser],
        )
        get_template_parser.add_argument(
            '--template-id',
            required=True,
            help='Template ID to retrieve',
        )

        # delete_template subcommand (inherits common args from parent)
        delete_template_parser = store_subparsers.add_parser(
            'delete_template',
            help='Delete a template from storage',
            parents=[store_common_parser],
        )
        delete_template_parser.add_argument(
            '--template-id',
            required=True,
            help='Template ID to delete',
        )
        delete_template_parser.add_argument(
            '--expected-version',
            help='Expected version for atomic delete (optional)',
        )

        # get_all_templates subcommand (inherits common args from parent)
        store_subparsers.add_parser(
            'get_all_templates',
            help='List all templates (system-wide)',
            parents=[store_common_parser],
        )

        # =====================================================================
        # Log subcommands (per-project log files for historical tracking)
        # =====================================================================

        # save_log subcommand (inherits common args from parent)
        save_log_parser = store_subparsers.add_parser(
            'save_log',
            help='Save a log file for a source run',
            parents=[store_common_parser],
        )
        save_log_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID',
        )
        save_log_parser.add_argument(
            '--source',
            required=True,
            help='Source name',
        )
        save_log_parser.add_argument(
            '--contents-json',
            required=True,
            help='Log contents JSON as string (must contain body.startTime)',
        )

        # get_log subcommand (inherits common args from parent)
        get_log_parser = store_subparsers.add_parser(
            'get_log',
            help='Get a log file by source and start time',
            parents=[store_common_parser],
        )
        get_log_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID',
        )
        get_log_parser.add_argument(
            '--source',
            required=True,
            help='Source name',
        )
        get_log_parser.add_argument(
            '--start-time',
            required=True,
            type=float,
            help='Start time of the run (float)',
        )

        # list_logs subcommand (inherits common args from parent)
        list_logs_parser = store_subparsers.add_parser(
            'list_logs',
            help='List log files for a project',
            parents=[store_common_parser],
        )
        list_logs_parser.add_argument(
            '--project-id',
            required=True,
            help='Project ID',
        )
        list_logs_parser.add_argument(
            '--source',
            help='Optional source name to filter logs',
        )
        list_logs_parser.add_argument(
            '--page',
            type=int,
            help='Page number (0-indexed, page size is 100)',
        )

        return parser

    async def run(self) -> int:
        """
        Define main entry point for the CLI.

        Parses command line arguments, validates required parameters,
        routes to appropriate command implementation, and handles errors.

        Returns:
            int: Exit code (0 for success, 1 for error)

        Execution Flow:
            1. Parse command line arguments and validate
            2. Perform command-specific validation
            3. Create RocketRideClient with event handlers
            4. Route to appropriate command implementation
            5. Execute command and return exit code
            6. Handle errors and cleanup
        """
        # Parse command line arguments using configured parser
        parser = self.setup_parser()
        self.args = parser.parse_args()

        # Show help if no command specified
        if not self.args.command:
            parser.print_help()
            return 1

        # Validate required authentication
        if not self.args.apikey:
            print('Error: API key is required. Use --apikey or set ROCKETRIDE_APIKEY environment variable')
            return 1

        # Command-specific validation and preprocessing
        if self.args.command == 'start' and not self.args.pipeline_path:
            # Start command requires pipeline file
            print('Error: Pipeline file is required for start command')
            return 1

        elif self.args.command in ['status', 'stop', 'events'] and not self.args.token:
            # These commands require existing task token
            print(f'Error: Token is required for {self.args.command} command')
            return 1

        elif self.args.command == 'list':
            # List command doesn't require token (lists all user's tasks)
            pass

        elif self.args.command == 'apaext_store':
            # Store command requires store_subcommand
            if not hasattr(self.args, 'store_subcommand') or not self.args.store_subcommand:
                print('Error: Store subcommand is required (save_project, get_project, delete_project, get_all_projects, save_template, get_template, delete_template, get_all_templates, save_log, get_log, list_logs)')
                return 1

        elif self.args.command == 'upload' and not self.args.pipeline_path and not self.args.token:
            # Upload needs either pipeline file to create task or existing token
            print('Error: Either --pipeline_path or --token must be specified for upload command')
            return 1

        elif self.args.command == 'events':
            # Parse event types (no validation - let server handle it)
            try:
                # Convert comma-separated string to list of event types
                event_types_list = self._parse_event_types(self.args.event_types)
                if not event_types_list:
                    print('Error: At least one event type must be specified')
                    return 1

                # Store parsed event types for the command to use
                self.args.parsed_event_types = event_types_list

            except Exception as e:
                print(f'Error parsing event types: {e}')
                return 1

        # Construct URI from command line argument
        self.uri = self.args.uri

        try:
            # Create RocketRideClient instance with event handlers
            self.client = RocketRideClient(
                uri=self.uri,
                auth=self.args.apikey,  # Authentication for server access
                on_event=self._on_event,  # Forward events to CLI event handler
                on_connected=self._on_connected,  # Connection established callback
                on_disconnected=self._on_disconnected,  # Connection lost callback
            )

            # Route to appropriate command implementation
            command_map = {
                'start': StartCommand,
                'upload': UploadCommand,
                'status': StatusCommand,
                'stop': StopCommand,
                'events': EventsCommand,
                'list': ListCommand,
                'apaext_store': StoreCommand,
            }

            if self.args.command in command_map:
                # Create and execute the appropriate command
                command_class = command_map[self.args.command]

                # Allocate the command processor
                self.command = command_class(self, self.args)

                # Execute the command and return its exit code
                status = await self.command.execute(self.client)

                # Disconnect the client if connected
                await self.client.disconnect()

                # And return our final status
                return status
            else:
                # Unknown command - should not happen due to argparse validation
                print(f'Unknown command: {self.args.command}')
                return 1

        except KeyboardInterrupt:
            # Handle user interruption gracefully
            print('\nOperation interrupted by user')
            return 1

        except Exception as e:
            # Handle unexpected errors
            print(f'Unexpected Error: {e}')
            return 1

        finally:
            # Always mark as cancelled for cleanup
            self.cancel()


def main() -> None:
    """
    Entry point for the CLI application.

    Creates RocketRideCLI instance, runs it with asyncio, and handles
    top-level exceptions and exit codes.

    Usage:
        This function serves as the main entry point when the module
        is executed directly or installed as a command-line tool.

    Error Handling:
        - Keyboard interruption: Clean exit with user message
        - Other exceptions: Error message and non-zero exit code
        - Normal completion: Exit with command's return code
    """
    try:
        # Create CLI instance and run with asyncio
        cli = RocketRideCLI()
        exit_code = asyncio.run(cli.run())
        sys.exit(exit_code)

    except KeyboardInterrupt:
        # Handle keyboard interrupt at top level
        print('\n\nOperation interrupted by user')

    except Exception as e:
        # Handle any other top-level exceptions
        print(f'\nOperation failed: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
