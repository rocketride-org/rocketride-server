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


class DebugCommands(DAPConn):
    """
    DAP command handler for debug commands.

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
        # On launch/attach, the task token so we don't need to send it back
        # and forth on debugging commands
        self._debug_token = None
        self._debug_id = None

    async def on_initialize(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'initialize' command to establish debugging capabilities.

        This is the first command sent by DAP clients to negotiate debugging
        capabilities and establish the protocol session. The response advertises
        which debugging features this server supports.

        Args:
            request (Dict[str, Any]): DAP initialize request containing client capabilities

        Returns:
            Dict[str, Any]: Initialize response with server debugging capabilities including:
                - Breakpoint support (conditional, hit-conditional, function breakpoints)
                - Exception handling filters and options
                - Variable inspection and modification capabilities
                - Step debugging and stack trace features
                - Expression evaluation and completion support
        """
        # Log the initialization for debugging purposes
        self.debug_message('Initializing session')

        # Respond to the initialize request with comprehensive debugging capabilities
        return self.build_response(
            request,
            body={
                # Core debugging features
                'supportsConfigurationDoneRequest': True,
                'supportsFunctionBreakpoints': True,
                'supportsConditionalBreakpoints': True,
                'supportsHitConditionalBreakpoints': True,
                'supportsEvaluateForHovers': True,
                # Exception handling configuration
                'exceptionBreakpointFilters': [
                    {
                        'filter': 'raised',
                        'label': 'Raised Exceptions',
                        'default': False,
                    },
                    {
                        'filter': 'uncaught',
                        'label': 'Uncaught Exceptions',
                        'default': True,
                    },
                    {
                        'filter': 'userUnhandled',
                        'label': 'User Uncaught Exceptions',
                        'default': False,
                    },
                ],
                # Advanced debugging capabilities
                'supportsStepBack': False,
                'supportsSetVariable': True,
                'supportsRestartFrame': False,
                'supportsGotoTargetsRequest': True,
                'supportsStepInTargetsRequest': True,
                'supportsCompletionsRequest': True,
                'completionTriggerCharacters': [],
                'supportsModulesRequest': True,
                'additionalModuleColumns': [],
                'supportedChecksumAlgorithms': [],
                'supportsRestartRequest': False,
                'supportsExceptionOptions': True,
                'supportsValueFormattingOptions': True,
                'supportsExceptionInfoRequest': True,
                'supportTerminateDebuggee': True,
                'supportSuspendDebuggee': True,
                'supportsDelayedStackTraceLoading': True,
                'supportsLoadedSourcesRequest': False,
                'supportsLogPoints': True,
                'supportsTerminateThreadsRequest': False,
                'supportsSetExpression': True,
                'supportsTerminateRequest': True,
                'supportsDataBreakpoints': False,
                'supportsReadMemoryRequest': False,
                'supportsDisassembleRequest': False,
                'supportsClipboardContext': True,
                'supportsDebuggerProperties': True,
            },
        )

    async def on_launch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'launch' command to start a new task with debugging enabled.

        Creates a new task instance through the TaskServer and conditionally
        attaches the debugger based on the launch configuration. This is the
        primary entry point for starting new computational tasks with full
        debugging capabilities.

        Args:
            request (Dict[str, Any]): Launch request containing:
                - arguments: Task configuration and launch parameters
                - noDebug: Boolean flag to control debugger attachment

        Returns:
            Dict[str, Any]: Launch response containing the task token and
                          initialization event for debugging session

        Raises:
            Exception: If task creation or debugger attachment fails
        """
        try:
            # Verify permission - don't have a task yet
            self.verify_permission('task.debug')

            # Each debug session must have it's own unique connection
            if self._debug_token:
                raise RuntimeError('Debugger already active on this session')

            # Create and start the new task, obtaining a unique token
            response = await self._server.start_task(
                self._account_info.apikey,
                request,
                self,
                attach_debugger=True,
                client_id=self._account_info.clientid,
            )

            # Save the debug token and the event id
            self._debug_id = response.get('id')
            self._debug_token = response.get('token')

            # Send successful launch response with task token
            await self.send_response(request, body=response)

            # Signal that the debugging session is ready
            return self.build_event('initialized', id=self._debug_id)

        except Exception as e:
            # Log the error for diagnostics and re-raise
            self.debug_message(f'Failed to launch task: {str(e)}')
            raise

    async def on_attach(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'attach' command to connect to an existing task.

        Establishes a debugging connection to a previously launched task,
        enabling collaborative debugging or reconnection scenarios. Multiple
        clients can attach to the same task for shared debugging sessions.

        Args:
            request (Dict[str, Any]): Attach request containing:
                - token: Unique identifier of the target task session

        Returns:
            Dict[str, Any]: Attach response with pipeline information and
                          initialization event for the debugging session

        Raises:
            Exception: If task attachment or session establishment fails
        """
        try:
            # Each debug session must have it's own unique connection
            if self._debug_token:
                raise RuntimeError('Debugger already active on this session')

            # Validate ownership and permissions via get_task
            task = self.get_task(request, 'task.debug')
            token = self.get_task_token(request)

            # If debugging is available, attach to it
            if not task.is_debug_available():
                raise Exception('Debugging is not available')

            # Establish connection to the existing task
            pipeline = await self._server.attach_task(token, self)

            # Save the token and resolve the task id for events
            self._debug_token = token
            self._debug_id = self._server.get_task_control(token).id

            # Confirm successful attachment with pipeline details
            await self.send_response(request, body={'pipeline': pipeline})

            # Signal that debugging session is established
            return self.build_event('initialized', id=self._debug_id)

        except Exception as e:
            # Log attachment failure with task context
            self.debug_message(f'Failed to attach to task "{token}": {str(e)}')
            raise

    async def on_terminate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'terminate' command to stop task execution and cleanup.

        Forcibly terminates the target task and cleans up associated resources.
        This is a graceful shutdown that may not always be called if clients
        disconnect abruptly, so cleanup logic should also be handled in disconnect.

        Args:
            request (Dict[str, Any]): Terminate request from the DAP client

        Returns:
            Dict[str, Any]: Acknowledgment of successful termination

        Raises:
            Exception: If task termination or cleanup fails
        """
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Validate ownership and permissions via get_task
            self.get_task(request, 'task.control')
            token = self.get_task_token(request)

            # Log the termination request
            self.debug_message('Terminating task and cleaning up resources')

            # Stop the task and perform resource cleanup
            await self._server.stop_task(token)

            # This was removed because it doesn't discriminate on event
            # subscriptions. If vscode and we are not using debugpy, then
            # it really is an invalid configuration. This happens when
            # you try to use subProcess:true since the vscode extension
            # can't enter debug mode
            #
            # If we are not sending stuff to debugpy, then we must issue the
            # terminate to vscode so it doesn't hang
            # if not self._server.is_debug_available(token=token):
            #     await self.send_event('terminated', id=self._debug_id)

            # Acknowledge successful termination
            return self.build_response(request)

        except Exception as e:
            # Log termination failure with task context
            self.debug_message(f'Failed to terminate task "{token}": {str(e)}')
            raise

    async def on_disconnect(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """

        Handle DAP 'disconnect' command to end the debugging session.

        Disconnects from the task and performs any necessary cleanup.
        Unlike terminate, this may leave the task running but simply
        detaches the debugging session. The task may have already been
        terminated by a prior terminate command.

        Args:
            request (Dict[str, Any]): Disconnect request from the DAP client

        Returns:
            Dict[str, Any]: Acknowledgment of successful disconnection

        Raises:
            Exception: If disconnection or cleanup fails
        """
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Best-effort detach — task may already be terminated
            try:
                self.get_task(request, 'task.debug')
                await self._server.detach_task(request, self)
            except Exception as e:
                self.debug_message(f'Best-effort detach (task may be terminated): {e}')

            # Log the disconnection request
            self.debug_message('Disconnecting from task')

            # Acknowledge successful disconnection
            # Note: Actual cleanup will be handled by the transport layer
            return self.build_response(request)

        except Exception as e:
            # Log disconnection failure with task context
            self.debug_message(f'Failed to disconnect from task: {str(e)}')
            raise
        finally:
            # Always clear debug state regardless of success/failure
            self._debug_id = None
            self._debug_token = None

    async def on_pause(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'pause' command to suspend task execution.

        Pauses all active threads in the target task, including pipeline
        execution threads and the main thread. This enables inspection
        of the current execution state and variables.

        Args:
            request (Dict[str, Any]): Pause request from the DAP client

        Returns:
            Dict[str, Any]: Response from the underlying task's pause operation

        Raises:
            Exception: If the pause operation fails
        """
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Log the continue operation
            self.debug_message('Pausing execution of task')

            # Configure pause to affect all threads in the task
            request['arguments'] = {
                'threadId': '*',  # Target all threads
                'singleThread': False,  # Don't limit to single thread
            }

            # Forward the pause command to the task's debugging engine
            return await self.request(request)

        except Exception as e:
            # Log pause failure with task context
            self.debug_message(f'Failed to pause task: {str(e)}')
            raise

    async def on_continue(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'continue' command to resume task execution.

        Resumes execution of all threads that were previously paused,
        allowing the task to continue running until completion or the
        next breakpoint is encountered.

        Args:
            request (Dict[str, Any]): Continue request from the DAP client

        Returns:
            Dict[str, Any]: Response from the underlying task's continue operation

        Raises:
            Exception: If the continue operation fails
        """
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Log the continue operation
            self.debug_message('Continuing execution of task')

            # Configure continue to affect all threads in the task
            request['arguments'] = {
                'threadId': '*',  # Target all threads
                'singleThread': False,  # Resume all paused threads
            }

            # Forward the continue command to the task's debugging engine
            return await self.request(request)

        except Exception as e:
            # Log continue failure
            self.debug_message(f'Failed to continue execution: {str(e)}')
            raise

    async def on_configurationDone(self, request: Dict[str, Any]) -> None:
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Extract authentication and task identification from the request
            token = self.get_task_token(request, 'task.debug')

            # vscode sends this after launch even if debugging is not available
            if not self._server.is_debug_available(token=token):
                return self.build_response(request)
            else:
                return await self.request(request)

        except Exception as e:
            # Log configuration failure with task context
            self.debug_message(f'Failed configurationDone on task: {str(e)}')
            raise

    async def on_threads(self, request: Dict[str, Any]) -> None:
        try:
            # We know this is now a vscode debugging command. Inject
            # the debug token if it was not specified
            request.setdefault('token', self._debug_token)

            # Extract authentication and task identification from the request
            token = self.get_task_token(request, 'task.debug')

            # vscode sends this after launch even if debugging is not available
            if not self._server.is_debug_available(token=token):
                return self.build_response(request)
            else:
                return await self.request(request)

        except Exception as e:
            # Log configuration failure with task context
            self.debug_message(f'Failed threads on task "{token}": {str(e)}')
            raise
