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
MiscCommands: DAP Command Handler for Miscellaneous Operations.

This module implements a Debug Adapter Protocol (DAP) command handler for
miscellaneous utility operations that don't fit into the core task, data,
monitoring, or debugging categories. It provides access to system-level
information and metadata services.

Primary Responsibilities:
--------------------------
1. Handles DAP 'rrext_services' command for service definition retrieval
2. Provides access to connector schemas, UI schemas, and metadata
3. Returns service information for pipeline configuration and validation

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Works in conjunction with TaskServer for server context
- Provides read-only access to service metadata
"""

import time
from typing import TYPE_CHECKING, Dict, Any, List
from rocketride import EVENT_TYPE
from rocketlib import getServiceDefinitions, getServiceDefinition, validatePipeline
from ai.common.dap import DAPConn, TransportBase
from ..pipeline import resolve_implied_source

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


class MiscCommands(DAPConn):
    """
    DAP command handler for miscellaneous utility commands.

    This class processes DAP commands for system-level utilities and metadata
    access. It provides a clean interface for clients to query service
    definitions, schemas, and other configuration information.

    Key Features:
    - Service definition retrieval (single or all services)
    - DAP-compliant request/response handling
    - Access to connector schemas and UI configuration

    Attributes:
        _server: Reference to the TaskServer for context
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
        Initialize a new MiscCommands instance.

        Sets up the miscellaneous command handler with a connection to the task
        management server and establishes the communication transport layer.

        Args:
            connection_id (int): Unique identifier for this DAP connection session
            server (TaskServer): The server instance for context and utilities
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_rrext_services(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_services' command to retrieve service definitions.

        This method provides access to connector service definitions including
        schemas, UI schemas, and other metadata. It can return either a single
        service definition by name or all available service definitions.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any], optional):
                    - service (str, optional): Name of specific service to retrieve

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: Service definition(s) as JSON object
                    - If service specified: single service definition
                    - If no service specified: all service definitions

        Raises:
            Exception: If the specified service is not found

        Usage Examples:
        - Get all services: { "command": "rrext_services" }
        - Get specific service: { "command": "rrext_services", "arguments": { "service": "ocr" } }
        """
        try:
            # Extract optional service name from request arguments
            args = request.get('arguments', {})
            service = args.get('service', None)

            if service:
                # Retrieve specific service definition by name
                schema = getServiceDefinition(service)

                # Validate the service exists
                if not schema:
                    raise ValueError(f"Service '{service}' not found. Please check the service name and try again.")
            else:
                # Retrieve all available service definitions
                schema = getServiceDefinitions()

            # Return successful response with service definition(s)
            return self.build_response(request, body=schema)

        except Exception as e:
            # Log service retrieval failure with context
            self.debug_message(f'Failed to retrieve service definitions: {str(e)}')

            # Re-raise to let DAP error handling create proper error response
            raise

    async def on_rrext_validate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_validate' command to validate a pipeline configuration.

        Validates pipeline structure, component compatibility, and connection
        integrity using rocketlib's validatePipeline function.

        Source resolution follows the same logic as execute:
        1. Explicit ``source`` argument (if provided)
        2. ``source`` field inside the pipeline config
        3. Implied source: the single component whose config.mode == 'Source'

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments (Dict[str, Any]):
                    - pipeline (Dict[str, Any]): Pipeline configuration to validate
                    - source (str, optional): Override source component ID

        Returns:
            Dict[str, Any]: DAP response containing:
                - body: Validation result with errors, warnings, resolved
                  component, and execution chain

        Usage Example:
        { "command": "rrext_validate", "arguments": { "pipeline": { "components": [], ... }, "source": "chat_1" } }
        """
        try:
            args = request.get('arguments', {})
            pipeline = args.get('pipeline', {})

            # Resolve source: explicit arg > pipeline field > implied from components
            source = args.get('source', None) or pipeline.get('source', None)
            if not source:
                source = resolve_implied_source(pipeline)

            # Build the C++ payload with resolved source and default version
            inner = {**pipeline, 'version': pipeline.get('version', 1)}
            if source:
                inner['source'] = source

            # Validate it
            data = validatePipeline(inner)

            # Return the results
            return self.build_response(request, body=data)

        except Exception as e:
            self.debug_message(f'Pipeline validation failed: {str(e)}')
            raise

    async def on_rrext_dashboard(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_dashboard' command to retrieve server dashboard data.

        Returns a snapshot of the server's current state including overview
        metrics, active connections, and task information for administrative
        monitoring dashboards.

        Args:
            request (Dict[str, Any]): DAP request (no arguments required)

        Returns:
            Dict[str, Any]: DAP response containing:
                - body.overview: Server-level aggregate metrics
                - body.connections: List of active connection details
                - body.tasks: List of task details with status and metrics
        """
        try:
            # Require monitor permission
            self.verify_permission('task.monitor')

            server = self._server
            current_time = time.time()
            caller_user_id = self._account_info.userId

            # Snapshot and filter to caller's own data (cross-team: match on userId)
            task_controls = [c for c in server._task_control.values() if c.userId == caller_user_id]
            conn_items = [
                (cid, conn)
                for cid, conn in server._connections.items()
                if hasattr(conn, '_account_info') and conn._account_info and conn._account_info.userId == caller_user_id
            ]

            # Task-scoped tokens (tk_) can only see their own task
            caller_auth = self._account_info.auth if hasattr(self._account_info, 'auth') else ''
            if caller_auth.startswith('tk_'):
                task_controls = [c for c in task_controls if c.token == caller_auth]
                conn_items = [(cid, conn) for cid, conn in conn_items if cid == self._connection_id]

            # Build connection-to-task mapping by scanning task controls
            conn_tasks: Dict[int, List[str]] = {}
            for control in task_controls:
                if control.task is None:
                    continue
                task_name = getattr(control.task.get_status(), 'name', None) or control.source
                for cid, conn in conn_items:
                    if not hasattr(conn, '_monitors'):
                        continue
                    project_key = f'p.{control.project_id}.{control.source}'
                    project_wildcard_key = f'p.{control.project_id}.*'
                    pipe_prefix = f'{project_key}.'
                    if (
                        project_key in conn._monitors
                        or project_wildcard_key in conn._monitors
                        or '*' in conn._monitors
                        or any(k.startswith(pipe_prefix) for k in conn._monitors)
                    ):
                        conn_tasks.setdefault(cid, []).append(task_name)

            # Build project ID → friendly name map from task controls
            # so monitor keys like p.{uuid}.{source} can be displayed readably
            project_names: Dict[str, str] = {}
            source_names: Dict[str, str] = {}
            for control in task_controls:
                if control.task is None:
                    continue
                status = control.task.get_status()
                task_name = getattr(status, 'name', None) or control.source
                # Use the task_name prefix (before the dot) as project label
                name_parts = task_name.split('.', 1)
                project_names.setdefault(control.project_id, name_parts[0])
                source_names.setdefault(
                    f'{control.project_id}.{control.source}', name_parts[-1] if len(name_parts) > 1 else control.source
                )

            # Build connections list
            connections = []
            for conn_id, conn in conn_items:
                conn_info: Dict[str, Any] = {
                    'id': conn_id,
                    'connectedAt': getattr(conn, '_connected_at', current_time),
                    'lastActivity': getattr(conn, '_last_activity', current_time),
                    'messagesIn': getattr(conn, '_messages_in', 0),
                    'messagesOut': getattr(conn, '_messages_out', 0),
                    'authenticated': getattr(conn, '_authenticated', False),
                    'clientId': None,
                    'apikey': '****',
                    'clientInfo': getattr(conn, '_client_info', {}),
                    'monitors': self._build_monitors_list(conn._monitors, project_names, source_names)
                    if hasattr(conn, '_monitors')
                    else [],
                    'attachedTasks': conn_tasks.get(conn_id, []),
                }
                if hasattr(conn, '_account_info') and conn._account_info:
                    conn_info['clientId'] = conn._account_info.userId
                    conn_info['apikey'] = self._mask_apikey(conn._account_info.userToken)
                connections.append(conn_info)

            # Build tasks list
            tasks = []
            for control in task_controls:
                try:
                    task_status = control.task.get_status()
                    start = getattr(task_status, 'startTime', 0) or 0
                    end = getattr(task_status, 'endTime', 0) or 0
                    completed = getattr(task_status, 'completed', False)
                    if completed and start > 0 and end > 0:
                        elapsed = end - start
                    elif start > 0:
                        elapsed = current_time - start
                    else:
                        elapsed = 0

                    # Convert Pydantic metrics model to plain dict for JSON serialization
                    metrics_raw = getattr(task_status, 'metrics', None)
                    metrics_dict = metrics_raw.model_dump() if hasattr(metrics_raw, 'model_dump') else metrics_raw

                    tasks.append(
                        {
                            'id': control.id,
                            'name': getattr(task_status, 'name', control.source),
                            'projectId': control.project_id,
                            'source': control.source,
                            'provider': control.provider,
                            'launchType': control.launch_type.value,
                            'startTime': start,
                            'elapsedTime': elapsed,
                            'completed': completed,
                            'status': getattr(task_status, 'status', None) if not completed else None,
                            'exitCode': getattr(task_status, 'exitCode', None) if completed else None,
                            'endTime': end if completed else None,
                            'connections': control.task.get_connection_count(),
                            'state': getattr(task_status, 'state', 0),
                            'idleTime': getattr(control.task, '_idle_time', 0),
                            'ttl': getattr(control.task, '_ttl', 0),
                            'metrics': metrics_dict,
                            'totalCount': getattr(task_status, 'totalCount', 0),
                            'completedCount': getattr(task_status, 'completedCount', 0),
                            'rateCount': getattr(task_status, 'rateCount', 0),
                            'rateSize': getattr(task_status, 'rateSize', 0),
                        }
                    )
                except Exception as e:
                    self.debug_message(f'Error building task info for "{control.id}": {e}')
                    continue

            # Build overview — derive from sanitized tasks list to avoid
            # re-calling get_status() on potentially torn-down controls
            active_count = sum(1 for task in tasks if not task['completed'])
            start_time = getattr(server._server, '_startTime', None) or current_time
            overview = {
                'totalConnections': len(conn_items),
                'activeTasks': active_count,
                'serverUptime': current_time - start_time,
            }

            return self.build_response(
                request,
                body={
                    'overview': overview,
                    'connections': connections,
                    'tasks': tasks,
                },
            )

        except Exception as e:
            self.debug_message(f'Failed to retrieve dashboard data: {str(e)}')
            raise

    @staticmethod
    def _mask_apikey(apikey: str) -> str:
        """Mask an API key for display, showing only first 4 and last 4 characters."""
        if not apikey or len(apikey) <= 8:
            return '****'
        return f'{apikey[:4]}****{apikey[-4:]}'

    @staticmethod
    def _build_monitors_list(
        monitors: Dict[str, 'EVENT_TYPE'],
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        """Convert the _monitors dict into a list of {key, flags} objects for the dashboard."""
        result = []
        for key, flags in monitors.items():
            flag_names = [f.name.lower() for f in EVENT_TYPE if f.value and f in flags]
            label = MiscCommands._resolve_monitor_label(key, project_names, source_names)
            result.append({'key': label, 'flags': flag_names})
        return result

    @staticmethod
    def _resolve_monitor_label(
        key: str,
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> str:
        """Resolve a raw monitor key into a human-friendly label."""
        if key == '*':
            return 'All tasks'

        if not key.startswith('p.'):
            return 'Task monitor'

        # Strip the 'p.' prefix and split: projectId, source, [pipeId]
        parts = key[2:].split('.', 2)
        project_id = parts[0]
        project_label = project_names.get(project_id, project_id[:8])

        if len(parts) == 1 or (len(parts) == 2 and parts[1] == '*'):
            return f'{project_label}.*'

        source = parts[1]
        source_label = source_names.get(f'{project_id}.{source}', source)

        if len(parts) == 3:
            return f'{project_label}.{source_label}.pipe{parts[2]}'

        return f'{project_label}.{source_label}'
