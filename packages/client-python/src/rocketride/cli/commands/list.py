# MIT License
#
# Copyright (c) 2025 RocketRide Corporation
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
RocketRide CLI List Tasks Command Implementation.

This module provides the ListCommand class for listing all active tasks
through the RocketRide CLI. Use this command to view all running tasks
for the authenticated user.

The list command retrieves and displays all active tasks using the
rrext_get_tasks request, providing a comprehensive view of running
pipelines and their current status.

Key Features:
    - List all active tasks for authenticated user
    - Display task information including name, token, source, and status
    - JSON output format option for programmatic use
    - Comprehensive error handling and user feedback

Usage:
    rocketlib list --apikey <key>
    rocketlib list --apikey <key> --json

Components:
    ListCommand: Main command implementation for listing active tasks
"""

import json
from typing import TYPE_CHECKING
from .base import BaseCommand

if TYPE_CHECKING:
    from ..main import RocketRideClient


class ListCommand(BaseCommand):
    """
    Command implementation for listing all active tasks.

    Retrieves and displays all active tasks for the authenticated user
    using the rrext_get_tasks request. Provides both human-readable
    and JSON output formats for different use cases.

    Example:
        ```python
        # Initialize and execute list command
        command = ListCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Task listing with comprehensive information
        - Human-readable and JSON output formats
        - Error handling with clear user feedback
        - No token required (lists all user's tasks)
    """

    def __init__(self, cli, args):
        """
        Initialize ListCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing connection info
        """
        super().__init__(cli, args)

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the list tasks command.

        Retrieves all active tasks for the authenticated user and displays
        them in either human-readable or JSON format based on command options.

        Args:
            client: Connected RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for success, 1 for errors

        Process Flow:
            1. Connect to server if not already connected
            2. Build rrext_get_tasks request
            3. Send request to server
            4. Check for errors in response
            5. Extract tasks from response body
            6. Display tasks in requested format
            7. Handle errors with appropriate feedback
        """
        try:
            # Connect to server if not already connected
            if not self.cli.client.is_connected():
                await self.cli.connect()

            # Build the rrext_get_tasks request
            request = client.build_request(command='rrext_get_tasks')

            # Send the request
            response = await client.request(request)

            # Check for errors
            if client.did_fail(response):
                error_msg = response.get('message', 'Unknown error')
                print(f'Error: {error_msg}')
                return 1

            # Extract tasks from response
            tasks = response.get('body', {}).get('tasks', [])

            # Handle JSON output format
            if hasattr(self.args, 'json') and self.args.json:
                print(json.dumps(tasks, indent=2))
                return 0

            # Display results in human-readable format
            if not tasks:
                print('No active tasks found')
                return 0

            print(f'Found {len(tasks)} active task(s):\n')

            # Display each task with detailed information
            for i, task in enumerate(tasks, 1):
                print(f'Task {i}:')
                print(f'  Name: {task.get("name", "N/A")}')
                print(f'  Token: {task.get("token", "N/A")}')
                print(f'  Source: {task.get("source", "N/A")}')
                print(f'  Status: {task.get("status", "N/A")}')

                description = task.get('description', 'N/A')
                if description and description != 'N/A':
                    print(f'  Description: {description}')

                print()

            return 0

        except Exception as e:
            print(f'Error listing tasks: {e}')
            return 1
