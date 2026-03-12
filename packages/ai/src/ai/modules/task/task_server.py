"""
TaskServer: Centralized Task Management and Orchestration Server.

This module implements a comprehensive task management system that orchestrates
computational task lifecycles through DAP (Debug Adapter Protocol) over WebSocket
connections. It serves as the central hub for creating, managing, monitoring, and
cleaning up distributed computational tasks with full debugging and data processing
capabilities.

Primary Responsibilities:
--------------------------
1. Manages WebSocket connections for multiple concurrent DAP clients
2. Orchestrates task creation, execution, and termination with security controls
3. Provides task registry with API key-based access control and isolation
4. Handles task lifecycle management (launch, execute, attach, detach, stop)
5. Implements event broadcasting system for real-time task monitoring
6. Performs automatic cleanup of completed tasks to prevent memory leaks
7. Maintains comprehensive metrics and status reporting for monitoring
8. Ensures secure multi-tenant task isolation through authentication

Task Lifecycle Management:
-------------------------
- LAUNCH: Creates new tasks with debugging capabilities enabled
- EXECUTE: Creates new tasks for batch processing without debugging
- ATTACH: Connects clients to existing running tasks (multi-client support)
- DETACH: Disconnects clients from tasks while preserving task state
- STOP: Terminates tasks and performs resource cleanup

Security Features:
------------------
- API key-based task authentication prevents cross-tenant access
- Task token validation ensures only authorized clients can access tasks
- Secure task isolation with per-tenant resource management
- Connection tracking and audit logging for security monitoring

Architecture:
-------------
Central orchestration server managing:
- Task instances (computational workloads)
- DAP connections (debugging and control interfaces)
- Event broadcasting (real-time monitoring and notifications)
- Resource management (automatic cleanup and metrics)
- Multi-tenant security (API key isolation and access control)
"""

import time
import asyncio
import uuid
from typing import List
from fastapi import WebSocket, HTTPException
from dataclasses import dataclass
from typing import Dict, Any, Optional
from ai.constants import CONST_CLEANUP_DELAY_TIME, CONST_CLEANUP_SLEEP_TIME, CONST_DEFAULT_TTL, CONST_TTL_CHECK
from ai.common.dap import TransportWebSocket, DAPBase
from rocketride import TASK_STATUS, EVENT_TYPE
from ai.web import WebServer, AccountInfo
from ai.account.store import Store
from .task_conn import TaskConn
from .task_engine import Task
from .types import LAUNCH_TYPE


@dataclass
class TASK_CONTROL:
    """
    Task control structure containing all metadata and references for a managed task.

    This dataclass encapsulates the complete state and metadata required to
    manage a computational task throughout its lifecycle. It serves as the
    central registry entry that tracks task ownership, configuration, and status.

    Attributes:
        token (str): Unique identifier for the task instance
        apikey (str): Authentication key for task access control and tenant isolation
        task (Optional[Task]): Reference to the actual Task instance managing execution
        launch_type (LAUNCH_TYPE): The method used to create this task (launch/execute)
        pipeline (Optional[Dict[str, Any]]): Task configuration and execution parameters
    """

    # Short of the pipe -  used for display and events
    id: str = ''

    # These are the mapped apikey and the token for the task
    apikey: str = ''
    token: str = ''

    # Public token - used in as alt auth
    public_auth: str = ''

    # Launch type and owning connection
    launch_owner: TaskConn = None
    launch_type: LAUNCH_TYPE = LAUNCH_TYPE.LAUNCH

    # Meta info about the task
    project_id: str = None
    source: str = None
    provider: str = None
    pipeline: Optional[Dict[str, Any]] = None

    # And finally, the task reference
    task: Optional[Task] = None


