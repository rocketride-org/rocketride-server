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
TaskCommands: DAP Command Handler for Task Management.

This module implements a Debug Adapter Protocol (DAP) command handler that manages
the lifecycle of computational tasks within a distributed debugging/execution system.
It serves as the command interface layer that processes DAP messages to control
task execution, debugging sessions, and resource management.

Primary Responsibilities:
--------------------------
1. Handles DAP protocol commands for task lifecycle management (launch, execute, attach, terminate)
2. Manages debugging session initialization and capabilities negotiation
3. Provides task execution control (pause, continue, disconnect)
4. Coordinates with a TaskServer to orchestrate backend task engines
5. Maintains DAP-compliant communication with debugging clients

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Works in conjunction with TaskServer for actual task management
- Supports both debugging-enabled ('launch') and debug-free ('execute') task execution
- Handles attachment to existing task sessions for collaborative debugging

Usage Context:
--------------
This is designed for integration with FastAPI applications and serves as the
command processing layer in a task execution and debugging infrastructure.
The actual task execution and management is delegated to the TaskServer.
"""

import os
from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase
from ai.account import account
from ai.account.models import resolve_task_permissions
from rocketride import TASK_STATE

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


class TaskCommands(DAPConn):
    """
    DAP command handler for task lifecycle management and debugging control.

    This class processes Debug Adapter Protocol commands to manage computational
    tasks, handle debugging sessions, and coordinate with backend task engines.
    It acts as the protocol-aware interface layer between DAP clients and the
    underlying task execution system.

    Key Features:
    - DAP-compliant command processing and response handling
    - Task lifecycle management (launch, execute, attach, terminate)
    - Debugging session control (pause, continue, breakpoints)
    - Multi-client task attachment support
    - Error handling and diagnostic messaging

    Attributes:
        _server: Reference to the TaskServer managing actual task instances
        connection_id: Unique identifier for this DAP connection
        transport: Underlying transport mechanism for DAP communication
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new TaskCommands instance.

        Sets up the DAP command handler with a connection to the task management
        server and establishes the communication transport layer.

        Args:
            connection_id (int): Unique identifier for this DAP connection session
            server (TaskServer): The server instance that manages task creation,
                                execution, and resource cleanup
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_execute(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'execute' command to start a task without debugging.

        Similar to 'launch' but specifically designed for non-interactive task
        execution. The task runs to completion without debugger attachment,
        making it suitable for batch processing or automated execution scenarios.

        Args:
            request (Dict[str, Any]): Execute request containing:
                - arguments: Task configuration including apikey for authentication

        Returns:
            Dict[str, Any]: Execute response with task token and initialization event

        Raises:
            Exception: If task creation or execution startup fails
        """
        try:
            # Verify permission
            self.verify_permission('task.control')

            # Verify required pipeline plans
            args = request.get('arguments') or {}
            pipeline = args.get('pipeline')
            if pipeline is not None:
                # Check that the pipeline's required plan is available for this account.
                self.verify_plans(self._account_info, pipeline)

            # Use client-supplied teamId if present, otherwise fall back to defaultTeam.
            team_id = args.get('teamId') or self._account_info.defaultTeam

            # Resolve org_id from the user's single organization.
            org_id = ''
            org = self._account_info.organization
            if org:
                for team in org.get('teams', []):
                    if team.get('id') == team_id:
                        org_id = org.get('id', '')
                        break

            # Build merged environment for pipeline variable resolution.
            # Combines .env → org → team → user secrets (SaaS) or just .env (OSS).
            # Security: only accept ROCKETRIDE_* keys from the caller
            raw_env = args.get('env', {})
            caller_env = {k: v for k, v in raw_env.items() if k.startswith('ROCKETRIDE_')}

            # sys.admin: seed with server RR_* keys mapped to ROCKETRIDE_* so
            # admin pipelines can reference internal secrets via ${ROCKETRIDE_*}.
            # This is the bottom layer — org/team/user secrets override it.
            if 'sys.admin' in (self._account_info.sysPermissions or []):
                merged_env = {'ROCKETRIDE_' + k[3:]: v for k, v in os.environ.items() if k.startswith('RR_')}
            else:
                merged_env = {}

            # Layer org → team → user secrets on top
            merged_env.update(
                await account.get_merged_env(
                    user_id=self._account_info.userId,
                    org_id=org_id,
                    team_id=team_id,
                )
            )
            # Caller-supplied env overrides on top
            merged_env.update(caller_env)

            # Start the task without debugger attachment
            response = await self._server.start_task(
                request,
                self,
                wait_for_running=True,
                client_id=self._account_info.userId,
                user_id=self._account_info.userId,
                team_id=team_id,
                org_id=org_id,
                env=merged_env,
            )

            # Confirm successful task execution startup
            return self.build_response(request, body=response)

        except Exception as e:
            # Log execution failure and re-raise
            self.debug_message(f'Failed to execute task: {str(e)}')
            raise

    async def on_restart(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'restart' command to restart a task.

        Leaves the underlying task execution intact while reinitializing the
        engine pipeline.

        Args:
            request (Dict[str, Any]): Execute request containing:
                - arguments: Task configuration including apikey for authentication

        Returns:
            Dict[str, Any]: Execute response with task token and initialization event

        Raises:
            Exception: If task creation or execution startup fails
        """
        try:
            # Verify permission
            self.verify_permission('task.control')

            # Start the task without debugger attachment
            response = await self._server.restart_task(
                request,
                self,
                wait_for_running=True,
            )

            # Confirm successful task execution startup
            return self.build_response(request, body=response)

        except Exception as e:
            # Log execution failure and restart
            self.debug_message(f'Failed to restart task: {str(e)}')
            raise

    async def on_rrext_get_task_status(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_get_task_status' command to retrieve the current status of a task.

        Retrieves and returns the current status information for the specified task,
        including execution state, progress metrics, errors, and other diagnostic data.
        This is a read-only operation that does not affect the running task.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - apikey (str): API key for authentication
                - token (str): Task token to query status for

        Returns:
            Dict[str, Any]: DAP response with task status in body:
                - name (str): Task name
                - state (int): Current execution state
                - status (str): Human-readable status description
                - startTime (float): Task start timestamp
                - endTime (float, optional): Task completion timestamp
                - completed (bool): Whether task has finished
                - totalCount (int): Total items to process
                - completedCount (int): Items completed
                - failedCount (int): Items that failed
                - errors (List[str]): Error messages
                - warnings (List[str]): Warning messages
                - metrics (Dict): Performance and operational metrics

        Raises:
            Exception: If task retrieval fails or status cannot be obtained
        """
        try:
            # Get the task instance
            task = self.get_task(request, 'task.monitor')

            # Retrieve current task status
            status = task.get_status()

            # Convert status to dictionary format for response
            response = status.model_dump()

            # Return successful response with status data
            return self.build_response(request, body=response)

        except Exception as e:
            # Log status retrieval failure with context
            self.debug_message(f'Failed to get status from task: {str(e)}')

            # Re-raise to let DAP error handling create proper error response
            raise

    async def on_rrext_get_pipeline(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_get_pipeline' command to retrieve the unresolved pipeline for a task.

        Returns the original pipeline dict as stored on the task — placeholders such as
        ${ROCKETRIDE_API_KEY} are NOT substituted, so no secrets are exposed.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - token (str): Task token to query

        Returns:
            Dict[str, Any]: DAP response with pipeline in body:
                - pipeline (Dict): The unresolved pipeline configuration

        Raises:
            Exception: If the task cannot be found or the caller lacks task.monitor permission
        """
        try:
            # Step 1: locate the task — verifies task.monitor permission.
            task = self.get_task(request, 'task.monitor')

            # Step 2: return the unresolved pipeline (${...} placeholders intact).
            return self.build_response(request, body={'pipeline': task._pipeline})

        except Exception as e:
            self.debug_message(f'Failed to get pipeline from task: {str(e)}')
            raise

    async def on_rrext_get_token(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_status' command to retrieve the current status of a task.

        Retrieves and returns the current status information for the specified task,
        including execution state, progress metrics, errors, and other diagnostic data.
        This is a read-only operation that does not affect the running task.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - args (Dict[str, Any]): Additional arguments for the request
                    - projectId (str)): The project id
                    - source (str): The source id

        Returns:
            Dict[str, Any]: DAP response with token
                - token (str): The task token
        Raises:
            Exception: If task does not exist
        """
        try:
            # Verify permission
            self.verify_permission('task.monitor')

            # Get the arguments
            args = request.get('arguments', {})
            project_id = args.get('projectId', None)
            source = args.get('source', None)

            # Get the task control (ownership + permission check inside)
            control = self._server.get_task_control_by_project(
                project_id, source, self._account_info, require='task.monitor'
            )

            # Return successful response with status data
            return self.build_response(
                request,
                body={'token': control.token},
            )

        except Exception as e:
            # Log status retrieval failure with context
            self.debug_message(f'Failed to get status from task: {str(e)}')

            # Re-raise to let DAP error handling create proper error response
            raise

    async def on_rrext_get_tasks(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_get_tasks' command to retrieve list of all active tasks.

        Retrieves and returns the current tasks information for the authenticated user.
        This is a read-only operation that does not affect the running tasks.

        Returns:
            Dict[str, Any]: DAP response containing:
                - tasks: List of task descriptors with:
                    - name: Task name
                    - description: Task description
                    - source: Task source
                    - token: Task token
                    - status: Task status
                    - pipeline: Full pipeline configuration dict
        """
        try:
            # Require monitor permission to list tasks
            self.verify_permission('task.monitor')

            tasks = []

            # Iterate all tasks the caller has access to (own, teammate, or org admin).
            for control in self._server._task_control.values():
                if not resolve_task_permissions(self._account_info, control.teamId):
                    continue

                # Get current status for name and status string
                status = control.task.get_status()

                # Read name and description from the flat project
                project = control.pipeline or {}
                pipeline_name = project.get('name') if isinstance(project, dict) else None
                pipeline_desc = (
                    project.get('description')
                    if isinstance(project, dict) and isinstance(project.get('description'), str)
                    else None
                )

                # Build the name and description; fall back to source/default if not present.
                name = pipeline_name or control.source
                description = pipeline_desc or 'RocketRide DTC MCP Tool'

                # Only include tasks that are actively running — completed or
                # queued tasks are not surfaced to the caller.
                if status.state == TASK_STATE.RUNNING.value:
                    tasks.append(
                        {
                            'name': name,
                            'description': description,
                            'source': control.source,
                            'token': control.token,
                            'status': status.status,
                            'pipeline': control.pipeline,
                        }
                    )

            return self.build_response(request, body={'tasks': tasks})

        except Exception as e:
            # Log and re-raise for standard error handling
            self.debug_message(f'Failed to list tasks: {str(e)}')
            raise
