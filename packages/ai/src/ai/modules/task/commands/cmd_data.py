"""
DataCommands: DAP Data Processing Interface for Task Communication.

This module implements a DAP-based data processing interface that enables clients
to send data processing requests to active computational tasks. It serves as the
communication bridge for data exchange between DAP clients and running task instances,
facilitating real-time data processing and response handling.

Primary Responsibilities:
--------------------------
1. Handles DAP 'rrext_process' commands for data processing requests
2. Manages authentication and task identification for data access
3. Ensures tasks are in running state before processing data requests
4. Forwards data processing requests to appropriate task instances
5. Returns processed results back to requesting clients via DAP protocol
6. Provides error handling and logging for data processing operations

Use Cases:
----------
- Real-time data analysis requests to running computational tasks
- Interactive data processing sessions with task instances
- Client-server data exchange in distributed computing environments
- Dynamic data queries and transformations on active tasks

Architecture:
-------------
This module works in conjunction with TaskServer to:
- Authenticate clients using API keys
- Locate and validate target task instances
- Ensure task readiness before data processing
- Facilitate bidirectional data communication
- Handle processing errors and edge cases
"""

import re
from typing import TYPE_CHECKING, Dict, Any, Optional
from ai.account import account
from ai.common.dap import DAPConn, TransportBase
from ai.common.tool_context import caller_from_auth

# Most object ids one audit record carries (the write tools accept at most 100).
AUDIT_OBJECT_IDS_MAX = 100

# The audit labels the vector write tools use: `vector.<snake_case name>`. Any
# node reached by a tool call can return an `audit` block, so only this
# namespace is recorded (under source 'vector').
AUDIT_ACTION_PATTERN = re.compile(r'vector\.[a-z][a-z0-9_]{0,63}')

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


