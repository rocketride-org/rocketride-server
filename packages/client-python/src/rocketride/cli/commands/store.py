# MIT License
#
# Copyright (c) 2026 RocketRide Corporation
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
RocketRide CLI Store Command Implementation.

This module provides the StoreCommand class for managing project and template storage
through the RocketRide CLI. It uses the StoreMixin methods from the client
to perform storage operations on the server.

The store command supports atomic operations to prevent concurrent modification
conflicts using version/ETag checking.

Key Features:
    - Save projects with atomic write operations
    - Retrieve projects by ID
    - Delete projects with version checking
    - List all projects for authenticated user
    - Save, retrieve, delete, and list templates (system-wide)
    - Server-side storage with proper authentication

Usage:
    rocketride rrext_store save_project --project-id <id> --project-file <file> --apikey <key>
    rocketride rrext_store get_project --project-id <id> --apikey <key>
    rocketride rrext_store delete_project --project-id <id> --apikey <key>
    rocketride rrext_store get_all_projects --apikey <key>
    rocketride rrext_store save_template --template-id <id> --template-file <file> --apikey <key>
    rocketride rrext_store get_template --template-id <id> --apikey <key>
    rocketride rrext_store delete_template --template-id <id> --apikey <key>
    rocketride rrext_store get_all_templates --apikey <key>

Components:
    StoreCommand: Main command implementation for project and template storage operations
