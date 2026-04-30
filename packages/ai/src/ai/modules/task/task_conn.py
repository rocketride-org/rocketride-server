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
TaskConn: Unified DAP Connection Handler for Task Management System.

This module implements a comprehensive DAP (Debug Adapter Protocol) connection handler
that combines multiple command processing capabilities into a single unified interface.
It serves as the primary connection point for DAP clients to interact with computational
tasks, providing task lifecycle management, data processing, and event monitoring
through a single WebSocket connection.

Primary Responsibilities:
--------------------------
1. Provides a unified DAP interface combining task, data, and monitor commands
2. Manages WebSocket connections for DAP clients with complete protocol support
3. Routes DAP commands to appropriate specialized command handlers
4. Handles task lifecycle operations (launch, execute, attach, terminate)
5. Facilitates real-time data processing requests to running tasks
6. Manages event monitoring and subscription services
7. Provides connection management and transport layer integration
8. Delegates complex operations to backend task instances

Command Categories:
-------------------
- Task Commands: lifecycle management (launch, execute, attach, terminate, pause, continue)
- Data Commands: real-time data processing requests (ext_process)
- Monitor Commands: event subscription and monitoring (ext_monitor)
- Standard DAP: debugging protocol commands (initialize, breakpoints, etc.)

Architecture:
-------------
Uses multiple inheritance to combine specialized command handlers:
- TaskCommands: Task lifecycle and debugging session management
- DataCommands: Data processing request handling
- MonitorCommands: Event monitoring and subscription management
- DAPConn: Base DAP protocol implementation

This design provides a single connection point while maintaining separation
of concerns through specialized command handler classes.
"""

import time
from typing import TYPE_CHECKING, Dict, Any, Union, Optional
from rocketride import EVENT_TYPE
from ai.common.dap import DAPConn, TransportBase
from ai.constants import CONST_AUTH_MAX_ATTEMPTS_PER_CONN
from .commands.cmd_task import TaskCommands
from .commands.cmd_data import DataCommands
from .commands.cmd_monitor import MonitorCommands
from .commands.cmd_debug import DebugCommands
from .commands.cmd_misc import MiscCommands
from .commands.cmd_account import AccountCommands
from .commands.cmd_app import AppCommands
from ai.account.models import AccountInfo, resolve_team_permissions
from ai.common.account import AccountPipelineValidation

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from .task_engine import Task
    from .task_server import TaskServer

"""
Permissions Management

