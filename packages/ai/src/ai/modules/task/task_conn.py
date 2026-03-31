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

from typing import TYPE_CHECKING, Dict, Any, Union, Optional
from ai.common.dap import DAPConn, TransportBase
from .commands.cmd_task import TaskCommands
from .commands.cmd_data import DataCommands
from .commands.cmd_monitor import MonitorCommands
from .commands.cmd_debug import DebugCommands
from .commands.cmd_misc import MiscCommands
from ai.web import AccountInfo
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

        # Store connection identifier for tracking and logging
        self._connection_id = connection_id

        # Log connection initialization for debugging and monitoring
        self.debug_message(f'Initializing connection {connection_id}...')

        # Store reference to task server for task lookup and management operations
        self._server = server

        # Account info set when client sends successful auth command as first message
        self._account_info: Optional[AccountInfo] = None
        self._authenticated = False

    async def on_receive(self, message: Dict[str, Any] = {}) -> None:
        """
        Intercept DAP dispatch: if not authenticated, only allow auth command; otherwise require auth first.
        """
        if message.get('type') == 'request' and message.get('command') == 'auth':
            await super().on_receive(message)
            if not self._authenticated:
                await self._transport.disconnect()
            return
        if not self._authenticated:
            err = self.build_error(message, 'Not authenticated')
            await self.send(err)
            await self._transport.disconnect()
            return
        await super().on_receive(message)

    async def on_auth(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP auth command: validate credential from arguments.auth and set account_info on success.
        """
        args = request.get('arguments') or {}
        credential = args.get('auth') or ''
        result = await self._server._server.authenticate_credential(credential)
        if isinstance(result, tuple):
            return self.build_error(request, result[1])
        self._account_info = result
        self._authenticated = True
        return self.build_response(request, body={})

    def has_permission(self, perm: Union[list[str], str]) -> bool:
        """
        Check if the account has the specified permission.

        Args:
            perm (str): The permission to check.

        Returns:
            bool: True if the permission is granted, False otherwise.
        """
        if not self._account_info:
            return False
        # Check for all permissions
        if '*' in self._account_info.permissions:
            return True

        # If it is a single string, turn it into a list
        if isinstance(perm, str):
            perm = [perm]

        # Look for an of the permissions
        for p in perm:
            if p in self._account_info.permissions:
                return True

        # Nope, denied
        return False

    def verify_permission(self, perm: str) -> bool:
        """
        Check if the account has the specified permission.

        Args:
            perm (str): The permission to check.

        Returns:
            bool: True if the permission is granted, False otherwise.
        """
        if not self.has_permission(perm):
            raise PermissionError('Permission denied')

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
        # If we authenticated with a public key, we need to use that
        if self._account_info.auth.startswith('pk_'):
            # Look it up
            control = self._server.get_task_control_by_public_key(self._account_info.auth)
            return control.token

        # First, extract any specified token
        token = request.get('token', None)

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

        # Get the task
        return self._server.get_task(token)

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
