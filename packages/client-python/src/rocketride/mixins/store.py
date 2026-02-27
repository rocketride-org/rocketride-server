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
Project Storage Management for RocketRide Client.

This module provides project storage capabilities including saving, retrieving,
and managing project pipelines. Projects are stored securely with version control
and atomic operations to prevent conflicts.

Key Features:
- Save and update project pipelines with version control
- Retrieve projects by ID with version metadata
- Delete projects with optional version checking
- List all user projects with summaries
- Atomic operations to prevent race conditions

Usage:
    # Save a new project
    result = await client.save_project(
        project_id="my-project",
        pipeline={"name": "My Pipeline", "components": [...]}
    )

    # Get a project
    project = await client.get_project(project_id="my-project")
    print(f"Version: {project['version']}")

    # Update with version check
    result = await client.save_project(
        project_id="my-project",
        pipeline=updated_pipeline,
        expected_version=project['version']
    )

    # Delete a project
    await client.delete_project(
        project_id="my-project",
        expected_version=project['version']
    )

    # List all projects
    projects = await client.get_all_projects()
    for proj in projects['projects']:
        print(f"{proj['id']}: {proj['name']}")
"""

from typing import Dict, Any, Optional
from ..core import DAPClient


class StoreMixin(DAPClient):
    """
    Provides project storage capabilities for the RocketRide client.

    This mixin adds the ability to save, retrieve, delete, and list project
    pipelines stored on the RocketRide server. All operations are atomic and
    support version control to prevent conflicts when multiple users or
    processes modify the same project.

    Storage operations work with project IDs and pipeline configurations:
    - Projects are stored per-user (automatically isolated by API key)
    - Each save operation returns a version hash
    - Updates require matching version to prevent conflicts
    - Deletions can optionally verify version before removing

    This is automatically included when you use RocketRideClient, so you can
    call methods like client.save_project() and client.get_project() directly.
    """

    def __init__(self, **kwargs):
        """Initialize project storage capabilities."""
        super().__init__(**kwargs)

    async def save_project(
        self,
        project_id: str,
        pipeline: Dict[str, Any],
        expected_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Save or update a project pipeline.

        Stores a project pipeline configuration on the server. If the project
        already exists, it will be updated. Use expected_version to ensure
        you're updating the version you expect (prevents conflicts).

        Args:
            project_id: Unique identifier for the project
            pipeline: Pipeline configuration as a dictionary
            expected_version: Expected current version for atomic updates (optional)
                If provided and doesn't match current version, save fails with CONFLICT error.
                For updates, recommended to auto-fetch or specify explicitly.
                For new projects, omit this parameter.

        Returns:
            Dict containing:
            - success: True if saved successfully (bool)
            - project_id: The project ID that was saved (str)
            - version: New version hash after save (str)

        Raises:
            ValueError: If project_id or pipeline is missing/invalid
            RuntimeError: If save fails due to:
                - CONFLICT: Version mismatch (someone else modified it)
                - STORAGE_ERROR: Server storage problem
                - Other server errors

        Example:
            # Save a new project
            pipeline = {
                "name": "Data Processor",
                "source": "source_1",
                "components": [
                    {"id": "source_1", "provider": "filesystem", "config": {...}}
                ]
            }
            result = await client.save_project("proj-123", pipeline)
            print(f"Saved version: {result['version']}")

            # Update existing project with version check
            existing = await client.get_project("proj-123")
            updated_pipeline = existing['pipeline']
            updated_pipeline['name'] = "Updated Name"

            result = await client.save_project(
                "proj-123",
                updated_pipeline,
                expected_version=existing['version']  # Ensures atomic update
            )

            # Save/overwrite without version check (not recommended for updates)
            result = await client.save_project("proj-123", pipeline)

        Version Control:
            - For NEW projects: Don't provide expected_version
            - For UPDATES: Provide expected_version to prevent conflicts
            - If version mismatch occurs, fetch latest and retry:
                try:
                    await client.save_project(id, pipeline, version)
                except RuntimeError as e:
                    if 'CONFLICT' in str(e):
                        # Fetch latest version and merge changes
                        latest = await client.get_project(id)
                        # ... resolve conflicts ...
                        await client.save_project(id, merged, latest['version'])
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')

        if not pipeline or not isinstance(pipeline, dict):
            raise ValueError('pipeline must be a non-empty dictionary')

        # Build request arguments
        arguments = {
            'subcommand': 'save_project',
            'projectId': project_id,
            'pipeline': pipeline,
        }

        # Add optional version for atomic updates
        if expected_version is not None:
            arguments['expectedVersion'] = expected_version

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error saving project')
            self.debug_message(f'Project save failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Project saved successfully: {project_id}, version: {response_body.get("version")}')
        return response_body

    async def get_project(self, project_id: str) -> Dict[str, Any]:
        """
        Retrieve a project by its ID.

        Fetches the complete pipeline configuration and current version for
        the specified project. Use this before updating to get the current
        version for atomic updates.

        Args:
            project_id: Unique identifier of the project to retrieve

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - pipeline: Complete pipeline configuration (dict)
            - version: Current version hash (str)

        Raises:
            ValueError: If project_id is missing
            RuntimeError: If retrieval fails due to:
                - NOT_FOUND: Project doesn't exist
                - STORAGE_ERROR: Server storage problem
                - Other server errors

        Example:
            # Get a project
            try:
                project = await client.get_project("proj-123")
                print(f"Project: {project['pipeline']['name']}")
                print(f"Version: {project['version']}")

                # Access pipeline components
                for component in project['pipeline']['components']:
                    print(f"  - {component['id']}: {component['provider']}")

            except RuntimeError as e:
                if 'NOT_FOUND' in str(e):
                    print("Project doesn't exist")
                else:
                    print(f"Error: {e}")

        Use Cases:
            # Before updating - get current version
            project = await client.get_project("proj-123")
            pipeline = project['pipeline']
            pipeline['name'] = "Updated"
            await client.save_project("proj-123", pipeline, project['version'])

            # Check if project exists
            try:
                await client.get_project("proj-123")
                print("Project exists")
            except RuntimeError:
                print("Project doesn't exist")
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')

        # Build request
        arguments = {
            'subcommand': 'get_project',
            'projectId': project_id,
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error retrieving project')
            self.debug_message(f'Project retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Project retrieved successfully: {project_id}')
        return response_body

    async def delete_project(
        self,
        project_id: str,
        expected_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Delete a project by its ID.

        Permanently removes a project from storage. Optionally verify the
        version before deletion to ensure you're deleting the version you
        expect (prevents accidental deletion of modified projects).

        Args:
            project_id: Unique identifier of the project to delete
            expected_version: Expected current version for atomic deletion (required)
                If provided and doesn't match, deletion fails with CONFLICT error.
                Recommended to fetch current version before deleting.

        Returns:
            Dict containing:
            - success: True if deleted successfully (bool)
            - message: Confirmation message (str)

        Raises:
            ValueError: If project_id is missing
            RuntimeError: If deletion fails due to:
                - NOT_FOUND: Project doesn't exist
                - CONFLICT: Version mismatch
                - STORAGE_ERROR: Server storage problem
                - Other server errors

        Example:
            # Safe deletion with version check
            project = await client.get_project("proj-123")
            try:
                result = await client.delete_project(
                    "proj-123",
                    expected_version=project['version']
                )
                print("Project deleted successfully")
            except RuntimeError as e:
                if 'CONFLICT' in str(e):
                    print("Project was modified, deletion cancelled")
                elif 'NOT_FOUND' in str(e):
                    print("Project doesn't exist")
                else:
                    print(f"Error: {e}")

            # Delete without version check (not recommended)
            # Note: Server may still require version for existing projects
            result = await client.delete_project("proj-123")

        Warning:
            Deletion is permanent and cannot be undone. Always verify the
            project_id and consider backing up important projects before deletion.

        Version Check:
            - Always provide expected_version for safe deletion
            - If version mismatch occurs, project was modified - verify before retrying
            - If project doesn't exist, deletion fails with NOT_FOUND
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')

        # Build request
        arguments = {
            'subcommand': 'delete_project',
            'projectId': project_id,
        }

        # Add optional version for atomic deletion
        if expected_version is not None:
            arguments['expectedVersion'] = expected_version

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error deleting project')
            self.debug_message(f'Project deletion failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Project deleted successfully: {project_id}')
        return response_body

    async def get_all_projects(self) -> Dict[str, Any]:
        r"""
        List all projects for the current user.

        Retrieves a summary of all projects stored for the authenticated user.
        Each project summary includes the ID, name, and list of data sources.

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - projects: List of project summaries (list of dict)
                Each project contains:
                - id: Project identifier (str)
                - name: Project name from pipeline (str)
                - sources: List of source components (list of dict)
                    Each source contains:
                    - id: Component ID (str)
                    - provider: Provider type (e.g., "filesystem", "s3") (str)
                    - name: Component name (str)
            - count: Total number of projects (int)

        Raises:
            RuntimeError: If retrieval fails due to server errors

        Example:
            # List all projects
            result = await client.get_all_projects()

            print(f"Found {result['count']} projects:")
            for project in result['projects']:
                print(f"\nProject: {project['id']}")
                print(f"  Name: {project['name']}")
                print(f"  Sources:")
                for source in project['sources']:
                    print(f"    - {source['name']} ({source['provider']})")

            # Find specific project
            result = await client.get_all_projects()
            my_project = next(
                (p for p in result['projects'] if p['id'] == 'proj-123'),
                None
            )
            if my_project:
                print(f"Found: {my_project['name']}")

            # Check if user has any projects
            result = await client.get_all_projects()
            if result['count'] == 0:
                print("No projects found")
            else:
                print(f"User has {result['count']} projects")

        Use Cases:
            # Display project list in UI
            projects = await client.get_all_projects()
            for proj in projects['projects']:
                show_in_list(proj['id'], proj['name'])

            # Search for projects by name
            all_projects = await client.get_all_projects()
            matches = [p for p in all_projects['projects']
                      if 'test' in p['name'].lower()]

            # Get project IDs for batch operations
            result = await client.get_all_projects()
            project_ids = [p['id'] for p in result['projects']]
        """
        # Build request
        arguments = {
            'subcommand': 'get_all_projects',
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error listing projects')
            self.debug_message(f'Project list retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        project_count = response_body.get('count', 0)
        self.debug_message(f'Projects retrieved successfully: {project_count} projects')
        return response_body

    # =========================================================================
    # Template Operations (system-wide templates accessible to all users)
    # =========================================================================

    async def save_template(
        self,
        template_id: str,
        pipeline: Dict[str, Any],
        expected_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Save or update a template pipeline (system-wide).

        Templates are stored in a system-wide location accessible to all users.
        They can be used as starting points for creating new projects.

        Args:
            template_id: Unique identifier for the template
            pipeline: Pipeline configuration as a dictionary
            expected_version: Expected current version for atomic updates (optional)

        Returns:
            Dict containing:
            - success: True if saved successfully (bool)
            - template_id: The template ID that was saved (str)
            - version: New version hash after save (str)

        Raises:
            ValueError: If template_id or pipeline is missing/invalid
            RuntimeError: If save fails

        Example:
            # Save a new template
            pipeline = {
                "name": "Data Processing Template",
                "source": "source_1",
                "components": [...]
            }
            result = await client.save_template("tmpl-123", pipeline)
            print(f"Saved version: {result['version']}")
        """
        # Validate inputs
        if not template_id:
            raise ValueError('template_id is required')

        if not pipeline or not isinstance(pipeline, dict):
            raise ValueError('pipeline must be a non-empty dictionary')

        # Build request arguments
        arguments = {
            'subcommand': 'save_template',
            'templateId': template_id,
            'pipeline': pipeline,
        }

        # Add optional version for atomic updates
        if expected_version is not None:
            arguments['expectedVersion'] = expected_version

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error saving template')
            self.debug_message(f'Template save failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Template saved successfully: {template_id}, version: {response_body.get("version")}')
        return response_body

    async def get_template(self, template_id: str) -> Dict[str, Any]:
        """
        Retrieve a template by its ID.

        Args:
            template_id: Unique identifier of the template to retrieve

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - pipeline: Complete pipeline configuration (dict)
            - version: Current version hash (str)

        Raises:
            ValueError: If template_id is missing
            RuntimeError: If retrieval fails (NOT_FOUND, etc.)

        Example:
            template = await client.get_template("tmpl-123")
            print(f"Template: {template['pipeline']['name']}")
        """
        # Validate inputs
        if not template_id:
            raise ValueError('template_id is required')

        # Build request
        arguments = {
            'subcommand': 'get_template',
            'templateId': template_id,
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error retrieving template')
            self.debug_message(f'Template retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Template retrieved successfully: {template_id}')
        return response_body

    async def delete_template(
        self,
        template_id: str,
        expected_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Delete a template by its ID.

        Args:
            template_id: Unique identifier of the template to delete
            expected_version: Expected current version for atomic deletion (optional)

        Returns:
            Dict containing:
            - success: True if deleted successfully (bool)
            - template_id: The deleted template ID (str)

        Raises:
            ValueError: If template_id is missing
            RuntimeError: If deletion fails (NOT_FOUND, CONFLICT, etc.)

        Example:
            template = await client.get_template("tmpl-123")
            result = await client.delete_template(
                "tmpl-123",
                expected_version=template['version']
            )
        """
        # Validate inputs
        if not template_id:
            raise ValueError('template_id is required')

        # Build request
        arguments = {
            'subcommand': 'delete_template',
            'templateId': template_id,
        }

        # Add optional version for atomic deletion
        if expected_version is not None:
            arguments['expectedVersion'] = expected_version

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error deleting template')
            self.debug_message(f'Template deletion failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Template deleted successfully: {template_id}')
        return response_body

    async def get_all_templates(self) -> Dict[str, Any]:
        """
        List all templates (system-wide).

        Retrieves a summary of all templates available in the system.
        Each template summary includes the ID, name, and list of data sources.

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - templates: List of template summaries (list of dict)
                Each template contains:
                - id: Template identifier (str)
                - name: Template name from pipeline (str)
                - sources: List of source components (list of dict)
            - count: Total number of templates (int)

        Raises:
            RuntimeError: If retrieval fails due to server errors

        Example:
            result = await client.get_all_templates()
            print(f"Found {result['count']} templates:")
            for tmpl in result['templates']:
                print(f"  - {tmpl['id']}: {tmpl['name']}")
        """
        # Build request
        arguments = {
            'subcommand': 'get_all_templates',
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error listing templates')
            self.debug_message(f'Template list retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        template_count = response_body.get('count', 0)
        self.debug_message(f'Templates retrieved successfully: {template_count} templates')
        return response_body

    # =========================================================================
    # Log Operations (per-project log files for historical tracking)
    # =========================================================================

    async def save_log(
        self,
        project_id: str,
        source: str,
        contents: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Save a log file for a source run.

        Creates or overwrites a log file in the project's log directory.
        The filename is constructed as <source>-<startTime>.log where startTime
        is extracted from contents['body']['startTime'].

        Args:
            project_id: Project ID
            source: Name of the source
            contents: Log contents dictionary containing body.startTime

        Returns:
            Dict containing:
            - success: True if saved successfully (bool)
            - filename: The log filename that was saved (str)

        Raises:
            ValueError: If parameters are invalid
            RuntimeError: If save fails

        Example:
            log_contents = {
                "type": "event",
                "event": "apaevt_status_update",
                "body": {
                    "source": "source_1",
                    "startTime": 1764337626.6564875,
                    "status": "Completed",
                    "completed": True,
                    ...
                }
            }
            result = await client.save_log("proj-123", "source_1", log_contents)
            print(f"Saved: {result['filename']}")
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if not contents or not isinstance(contents, dict):
            raise ValueError('contents must be a non-empty dictionary')

        # Build request arguments
        arguments = {
            'subcommand': 'save_log',
            'projectId': project_id,
            'source': source,
            'contents': contents,
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error saving log')
            self.debug_message(f'Log save failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Log saved successfully: {response_body.get("filename")}')
        return response_body

    async def get_log(
        self,
        project_id: str,
        source: str,
        start_time: float,
    ) -> Dict[str, Any]:
        """
        Get a log file by source name and start time.

        Args:
            project_id: Project ID
            source: Name of the source
            start_time: Start time of the run

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - contents: The log contents (dict)

        Raises:
            ValueError: If parameters are invalid
            RuntimeError: If log not found or retrieval fails

        Example:
            log = await client.get_log("proj-123", "source_1", 1764337626.6564875)
            print(f"Status: {log['contents']['body']['status']}")
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')
        if not source:
            raise ValueError('source is required')
        if start_time is None:
            raise ValueError('start_time is required')

        # Build request
        arguments = {
            'subcommand': 'get_log',
            'projectId': project_id,
            'source': source,
            'startTime': start_time,
        }

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error retrieving log')
            self.debug_message(f'Log retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        self.debug_message(f'Log retrieved successfully: {project_id}/{source}')
        return response_body

    async def list_logs(
        self,
        project_id: str,
        source: Optional[str] = None,
        page: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        List log files for a project.

        Args:
            project_id: Project ID
            source: Optional source name to filter logs (filters files starting with '<source>-')
            page: Page number (0-indexed). If negative or None, defaults to 0.
                  Page size is 100.

        Returns:
            Dict containing:
            - success: True if retrieved successfully (bool)
            - logs: List of log filenames (list of str)
            - count: Number of logs in this page (int)
            - total_count: Total number of logs (int)
            - page: Current page number (int)
            - total_pages: Total number of pages (int)

        Raises:
            ValueError: If project_id is missing
            RuntimeError: If retrieval fails

        Example:
            # List all logs
            result = await client.list_logs("proj-123")
            print(f"Found {result['total_count']} logs")
            for log in result['logs']:
                print(f"  - {log}")

            # Filter by source
            result = await client.list_logs("proj-123", source="source_1")

            # With pagination
            result = await client.list_logs("proj-123", page=1)
        """
        # Validate inputs
        if not project_id:
            raise ValueError('project_id is required')

        # Build request
        arguments: Dict[str, Any] = {
            'subcommand': 'list_logs',
            'projectId': project_id,
        }

        # Add optional parameters
        if source is not None:
            arguments['source'] = source
        if page is not None:
            arguments['page'] = page

        # Send request to server
        request = self.build_request(command='rrext_store', arguments=arguments)
        response = await self.request(request)

        # Check for errors
        if self.did_fail(response):
            error_msg = response.get('message', 'Unknown error listing logs')
            self.debug_message(f'Log list retrieval failed: {error_msg}')
            raise RuntimeError(error_msg)

        # Extract and return response
        response_body = response.get('body', {})
        log_count = response_body.get('total_count', 0)
        self.debug_message(f'Logs retrieved successfully: {log_count} logs')
        return response_body