class DataCommands(DAPConn):
    """
    DAP command handler for data processing requests to computational tasks.

    This class processes DAP 'rrext_process' commands to facilitate data exchange
    between clients and running task instances. It handles authentication,
    task validation, and data forwarding while maintaining DAP protocol
    compliance for seamless integration with debugging and monitoring tools.

    Key Features:
    - Authenticated data processing requests using API keys
    - Task state validation before processing (ensures tasks are running)
    - Direct data forwarding to target task instances
    - Error handling with comprehensive logging
    - DAP-compliant request/response handling

    Workflow:
    1. Receive 'rrext_process' DAP command from client
    2. Extract authentication credentials and task identification
    3. Validate task exists and is in running state
    4. Forward data processing request to target task
    5. Return processed results to client
    6. Handle and log any processing errors

    Attributes:
        _server: Reference to TaskServer for task lookup and management
        connection_id: Unique identifier for this data processing connection
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
        Initialize a new DataCommands instance for data processing operations.

        Sets up the data processing command handler with connection to the
        task management server and establishes the DAP communication transport.

        Args:
            connection_id (int): Unique identifier for this data processing connection
            server (TaskServer): The server instance managing task lifecycle and access
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    async def on_rrext_process(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_process' command for data processing requests.

        This method processes data processing requests by locating the target task,
        ensuring it's in a running state, and forwarding the data processing request
        to the task instance. It handles the complete request lifecycle from
        authentication through response delivery.

        Args:
            request (Dict[str, Any]): DAP data processing request containing:
                - apikey: Authentication key for task access control
                - token: Unique identifier for the target task instance
                - arguments: Data processing parameters and payload (task-specific)

        Returns:
            Dict[str, Any]: Response from the task's data processing operation,
                          which may contain:
                          - Processed data results
                          - Status information
                          - Task-specific response payload

        Workflow:
        1. Extract authentication credentials (apikey) and task identifier (token)
        2. Locate the target task instance using server registry
        3. Wait for task to reach running state (blocks until ready)
        4. Forward the complete request to task's data processing method
        5. Return the task's response directly to the client
        6. Handle and log any errors that occur during processing

        Raises:
            Exception: If task lookup fails, task is not accessible, task cannot
                      reach running state, or data processing operation fails

        Note:
        - This method blocks until the target task is in running state
        - The actual data processing logic is implemented by the task instance
        - Error details are logged for debugging but original exceptions are re-raised
        - Response format is determined by the individual task's processing logic
        """
        try:
            # Locate the target task instance using authentication and token
            task = self.get_task(request, 'task.data')

            # Ensure the task is ready to process data (blocks until running)
            # This is critical as tasks may be in startup, initialization, or other states
            await task.wait_for_running()

            # A tool call carries the caller as THIS server sees it: whatever
            # caller the client put in the arguments is replaced. The node
            # tools read it from the call context the task builds from it.
            caller = None
            control = None
            arguments = request.get('arguments')
            if isinstance(arguments, dict) and arguments.get('subcommand') == 'tool':
                control = self._task_control_for(request)
                caller = self._server_caller(control)
                request = {**request, 'arguments': {**arguments, 'caller': caller}}

            # Forward the data processing request to the task instance and get
            # the raw response from the subprocess.
            subprocess_response = await task._send_data(request)

            # Write tools report what they changed in an `audit` block; record
            # it once, server-side, with ids and counts only.
            if caller is not None:
                await self._forward_audit(subprocess_response, caller, control)

            # Rebuild the response envelope keyed off the INBOUND request so the
            # inbound DAPConn can correlate it back to the originating chat client.
            # _send_data builds its own outbound DAP packet with a fresh seq for
            # the eaas->subprocess hop, which means subprocess_response.request_seq
            # points at the outbound seq, not the chat client's original seq.
            # build_response constructs a fresh envelope keyed off the inbound
            # request so request_seq matches what the chat client sent.  Mirrors
            # the same pattern task_conn.request uses for the debug channel.

            return self.build_response(
                request,
                body=subprocess_response.get('body'),
            )

        except Exception as e:
            # Log data processing failure with context for debugging
            self.debug_message(f'Failed to process data request: {str(e)}')

            # Re-raise the exception to maintain error propagation to client
            raise

    # =========================================================================
    # TOOL CALLER AND AUDIT
    # =========================================================================

    def _task_control_for(self, request: Dict[str, Any]) -> Optional[Any]:
        """Return the task control of the request's task, or None when it cannot be read."""
        try:
            return self._server.get_task_control(self.get_task_token(request))
        except Exception as e:
            self.debug_message(f'Tool caller: task control unavailable ({type(e).__name__})')
            return None

    def _server_caller(self, control: Optional[Any]) -> Dict[str, Any]:
        """Return the caller block for this connection: key kind, user, the task's team and org.

        The kind follows the key the connection signed in with (public task key,
        task token, or an account credential); the key itself is never copied.
        """
        info = getattr(self, '_account_info', None)
        return caller_from_auth(
            getattr(info, 'auth', None),
            user_id=getattr(info, 'userId', None),
            team_id=getattr(control, 'teamId', None),
            org_id=getattr(control, 'orgId', None),
        )

    async def _forward_audit(self, subprocess_response: Any, caller: Dict[str, Any], control: Optional[Any]) -> None:
        """Record a tool result's ``audit`` block with ``account.audit``.

        Only a dict result whose ``audit`` block names an ``action`` in the
        ``vector.<snake_case name>`` namespace (``AUDIT_ACTION_PATTERN``) is
        recorded; the caller kind, team, org and source component come from the
        server, never from the block.
        The record carries the node, provider, collection, at most
        ``AUDIT_OBJECT_IDS_MAX`` object ids, the caller kind and team, the source
        component, the rows changed and the outcome; never content or vectors.
        An audit failure is logged and does not fail the call.
        """
        body = subprocess_response.get('body') if isinstance(subprocess_response, dict) else None
        result = body.get('result') if isinstance(body, dict) else None
        audit = result.get('audit') if isinstance(result, dict) else None
        if not isinstance(audit, dict):
            return
        action = audit.get('action')
        if not isinstance(action, str) or not AUDIT_ACTION_PATTERN.fullmatch(action):
            return

        def _text(value: Any) -> Optional[str]:
            return value if isinstance(value, str) and value else None

        raw_ids = audit.get('object_ids')
        object_ids = [oid for oid in raw_ids if isinstance(oid, str)] if isinstance(raw_ids, list) else []
        rows = audit.get('rows')
        code = result.get('code')
        request_data = {
            'node': _text(audit.get('node')),
            'provider': _text(audit.get('provider')),
            'collection': _text(audit.get('collection')),
            'object_ids': object_ids[:AUDIT_OBJECT_IDS_MAX],
            'caller_auth': caller.get('auth'),
            'teamId': caller.get('teamId'),
            'source': _text(getattr(control, 'source', None)),
        }
        response_data = {
            'rows': rows if isinstance(rows, int) and not isinstance(rows, bool) else None,
            'success': result.get('success') is True,
            'code': code if isinstance(code, str) else None,
        }
        try:
            await account.audit(
                caller.get('userId'),
                source='vector',
                reason=action,
                request_data=request_data,
                response_data=response_data,
                org_id=caller.get('orgId'),
            )
        except Exception as e:
            self.debug_message(f'Tool audit for {action} failed: {type(e).__name__}: {e}')