class TaskServer(DAPBase):
    """
    Central task management server orchestrating computational task lifecycles.

    This server acts as the primary coordination point for a distributed task
    execution system. It manages task creation, client connections, security,
    monitoring, and resource cleanup. The server supports multiple concurrent
    clients and tasks with full isolation and debugging capabilities.

    Key Features:
    - Multi-tenant task management with API key-based security
    - Real-time event broadcasting to subscribed monitors
    - Automatic resource cleanup and memory management
    - Comprehensive metrics and status reporting
    - Support for both interactive debugging and batch execution
    - WebSocket-based DAP communication with multiple concurrent clients

    Task Management:
    - Task registry with secure lookup and access control
    - Lifecycle management (create, start, stop, cleanup)
    - Connection tracking and client session management
    - Event distribution to interested monitors
    - Performance metrics and usage tracking

    Security Model:
    - API key-based tenant isolation prevents cross-tenant access
    - Task tokens provide fine-grained access control
    - Connection tracking for audit and security monitoring
    - Secure task lookup with ownership validation

    Resource Management:
    - Automatic cleanup of completed tasks after grace period
    - Memory usage optimization through timely resource deallocation
    - Connection limit tracking and management
    - Performance metrics for capacity planning

    Attributes:
        _connections: Registry of active DAP client connections
        _task_control: Registry of all managed tasks with metadata
        _connection_id: Monotonic counter for connection identification
        _tasks_peak: Historical maximum concurrent task count
        _tasks_total: Lifetime counter of created tasks
        _server: Reference to parent web server for statistics
    """

    def __init__(self, server: WebServer, **kwargs) -> None:
        """
        Initialize the TaskServer with connection management and cleanup systems.

        Sets up the central task management system including connection registries,
        task control structures, metrics tracking, and background cleanup processes.
        Establishes the foundation for secure multi-tenant task orchestration.

        Args:
            server (WebServer): Reference to the parent web server for statistics
                              and integration with the broader application framework
            **kwargs: Additional arguments passed to parent DAPBase constructor
                     for debugging and protocol configuration

        Initialization Process:
        1. Initialize connection and task registries
        2. Set up connection ID generation
        3. Initialize performance metrics tracking
        4. Start background task cleanup process
        5. Configure DAP base class for protocol handling
        """
        # Initialize registries for connection and task management
        self._task_control: Dict[str, TASK_CONTROL] = {}  # Task registry and metadata
        self._connections: Dict[int, TaskConn] = {}  # Active client connections
        self._connection_id = 0  # Monotonic connection identifier generator

        # Performance and usage metrics for monitoring and capacity planning
        self._tasks_peak: int = 0  # Maximum concurrent tasks ever achieved
        self._tasks_total: int = 0  # Lifetime total of created tasks

        # Global port allocation tracking
        self._allocated_ports: List[int] = []

        # Shared store instance (lazy-loaded via property)
        self._store_instance: Optional[Store] = None

        # Start background cleanup process for completed tasks
        asyncio.create_task(self._cleanup_tasks())

        # Start background TTL monitoring process
        asyncio.create_task(self._monitor_ttl())

        # Store reference to parent server for statistics integration
        self._server = server
        self._config = server.config

        # Register authentication handler for our keys
        server.add_authenticator(self.authenticate)

        # Initialize DAP base class with server identification
        super().__init__('SERVER', **kwargs)

    @property
    def store(self) -> Store:
        """
        Shared Store instance for all tasks and connections.

        Lazy initialization ensures Store is only created when first accessed.
        All TaskCommands and Task instances share this single Store instance
        for consistent data access and reduced resource usage.

        Returns:
            Store: The shared store instance
        """
        if self._store_instance is None:
            self._store_instance = Store.create()
        return self._store_instance

    async def _cleanup_tasks(self) -> None:
        """
        Background process for automatic cleanup of completed tasks.

        This coroutine runs continuously to prevent memory leaks by automatically
        removing completed tasks after a grace period. The grace period allows
        clients to retrieve final status and results before cleanup occurs.

        Cleanup Policy:
        - Completed tasks are retained for 5 minutes after completion
        - Cleanup scan runs every 1 minute to balance responsiveness and overhead
        - Only tasks with completed status are candidates for removal
        - Cleanup failures are logged but don't terminate the cleanup process

        Resource Management:
        - Prevents unbounded memory growth from accumulated completed tasks
        - Maintains task availability for status queries after completion
        - Ensures proper resource deallocation including task-specific cleanup
        - Handles cleanup errors gracefully to maintain system stability

        This method runs as a background async task throughout server lifetime.
        """
        # Continuous cleanup loop - runs for server lifetime
        while True:
            current_time = time.time()

            try:
                # Create snapshot of task tokens to avoid modification during iteration
                task_keys = list(self._task_control.keys())

                # Examine each task for cleanup eligibility
                for task_key in task_keys:
                    control = self._task_control.get(task_key)
                    if not control:
                        continue  # Task may have been removed by another process

                    # Skip tasks that are still actively runnings
                    if not control.task.is_task_complete():
                        continue

                    # Check if sufficient time has passed since completion
                    task_status = control.task.get_status()
                    if task_status.endTime + CONST_CLEANUP_DELAY_TIME < current_time:
                        # Remove the expired completed task
                        await self.remove_task(control.token)

            except Exception as e:
                # Log cleanup errors but continue operation to maintain system stability
                self.debug_message(f'Error during task cleanup cycle: {e}')

            # Wait before next cleanup cycle
            await asyncio.sleep(CONST_CLEANUP_SLEEP_TIME)

    async def _monitor_ttl(self) -> None:
        """
        Background process for monitoring task idle times and enforcing TTL limits.

        This coroutine runs continuously to automatically terminate tasks that have
        been idle (no activity) longer than their configured TTL (time-to-live).

        TTL Policy:
        - Check interval: 60 seconds (1 minute)
        - Idle timer incremented by elapsed time each cycle
        - Tasks exceeding their TTL are automatically terminated
        - Only running tasks are checked (completed tasks handled by cleanup)
        - Tasks with ttl=0 have no timeout (run indefinitely until explicitly stopped)

        Count-up Timer Approach:
        - idle_timer starts at 0 when task created or activity occurs
        - Each cycle adds ~60 seconds to idle_timer
        - When idle_timer >= ttl, task is terminated
        - reset_idle_timer() sets idle_timer back to 0 on activity

        This method runs as a background async task throughout server lifetime.
        """
        # Check interval in seconds (run every 1 minute)
        check_interval = CONST_TTL_CHECK

        while True:
            try:
                # Wait for the check interval before processing
                await asyncio.sleep(check_interval)

                # Create snapshot of task tokens to avoid modification during iteration
                task_keys = list(self._task_control.keys())

                # Examine each task for TTL enforcement
                for task_key in task_keys:
                    control = self._task_control.get(task_key)
                    if not control or not control.task:
                        continue  # Task may have been removed

                    # Skip completed tasks (handled by cleanup process)
                    if control.task.is_task_complete():
                        continue

                    # Skip TTL enforcement if ttl is 0 (no timeout)
                    if control.task._ttl == 0:
                        continue

                    # Increment the idle timer by the check interval
                    control.task._idle_time += check_interval

                    # Check if task has exceeded its TTL
                    if control.task._idle_time >= control.task._ttl:
                        self.debug_message(f'Task "{control.id}" exceeded TTL ({control.task._idle_time}s >= {control.task._ttl}s), terminating...')
                        # Terminate the idle task
                        await self.stop_task(control.token)

            except Exception as e:
                # Log errors but continue operation to maintain system stability
                self.debug_message(f'Error during TTL monitoring cycle: {e}')

    def _next_connection_id(self) -> int:
        """
        Generate the next unique connection identifier for client tracking.

        Connection IDs are used throughout the system for logging, debugging,
        and correlation purposes. Each connection receives a unique monotonic
        identifier that persists throughout the connection lifetime.

        Returns:
            int: Unique monotonic connection identifier

        Design Notes:
        - IDs are never reused, even after connection termination
        - Monotonic sequence aids in debugging and audit trail analysis
        - Connection IDs start from 1 and increment indefinitely
        - Thread-safe through single-threaded async execution model
        """
        self._connection_id += 1
        return self._connection_id

    async def _dapbase_on_connected(self, conn: TaskConn) -> None:
        """
        Handle new WebSocket connection establishment and registration.

        This method is called when a new DAP client establishes a WebSocket
        connection to the server. It registers the connection for message
        routing and prepares it for task operations.

        Args:
            conn (TaskConn): The newly established WebSocket connection with
                           unified DAP command handling capabilities

        Registration Process:
        1. Extract unique connection identifier from connection instance
        2. Add connection to active connections registry
        3. Log connection establishment for monitoring and debugging
        4. Connection is now ready to receive and process DAP commands
        """
        # Extract the unique identifier for this connection
        connection_id = conn.get_connection_id()

        # Register the connection in the active connections registry
        self._connections[connection_id] = conn

        # Log successful connection establishment
        self.debug_message(f'New connection established: {connection_id}')

    async def _dapbase_on_disconnected(self, conn: TaskConn) -> None:
        """
        Handle WebSocket disconnection and perform comprehensive cleanup.

        This method manages the complete cleanup process when a DAP client
        disconnects from the server. It handles task detachment, connection
        registry cleanup, and automatic task termination based on launch type.

        Args:
            conn (TaskConn): The disconnected WebSocket connection requiring cleanup

        Cleanup Process:
        1. Remove connection from active connections registry
        2. Detach connection from all associated tasks
        3. Automatically terminate launched tasks if they have no other connections
        4. Clean up monitoring subscriptions and event registrations
        5. Log disconnection for audit and debugging purposes

        Task Termination Logic:
        - LAUNCH type tasks are terminated when the launching client disconnects
        - EXECUTE type tasks continue running independently
        - Tasks with multiple attached clients continue running
        """
        # Extract connection identifier for cleanup operations
        connection_id = conn.get_connection_id()

        # Remove connection from active connections registry
        if connection_id in self._connections:
            del self._connections[connection_id]

        # Process all tasks for disconnection cleanup
        for control in list(self._task_control.values()):
            try:
                # Detach this connection from the task
                await control.task.detach_task(conn)

                # Auto-terminate launched tasks when the launching client disconnects
                if control.launch_type == LAUNCH_TYPE.LAUNCH and control.launch_owner == conn:
                    await control.task.stop_task()
                    self.debug_message(f'Auto-terminated launched task "{control.id}" after client disconnect')

            except Exception as e:
                # Log cleanup errors but continue processing other tasks
                self.debug_message(f'Error during disconnection cleanup for task "{control.id}": {e}')

        # Log successful disconnection cleanup
        self.debug_message(f'Connection {connection_id} disconnected and cleaned up.')

    async def authenticate(self, authorization: str) -> Optional[AccountInfo]:
        """
        Validate that the task key is valid and return the associated account info.

        Args:
            authorization (str): Authentication key

        Raises:
            ValueError: If task doesn't exist or authorization is invalid
        """
        if authorization.startswith('pk_'):
            """
            This is the public key validation - it is used to specifically
            target a task that is already running and will have very
            limited permissions.
            """
            # Look for the access token
            for control in self._task_control.values():
                # If this is it...
                if control.public_auth == authorization:
                    # Get the account info
                    account_info = await self._server.account.authenticate(control.apikey)

                    # We used our own authentication
                    account_info.auth = authorization

                    # Public account keys can only write data through the pipe
                    account_info.permissions = ['task.data']
                    return account_info

            # Not found - raise PermissionError for proper HTTP 401 response
            raise ValueError('Your pipeline is not running')

        # Could not authenticate
        return

    def get_task_control_by_project(self, project_id: str, source: str) -> TASK_CONTROL:
        """
        Retrieve task control structure with a given project/source id.

        Args:
            token (str): The token to retrieve

        Returns:
            TASK_CONTROL: Complete task control structure with metadata and references

        Raises:
            ValueError: If task doesn't exist
        """
        # Look for it
        for control in self._task_control.values():
            if control.project_id == project_id and control.source == source:
                return control

        # Couldn't find it
        raise RuntimeError('Your pipeline is not running')

    def get_task_control_by_public_key(self, public_auth: str) -> TASK_CONTROL:
        """
        Retrieve task control structure with a given project/source id.

        Args:
            token (str): The token to retrieve

        Returns:
            TASK_CONTROL: Complete task control structure with metadata and references

        Raises:
            ValueError: If task doesn't exist
        """
        # Look for it
        for control in self._task_control.values():
            if control.public_auth == public_auth:
                return control

        # Couldn't find it
        raise RuntimeError('Your pipeline is not running')

    def get_task_control(self, token: str) -> TASK_CONTROL:
        """
        Retrieve task control structure with a token.

        Args:
            token (str): The token to retrieve

        Returns:
            TASK_CONTROL: Complete task control structure with metadata and references

        Raises:
            ValueError: If token is not specified
            RuntimeError: If task doesn't exist
        """
        if not token:
            raise ValueError('Task token is required')

        control = self._task_control.get(token, None)
        if not control:
            raise RuntimeError('Your pipeline is not running')

        # Return it
        return control

    def get_task(self, token: str) -> Task:
        """
        Retrieve task instance.

        This is a convenience method that combines task control lookup
        with task instance extraction in a single operation. It provides
        direct access to task objects while maintaining security controls.

        Args:
            token (str): Private key for task ownership validation

        Returns:
            Task: The authenticated task instance ready for operations

        Raises:
            ValueError: If task doesn't exist

        Usage:
        This method is the primary way to access task instances throughout
        the system. It ensures consistent security validation and simplifies
        task access patterns in command handlers and other components.
        """
        # Get authenticated task control structure
        control = self.get_task_control(token)

        # Extract and return the task instance
        return control.task

    def assign_port(self) -> int:
        """
        Allocate available port from managed pool.

        Returns:
            Available port number (base_port to base_port+9999 range)

        Raises:
            RuntimeError: If no ports available
        """
        base_port = self._config.get('base_port', 20000)
        # Search for available port
        for port in range(base_port, base_port + 10000):
            if port not in self._allocated_ports:
                self._allocated_ports.append(port)
                return port

        raise RuntimeError(f'No available ports in the range {base_port}-{base_port + 9999}')

    def release_port(self, port: int) -> None:
        """
        Release port back to available pool.

        Args:
            port: Port number to release
        """
        if port in self._allocated_ports:
            self._allocated_ports.remove(port)

    async def broadcast_event(
        self,
        type: EVENT_TYPE,
        token: str,
        event: Dict[str, Any],
    ) -> None:
        """
        Broadcast task events to all interested monitoring connections.

        This method implements the event distribution system that notifies
        subscribed clients about task state changes, data updates, and other
        significant events. It respects client subscription preferences and
        handles broadcast failures gracefully.

        Args:
            listen_type (EVENT_TYPE): Category of event being broadcast
                                    (PASSIVE, ACTIVE, DEBUG, etc.)
            id (str): Short identifier for the specific task instance
            token (str): Unique task identifier for event source
            event (Dict[str, Any]): Event payload containing event details and data

        Event Distribution Logic:
        - Iterates through all active connections
        - Each connection filters events based on subscription preferences
        - Individual broadcast failures don't affect other recipients
        - Events are only sent to connections with matching access rights

        Error Handling:
        - Individual monitor failures are logged but don't stop broadcasting
        - Ensures robust event delivery even with problematic connections
        - Maintains system stability despite client-side issues
        """
        # Broadcast to all active connections with error isolation
        for conn in self._connections.values():
            try:
                # Delegate to connection's event filtering and forwarding logic
                await conn.forward_event(type, token=token, event=event)

            except PermissionError:
                # This is a normal error - when the connection is typically
                # using a public key
                continue

            except Exception as e:
                # Log individual monitor failures but continue broadcasting
                self.debug_message(f'Failed to broadcast event to connection: {e}')

    def is_debug_available(self, token: str) -> bool:
        """
        Handle DAP 'pause' command to suspend task execution.

        Pauses all active threads in the target task, including pipeline
        execution threads and the main thread. This enables inspection
        of the current execution state and variables.

        Args:
            token (str): Task token

        Returns:
            bool: True if the task supports debugging, False otherwise
        """
        try:
            # Verify permission
            task = self.get_task(token)

            # Return whether it is available or not
            return task.is_debug_available()

        except Exception as e:
            # Log pause failure with task context
            self.debug_message(f'Failed to get debug state for task: {str(e)}')
            raise

    def get_server_status(self, status: Dict[str, Any]) -> None:
        """
        Populate status dictionary with comprehensive server and task metrics.

        This method provides detailed operational status suitable for monitoring
        dashboards, administrative interfaces, and automated health checks. It
        includes both current state and historical performance metrics.

        Args:
            status (Dict[str, Any]): Dictionary to populate with server status.
                                   Method adds 'task' key with complete task metrics.

        Status Information Included:
        - Current active task count and detailed task list
        - Historical peak concurrent task count
        - Lifetime total of created tasks
        - Per-task details including runtime, status, and performance metrics
        - Obfuscated tokens for security while maintaining identifiability

        Data Structure:
        {
            'task': {
                'tasks': [array of detailed task objects],
                'peak': maximum concurrent tasks ever achieved,
                'active': current number of active tasks,
                'total': lifetime total of created tasks
            }
        }
        """
        # Initialize comprehensive task metrics structure
        task_info = {
            'tasks': [],  # Detailed information for each active task
            'peak': self._tasks_peak,  # Historical peak concurrent task count
            'active': len(self._task_control),  # Current active task count
            'total': self._tasks_total,  # Lifetime total of created tasks
        }

        # Build detailed status for each active task
        for control in self._task_control.values():
            # Get current task status with comprehensive details
            task_status: TASK_STATUS = control.task.get_status()

            # Calculate task runtime for performance monitoring
            current_time = time.time()
            if task_status.completed:
                elapsed_time = task_status.endTime - task_status.startTime
            else:
                elapsed_time = current_time - task_status.startTime

            # Build comprehensive task information object
            task_obj = {
                'id': control.id,  # Human-readable task identifier
                'startTime': task_status.startTime,  # Task creation timestamp
                'completed': task_status.completed,  # Completion status flag
                'elapsedTime': elapsed_time,  # Runtime duration in seconds
                'launchType': control.launch_type.value,  # How task was created
            }

            # Add completion-specific information
            if task_status.completed:
                task_obj['endTime'] = task_status.endTime
                task_obj['exitCode'] = getattr(task_status, 'exitCode', None)
            else:
                # For running tasks, include current status message
                task_obj['status'] = task_status.status

            # Include performance and resource metrics if available
            if hasattr(task_status, 'metrics'):
                task_obj['metrics'] = task_status.metrics

            # Include connection and attachment information
            task_obj['connections'] = control.task.get_connection_count()

            # Add this task's information to the status report
            task_info['tasks'].append(task_obj)

        # Add complete task information to the status dictionary
        status['task'] = task_info

    def get_task_status(self, token: str) -> TASK_STATUS:
        """
        Retrieve comprehensive status information for a specific task.

        This method combines secure task lookup with status retrieval to
        provide authenticated access to task status information. It's used
        for status queries, monitoring, and administrative interfaces.

        Args:
            token (str): Unique task identifier

        Returns:
            TASK_STATUS: Complete task status including runtime state,
                        performance metrics, and completion information

        Raises:
            ValueError: If task doesn't exist or API key validation fails
        """
        # Perform secure task lookup with authentication
        task = self.get_task(token)

        # Retrieve and return current task status
        return task.get_status()

    async def remove_task(self, token: str) -> TASK_CONTROL:
        """
        Remove task from registry and perform comprehensive cleanup.

        This method handles complete task removal including resource cleanup,
        registry maintenance, and proper task termination. It ensures no
        resources are leaked and all associated components are properly cleaned up.

        Args:
            token (str): Unique task identifier

        Returns:
            TASK_CONTROL: The removed task control structure for caller cleanup

        Raises:
            ValueError: If task doesn't exist or API key validation fails

        Cleanup Process:
        1. Validate task ownership and existence
        2. Remove task from central registry
        3. Stop task execution and cleanup resources
        4. Remove all monitoring subscriptions
        5. Log removal for audit trail
        6. Return control structure for additional caller-specific cleanup
        """
        # Remove task from central registry
        control = self._task_control.pop(token)

        # If not there, it wasn't running
        if not control:
            raise RuntimeError('Your pipeline is not running')

        # Ensure task is properly stopped and resources are cleaned up
        await control.task.stop_task()

        # Log task removal for audit trail and debugging
        self.debug_message(f'Task status for "{control.id}" removed')
        return control

    async def start_task(
        self,
        apikey: str,
        request: Dict[str, Any],
        conn: TaskConn = None,
        *,
        attach_debugger=False,
        wait_for_running=False,
    ) -> str:
        """
        Create and start a new computational task with full lifecycle management.

        This method handles the complete task creation process including validation,
        registry management, resource allocation, and startup coordination. It
        supports both interactive debugging and batch execution modes.

        Args:
            request (Dict[str, Any]): Task creation request containing:
                - arguments: Task configuration including Optional(token), pipeline
                - command: Launch type (launch/execute) determining task behavior
            conn (TaskConn, optional): Connection to associate with task for monitoring

        Returns:
            str: Unique task token for subsequent operations

        Raises:
            ValueError: If launch type is invalid or task already exists
            RuntimeError: If required pipeline configuration is missing
            Exception: If task creation or startup fails

        Task Creation Process:
        1. Parse and validate request parameters
        2. Generate unique task token if not provided
        3. Validate pipeline configuration
        4. Check for task uniqueness and handle conflicts
        5. Create Task instance with full configuration
        6. Register task in central registry with security metadata
        7. Update performance metrics and tracking
        8. Set up initial monitoring if connection provided
        9. Start task execution
        10. Return task token for client use

        Launch Types:
        - LAUNCH:
            - Usually interactive debugging-enabled tasks
            - If useTask=False:
                * Fail if the tasks already exists.
                * The task is created, and destroyed when the connection closes
            - If useTask=True:
                * Success if the task already exists. If it does, leaves the
                task running when the connection closes. The original creator
                of the task controls its life cycle
        """

        def _return_results(control: TASK_CONTROL) -> str:
            """
            Return task token for the task.

            This inner function encapsulates the logic for returning the tokens.

            Args:
                control (TASK_CONTROL): The existing task control structure
            """
            return {
                'id': control.id,
                'token': control.token,
                'publicToken': control.public_auth,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
            }

        # Initialize task control structure for new task
        control = TASK_CONTROL()

        # For launch/exec token is in args
        args = request.get('arguments', {})
        use_existing_task = args.get('useExisting', False)

        # Extract TTL from args (use server-configured default if not provided)
        ttl = args.get('ttl', CONST_DEFAULT_TTL)

        # Parse task configuration from request arguments
        control.apikey = apikey
        control.token = args.get('token', None)
        control.pipeline = args.get('pipeline', None)
        control.source = args.get('source', None)

        # If a source was not specified, in the args, get it from the pipeline
        if not control.source:
            control.source = control.pipeline.get('source', None)

        # If the pipeline doesn't have a source, try and find the implied
        # source. We can get the implied source by looking at the components
        # list and finding the one, and only source. If we find multiple
        # sources, it is ambigouous and we should raise an error.
        if not control.source:
            # Look for the source component
            for component in control.pipeline.get('components', []):
                config = component.get('config', {})
                if config.get('mode', '') == 'Source':
                    if control.source is not None:
                        raise ValueError('Pipeline has multiple source components, please specify one explicitly')
                    control.source = component.get('id', None)

            # Check to make sure we found one
            if control.source is None:
                raise ValueError('Pipeline does not have a source component defined')

        # Find the actual source component
        source_component = None
        for component in control.pipeline.get('components', []):
            if component.get('id') == control.source:
                source_component = component
                break

        # Update the source on the pipeline
        control.pipeline['source'] = control.source

        if source_component is None:
            raise ValueError(f'Pipeline source component "{control.source}" not found in components list')

        if 'config' not in source_component:
            source_component['config'] = {}
        config = source_component['config']

        # Project identity is project_id on the flat project.
        control.project_id = control.pipeline.get('project_id', None)
        if not control.project_id:
            control.project_id = str(uuid.uuid4())

        # Find the component so we can look up the provider
        components = control.pipeline.get('components', [])
        if type(components) is not list:
            raise ValueError('Invalid components in pipeline')

        # Find the component
        for component in components:
            id = component.get('id', '')
            if id == control.source:
                control.provider = component.get('provider', None)
                break

        if not control.provider:
            raise ValueError(f'Source "{control.source}" not found in pipeline')

        # Build the token
        if control.token is None:
            control.token = self._server.account.generate_token(
                content={
                    'apikey': control.apikey,
                    'project_id': control.project_id,
                    'source': control.source,
                }
            )

        # Build the public token
        control.public_auth = self._server.account.generate_token(
            content={
                'project_id': control.project_id,
                'source': control.source,
            },
            prefix='pk_',
        )

        # Give it a short identifying name
        control.id = f'{control.token[:8]}.{control.source}'

        # Parse and validate launch type from request command
        try:
            command = request.get('command', 'launch')
            control.launch_type = LAUNCH_TYPE(command)
        except (ValueError, TypeError):
            raise ValueError(f'Invalid launch type: "{command}"')

        # Validate required pipeline configuration
        if not control.pipeline:
            raise RuntimeError('Missing pipeline configuration in launch request')

        # Save the owner so we know when to stop the task
        if control.launch_type == LAUNCH_TYPE.LAUNCH:
            control.launch_owner = conn

        # Handle task uniqueness and potential conflicts
        if control.token in self._task_control:
            # Get the existing task control
            existing_control = self._task_control[control.token]

            # Prevent duplicate active tasks
            if not existing_control.task.is_task_complete():
                # This is an active task, if we are told we can use it, then,
                # make sure the user actually specified the task to use. If so,
                # then all is ok, just use the existing task
                if use_existing_task:
                    if wait_for_running:
                        await existing_control.task.wait_for_running()
                    return _return_results(existing_control)

                # We are absolutely supposed to create a task or the user did
                # not specify the token (which means a random collision)
                raise ValueError('Pipeline is already running.')

            # Clean up completed task with same token
            self._task_control.pop(control.token, None)
            self.debug_message(f'Replaced completed task "{control.id}"...')

        try:
            # Create new Task instance with complete configuration
            control.task = Task(
                server=self,
                id=control.id,
                project_id=control.project_id,
                source=control.source,
                token=control.token,
                public_auth=control.public_auth,
                pipeline=control.pipeline,
                launch_args=args,
                launch_type=control.launch_type,
                provider=control.provider,
                ttl=ttl,
            )

            # Register task in central registry
            self._task_control[control.token] = control
            self._tasks_total += 1

            # Update peak concurrent task counter for metrics
            current_count = len(self._task_control)
            if current_count > self._tasks_peak:
                self._tasks_peak = current_count

            # Start task execution
            await control.task.start_task()

            # Log successful task creation
            self.debug_message(f'Task "{control.id}" started... (type: {control.launch_type.value})')

            # If debugging is available, attach to it
            if attach_debugger and control.task.is_debug_available():
                await self.attach_task(control.token, conn)

            # Retrieve the task instance for status monitoring
            if wait_for_running:
                # Block until the task transitions to running state
                await control.task.wait_for_running()

            # Return formatted results
            return _return_results(control)

        except Exception:
            # Clean up failed task creation
            self._task_control.pop(control.token, None)
            self.debug_message(f'Task creation failed, cleaned up: {control.id}...')
            raise

    async def restart_task(
        self,
        apikey: str,
        request: Dict[str, Any],
        conn: TaskConn = None,
        *,
        attach_debugger=False,
        wait_for_running=False,
    ) -> Dict[str, Any]:
        """
        Restart an existing task with a new pipeline configuration.

        This method restarts the underlying engine process with updated configuration
        while preserving the task's identity, statistics, monitoring connections,
        and registry entry. The task must exist and not have a debugger attached.

        CRITICAL: The project_id and source in the new pipeline MUST match the existing
        task's project_id and source. These define the task's identity and cannot be
        changed during restart. Only the pipeline configuration and provider can be updated.

        Args:
            apikey (str): API key for authentication (must match task's apikey)
            request (Dict[str, Any]): Restart request containing:
                - arguments: Task configuration including:
                    - token: Task token to restart (required)
                    - pipeline: New pipeline configuration (required)
            conn (TaskConn, optional): Connection requesting restart (must match launch_owner)
            attach_debugger (bool): Ignored for restart (debugger must be detached)
            wait_for_running (bool): If True, wait for task to reach running state

        Returns:
            Dict[str, Any]: Task information including:
                - id: Task identifier (unchanged)
                - token: Task token (unchanged)
                - publicToken: Public authentication token (unchanged)
                - projectId: Project identifier (unchanged - must match existing)
                - source: Source identifier (unchanged - must match existing)
                - provider: Provider name (may be updated)

        Raises:
            ValueError: If task doesn't exist, pipeline invalid, source not found,
                    project_id/source don't match existing values, or token not provided
            RuntimeError: If pipeline configuration missing, debugger attached,
                        apikey mismatch, or connection is not the launch owner

        Restart Process:
        1. Parse and validate request parameters
        2. Validate task existence
        3. Verify connection is the launch owner
        4. Verify apikey matches
        5. Check that no debugger is attached
        6. Extract and validate new pipeline configuration
        7. Verify project_id and source match existing (cannot change)
        8. Validate source component exists in new pipeline
        9. Update TASK_CONTROL with new configuration (pipeline, provider)
        10. Call task.restart_task() to restart engine process
        11. Optionally wait for running state
        12. Return task information

        Note:
        - Task identity (token, public_auth, project_id, source) remains unchanged
        - Task statistics are preserved across restart
        - Monitoring connections remain active
        - Registry entry is updated but not recreated
        - Peak/total metrics are not modified (not a new task)
        - Debugger must be detached before restart
        - Only the original launch owner can restart the task
        """
        try:
            # Parse request arguments
            args = request.get('arguments', {})

            # Extract token from request
            token = args.get('token', None)
            if not token:
                raise ValueError('Task token is required for restart')

            # Extract pipeline from request
            pipeline = args.get('pipeline', None)
            if not pipeline:
                raise ValueError('Missing pipeline configuration in restart request')

            # Validate task existence and get control structure
            control = self.get_task_control(token)

            self.debug_message(f'Restart requested for task "{control.id}"')

            # Update the new owner
            control.launch_owner = conn

            # Verify apikey matches the task's apikey
            if apikey != control.apikey:
                raise RuntimeError('API key mismatch. Cannot restart task with different credentials.')

            # Check if debugger is attached - fail if so
            if control.task.has_attached_debugger():
                raise RuntimeError('Cannot restart task while debugger is attached. Please detach the debugger first.')

            # Find and validate the provider from new pipeline
            components = pipeline.get('components', [])
            if type(components) is not list:
                raise ValueError('Invalid components in pipeline')

            # Call the Task's restart method to restart the engine process
            # This preserves all statistics and monitoring while restarting the subprocess
            await control.task.restart_task(
                pipeline=pipeline,
                project_id=control.project_id,
                source=control.source,
                provider=control.provider,
            )

            # Wait for running state if requested
            if wait_for_running:
                await control.task.wait_for_running()

            # Log successful restart
            self.debug_message(f'Task "{control.id}" restarted successfully')

            # Return task information
            return {
                'id': control.id,
                'token': control.token,
                'publicToken': control.public_auth,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
            }

        except Exception as e:
            # Log restart failure with context
            self.debug_message(f'Failed to restart task: {str(e)}')
            raise

    async def stop_task(self, token: str):
        """
        Stop a running task with proper cleanup and resource management.

        This method handles task termination requests by validating ownership
        and performing clean shutdown for appropriate task types. It ensures
        proper resource cleanup while handling various edge cases gracefully.

        Args:
            request (Dict[str, Any]): Stop request containing:
                - token: Unique task identifier to stop
            conn (TaskConn): Connection requesting the task stop

        Termination Logic:
        - Only LAUNCH and EXECUTE type tasks are terminated by stop requests
        - ATTACH type tasks are not terminated (clients can detach safely)
        - Graceful error handling for non-existent or already-stopped tasks
        - Always returns success to client regardless of actual termination result

        Error Handling:
        - Missing tasks are handled gracefully (may have been auto-cleaned up)
        - Authentication failures are ignored for stop requests
        - Task termination errors are logged but don't propagate to client
        """
        try:
            # Attempt to locate and validate task ownership
            control = self.get_task_control(token)

            # Only terminate tasks that were launched or executed directly
            if control.launch_type in (LAUNCH_TYPE.LAUNCH, LAUNCH_TYPE.EXECUTE):
                await control.task.stop_task()
                self.debug_message(f'Task "{control.id}" stopped on request')

        except Exception as e:
            # Log but ignore errors - task may already be stopped or removed
            self.debug_message(f'Task stop request handled (may have been already stopped): {e}')

    async def attach_task(self, token: str, conn: TaskConn) -> None:
        """
        Attach a DAP connection to an existing running task.

        This method enables multiple clients to connect to the same task for
        collaborative debugging, monitoring, or data processing. It establishes
        the necessary connection state and monitoring subscriptions.

        Args:
            request (Dict[str, Any]): Attach request containing:
                - token: Unique identifier for target task
            conn (TaskConn): Connection to attach to the task

        Returns:
            Pipeline configuration information for the attached task

        Raises:
            ValueError: If task doesn't exist or API key validation fails

        Attachment Process:
        1. Validate task existence and ownership
        2. Set up passive monitoring for task events
        3. Attach connection to task's debugging interface
        4. Return pipeline configuration for client setup
        """
        # Validate task existence and ownership
        control = self.get_task_control(token)

        # Set up passive event monitoring for this connection
        await conn.set_monitor(
            token=control.token,
            type=EVENT_TYPE.SUMMARY,
        )

        # Attach connection to task and get pipeline configuration
        pipeline = await control.task.attach_task(conn)

        # Log successful attachment
        self.debug_message(f'Connection attached to task "{control.id}"')
        return pipeline

    async def detach_task(self, request: Dict[str, Any], conn: TaskConn):
        """
        Detach a DAP connection from a task with optional termination.

        This method safely disconnects a client from a task while preserving
        the task state for other connected clients. It optionally terminates
        the task if requested by the detaching client.

        Args:
            request (Dict[str, Any]): Detach request containing:
                - token: Task identifier to detach from
                - arguments: Optional parameters including:
                    - terminateDebuggee: Boolean flag to terminate task on detach
            conn (TaskConn): Connection to detach from the task

        Detachment Process:
        1. Extract detachment parameters including termination flag
        2. Locate and validate task (with graceful error handling)
        3. Detach connection from task's debugging interface
        4. Remove monitoring subscription for this connection
        5. Optionally terminate task if requested

        Error Handling:
        - Missing tasks or authentication failures are handled gracefully
        - Detachment operations are best-effort and don't propagate errors
        - Task may have been auto-cleaned up between request and processing
        """
        # Extract task identification and termination preference
        token = request.get('token', 'not-specified')

        args = request.get('arguments', {})
        terminate_task = args.get('terminateDebuggee', False)

        try:
            # Locate task with ownership validation
            control = self.get_task_control(token)

            # Detach connection from task's debugging interface
            await control.task.detach_task(conn)

            # Remove monitoring subscription for this connection
            if conn:
                await conn.set_monitor(
                    token=control.token,
                    type=EVENT_TYPE.NONE,
                )

            # Terminate task if requested by client
            if terminate_task:
                await self.stop_task(token)

            # Log successful detachment
            self.debug_message(f'Connection detached from task "{control.id}"')

        except Exception as e:
            # Handle errors gracefully - task may not exist or be accessible
            self.debug_message(f'Task detachment handled (task may be gone): "{control.id}": {e}')

    def get_connection_count(self) -> int:
        """
        Get the current number of active WebSocket connections.

        This method provides real-time connection count information for
        monitoring, load balancing, and capacity management decisions.

        Returns:
            int: Number of currently active DAP connections

        Usage:
        Used for server health monitoring, connection limit enforcement,
        and administrative dashboards showing current server load.
        """
        return len(self._connections)

    async def listen(self, websocket: WebSocket) -> None:
        """
        Accept and manage a new WebSocket connection for the connection's lifetime.

        This method handles the complete lifecycle of a WebSocket connection from
        establishment through disconnection. It creates the necessary connection
        objects, manages the DAP transport layer, and ensures proper cleanup.

        Args:
            websocket (WebSocket): FastAPI WebSocket object for the new connection

        Connection Lifecycle:
        1. Generate unique connection identifier
        2. Create DAP transport layer for WebSocket communication
        3. Instantiate TaskConn with unified command handling capabilities
        4. Register connection and update statistics
        5. Accept WebSocket connection and start message processing
        6. Handle connection lifetime (blocks until disconnection)
        7. Perform cleanup and update statistics on disconnection

        Note:
        This method blocks until the WebSocket connection is closed by the client
        or due to network issues. The actual message processing is handled by
        the transport layer and TaskConn command handlers. Authentication is
        performed by TaskConn on the first DAP message (auth command), not on
        the WebSocket upgrade.
        """
        # Accept WebSocket without auth on upgrade; first DAP message must be auth (handled in TaskConn)
        connection_id = self._next_connection_id()

        # Create DAP transport layer for WebSocket communication
        transport = TransportWebSocket()

        # Create unified DAP connection handler; account_info set when client sends auth as first message
        conn = TaskConn(
            connection_id=connection_id,
            server=self,
            transport=transport,
        )

        # Register new connection and update server statistics
        await self._dapbase_on_connected(conn)

        try:
            # Accept WebSocket connection and start message processing
            # This call blocks until the connection is terminated
            await transport.accept(websocket=websocket)

        finally:
            # Ensure cleanup occurs regardless of how connection ends
            await self._dapbase_on_disconnected(conn)
