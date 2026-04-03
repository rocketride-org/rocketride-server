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

from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase

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
        # Map of store subcommand names to handler methods
        self._store_subcommand_handlers = {
            'fs_open': self._store_fs_open,
            'fs_read': self._store_fs_read,
            'fs_write': self._store_fs_write,
            'fs_close': self._store_fs_close,
            'fs_delete': self._store_fs_delete,
            'fs_list_dir': self._store_fs_list_dir,
            'fs_mkdir': self._store_fs_mkdir,
            'fs_stat': self._store_fs_stat,
        }

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
                self.verify_plans(self._account_info, pipeline)

            # Start the task without debugger attachment
            response = await self._server.start_task(
                self._account_info.apikey,
                request,
                self,
                wait_for_running=True,
                client_id=self._account_info.clientid,
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
                self._account_info.apikey,
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
            # Get the argunents
            args = request.get('arguments', {})
            project_id = args.get('projectId', None)
            source = args.get('source', None)

            # Get the task control
            control = self._server.get_task_control_by_project(project_id, source)

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

            # Iterate all tasks and include only those owned by this apikey
            for control in self._server._task_control.values():
                if control.apikey != self._account_info.apikey:
                    continue

                # Get current status for name and status string
                status = control.task.get_status()

                # Read name and description from the flat project
                project = control.pipeline or {}
                pipeline_name = project.get('name') if isinstance(project, dict) else None
                pipeline_desc = project.get('description') if isinstance(project, dict) and isinstance(project.get('description'), str) else None

                # Build the name and description
                name = pipeline_name or control.source
                description = pipeline_desc or 'RocketRide DTC MCP Tool'

                if status.state == 3:
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

    async def on_rrext_store(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_store' command - unified project and template storage operations.

        Central dispatcher for all storage subcommands. Verifies permissions once
        and routes to appropriate subcommand handler.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments: Dict with:
                    - subcommand: One of 'save_project', 'get_project', 'delete_project', 'get_all_projects',
                                  'save_template', 'get_template', 'delete_template', 'get_all_templates'
                    - ...: Additional arguments specific to subcommand

        Returns:
            Dict[str, Any]: DAP response (format depends on subcommand)

        Raises:
            ValueError: If subcommand is missing or unknown
            Exception: If subcommand execution fails
        """
        try:
            # Require store permission (once for all subcommands)
            self.verify_permission('task.store')

            # Extract subcommand
            args = request.get('arguments', {})
            subcommand = args.get('subcommand')

            if not subcommand:
                raise ValueError('Subcommand is required')

            # Dispatch to appropriate handler
            if handler := self._store_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Store operation failed: {str(e)}')
            raise

    def _get_file_store(self):
        """Get a FileStore scoped to the authenticated user."""
        return self._server.store.get_file_store(self._account_info.clientid)

    # =========================================================================
    # Generic File Store Handlers
    # =========================================================================

    async def _store_fs_open(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Open a file handle for reading or writing."""
        fs = self._get_file_store()
        path = args.get('path')
        mode = args.get('mode', 'r')

        if mode == 'w':
            handle_id = await fs.open_write(path, self._connection_id)
            return self.build_response(request, body={'handle': handle_id})
        else:
            result = await fs.open_read(path, self._connection_id)
            return self.build_response(request, body=result)

    async def _store_fs_read(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Read data from an open read handle."""
        fs = self._get_file_store()
        handle = args.get('handle')
        offset = args.get('offset', 0)
        length = args.get('length', 4_194_304)

        # Clamp client-supplied values
        if not isinstance(offset, int) or offset < 0:
            offset = 0
        if not isinstance(length, int) or length <= 0:
            length = 4_194_304
        length = min(length, 4_194_304)

        data = await fs.read_chunk(handle, offset, length, connection_id=self._connection_id)
        response = self.build_response(request, body={'size': len(data)})
        response['arguments'] = {'data': data}
        return response

    async def _store_fs_write(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Write data to an open write handle."""
        fs = self._get_file_store()
        handle = args.get('handle')
        data = args.get('data', b'')
        if isinstance(data, str):
            data = data.encode('utf-8')
        written = await fs.write_chunk(handle, data, connection_id=self._connection_id)
        return self.build_response(request, body={'bytesWritten': written})

    async def _store_fs_close(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Close a file handle."""
        fs = self._get_file_store()
        handle = args.get('handle')
        mode = args.get('mode', 'r')

        if mode == 'w':
            await fs.close_write(handle, connection_id=self._connection_id)
        else:
            await fs.close_read(handle, connection_id=self._connection_id)
        return self.build_response(request)

    async def _store_fs_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Delete file from file store."""
        await self._get_file_store().delete(args.get('path'))
        return self.build_response(request)

    async def _store_fs_list_dir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """List directory contents."""
        result = await self._get_file_store().list_dir(args.get('path', ''))
        return self.build_response(request, body=result)

    async def _store_fs_mkdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Create directory."""
        await self._get_file_store().mkdir(args.get('path'))
        return self.build_response(request)

    async def _store_fs_stat(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Get file/directory metadata."""
        result = await self._get_file_store().stat(args.get('path'))
        return self.build_response(request, body=result)