task.monitor        Allow turning on/off monitoring for a specific task
task.data           Allow submitting data to a specific task
task.control        Allow launch/execute/terminate
task.debug          Allow debugging a specific task
"""


class TaskConn(
    TaskCommands,
    DataCommands,
    MonitorCommands,
    DebugCommands,
    MiscCommands,
    AccountCommands,
    AppCommands,
    DAPConn,
):
    """
    Unified DAP connection handler combining task management, data processing, and monitoring.

    This class serves as the primary interface for DAP clients to interact with the
    task management system. It combines multiple specialized command handlers through
    multiple inheritance, providing a comprehensive API for task operations while
    maintaining clean separation of concerns.

    Key Features:
    - Complete DAP protocol compliance with extended task management commands
    - Unified connection management for all task-related operations
    - Transport layer abstraction with callback-based event handling
    - Automatic command routing to appropriate specialized handlers
    - Connection lifecycle management with proper cleanup
    - Error handling and diagnostic logging across all command types

    Command Routing:
    - DAP standard commands (initialize, terminate, etc.) → specialized handlers
    - Task commands (launch, execute, attach) → TaskCommands mixin
    - Data commands (ext_process) → DataCommands mixin
    - Monitor commands (ext_monitor) → MonitorCommands mixin
    - Generic task commands → delegated to task instances

    Inheritance Hierarchy:
    - TaskCommands: Task lifecycle and debugging operations
    - DataCommands: Real-time data processing interface
    - MonitorCommands: Event subscription and monitoring
    - DebugCommands: Debugging session management
    - MiscCommands: Miscellaneous utility commands (services, etc.)
    - AccountCommands: Account management (profile, keys, organizations, teams, billing)
    - AppCommands: App marketplace (developer, submission, catalog, admin, pricing)
    - DAPConn: Base DAP protocol implementation and transport handling

    Attributes:
        _connection_id: Unique identifier for this DAP connection session
        _server: Reference to TaskServer for task lookup and management
        transport: Communication layer for DAP message exchange
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new unified DAP connection with all command handling capabilities.

        Sets up the connection by initializing all specialized command handlers
        and configuring the transport layer for DAP communication. This creates
        a complete DAP endpoint capable of handling task management, data processing,
        and event monitoring through a single WebSocket connection. Account info
        is set when the client sends a successful auth command as the first message.

        Args:
            connection_id (int): Unique identifier for this connection session,
                               used for logging and connection tracking
            server (TaskServer): The server instance managing task lifecycle,
                               registration, and inter-task communication
            transport (TransportBase): Communication transport layer handling
                                     WebSocket messages and DAP protocol encoding
            **kwargs: Additional arguments passed to parent constructors

        Initialization Process:
        1. Initialize base DAPConn with connection naming and transport
        2. Initialize all specialized command handler mixins
        3. Configure transport layer callbacks for message handling
        4. Establish server reference for task operations
        5. Log connection establishment for debugging
        """
        # Create a unique name for this connection for logging and identification
        name = f'CONN-{connection_id}'

        # Initialize all specialized command handler mixins
        # Note: Explicit initialization needed due to multiple inheritance
        DAPConn.__init__(self, module=name, transport=transport)
        MonitorCommands.__init__(self, connection_id, server, transport, **kwargs)
        DataCommands.__init__(self, connection_id, server, transport, **kwargs)
        TaskCommands.__init__(self, connection_id, server, transport, **kwargs)
        DebugCommands.__init__(self, connection_id, server, transport, **kwargs)
        MiscCommands.__init__(self, connection_id, server, transport, **kwargs)
        AccountCommands.__init__(self, connection_id, server, transport, **kwargs)
        AppCommands.__init__(self, connection_id, server, transport, **kwargs)

        # Store connection identifier for tracking and logging
        self._connection_id = connection_id

        # Log connection initialization for debugging and monitoring
        self.debug_message(f'Initializing connection {connection_id}...')

        # Store reference to task server for task lookup and management operations
        self._server = server

        # Account info set when client sends successful auth { auth: apikey } command.
        self._account_info: Optional[AccountInfo] = None
        self._authenticated = False

        # Client IP — set by task_server.listen() immediately after construction,
        # used for per-IP unauthenticated connection tracking.
        self._client_ip: str = ''

        # Connection tracking for server dashboard
        self._connected_at: float = time.time()
        self._messages_in: int = 0
        self._messages_out: int = 0
        self._last_activity: float = time.time()
        self._client_info: Dict[str, str] = {}

        # Brute-force guard: per-connection lifetime count of auth requests.
        # Enforced in on_auth against CONST_AUTH_MAX_ATTEMPTS_PER_CONN so a
        # single WebSocket cannot submit an unbounded stream of credentials.
        self._auth_attempts: int = 0

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a DAP message over the transport layer, updating outbound message metrics.

        Increments the outbound message counter and refreshes the last-activity
        timestamp before delegating to the parent DAPConn send implementation.
        This ensures dashboard metrics remain accurate for every message sent.

        Args:
            message (Dict[str, Any]): The fully-formed DAP message dict to transmit.
                Must be JSON-serialisable; encoding is handled by the transport layer.
        """
        # Increment outbound message counter for dashboard metrics
        self._messages_out += 1
        # Update last activity timestamp so idle-time tracking stays accurate
        self._last_activity = time.time()
        # Delegate to the parent transport send implementation
        await super().send(message)

    async def on_receive(self, message: Optional[Dict[str, Any]] = None) -> None:
        """
        Intercept DAP dispatch: whitelist auth and login pre-authentication;
        reject and disconnect all other commands until authenticated.
        """
        if message is None:
            message = {}
        self._messages_in += 1
        self._last_activity = time.time()
        cmd = message.get('command', '')

        # auth is always allowed before authentication:
        #   auth  — authenticates the connection with a credential (access_token or user key)
        if message.get('type') == 'request' and cmd in ('auth',):
            await super().on_receive(message)
            return

        if not self._authenticated:
            # Send an error message
            err = self.build_error(message, 'Not authenticated')
            await self.send(err)

            # Schedules the disconnect after we return
            self._transport.disconnect()
            return

        await super().on_receive(message)

    async def on_auth(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP auth command: validate credential and return ConnectResult on success.
        An empty credential deauthenticates the connection.

        Also enforces ``CONST_AUTH_MAX_ATTEMPTS_PER_CONN`` — once the per-connection
        auth attempt count exceeds the cap, further auth requests are rejected and
        the connection is scheduled for disconnect. Successful auth does not reset
        the counter: the cap is a per-connection lifetime limit.
        """
        # Count every call (including empty/deauth and re-auth) toward the cap.
        self._auth_attempts += 1
        if self._auth_attempts > CONST_AUTH_MAX_ATTEMPTS_PER_CONN:
            err = self.build_error(request, 'Too many authentication attempts')
            await self.send(err)
            self._transport.disconnect()
            return

        args = request.get('arguments') or {}
        credential = args.get('auth') or ''

        if not credential:
            self._authenticated = False
            self._account_info = None
            raise ValueError('Not authenticated')

        result = await self._server._server.authenticate_credential(credential)
        if isinstance(result, tuple):
            error_code, error_message = result
            await self._server.broadcast_server_event(
                EVENT_TYPE.DASHBOARD,
                {
                    'event': 'apaevt_dashboard',
                    'body': {
                        'action': 'auth_failed',
                        'timestamp': time.time(),
                        'connectionId': self.get_connection_id(),
                        'reason': error_message,
                        'code': error_code,
                    },
                },
            )

            # Send an error message
            err = self.build_error(request, error_message)
            await self.send(err)

            # Schedules the disconnect after we return
            self._transport.disconnect()
            return

        self._account_info = result
        self._authenticated = True
        self._server.release_unauthed_slot(self._client_ip)

        # Capture optional client identification from auth arguments
        if args.get('clientName'):
            self._client_info['name'] = str(args['clientName'])
        if args.get('clientVersion'):
            self._client_info['version'] = str(args['clientVersion'])

        # Notify dashboard subscribers
        await self._server.broadcast_server_event(
            EVENT_TYPE.DASHBOARD,
            {
                'event': 'apaevt_dashboard',
                'body': {
                    'action': 'connection_added',
                    'timestamp': time.time(),
                    'connectionId': self.get_connection_id(),
                    'clientName': self._client_info.get('name'),
                    'clientVersion': self._client_info.get('version'),
                    'clientId': self._account_info.userId if self._account_info else None,
                },
            },
            apikey=self._account_info.userToken,
        )

        return self.build_response(request, body=result.to_connect_result())

    def has_permission(self, perm: Union[list, str]) -> bool:
        """Check if the authenticated user has the given permission for their default team."""
        if not self._account_info:
            return False
        try:
            perms = resolve_team_permissions(self._account_info, self._account_info.defaultTeam)
        except PermissionError:
            return False
        if isinstance(perm, str):
            perm = [perm]
        return any(p in perms for p in perm)

    def verify_permission(self, perm: str) -> None:
        """Raise PermissionError if the authenticated user lacks the given permission."""
        if not self.has_permission(perm):
            raise PermissionError(f'Permission {perm!r} denied')

    def require_zitadel_auth(self) -> None:
        """Verify the connection is authenticated (any credential type is accepted)."""
        if not self._authenticated or not self._account_info:
            raise PermissionError('Not authenticated')

    def verify_plans(self, account_info: AccountInfo, pipeline: Dict[str, Any]) -> bool:
        """
        Validate the user has the correct plan for a pipeline.

        Args:
            account_info (AccountInfo)
            pipeline (Dict[str, Any])

        Raises:
            PermissionError: If account info does not contain the required pipeline plans
        """
        valid_plan = AccountPipelineValidation().validate(account_info, pipeline)

        if not valid_plan:
            raise PermissionError('Invalid account plan for pipeline')

        return True

    def get_task_token(self, request: Dict[str, Any], permissions: str = '') -> str:
        """
        Retrieve the task token associated with a command request and verify permissions if needed.

        Args:
            request (Dict[str, Any]): The command request containing task token
            token (str): The task token to look up.

        Returns:
            TASK: The task instance corresponding to the token.

        Raises:
            KeyError: If the task with the specified token does not exist.
        """
        if not self._account_info:
            raise PermissionError('Not authenticated')
        # If we authenticated with a public key, we are locked to that task
        if self._account_info.auth.startswith('pk_'):
            control = self._server.get_task_control_by_public_key(self._account_info.auth)
            return control.token

        # If we authenticated with a task token, we are locked to that task
        if self._account_info.auth.startswith('tk_'):
            return self._account_info.auth

        # Extract token from arguments
        args = request.get('arguments') or {}
        token = args.get('token', None)

        # Now, we are good... but we need to verify permissions
        if permissions:
            self.verify_permission(permissions)

        # Get the task
        return token

    def get_task(self, request: Dict[str, Any], permissions: str = '') -> 'Task':
        """
        Retrieve the task instance associated with the given request.

        If a task token is specified in request.arguments:
            - If the initial auth token is an apikey, no problem
            - If the initial auth token is a task or public key token,
            the token pass here must match (no cross task access)
        If a task token is not specfied, we use the initial auth token

        Args:
            apikey (str): API key for authentication.
            token (str): The task token to look up.

        Returns:
            TASK: The task instance corresponding to the token.

        Raises:
            KeyError: If the task with the specified token does not exist.
        """
        # Get the token
        token = self.get_task_token(request, permissions)

        # Get the task control and verify ownership for API key auth
        control = self._server.get_task_control(token)

        # For API key auth, verify the task belongs to this user (cross-team safe).
        # pk_ and tk_ auth are already scoped to their task by get_task_token.
        if self._account_info and not self._account_info.auth.startswith(('pk_', 'tk_')):
            if control.userId != self._account_info.userId:
                raise PermissionError('Access denied: task belongs to a different account')

        return control.task

    def get_connection_id(self) -> int:
        """
        Retrieve the unique identifier for this DAP connection.

        This identifier is used for connection tracking, logging, and debugging
        purposes. It remains constant throughout the connection lifecycle.

        Returns:
            int: The unique connection identifier assigned during initialization
        """
        return self._connection_id

    async def request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process DAP debugging commands.

        Args:
            request: DAP command from debugging client

        Returns:
            DAP-compliant response from debugpy interface
        """
        # Get the command - we may have already done this, but
        # we need to make sure...
        request_command = request.get('command', '')

        # Reject internal commands
        if not request_command or request_command.startswith('rrext_'):
            return self.build_error(request, f'Invalid command: {request_command}')

        # Get the task
        task = self.get_task(request, 'task.debug')

        # Validate debug interface
        if task._debug_python is None:
            return self.build_error(request, 'Debug interface not available')

        # Make the request to debugpy
        response = await task._debug_python.request(request)

        # Build the response in our context
        server_response = self.build_response(
            request,
            body=response.get('body', None),
        )

        # And return the response
        return server_response

    async def on_command(self, request: Dict[str, Any]) -> None:
        """
        Handle generic DAP commands by delegating to appropriate task instances.

        This method serves as the fallback command handler for DAP commands that
        are not handled by the specialized command mixins. It performs task lookup
        and delegates the command to the appropriate task instance for processing.
        This enables standard DAP debugging commands (breakpoints, step, evaluate, etc.)
        to be forwarded directly to the task's debugging engine. This method is
        mainly used to forward commands on to the debugger.

        Args:
            request (Dict[str, Any]): DAP command request containing:
                - apikey: Authentication key for task access control
                - token: Unique identifier for the target task instance
                - command: DAP command type (step, breakpoint, evaluate, etc.)
                - arguments: Command-specific parameters and options

        Command Flow:
        1. Extract authentication credentials and task identification
        2. Locate the target task instance through server registry
        3. Forward the complete command request to task's request handler
        4. Return the task's response (handled by task's DAP implementation)

        Delegation Logic:
        - Commands handled by mixins (launch, ext_process, ext_monitor) bypass this method
        - Standard DAP commands (step, breakpoint, evaluate, etc.) are routed here
        - Task instances implement their own DAP command processing
        - This provides seamless integration with task-specific debugging engines

        Raises:
            Exception: If task lookup fails, authentication is invalid,
                      or command processing encounters errors

        Note:
        - This method assumes the task exists and is accessible with provided credentials
        - Error handling includes diagnostic logging before re-raising exceptions
        - The actual command processing logic resides in individual task instances
        """
        # Get the command
        request_command = request.get('command', '')

        # Reject internal commands
        if not request_command or request_command.startswith('rrext_'):
            return self.build_error(request, f'Invalid command: {request_command}')

        # We know this is now a vscode debugging command. Inject
        # the debug token if it was not specified
        request.setdefault('token', self._debug_token)

        # Call it
        return await self.request(request)

    async def on_rrext_ping(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP ping/ping.

        Args:
            request (Dict[str, Any]): Ping request

        Returns:
            Dict[str, Any]: PONG!

        Raises:
            Exception: If task creation or execution startup fails
        """
        # Confirm successful task execution startup
        return self.build_response(request, body={'pong': True})
