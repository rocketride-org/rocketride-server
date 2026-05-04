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

from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase
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
        # Map of store subcommand names to handler methods.
        # Populated here so new subcommands can be added without touching the
        # dispatcher logic in on_rrext_store.
        self._store_subcommand_handlers = {
            'fs_open': self._store_fs_open,
            'fs_read': self._store_fs_read,
            'fs_write': self._store_fs_write,
            'fs_close': self._store_fs_close,
            'fs_delete': self._store_fs_delete,
            'fs_list_dir': self._store_fs_list_dir,
            'fs_mkdir': self._store_fs_mkdir,
            'fs_rmdir': self._store_fs_rmdir,
            'fs_stat': self._store_fs_stat,
            'fs_rename': self._store_fs_rename,
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
                # Check that the pipeline's required plan is available for this account.
                self.verify_plans(self._account_info, pipeline)

            # Resolve org_id from the user's default team.
            # Walk the organizations/teams tree to find which org owns the
            # session's defaultTeam so it can be passed to start_task.
            org_id = ''
            for org in self._account_info.organizations or []:
                for team in org.get('teams', []):
                    if team.get('id') == self._account_info.defaultTeam:
                        org_id = org.get('id', '')
                        break
                if org_id:
                    break

            # Start the task without debugger attachment
            response = await self._server.start_task(
                self._account_info.userToken,
                request,
                self,
                wait_for_running=True,
                client_id=self._account_info.userId,
                user_id=self._account_info.userId,
                team_id=self._account_info.defaultTeam,
                org_id=org_id,
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
                self._account_info.userToken,
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

            # Iterate all tasks and include only those owned by this user.
            # Match on userId so tasks started with any team key are visible.
            caller_user_id = self._account_info.userId
            for control in self._server._task_control.values():
                if control.userId != caller_user_id:
                    # Skip tasks belonging to other users.
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

            # Dispatch to appropriate handler using the pre-built lookup dict.
            # The walrus operator assigns the handler if found; None triggers else.
            if handler := self._store_subcommand_handlers.get(subcommand):
                return await handler(request, args)
            else:
                raise ValueError(f'Unknown subcommand: {subcommand}')

        except Exception as e:
            self.debug_message(f'Store operation failed: {str(e)}')
            raise

    def _get_file_store(self):
        """
        Get a FileStore scoped to the authenticated user.

        Returns:
            FileStore: A file-store instance that isolates all paths under
                the current user's storage namespace.
        """
        # Scope the file store to the calling user so users cannot access each
        # other's files through the store API.
        return self._server.store.get_file_store(self._account_info.userId)

    # =========================================================================
    # Generic File Store Handlers
    # =========================================================================

    async def _store_fs_open(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Open a file handle for reading or writing.

        For write mode (``mode='w'``) the backend creates a new write handle and
        returns its ID.  For read mode (default) the backend opens the file,
        validates it exists, and returns metadata alongside the handle ID.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``path``.  Optional ``mode``
                (``'r'`` or ``'w'``, defaults to ``'r'``).

        Returns:
            Dict[str, Any]: DAP response.
                Write mode: ``body.handle`` — the new write handle ID.
                Read mode:  result from ``fs.open_read`` (includes handle + metadata).
        """
        fs = self._get_file_store()
        path = args.get('path')
        mode = args.get('mode', 'r')

        if mode == 'w':
            # Create a write handle; the connection_id is used to tie the handle
            # lifetime to this connection so it is cleaned up on disconnect.
            handle_id = await fs.open_write(path, self._connection_id)
            return self.build_response(request, body={'handle': handle_id})
        else:
            # Open for reading; returns handle ID plus file metadata (size, etc.).
            result = await fs.open_read(path, self._connection_id)
            return self.build_response(request, body=result)

    async def _store_fs_read(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Read data from an open read handle.

        Clamps ``offset`` and ``length`` to safe values before forwarding to the
        backend so that a misbehaving client cannot request an unbounded read.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``handle``.  Optional ``offset``
                (default 0) and ``length`` (default and max 4 MiB).

        Returns:
            Dict[str, Any]: DAP response with ``body.size`` (bytes read) and
                ``arguments.data`` (the raw bytes).
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        offset = args.get('offset', 0)
        length = args.get('length', 4_194_304)

        # Clamp client-supplied values to safe defaults.
        # Negative or non-integer offsets are reset to 0.
        if not isinstance(offset, int) or offset < 0:
            offset = 0
        # Non-positive or non-integer lengths are reset to the default chunk size.
        if not isinstance(length, int) or length <= 0:
            length = 4_194_304
        # Cap the length at 4 MiB to prevent memory exhaustion from large reads.
        length = min(length, 4_194_304)

        # Read the chunk from the file store backend.
        data = await fs.read_chunk(handle, offset, length, connection_id=self._connection_id)

        # Build the response: body carries the byte count; arguments carries the
        # raw data separately so the protocol can handle binary payloads correctly.
        response = self.build_response(request, body={'size': len(data)})
        response['arguments'] = {'data': data}
        return response

    async def _store_fs_write(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Write data to an open write handle.

        Accepts both ``bytes`` and ``str`` data; strings are UTF-8 encoded before
        being forwarded to the backend.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``handle``.  Optional ``data``
                (bytes or str, defaults to empty bytes).

        Returns:
            Dict[str, Any]: DAP response with ``body.bytesWritten`` containing the
                number of bytes actually written.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        data = args.get('data', b'')

        # Normalise string data to bytes so the backend always receives bytes.
        if isinstance(data, str):
            data = data.encode('utf-8')

        # Write the chunk and return the actual byte count confirmed by the backend.
        written = await fs.write_chunk(handle, data, connection_id=self._connection_id)
        return self.build_response(request, body={'bytesWritten': written})

    async def _store_fs_close(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Close a file handle.

        Dispatches to the correct close method based on the handle mode so that
        the backend can flush write buffers for write handles.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``handle``.  Optional ``mode``
                (``'r'`` or ``'w'``, defaults to ``'r'``).

        Returns:
            Dict[str, Any]: Empty success DAP response.
        """
        fs = self._get_file_store()
        handle = args.get('handle')
        mode = args.get('mode', 'r')

        if mode == 'w':
            # Flush and close a write handle; triggers any finalisation (e.g. S3 upload).
            await fs.close_write(handle, connection_id=self._connection_id)
        else:
            # Release a read handle and free associated resources.
            await fs.close_read(handle, connection_id=self._connection_id)
        return self.build_response(request)

    async def _store_fs_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete file from file store.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``path`` — the file to delete.

        Returns:
            Dict[str, Any]: Empty success DAP response.
        """
        # Delegate deletion to the user-scoped file store.
        await self._get_file_store().delete(args.get('path'))
        return self.build_response(request)

    async def _store_fs_list_dir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        List directory contents.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Optional ``path`` — directory to list
                (defaults to the root of the user's store, i.e. ``''``).

        Returns:
            Dict[str, Any]: DAP response with directory listing as the body.
        """
        # Delegate to the file store; default to the root path if not specified.
        result = await self._get_file_store().list_dir(args.get('path', ''))
        return self.build_response(request, body=result)

    async def _store_fs_mkdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create directory.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``path`` — the directory to create.

        Returns:
            Dict[str, Any]: Empty success DAP response.
        """
        # Create the directory in the user-scoped file store.
        await self._get_file_store().mkdir(args.get('path'))
        return self.build_response(request)

    async def _store_fs_rmdir(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Remove directory.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``path`` (non-empty string). Optional
                ``recursive`` (strict bool; any non-bool value is rejected rather than
                coerced). If ``True`` the directory and all its contents are removed;
                if ``False`` the call fails when the directory is non-empty.

        Returns:
            Dict[str, Any]: Empty success DAP response, or a DAP error response if
                ``path`` is missing/empty or ``recursive`` is not a bool.
        """
        # Validate path is a non-empty string before touching the store — the
        # FileStore layer rejects empty paths, but an early error here produces
        # a cleaner DAP-level message.
        path = args.get('path')
        if not isinstance(path, str) or not path:
            return self.build_error(request, 'rmdir requires a non-empty "path" string')

        # Accept only an explicit bool for ``recursive`` — avoid silently enabling
        # recursive deletion when the client sends a non-bool truthy value (e.g.
        # a string or a dict).
        recursive = args.get('recursive', False)
        if not isinstance(recursive, bool):
            return self.build_error(request, 'rmdir "recursive" must be a boolean')

        # Remove the directory; pass the recursive flag from the client.
        await self._get_file_store().rmdir(path, recursive=recursive)
        return self.build_response(request)

    async def _store_fs_stat(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get file/directory metadata.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``path`` — the path to stat.

        Returns:
            Dict[str, Any]: DAP response with metadata (size, modified time, type,
                etc.) as the body.
        """
        # Retrieve metadata for the given path from the user-scoped store.
        result = await self._get_file_store().stat(args.get('path'))
        return self.build_response(request, body=result)

    async def _store_fs_rename(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Rename a file or directory.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Must contain ``old_path`` (current path) and
                ``new_path`` (desired path). Both are required non-empty strings.

        Returns:
            Dict[str, Any]: Empty success DAP response, or a DAP error response if
                either argument is missing or not a non-empty string.
        """
        # Validate both paths up front so FileStore.rename does not receive None
        # and fail with a less actionable error further down the stack.
        old_path = args.get('old_path')
        new_path = args.get('new_path')
        if not isinstance(old_path, str) or not old_path:
            return self.build_error(request, 'rename requires a non-empty "old_path" string')
        if not isinstance(new_path, str) or not new_path:
            return self.build_error(request, 'rename requires a non-empty "new_path" string')

        # Delegate the rename operation to the user-scoped file store backend.
        await self._get_file_store().rename(old_path, new_path)
        return self.build_response(request)
