from typing import Dict, Any, Optional, Union
from . import DAPBase
from ai.account.models import RequestContext, resolve_team_permissions


class DAPConn(DAPBase):
    """
    DAP (Debug Adapter Protocol) connection handler for WebSocket-based debugging clients.

    Manages a single DAP client connection over WebSocket, providing automatic message
    handling and dispatching. Extends DAPBase with WebSocket-specific transport functionality.

    Key Features:
    - Automatic message monitoring with background task
    - Bidirectional communication for DAP messages
    - JSON text and binary message support
    - Error handling and connection lifecycle management
    - Handler dispatch to appropriate methods

    Message Flow:
    1. Client sends DAP request over WebSocket
    2. Background task receives and parses message
    3. Message dispatched to appropriate on_{command} handler
    4. Handler processes request and returns response
    5. Response automatically sent back to client

    Attributes:
        _websocket (WebSocket): The connected WebSocket for this client
        _monitor_task (asyncio.Task): Background task monitoring incoming messages
    """

    def __init__(self, module: str, **kwargs) -> None:
        """
        Initialize the DAP connection with automatic message monitoring.

        Sets up the WebSocket-based DAP connection and starts a background task to
        monitor for incoming messages. The connection is ready to handle DAP
        communication immediately.

        Args:
            module (str): Module identifier for logging and tracking
            **kwargs: Additional configuration parameters passed to DAPBase
        """
        # Initialize base DAP functionality
        super().__init__(module, **kwargs)

    # =========================================================================
    # DISPATCH
    # =========================================================================

    async def _call_method(
        self, message: Dict[str, Any], method_name: str, default_name: str, ctx: Optional[RequestContext] = None
    ):
        """
        Server-side override of DAPBase._call_method that passes a
        ``RequestContext`` as the second argument to every handler.

        All ``on_*`` handlers have the signature ``(self, request, ctx)``.

        Args:
            message:      The DAP request dict.
            method_name:  Primary handler to try (e.g. ``'on_execute'``).
            default_name: Fallback handler (e.g. ``'on_command'``).
            ctx:          RequestContext built by on_receive.

        Returns:
            ``(handled, response)`` tuple.
        """
        try:
            if method_name:
                method = getattr(self, method_name, None)
                if callable(method):
                    return (True, await method(message, ctx))
            if default_name:
                method = getattr(self, default_name, None)
                if callable(method):
                    return (True, await method(message, ctx))
            return (False, None)
        except Exception as e:
            return (True, self.build_exception(message, e))

    async def on_receive(self, message: Optional[Dict[str, Any]] = None) -> None:
        """
        Dispatch a received DAP message to the appropriate handler method.

        Builds a ``RequestContext`` from connection state and passes it to the
        handler via ``_call_method``.  Subclasses (TaskConn, pod Conns) override
        this to extract ``_ctx`` from forwarded request arguments instead.

        Handler Resolution Order:
        1. on_{command}(self, request, ctx)
        2. on_command(self, request, ctx) fallback
        3. Default success response (if no handlers found)

        Args:
            message: The parsed DAP message dict.
        """
        if message is None:
            message = {}

        # Per-message bookkeeping (metrics/activity) — no-op in the base.
        self._track_message(message)

        # Extract message type to determine handling approach
        message_type = message.get('type', '')

        if message_type != 'request':
            # Handle non-request messages (responses, events, etc.)
            self.debug_message(f'Unhandled message type: {message_type} - {message}')
            return

        # Handle DAP requests (commands from client)
        command = message.get('command', '')

        # Pre-dispatch gate (e.g. authentication). Base allows everything;
        # subclasses may reject and return False after handling the rejection.
        if not await self._pre_dispatch_gate(message):
            return

        # Build the per-request identity context (subclass-overridable).
        ctx = self._build_ctx(message)

        # Try to find and call appropriate handler method
        handled, response = await self._call_method(message, f'on_{command}', 'on_command', ctx)

        if not handled:
            # No handler found - create default success response
            self.debug_message(f'No handler for command: {command}')
            response = self.build_response(message)

        # Send response if handler provided one
        if response is not None:
            await self.send(response)

    def _track_message(self, message: Dict[str, Any]) -> None:
        """
        Per-message bookkeeping hook, called for every received message before
        dispatch. No-op in the base; TaskConn overrides it to update inbound
        message counters and last-activity time.

        Args:
            message: The parsed DAP message dict.
        """
        return None

    async def _pre_dispatch_gate(self, message: Dict[str, Any]) -> bool:
        """
        Gate hook run before a request is dispatched. The base allows every
        request; subclasses (TaskConn) override this to enforce authentication.

        Args:
            message: The parsed DAP request message.

        Returns:
            True to proceed with dispatch, False if the subclass already handled
            the message (e.g. sent an error and scheduled disconnect).
        """
        return True

    def _build_ctx(self, message: Dict[str, Any]):
        """
        Build the ``RequestContext`` for a request from connection state.

        Subclasses (TaskConn, pod Conns) override this to extract ``_ctx`` from
        the forwarded request arguments instead of connection-level state.

        Args:
            message: The parsed DAP request message.

        Returns:
            RequestContext: the per-request identity context.
        """
        from ai.account.models import RequestContext

        return RequestContext(
            account_info=getattr(self, '_account_info', None),
            conn_id=str(getattr(self, '_connection_id', 0)),
            source='local',
        )

    async def send(self, message: Dict[str, Any]) -> None:
        """
        Send a message to the DAP server.

        Must be implemented by concrete client transport classes to handle sending
        messages over their specific transport mechanism.

        Args:
            message (Dict[str, Any]): The DAP message to send to the server
        """
        return await self._transport.send(message)

    async def send_response(self, command: Dict[str, Any], *, body: Optional[Dict[str, Any]] = None) -> None:
        """
        Build and send a successful DAP response message to the client.

        Convenience method that combines response building and transmission for
        successful responses to DAP requests.

        Args:
            command (Dict[str, Any]): The original DAP request message to respond to
            body (Optional[Dict[str, Any]]): Optional response data specific to the command

        Raises:
            Exception: If response building or WebSocket sending fails
        """
        # Build standard DAP response format using base class method
        response = self.build_response(command, body=body)

        # Send the response via WebSocket
        await self.send(response)

    async def send_event(self, event: str, *, id: str = '', body: Optional[Dict[str, Any]] = None) -> None:
        """
        Build and send a DAP event message to the client.

        Events are server-initiated notifications that inform the client about
        state changes, output, or other asynchronous occurrences during debugging.

        Args:
            event (str): The event name as defined by the DAP specification
            id (str): Optional id for event correlation
            body (Optional[Dict[str, Any]]): Event-specific data payload

        Example:
            await self.send_event("output", body={"category": "stdout", "output": "Hello, World!"})
        """
        # Build standard DAP event format using base class method
        message = self.build_event(event, id=id, body=body)

        # Send the event via WebSocket
        await self.send(message)

    async def accept(self, websocket) -> None:
        """
        Accept an incoming WebSocket connection and block until it closes.

        Server-side counterpart of DAPClient.connect(). Delegates to the
        transport's accept() which handles the WebSocket handshake, starts
        the receive loop, and blocks until the client disconnects.

        Args:
            websocket: FastAPI WebSocket instance for the incoming connection.

        Raises:
            ConnectionError: If accepting the connection fails.
        """
        await self._transport.accept(websocket=websocket)

    async def send_error(self, request: Dict[str, Any], message: str) -> Dict[str, Any]:
        """
        Build and send a DAP error response message to the client.

        Handles failed DAP requests by building a properly formatted error response
        and sending it to the client.

        Args:
            request (Dict[str, Any]): The original DAP request that failed
            message (str): Human-readable error description

        Returns:
            Dict[str, Any]: The error response that was sent

        Raises:
            Exception: If response building or WebSocket sending fails
        """
        # Build standard DAP error response format using base class method
        response = self.build_error(request, message)

        # Send the error response via WebSocket
        await self.send(response)

        # Return the response for potential logging or further processing
        return response

    # =========================================================================
    # PERMISSION CHECKS
    # =========================================================================

    def has_permission(self, perm: Union[list, str], ctx: RequestContext) -> bool:
        """
        Check if the caller has the given permission for their default team.

        Resolves the caller's effective permissions via their organisation and
        team membership, then checks whether any of the requested permissions
        are present.

        Args:
            perm:  A single permission string or list of permission strings.
            ctx:   Per-request context carrying the caller's AccountInfo.

        Returns:
            True if the caller holds at least one of the requested permissions.
        """
        info = ctx.account_info
        if not info:
            return False
        try:
            perms = resolve_team_permissions(info, info.defaultTeam)
        except PermissionError:
            return False
        if isinstance(perm, str):
            perm = [perm]
        return any(p in perms for p in perm)

    def verify_permission(self, perm: str, ctx: RequestContext) -> None:
        """
        Raise PermissionError if the caller lacks the given permission.

        Args:
            perm:  The required permission string (e.g. ``'task.control'``).
            ctx:   Per-request context carrying the caller's AccountInfo.

        Raises:
            PermissionError: If the caller does not hold the required permission.
        """
        if not self.has_permission(perm, ctx):
            raise PermissionError(f'Permission {perm!r} denied')

    def verify_auth(self, ctx: RequestContext) -> None:
        """
        Raise PermissionError if the caller is not a fully authenticated user.

        Called by SaaS handlers that require a real user identity (userId).
        Rejects unauthenticated connections, waitlisted users, and
        task-scoped credentials (``pk_*``) which have no userId.

        Args:
            ctx:  Per-request context carrying the caller's AccountInfo.

        Raises:
            PermissionError: If account_info is None, or the user is
                waitlisted, or the account lacks a ``userId``.
        """
        info = ctx.account_info
        if not info:
            raise PermissionError('Authentication required')
        if getattr(info, 'waitlisted', False):
            raise PermissionError('Account is waitlisted')
        if not getattr(info, 'userId', None):
            raise PermissionError('User authentication required')

    # =========================================================================
    # TASK TOKEN RESOLUTION
    # =========================================================================

    def get_task_token(self, request: Dict[str, Any], ctx: RequestContext, permissions: str = '') -> str:
        """
        Extract the task token from a DAP request.

        Base implementation handles ``tk_*`` auth scoping (the caller is
        locked to the task they authenticated with) and falls back to
        extracting the token from ``request.arguments.token``.

        ``TaskConn`` overrides this to add ``pk_*`` public-key resolution
        against local task controls.

        Args:
            request:     The DAP request dict.
            ctx:         Per-request context carrying caller identity.
            permissions: Optional permission string (checked by subclasses).

        Returns:
            The task token string, or None if not present.

        Raises:
            PermissionError: If the caller is not authenticated.
        """
        info = ctx.account_info
        if not info:
            raise PermissionError('Not authenticated')

        # If authenticated with a task token, locked to that task
        auth = info.auth if hasattr(info, 'auth') else (info.get('auth', '') if isinstance(info, dict) else '')
        if auth.startswith('tk_'):
            return auth

        # Extract token from arguments, falling back to request root
        args = request.get('arguments') or {}
        return args.get('token') or request.get('token', '')