"""

import json
from typing import TYPE_CHECKING
from .base import BaseCommand

if TYPE_CHECKING:
    from ..main import RocketRideClient


class StoreCommand(BaseCommand):
    """
    Command implementation for project storage operations.

    Uses the client's StoreMixin methods to perform storage operations
    with proper authentication and atomic conflict detection.

    Example:
        ```python
        # Initialize and execute store command
        command = StoreCommand(cli, args)
        exit_code = await command.execute(client)
        ```

    Key Features:
        - Server-side storage with authentication
        - Atomic operations with version checking
        - Uses client mixin methods for clean interface
        - Proper error handling and user feedback
    """

    def __init__(self, cli, args):
        """
        Initialize StoreCommand with CLI context and parsed arguments.

        Args:
            cli: CLI instance providing cancellation state and event handling
            args: Parsed command line arguments containing subcommand and options
        """
        super().__init__(cli, args)

        # Map of subcommand names to handler methods
        self._subcommand_handlers = {
            'save_project': self._save_project,
            'get_project': self._get_project,
            'delete_project': self._delete_project,
            'get_all_projects': self._get_all_projects,
            'save_template': self._save_template,
            'get_template': self._get_template,
            'delete_template': self._delete_template,
            'get_all_templates': self._get_all_templates,
            'save_log': self._save_log,
            'get_log': self._get_log,
            'list_logs': self._list_logs,
        }

    def _load_pipeline_from_args(self, file_attr: str, json_attr: str) -> dict:
        """
        Load pipeline JSON from file or string argument.

        Args:
            file_attr: Name of the file argument attribute (e.g., 'project_file')
            json_attr: Name of the JSON string argument attribute (e.g., 'project_json')

        Returns:
            dict: Parsed pipeline configuration

        Raises:
            ValueError: If arguments are invalid or missing
            FileNotFoundError: If specified file doesn't exist
            json.JSONDecodeError: If JSON is invalid
        """
        file_path = getattr(self.args, file_attr, None)
        json_str = getattr(self.args, json_attr, None)

        if file_path:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if not content:
                    raise ValueError(f'Pipeline file is empty: {file_path}')
                pipeline = json.loads(content)
        elif json_str:
            if not isinstance(json_str, str):
                raise ValueError(f'Invalid JSON value (expected string, got {type(json_str).__name__})')
            json_str_stripped = json_str.strip()
            if not json_str_stripped:
                raise ValueError('Pipeline JSON string is empty or contains only whitespace')
            pipeline = json.loads(json_str_stripped)
        else:
            raise ValueError(f'Either --{file_attr.replace("_", "-")} or --{json_attr.replace("_", "-")} is required')

        if not pipeline:
            raise ValueError('Pipeline data cannot be empty')
        if not isinstance(pipeline, dict):
            raise ValueError('Pipeline must be a JSON object')

        return pipeline

    async def execute(self, client: 'RocketRideClient') -> int:
        """
        Execute the store command based on subcommand.

        Routes to the appropriate subcommand handler which uses the
        client's mixin methods for storage operations.

        Args:
            client: Connected RocketRideClient instance for server communication

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        try:
            # Connect to server if not already connected
            if not self.cli.client.is_connected():
                await self.cli.connect()

            # Route to appropriate subcommand handler
            if handler := self._subcommand_handlers.get(self.args.store_subcommand):
                return await handler(client)
            else:
                raise ValueError(f'Unknown store subcommand: {self.args.store_subcommand}')

        except Exception as e:  # noqa: BLE001
            print(f'Error executing store command: {e}')
            return 1

    async def _save_project(self, client: 'RocketRideClient') -> int:
        """
        Save a project using the client's save_project method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        # Load pipeline JSON
        pipeline = self._load_pipeline_from_args('project_file', 'project_json')

        # Get expected version (from args or auto-fetch)
        expected_version = getattr(self.args, 'expected_version', None)
        if not expected_version:
            # Auto-fetch current version if updating existing project
            try:
                existing = await client.get_project(project_id)
                expected_version = existing.get('version')
            except RuntimeError:
                # Project doesn't exist yet - no version to check
                pass

        # Call client mixin method
        result = await client.save_project(project_id=project_id, pipeline=pipeline, expected_version=expected_version)

        # Display success
        print(json.dumps(result, indent=2))
        return 0

    async def _get_project(self, client: 'RocketRideClient') -> int:
        """
        Get a project using the client's get_project method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        # Call client mixin method
        result = await client.get_project(project_id)

        # Display result
        print(json.dumps(result, indent=2))
        return 0

    async def _delete_project(self, client: 'RocketRideClient') -> int:
        """
        Delete a project using the client's delete_project method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        # Get expected version if provided
        expected_version = getattr(self.args, 'expected_version', None)

        # Call client mixin method
        result = await client.delete_project(project_id=project_id, expected_version=expected_version)

        # Display success
        print(f'Project {project_id} deleted successfully')
        if result.get('message'):
            print(result['message'])
        return 0

    async def _get_all_projects(self, client: 'RocketRideClient') -> int:
        """
        List all projects using the client's get_all_projects method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        # Call client mixin method
        result = await client.get_all_projects()

        # Display results
        print(json.dumps(result, indent=2))
        return 0

    # =========================================================================
    # Template Operations (system-wide templates accessible to all users)
    # =========================================================================

    async def _save_template(self, client: 'RocketRideClient') -> int:
        """
        Save a template using the client's save_template method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        template_id = self.args.template_id
        if not template_id:
            raise ValueError('Template ID is required')

        # Load pipeline JSON
        pipeline = self._load_pipeline_from_args('template_file', 'template_json')

        # Get expected version (from args or auto-fetch)
        expected_version = getattr(self.args, 'expected_version', None)
        if not expected_version:
            # Auto-fetch current version if updating existing template
            try:
                existing = await client.get_template(template_id)
                expected_version = existing.get('version')
            except RuntimeError:
                # Template doesn't exist yet - no version to check
                pass

        # Call client mixin method
        result = await client.save_template(template_id=template_id, pipeline=pipeline, expected_version=expected_version)

        # Display success
        print(json.dumps(result, indent=2))
        return 0

    async def _get_template(self, client: 'RocketRideClient') -> int:
        """
        Get a template using the client's get_template method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        template_id = self.args.template_id
        if not template_id:
            raise ValueError('Template ID is required')

        # Call client mixin method
        result = await client.get_template(template_id)

        # Display result
        print(json.dumps(result, indent=2))
        return 0

    async def _delete_template(self, client: 'RocketRideClient') -> int:
        """
        Delete a template using the client's delete_template method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        template_id = self.args.template_id
        if not template_id:
            raise ValueError('Template ID is required')

        # Get expected version if provided
        expected_version = getattr(self.args, 'expected_version', None)

        # Call client mixin method
        result = await client.delete_template(template_id=template_id, expected_version=expected_version)

        # Display success
        print(f'Template {template_id} deleted successfully')
        if result.get('message'):
            print(result['message'])
        return 0

    async def _get_all_templates(self, client: 'RocketRideClient') -> int:
        """
        List all templates using the client's get_all_templates method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        # Call client mixin method
        result = await client.get_all_templates()

        # Display results
        print(json.dumps(result, indent=2))
        return 0

    # =========================================================================
    # Log Operations (per-project log files for historical tracking)
    # =========================================================================

    async def _save_log(self, client: 'RocketRideClient') -> int:
        """
        Save a log file using the client's save_log method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        source = self.args.source
        if not source:
            raise ValueError('Source is required')

        # Load contents JSON
        contents_json = getattr(self.args, 'contents_json', None)
        if not contents_json:
            raise ValueError('--contents-json is required')

        contents = json.loads(contents_json)

        # Call client mixin method
        result = await client.save_log(
            project_id=project_id,
            source=source,
            contents=contents,
        )

        # Display success
        print(json.dumps(result, indent=2))
        return 0

    async def _get_log(self, client: 'RocketRideClient') -> int:
        """
        Get a log file using the client's get_log method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        source = self.args.source
        if not source:
            raise ValueError('Source is required')

        start_time = getattr(self.args, 'start_time', None)
        if start_time is None:
            raise ValueError('Start time is required')

        # Convert to float
        start_time = float(start_time)

        # Call client mixin method
        result = await client.get_log(
            project_id=project_id,
            source=source,
            start_time=start_time,
        )

        # Display result
        print(json.dumps(result, indent=2))
        return 0

    async def _list_logs(self, client: 'RocketRideClient') -> int:
        """
        List log files using the client's list_logs method.

        Returns:
            Exit code: 0 for success, 1 for errors
        """
        project_id = self.args.project_id
        if not project_id:
            raise ValueError('Project ID is required')

        # Get optional parameters
        source = getattr(self.args, 'source', None)
        page = getattr(self.args, 'page', None)
        if page is not None:
            page = int(page)

        # Call client mixin method
        result = await client.list_logs(
            project_id=project_id,
            source=source,
            page=page,
        )

        # Display results
        print(json.dumps(result, indent=2))
        return 0
