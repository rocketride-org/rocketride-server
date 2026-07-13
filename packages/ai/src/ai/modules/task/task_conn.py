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
from typing import TYPE_CHECKING, Dict, Any, Optional
from rocketride import EVENT_TYPE
from rocketride.types.client import DAPRequest, DAPResponse
from ai.common.dap import DAPConn, TransportBase
from ai.constants import CONST_AUTH_MAX_ATTEMPTS_PER_CONN
from .commands.cmd_task import TaskCommands
from .commands.cmd_data import DataCommands
from .commands.cmd_monitor import MonitorCommands
from .commands.cmd_debug import DebugCommands
from .commands.cmd_misc import MiscCommands
from .commands.cmd_cprofile import CProfileCommands
from .commands.cmd_account import AccountCommands
from .commands.cmd_app import AppCommands
from .commands.cmd_public import PublicCommands
from .commands.cmd_deploy import DeployCommands
from .commands.cmd_store import StoreCommands
from ai.account.models import AccountInfo, RequestContext
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
    CProfileCommands,
    AccountCommands,
    AppCommands,
    PublicCommands,
    DeployCommands,
    StoreCommands,
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
    - DAP standard commands (initialize, terminate, etc.) -> specialized handlers
    - Task commands (launch, execute, attach) -> TaskCommands mixin
    - Data commands (ext_process) -> DataCommands mixin
    - Monitor commands (ext_monitor) -> MonitorCommands mixin
    - Generic task commands -> delegated to task instances

    Inheritance Hierarchy:
    - TaskCommands: Task lifecycle and debugging operations
    - DataCommands: Real-time data processing interface
    - MonitorCommands: Event subscription and monitoring
    - DebugCommands: Debugging session management
    - MiscCommands: Miscellaneous utility commands (services, etc.)
    - CProfileCommands: cProfile process profiling (start, stop, status, report)
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
        CProfileCommands.__init__(self, connection_id, server, transport, **kwargs)
        AccountCommands.__init__(self, connection_id, server, transport, **kwargs)
        AppCommands.__init__(self, connection_id, server, transport, **kwargs)
        StoreCommands.__init__(self, connection_id, server, transport, **kwargs)

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
        self._client_info: Dict[str, str] = {}  # SDK identity (set at auth, immutable)
        self._app_name: str = ''  # App-level identity (set by rrext_identify)

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

    def _track_message(self, message: Dict[str, Any]) -> None:
        """
        Update connection-level inbound metrics for every received message.

        Overrides the base no-op hook (called from DAPConn.on_receive before
        dispatch) to count inbound messages and stamp last-activity time.

        Args:
            message: The parsed DAP message dict.
        """
        self._messages_in += 1
        self._last_activity = time.time()

    async def _pre_dispatch_gate(self, message: Dict[str, Any]) -> bool:
        """
        Enforce authentication before dispatching a request.

        Only ``auth`` and ``rrext_public_*`` commands bypass authentication; the
        rrext_public_* prefix convention lets public commands (catalog browsing,
        server probe) through without maintaining a whitelist. Everything else is
        rejected with an error and the connection is scheduled for disconnect.

        Args:
            message: The parsed DAP request message.

        Returns:
            True to proceed with dispatch, False if the request was rejected
            (an error was sent and disconnect scheduled).
        """
        cmd = message.get('command', '')

        # Pre-auth gate: only auth and rrext_public_* bypass authentication
        if not (cmd == 'auth' or cmd.startswith('rrext_public_')) and not self._authenticated:
            # Send an error and schedule disconnect
            err = self.build_error(message, 'Not authenticated')
            await self.send(err)
            self._transport.disconnect()
            return False

        return True

    def _build_ctx(self, message: Dict[str, Any]) -> RequestContext:
        """
        Build the RequestContext from either the forwarded ``_ctx`` argument
        (pod mode) or connection-level ``_account_info`` (OSS / direct mode).

        In pod mode the ``_ctx`` key is popped from the request arguments so the
        handler never sees it.

        Args:
            message: The parsed DAP request message.

        Returns:
            RequestContext: the per-request identity context.
        """
        # Extract _ctx from arguments if present (pod mode), otherwise build
        # from connection-level state (OSS / direct mode).
        args = message.get('arguments') or {}
        raw_ctx = args.pop('_ctx', None)

        # A forwarded _ctx replaces the caller's identity, so it is only honoured
        # on a connection that itself authenticated as an internal pod service
        # (the Orchestrator). An ordinary authenticated client could otherwise set
        # arguments._ctx to run as a forged user/admin. The key is already popped
        # above, so an untrusted forward simply falls through to the
        # connection-derived context below.
        conn_account = self._account_info
        conn_is_internal = bool(conn_account and 'internal' in (getattr(conn_account, 'sysPermissions', None) or []))

        if raw_ctx and conn_is_internal:
            # Pod mode: orchestrator forwarded the caller's identity. Guard the
            # account_info lookup — a malformed/pre-auth forward without it must
            # not raise KeyError out of on_receive (which would silently drop the
            # message); treat a missing account_info as unauthenticated instead.
            raw_account = raw_ctx.get('account_info')
            return RequestContext(
                account_info=AccountInfo(**raw_account) if raw_account else None,
                conn_id=raw_ctx.get('conn_id', str(self._connection_id)),
                source=raw_ctx.get('source', 'orchestrator'),
            )

        # OSS / direct mode: use connection-level account info
        return RequestContext(
            account_info=self._account_info,
            conn_id=str(self._connection_id),
            source='local',
        )

    async def on_auth(self, request: DAPRequest, ctx: RequestContext) -> Optional[DAPResponse]:
        """
        Handle DAP auth command: validate credential and return ConnectResult on success.
        An empty credential deauthenticates the connection.

        Also enforces ``CONST_AUTH_MAX_ATTEMPTS_PER_CONN`` — once the per-connection
        auth attempt count exceeds the cap, further auth requests are rejected and
        the connection is scheduled for disconnect. Successful auth does not reset
        the counter: the cap is a per-connection lifetime limit.

        Args:
            request (Dict[str, Any]): The DAP auth request.
            ctx (RequestContext): Per-request context (account_info is None pre-auth).
        """
        args = request.get('arguments') or {}

        # Count every call (including empty/deauth and re-auth) toward the cap.
        self._auth_attempts += 1
        if self._auth_attempts > CONST_AUTH_MAX_ATTEMPTS_PER_CONN:
            err = self.build_error(request, 'Too many authentication attempts')
            await self.send(err)
            self._transport.disconnect()
            return

        credential = args.get('auth') or ''

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

        # Store connection-level account info for future on_receive ctx building
        self._account_info = result
        self._authenticated = True
        self._server.release_unauthed_slot(self._client_ip)

        # Capture optional client identification from auth arguments
        if args.get('clientName'):
            self._client_info['name'] = str(args['clientName'])
        if args.get('clientVersion'):
            self._client_info['version'] = str(args['clientVersion'])

        # Notify dashboard subscribers — use result (freshly authenticated AccountInfo)
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
                    'clientId': result.userId,
                },
            },
            user_id=result.userId,
        )

        # Apps are already populated in AccountInfo by the account service
        # (desktop apps with full manifest + subscription status).
        return self.build_response(request, body=result.to_connect_result())

    async def on_deauth(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP deauth command: clear authentication state.

        Reverts the connection to unauthenticated mode so only
        ``rrext_public_*`` commands are accepted. The WebSocket stays
        open — callers can re-authenticate later via ``auth``.

        Args:
            request (Dict[str, Any]): The DAP deauth request.
            ctx (RequestContext): Per-request context (connection-level).
        """
        # Nothing to do if not authenticated
        if not self._authenticated:
            return self.build_response(request, body={})

        # Re-acquire an unauthenticated slot for this IP
        if self._client_ip:
            self._server._unauthed_by_ip[self._client_ip] = self._server._unauthed_by_ip.get(self._client_ip, 0) + 1

        # Clear authentication state
        self._authenticated = False
        self._account_info = None

        return self.build_response(request, body={})

    # has_permission, verify_permission, and verify_auth are
    # inherited from DAPConn — available to all server-side connections.

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

    def get_task_token(self, request: Dict[str, Any], ctx: RequestContext, permissions: str = '') -> str:
        """
        Retrieve the task token associated with a command request.

        Extends the base ``DAPConn.get_task_token`` with ``pk_*`` public-key
        resolution against local task controls (only available on EAAS where
        tasks run in-process).

        Args:
            request: The DAP command request.
            ctx:     Per-request context carrying caller identity.
            permissions: Optional permission string (checked by get_task).

        Returns:
            The task token string.

        Raises:
            PermissionError: If not authenticated or access is denied.
        """
        account_info = ctx.account_info
        if not account_info:
            raise PermissionError('Not authenticated')

        # pk_* auth: resolve the public key to its task's token via local
        # task controls (only available on EAAS, not on the orchestrator).
        if account_info.auth.startswith('pk_'):
            control = self._server.get_task_control_by_public_key(account_info.auth)
            return control.token

        # Delegate tk_* and regular token extraction to the base class
        return super().get_task_token(request, ctx, permissions)

    def get_task(self, request: Dict[str, Any], ctx: RequestContext, permissions: str = '') -> 'Task':
        """
        Retrieve the task instance associated with the given request.

        Extracts the token, looks up the task control, and verifies the
        caller has access via ``verify_task_access()``.

        Args:
            request: The DAP command request.
            ctx:     Per-request context carrying caller identity.
            permissions: Optional specific permission to check (e.g. 'task.monitor').

        Returns:
            Task: The task instance corresponding to the token.

        Raises:
            RuntimeError: If the task does not exist.
            PermissionError: If access is denied.
        """
        token = self.get_task_token(request, ctx, permissions)
        control = self._server.get_task_control_by_token(token)
        self._server.verify_task_access(control, ctx, require=permissions)
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

    async def request(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Process DAP debugging commands.

        Args:
            request (Dict[str, Any]): DAP command from debugging client.
            ctx (RequestContext): Per-request context carrying caller identity.

        Returns:
            Dict[str, Any]: DAP-compliant response from debugpy interface.
        """
        # Get the command - we may have already done this, but
        # we need to make sure...
        request_command = request.get('command', '')

        # Reject internal commands
        if not request_command or request_command.startswith('rrext_'):
            return self.build_error(request, f'Invalid command: {request_command}')

        # Get the task
        task = self.get_task(request, ctx, 'task.debug')

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

    async def on_command(self, request: DAPRequest, ctx: RequestContext) -> Optional[DAPResponse]:
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
            ctx (RequestContext): Per-request context carrying caller identity.

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
        return await self.request(request, ctx)

    async def on_rrext_identify(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """Update the app-level display name for this connection.

        Sets ``_app_name`` — a mutable label indicating which application or
        plugin is currently active on this connection.  This is separate from
        ``_client_info`` (SDK identity set at auth time, immutable).

        Accepts ``appName`` (preferred) or ``clientName`` (legacy) in the
        request arguments.

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.appName`` (str).
            ctx (RequestContext): Per-request context carrying caller identity.

        Returns:
            Dict[str, Any]: Acknowledgement with the current app name.
        """
        args = request.get('arguments', {})
        # Accept appName (new) or clientName (legacy back-compat)
        new_name = args.get('appName') or args.get('clientName')
        if new_name and isinstance(new_name, str):
            self._app_name = new_name
            # Notify dashboard so the monitor UI updates in real time
            await self._server.broadcast_server_event(
                EVENT_TYPE.DASHBOARD,
                {
                    'event': 'apaevt_dashboard',
                    'body': {
                        'action': 'connection_updated',
                        'timestamp': time.time(),
                        'connectionId': self.get_connection_id(),
                        'appName': new_name,
                    },
                },
                user_id=ctx.account_info.userId if ctx.account_info else None,
            )
        return self.build_response(request, body={'appName': self._app_name})

    async def on_rrext_ping(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP ping/ping.

        Args:
            request (Dict[str, Any]): Ping request.
            ctx (RequestContext): Per-request context (unused, stateless).

        Returns:
            Dict[str, Any]: PONG!
        """
        # Confirm successful task execution startup
        return self.build_response(request, body={'pong': True})
