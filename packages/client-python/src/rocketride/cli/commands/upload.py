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
RocketRide CLI File Upload Command Implementation.

This module provides the UploadCommand class for uploading files to RocketRide pipelines
through the CLI. Use this command to upload files using either existing task tokens
or by creating new pipeline tasks, with comprehensive file discovery, validation,
progress monitoring, and result analysis.

The upload command handles the complete file upload lifecycle including file discovery
from patterns, validation, progress tracking, error handling, and automatic cleanup
with real-time progress monitoring and detailed result reporting.

Key Features:
    - File discovery from patterns, wildcards, and directories
    - Comprehensive file validation before upload
    - Real-time upload progress monitoring with statistics
    - Support for both existing tasks and new pipeline creation
    - Automatic pipeline lifecycle management and cleanup
    - Detailed error reporting and result analysis
    - Progress bars and throughput calculations

Usage:
    rocketride upload file1.txt file2.txt --token <task_token> --apikey <key>
    rocketride upload *.txt --pipeline_path my_pipeline.json --apikey <key>
    rocketride upload /path/to/directory --token <task_token> --apikey <key>

Components:
    UploadCommand: Main command implementation for file upload operations
"""

import time
import asyncio
from typing import TYPE_CHECKING, Optional, Dict, Any
from .base import BaseCommand
from ..monitors.upload import UploadProgressMonitor
from ..utils.file_utils import find_files, validate_files

if TYPE_CHECKING:
    from ..main import RocketRideClient


class UploadCommand(BaseCommand):
    """
    Command implementation for uploading files to RocketRide pipelines.

    Handle file upload operations with support for both creating new pipeline
    tasks and using existing task tokens. Provide comprehensive file discovery,
    validation, progress monitoring, and result analysis with automatic cleanup
    and detailed error reporting.

    Example:
        ```python
        # Initialize and execute upload command
        command = UploadCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - File pattern discovery with wildcards and directories
        - Pre-upload file validation and accessibility checks
        - Real-time progress monitoring with progress bars
        - Support for both existing tasks and new pipeline creation
        - Automatic pipeline lifecycle management
        - Comprehensive error handling and result analysis
        - Upload statistics and throughput calculations
    """

    def __init__(self, cli, args):
        """
        Initialize UploadCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing file patterns,
                  pipeline or token info, and upload configuration
        """
        super().__init__(cli, args)

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Handle incoming upload progress events from the server.

        Process upload status events to update the progress display with
        current file transfer information, completion status, and error details.

        Args:
            message: DAP event message containing upload progress data
        """
        # If we are shutting down, skip
        if self.monitor is None:
            return

        # Only process upload status events
        if message.get('event') != 'apaevt_status_upload':
            return

        # Update the status
        self.monitor.display_status(message)

    async def on_connecting(self) -> None:
        """
        Handle connection establishment attempts to the server.

        Display connection progress to keep the user informed during
        server connection establishment for upload operations.
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

        Set up event subscriptions for upload progress monitoring
        once the connection to the RocketRide server is established.

        Args:
            connection_info: Optional connection details for logging
        """
        # Subscribe to summary events for status updates
        await self.client.set_events(token=self.args.token, event_types=['summary', 'output'])

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the file upload command with comprehensive lifecycle management.

        Handle the complete upload process including configuration validation,
        file discovery, validation, upload execution, and cleanup with
        comprehensive error handling and progress monitoring throughout.

        Args:
            client: Connected RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for successful upload, 1 for any errors

        Process Flow:
            1. Initialize upload progress monitor
            2. Determine upload configuration (pipeline vs existing token)
            3. Establish connection to RocketRide server
            4. Discover and validate files from patterns
            5. Start pipeline if needed or use existing token
            6. Execute file uploads with progress monitoring
            7. Display final results and statistics
            8. Clean up pipeline if managed by this command
        """
        # Initialize upload monitor
        self.monitor = UploadProgressMonitor(self.cli)

        try:
            # Save the client
            self.client = client

            # Determine upload configuration (pipeline vs existing token)
            pipeline_config = None
            task_token = None
            should_manage_pipeline = False

            # Connection phase
            self.monitor.set_command_status(
                [
                    'Connecting to server...',
                ]
            )
            self.monitor.draw()

            # Establish connection to RocketRide server
            await self.cli.connect()

            if self.args.pipeline_path:
                # Using pipeline file - we'll create and manage the task
                self.monitor.clear()
                self.monitor.set_command_status('Loading pipeline configuration...')
                self.monitor.draw()
                pipeline_config = self.load_pipeline_config(self.args.pipeline_path)
                should_manage_pipeline = True

            elif self.args.token:
                # Using existing task token
                task_token = self.args.token
                self.monitor.clear()
                self.monitor.set_command_status('Using existing task token...')
                self.monitor.draw()
                should_manage_pipeline = False

            else:
                # Configuration error - need either pipeline or token
                self.monitor.clear()
                self.monitor.set_command_status('Configuration error')
                self.monitor.add_box('Upload Error', ['Either --pipeline or --token must be specified'])
                self.monitor.draw()
                return 1

            # File discovery phase
            self.monitor.set_command_status(f'Discovering files from {len(self.args.files)} patterns...')
            self.monitor.draw()

            # Find all the files
            all_files = find_files(self.args.files)
            if not all_files:
                self.monitor.set_command_status('File discovery failed')
                self.monitor.add_box('Upload Error', ['No files found matching the specified patterns!'])
                self.monitor.draw()
                return 1

            # File validation phase
            self.monitor.set_command_status(f'Validating {len(all_files)} files...')
            self.monitor.draw()

            # Separate valid and invalid files
            valid_files, invalid_files = validate_files(all_files)

            # Show validation errors if any
            if invalid_files:
                self.monitor.display_validation_errors(invalid_files)
                await asyncio.sleep(3)  # Give user time to see errors

            # Check if we have any valid files to upload
            if not valid_files:
                self.monitor.set_command_status('File validation failed')
                self.monitor.add_box('Upload Error', ['No valid files found!'])
                self.monitor.draw()
                return 1

            # Pipeline startup phase (if needed)
            if should_manage_pipeline:
                # Say we are string the pipeline
                self.monitor.set_command_status('Starting pipeline...')
                self.monitor.draw()

                # Start it
                response = await self.client.use(
                    pipeline=pipeline_config,
                    threads=self.args.threads,
                    token='UPLOAD_TASK',
                    args=self.args.pipeline_args or [],
                )

                # Grab the token
                task_token = response.get('token', None)

            # Upload execution phase
            self.monitor.set_total_files(len(valid_files))
            self.monitor.draw()

            # Upload the files
            start_time = time.time()
            results = await self.client.send_files(valid_files, task_token)
            end_time = time.time()

            # Display final results
            self.monitor.display_final_results(results, start_time, end_time)

            # Cleanup phase (if we managed the pipeline)
            if should_manage_pipeline and task_token:
                try:
                    # Update the status
                    self.monitor.set_command_status(
                        [
                            'Upload completed successfully',
                            'Terminating pipeline...',
                        ]
                    )
                    self.monitor.draw()

                    # Terminate the pipeline we started
                    await self.client.terminate(task_token)

                    # Display final results
                    self.monitor.display_final_results(results, start_time, end_time)

                except Exception as e:
                    # Non-fatal cleanup error
                    self.monitor.set_command_status(
                        [
                            'Upload completed with error terminating pipeline',
                            f'    {e}',
                        ],
                    )
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
