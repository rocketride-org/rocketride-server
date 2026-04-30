"""
Task: Pipeline Task Execution and Lifecycle Management System.

This module provides the core Task class for orchestrating computational pipeline tasks
in isolated subprocess environments. It handles debugging interfaces, real-time monitoring,
resource allocation, multi-client connectivity, and error handling for distributed
data processing systems.

Key Features:
- Isolated subprocess execution with complete lifecycle management
- Multi-interface debugging (DAP, debugpy, stdio) with IDE integration
- Real-time status monitoring and event broadcasting
- Resource management (ports, temporary files, cleanup)
- Multi-client support for collaborative debugging
- Environment-aware configuration (development/production)

Classes:
    Task: Main pipeline task execution and lifecycle management

Constants:
    CONST_DEFAULT_MAX_THREADS: Default thread pool size (4)
    CONST_CANCEL_WAIT_TIMEOUT_SECONDS: Graceful termination timeout (5s)
    CONST_STATUS_UPDATE_FREQ: Status update frequency (100ms)
    CONST_MAX_READY_TIME: Maximum time to wait for task readiness (30s)

Global Resources:
    allocated_ports: Port allocation tracking to prevent conflicts
    copied_python_shim: Development environment optimization flag
"""

import os
import asyncio
import sys
import json
import tempfile
import time
import socket
import hashlib
import shlex
import shutil
import re
from typing import TYPE_CHECKING, Dict, Any, List, Optional
from tenacity import retry, stop_after_attempt, wait_fixed

from rocketlib import debug, args as startup_args
from ai.constants import (
    CONST_DEFAULT_MAX_THREADS,
    CONST_CANCEL_WAIT_TIMEOUT_SECONDS,
    CONST_STATUS_UPDATE_FREQ,
    CONST_MAX_READY_TIME,
    CONST_READY_POLL_INTERVAL,
    CONST_SUBPROCESS_BUFFER_LIMIT,
    CONST_STATUS_UPDATE_CANCEL_TIMEOUT,
)
from ai import CONST_AI_NODE_SCRIPT
from ai.web.metrics import metrics
from ai.common.dap import DAPBase, DAPClient, TransportWebSocket
from rocketride import TASK_STATUS, TASK_STATUS_FLOW, TASK_STATE, EVENT_TYPE
from .dbg_debugpy import DbgDebugpy
from .dbg_stdio import DbgStdio
from .types import LAUNCH_TYPE
from .task_conn import TaskConn
from .task_metrics import TaskMetrics


if TYPE_CHECKING:
    from .task_server import TaskServer


# Development environment optimization
copied_python_shim = False


class Task(DAPBase):
    """
    Pipeline task execution and lifecycle management system.

    Orchestrates the complete lifecycle of computational pipeline tasks with isolated
    subprocess execution, debugging interfaces, real-time monitoring, and resource
    management for development and production environments.

    Task States:
        NONE: Initial state
        STARTING: Resource allocation and setup
        INITIALIZING: Pipeline initialization
        RUNNING: Active execution
        STOPPING: Graceful shutdown
        COMPLETED: Successful completion
        CANCELLED: User termination

    Communication Interfaces:
        DAP: Debug Adapter Protocol for standardized debugging
        debugpy: Python debugger for IDE integration
        stdio: Direct subprocess communication
        WebSocket: Real-time event broadcasting

    Attributes:
        apikey (str): Authentication key for multi-tenant security
        token (str): Unique task identifier
        _server (TaskServer): Central orchestration server
        _status (TASK_STATUS): Task state and statistics
        _engine_process (Optional[Process]): Subprocess handle
        _debugger (Optional[TaskConn]): Primary debugging connection
        _debug_python (Optional[DbgDebugpy]): debugpy interface
        _debug_stdio (Optional[DbgStdio]): stdio interface
        _data_client (Optional[DAPClient]): Data communication client
        _debug_port (Optional[int]): debugpy communication port
        _data_port (Optional[int]): Data communication port
        _status_update_task (Optional[Task]): Background status broadcasting
        _is_terminating (bool): Termination state flag
        _termination_lock (asyncio.Lock): Atomic termination operations
    """

    class TaskDbgStdio(DbgStdio):
        """DAP client for stdio communication with subprocess."""

        def __init__(self, parent_task: 'Task', **kwargs):
            """Initialize stdio transport with parent task integration."""
            self._parent_task = parent_task
            super().__init__(**kwargs)

        async def on_event(self, event: Dict[str, Any]) -> None:
            """
            Handle DAP events from subprocess.

            Routes events to parent Task for broadcasting to connected clients.

            Args:
                event: DAP event message from subprocess
            """
            await self._parent_task.on_event(event)

        async def on_disconnected(self, reason=None, has_error=False):
            """
            Handle transport disconnection.

            Called when subprocess terminates (normal exit, crash, kill, etc).
            Guaranteed to be called exactly once.
            """
            await self._parent_task._terminated()

    class TaskDbgDebugpy(DbgDebugpy):
        """DAP client for debugpy server connections."""

        def __init__(self, parent_task: 'Task', **kwargs):
            """Initialize debugpy client with parent task integration."""
            self._parent_task = parent_task
            super().__init__(**kwargs)

        async def on_event(self, event: Dict[str, Any]) -> None:
            """
            Handle DAP events from debugpy server.

            Routes events to parent Task for broadcasting to connected clients.

            Args:
                event: DAP event message from debugpy
            """
            # Get the type of event
            event_type = event.get('event', '')

            # Our initialization sequence and termination sequence handles sending these
            # events when it is ready
            if event_type == 'initialized' or event_type == 'terminated':
                return

            await self._parent_task.on_event(event)

    class TaskData(DAPClient):
        """DAP client for data communication with pipeline."""

        def __init__(self, parent_task: 'Task', **kwargs):
            """Initialize debugpy client with parent task integration."""
            self._parent_task = parent_task
            super().__init__(**kwargs)

        async def on_disconnected(self, reason=None, has_error=False):
            """
            Handle unusual disconnection on the data channel.
            """
            # Clear it so the next time we come through, we try again
            self._parent_task._data_client = None

    def __init__(
        self,
        server: 'TaskServer',
        id: str,
        project_id: str,
        source: str,
        token: str,
        public_auth: str,
        pipeline: Dict[str, Any],
        launch_args: Dict[str, Any] = None,
        launch_type: LAUNCH_TYPE = LAUNCH_TYPE.LAUNCH,
        provider: str = None,
        ttl: int = 900,
        client_id: str = '',
        **kwargs,
    ) -> None:
        """
        Initialize Task with configuration and resource setup.

        Args:
            server: Central orchestration server
            token: Token for task authentication
            pipeline: Complete pipeline configuration
            launch_args: Launch configuration parameters
            launch_type: Task creation mode (launch/attach)
            ttl: Time-to-live in seconds for idle tasks (default: 900 = 15 minutes; 0 = no timeout)
            client_id: Account identifier for store access scoping
            **kwargs: Additional DAP configuration
        """
        # Store authentication
        self.id = id
        self.project_id = project_id
        self.source = source
        self.token = token
        self.public_auth = public_auth
        self.client_id = client_id

        # TTL management - count-up timer approach
        self._ttl = ttl  # Maximum idle time in seconds
        self._idle_time = 0  # Current idle time in seconds (resets on activity)

        # Have the final events been sent yet
        self._final_events_sent = False

        # Guard against _terminated() being called more than once
        self._terminated_called = False

        # Server reference
        self._server = server

        # Store configuration
        self._kwargs = kwargs

        # Save the source provider type
        self._provider = provider

        # Status annotations for operational context
        self._service_up_notes = []
        self._service_down_notes = []

        # Execution configuration
        _args = launch_args or {}
        self._threads = _args.get('threads', CONST_DEFAULT_MAX_THREADS)
        self._pipelineTraceLevel = _args.get('pipelineTraceLevel', None)
        self._task_name: Optional[str] = _args.get('name', None)
        self._engine_process: Optional[asyncio.subprocess.Process] = None

        # Status tracking
        self._status = TASK_STATUS()
        self._status_trace: List[str] = []
        self._status.project_id = project_id
        self._status.source = source

        # Info capture from >INF* output
        self.info: Dict[str, Any] = {}

        # Resource metrics tracking
        self._task_metrics: Optional[TaskMetrics] = None

        # System identification
        self._hostname = socket.gethostname()

        # Lifecycle state
        self._tmpfile = None
        self._stop_requested = False

        # Client connections
        self._debugger: Optional[TaskConn] = None
        self._monitors: Dict[TaskConn, EVENT_TYPE] = {}

        # Debug interfaces
        self._debug_port: Optional[int] = None
        self._debug_python: Optional[Task.TaskDbgDebugpy] = None
        self._debug_stdio: Optional[Task.TaskDbgStdio] = None

        # Data communication
        self._data_lock: asyncio.Lock = asyncio.Lock()
        self._data_port: Optional[int] = None
        self._data_client: DAPClient = None

        # Status broadcasting
        self._status_update_task: Optional[asyncio.Task] = None
        self._status_updated = False

        # Synchronization
        self._last_event_time = time.time()

        # Subprocess debugging flag
        self._debug_subprocess = False

        # Launch configuration
        self._noDebug = launch_args.get('noDebug', False)

        # Termination management
        self._is_restarting = False
        self._is_terminating = False
        self._termination_lock = asyncio.Lock()

        # Store complete configuration
        self._launch_args = launch_args
        self._launch_type: LAUNCH_TYPE = launch_type
        self._pipeline: Dict[str, Any] = pipeline

        # Initialize DAP base
        super().__init__(f'TASK-{self.id}', **kwargs)

    # Only environment variables with this prefix are permitted to resolve in pipelines.
    # All other env vars are blocked to prevent exfiltration of secrets via ${VAR} expansion.
    ALLOWED_ENV_PREFIX = 'ROCKETRIDE_'

    def _resolve_pipeline(self, pipeline: Dict[str, Any]) -> Dict[str, Any]:
        """
        Replace ${KEY} placeholders in a pipeline dictionary with environment variable values.

        Only environment variables whose names start with ALLOWED_ENV_PREFIX
        are resolved. All other references are replaced with a redacted
        placeholder to prevent secret exfiltration.

        Args:
            pipeline: Dictionary containing the pipeline configuration

        Returns:
            New dictionary with resolved environment variables
        """
        # Convert dict to JSON string
        pipeline_str = json.dumps(pipeline)

        # Replace ${VAR_NAME} with environment variable value (if allowed)
        def replacer(match):
            env_var = match.group(1)
            if env_var.startswith(self.ALLOWED_ENV_PREFIX):
                # Check JSON injection vulnerability in env var resolution.
                value = os.environ.get(env_var, match.group(0))
                if value == match.group(0):
                    return value  # placeholder not found
                return json.dumps(value)[1:-1]  # escape but strip outer quotes
            return '<REDACTED>'

        resolved_str = re.sub(r'\$\{([^}]+)\}', replacer, pipeline_str)

        # Parse back to dict and return
        return json.loads(resolved_str)

    def _check_pipeline(self, pipeline: Dict[str, Any]) -> None:
        """
        Validate pipeline configuration and extract metadata.

        Args:
            pipeline: Pipeline configuration to validate

        Raises:
            ValueError: If pipeline lacks required source component
        """
        # Find the actual source component
        source_component = None
        for component in pipeline.get('components', []):
            if component.get('id') == self.source:
                source_component = component
                break

        if source_component is None:
            raise ValueError(f'Pipeline source component "{self.source}" not found in components list')

        if 'config' not in source_component:
            source_component['config'] = {}
        config = source_component['config']

        # Build status name: {task_name | task_id}.{component_name | source_id}
        task_label = self._task_name or self.id
        component_label = source_component.get('name') or config.get('name') or self.source
        self._status.name = f'{task_label}.{component_label}'

        if 'mode' not in config:
            config['mode'] = 'Source'

        if 'type' not in config:
            provider = source_component.get('provider', 'Unknown')
            config['type'] = provider

    def _build_task(self) -> Dict[str, Any]:
        """
        Construct complete task configuration for subprocess.

        Returns:
            Complete subprocess task configuration
        """
        executable_path = sys.executable
        exec_dir = os.path.dirname(executable_path)
        data_path = os.path.abspath(os.path.join(exec_dir, '../data'))

        os.makedirs(data_path, exist_ok=True)

        config = {
            'keystore': 'kvsfile://data/keystore.json',
            'pipeline': {
                'version': self._pipeline.get('version', 1),
                'source': self._pipeline.get('source'),
                'project_id': self._pipeline.get('project_id'),
                'name': self._pipeline.get('name'),
                'description': self._pipeline.get('description'),
                'components': self._pipeline.get('components', []),
            },
            'threadCount': self._threads,
            'pipelineTraceLevel': self._pipelineTraceLevel or None,
        }

        return {
            'config': config,
            'paths': {'base': data_path},
            'nodeId': '9a0b9f66-f693-4b3b-a85b-bb810261c26e',
            'taskId': self.token,
            'type': 'pipeline',
        }

    async def _write_task_file(self) -> str:
        """
        Write task configuration to temporary file.

        Uses mkstemp for secure temporary file creation:
        - Owner-only permissions (0o600) to protect API keys in pipeline config
        - Unpredictable filename to prevent symlink attacks
        - O_EXCL flag to prevent TOCTOU race conditions

        Returns:
            Path to temporary task configuration file

        Raises:
            OSError: If file cannot be created or written
        """
        pipeline_task = self._build_task()
        pipeline_str = json.dumps(pipeline_task, indent=2) + '\n\n'

        fd, taskpath = tempfile.mkstemp(suffix='.json', prefix=f'task-{self.id}-')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            await asyncio.to_thread(f.write, pipeline_str)

        return taskpath

    def _file_checksum(self, path: str) -> str:
        """
        Calculate SHA256 checksum for file integrity.

        Args:
            path: File path for checksum calculation

        Returns:
            Hexadecimal SHA256 checksum
        """
        hash_sha256 = hashlib.sha256()
        with open(path, 'rb') as f:
            while chunk := f.read(8192):
                hash_sha256.update(chunk)
        return hash_sha256.hexdigest()

    def _is_debugging(self) -> bool:
        """
        Detect if running under debugger.

        Returns:
            True if debugging modules detected, False otherwise
        """
        if 'pydevd' not in sys.modules:
            return False

        if 'debugpy' not in sys.modules:
            return False

        return True

    def _get_attach_subprocesses(self) -> bool:
        """
        Check if subprocess debugging enabled in current session.

        Returns:
            True if subprocess debugging enabled, False otherwise
        """
        try:
            if not self._is_debugging():
                return False

            pydevd = sys.modules.get('pydevd')
            settings = pydevd.SetupHolder

            if not hasattr(settings, 'setup'):
                return False

            if 'multiprocess' not in settings.setup:
                return False

            return settings.setup['multiprocess']

        except Exception:
            return False

    async def _send_data(self, data: Dict[str, Any]) -> None:
        """
        Send data requests to task's data communication channel.

        Args:
            data: Data processing request

        Returns:
            Response from pipeline's data processing system

        Raises:
            RuntimeError: If task is terminating or connection fails
        """
        # Reset idle timer - task is actively processing data
        self.reset_idle_timer()

        # Prevent operations during termination
        if self._is_terminating:
            raise RuntimeError('Task is terminating, cannot process data requests')

        # Thread-safe data channel access
        async with self._data_lock:
            # Establish the data WebSocket connection on first use.
            # There is a race condition: the C++ engine emits the ">SVC*1" readiness
            # signal slightly before the child process's uvicorn server has finished
            # binding to its port. This means the first connection attempt may hit a
            # "Connection refused" error. We retry up to 10 times (150ms apart) to
            # give uvicorn time to start accepting connections.
            if not self._data_client:
                uri = f'ws://localhost:{self._data_port}/task/data'

                @retry(
                    stop=stop_after_attempt(10),
                    wait=wait_fixed(0.15),
                    reraise=True,
                    before_sleep=lambda retry_state: self.debug_message(
                        f'Data connection attempt {retry_state.attempt_number} failed, retrying in 0.15s: {retry_state.outcome.exception()}'
                    ),
                )
                async def _connect_data_client():
                    # Don't retry if subprocess has died
                    if self._engine_process and self._engine_process.returncode is not None:
                        raise RuntimeError(f'Subprocess exited with code {self._engine_process.returncode}')
                    transport = TransportWebSocket(uri)
                    name = f'DATA-{self.id}'
                    client = Task.TaskData(parent_task=self, module=name, transport=transport)
                    await client.connect()
                    return client

                self._data_client = await _connect_data_client()

        # Get the arguments
        args = data.get('arguments', {})

        # See if a provider was specified
        if args.get('subcommand', '') == 'open':
            # Get the specified provider (if any)
            provider = args.get('provider', None)

            # If one was specified, make sure it matches our pipeline
            if provider and provider != self._provider:
                raise RuntimeError(f'You are looking for a "{provider}", but this pipeline isn\'t it')

        # Build a brand new DAP packet for the outbound hop instead of forwarding
        # the inbound dict.  Many concurrent inbound chat clients multiplex through
        # this single _data_client; if we forwarded their dicts verbatim, the
        # caller-supplied seqs (e.g. two clients both using seq=128) would collide
        # in DAPClient._pending_requests, the second future would overwrite the
        # first, and one of the two responses would be silently dropped -- hanging
        # the originating chat forever.  dap_request() builds a fresh envelope via
        # build_request() which allocates a unique seq from _data_client._next_seq()
        # so each outbound message has its own correlation slot.
        response = await self._data_client.dap_request(
            command=data['command'],
            arguments=args,
            token=args.get('token'),
        )
        return response

    async def _terminated(self) -> None:
        """
        Handle task termination with comprehensive resource cleanup.

        Manages subprocess termination, resource cleanup, connection management,
        and final status updates.

        Idempotent: safe to call multiple times (only the first call performs
        cleanup; subsequent calls return immediately).
        """
        # Guard: only run cleanup once.  Multiple callers can reach here --
        # e.g. the stdio on_disconnected callback AND the start_task exception
        # handler -- so we must be idempotent.
        if self._terminated_called:
            return
        self._terminated_called = True

        # Block new operations (e.g. data requests) during teardown
        self._is_terminating = True

        # Update status to stopping
        self._status.status = 'Stopping'
        self._status.state = TASK_STATE.STOPPING.value
        await self._send_status_update()

        # Get subprocess reference
        engine = self._engine_process

        # Process exit code
        if engine:
            exit_code = engine.returncode
        else:
            exit_code = 1

        self.debug_message(f'Subprocess for task exited with code {exit_code}')

        # Update completion status - only if we didn't get an >EXIT event
        if self._status.exitCode is None:
            self._status.exitCode = exit_code
            self._status.exitMessage = 'Stopped'

        # If we are not restarting
        if not self._is_restarting:
            self._status.completed = True
            self._status.endTime = time.time()

        self.debug_message('Beginning resource cleanup for task')

        # Clean up debug interfaces
        try:
            if self._debug_stdio:
                try:
                    await self._debug_stdio.disconnect()
                    self.debug_message('stdio debug interface cleaned up')
                except Exception as e:
                    self.debug_message(f'Error cleaning up stdio debug interface: {e}')
                finally:
                    self._debug_stdio = None

        except Exception as e:
            self.debug_message(f'Error cleaning up stdio: {e}')

        try:
            if self._debug_python:
                try:
                    await self._debug_python.disconnect()
                    self.debug_message('debugpy interface cleaned up')
                except Exception as e:
                    self.debug_message(f'Error cleaning up debugpy interface: {e}')
                finally:
                    self._debug_python = None

        except Exception as e:
            self.debug_message(f'Error cleaning up debugpy: {e}')

        try:
            if self._data_client:
                try:
                    await self._data_client.disconnect()
                    self.debug_message('Data client cleaned up')
                except Exception as e:
                    self.debug_message(f'Error cleaning up data client: {e}')
                finally:
                    self._data_client = None
        except Exception as e:
            self.debug_message(f'Error cleaning up data client: {e}')

        # Stop metrics tracking (final metrics and tokens already in status)
        try:
            if self._task_metrics:
                try:
                    await self._task_metrics.stop_monitoring()
                    self.debug_message('Metrics tracking stopped')
                except Exception as e:
                    self.debug_message(f'Error stopping metrics tracking: {e}')
                finally:
                    self._task_metrics = None
        except Exception as e:
            self.debug_message(f'Error cleaning up metrics: {e}')

        # Reset metrics and tokens to zero after task termination
        try:
            # Reset current metrics
            self._status.metrics.cpu_percent = 0.0
            self._status.metrics.cpu_memory_mb = 0.0
            self._status.metrics.gpu_memory_mb = 0.0

            # Reset peak metrics
            self._status.metrics.peak_cpu_percent = 0.0
            self._status.metrics.peak_cpu_memory_mb = 0.0
            self._status.metrics.peak_gpu_memory_mb = 0.0

            # Reset average metrics
            self._status.metrics.avg_cpu_percent = 0.0
            self._status.metrics.avg_cpu_memory_mb = 0.0
            self._status.metrics.avg_gpu_memory_mb = 0.0

            self.debug_message('Metrics and tokens reset to zero')
        except Exception as e:
            self.debug_message(f'Error resetting metrics and tokens: {e}')

        try:
            # Clean up temporary files
            if self._tmpfile:
                try:
                    os.remove(self._tmpfile)
                    self.debug_message('Temporary file removed')
                except OSError as e:
                    self.debug_message(f'Could not remove temporary file: {self._tmpfile} - {e}')
                self._tmpfile = None
        except Exception as e:
            self.debug_message(f'Error cleaning up temporary file: {e}')

        try:
            # Release ports
            if self._debug_port:
                self._server.release_port(self._debug_port)
                self.debug_message('Debug port released')
                self._debug_port = None
        except Exception as e:
            self.debug_message(f'Error cleaning up debug port: {e}')

        try:
            if self._data_port:
                self._server.release_port(self._data_port)
                self.debug_message(f'Data port {self._data_port} released')
                self._data_port = None
        except Exception as e:
            self.debug_message(f'Error cleaning up data port: {e}')

        try:
            # Cancel status update task
            if self._status_update_task and not self._status_update_task.done():
                self.debug_message('Cancelling status update task')
                self._status_update_task.cancel()
                try:
                    await asyncio.wait_for(self._status_update_task, timeout=CONST_STATUS_UPDATE_CANCEL_TIMEOUT)
                    self.debug_message('Status update task cancelled successfully')
                except asyncio.CancelledError:
                    self.debug_message('Status update task cancelled')
                except asyncio.TimeoutError:
                    self.debug_message('Timeout waiting for status update task cancellation')
                except Exception as e:
                    self.debug_message(f'Error cancelling status update task: {e}')
                finally:
                    self._status_update_task = None
        except Exception as e:
            self.debug_message(f'Error cleaning up update task: {e}')

        try:
            # Clean up attached debugger
            if self._debugger:
                await self._debugger.send_event('terminated', id=self.id)
                await self._debugger._transport.disconnect()

                self._debugger = None
                self._status.debuggerAttached = False
        except Exception as e:
            self.debug_message(f'Error cleaning up debugger termination: {e}')

        # Set final state
        if self._stop_requested:
            if self._is_restarting:
                self._status.status = 'Restarting'
                self._status.state = TASK_STATE.CANCELLED.value
                self.debug_message('Task restarted by user request')
            else:
                self._status.status = 'Stopped'
                self._status.state = TASK_STATE.CANCELLED.value
                self.debug_message('Task stopped by user request')
        elif self._status.exitCode == 0:
            self._status.status = 'Completed'
            self._status.state = TASK_STATE.COMPLETED.value
            self.debug_message('Task completed successfully')
        else:
            self._status.status = 'Stopped'
            self._status.state = TASK_STATE.CANCELLED.value
            self.debug_message(f'Task terminated abnormally with exit code {exit_code}')

        # Send final status update
        await self._send_status_update()

        # Send out the final events - last you will every here from us...
        if not self._final_events_sent:
            # Say we have sent the final events
            self._final_events_sent = True

            # Broadcast exit event to the debugger
            exited_event = self.build_event(
                'exited',
                body={
                    'exitReason': self._status.exitMessage,
                    'exitCode': self._status.exitCode or 0,
                    'message': self._status.status,
                },
            )
            await self._forward_task_event(
                EVENT_TYPE.DEBUGGER,
                exited_event,
            )

            # If we are not restarting, send the final events
            if not self._is_restarting:
                # Broadcast termination event
                terminated_event = self.build_event(
                    'terminated',
                    id=self.id,
                )

                await self._forward_task_event(
                    EVENT_TYPE.DEBUGGER,
                    terminated_event,
                )

                # Send out an end task message
                task_message = self.build_event(
                    'apaevt_task',
                    body={
                        'action': 'end',
                        'name': self._status.name,
                        'projectId': self.project_id,
                        'source': self.source,
                    },
                    id=self.id,
                )
                await self._forward_task_event(
                    EVENT_TYPE.TASK,
                    task_message,
                )

                # Notify dashboard of task errors (non-zero exit)
                if self._status.exitCode and self._status.exitCode != 0:
                    try:
                        task_apikey = self._server.get_task_control(self.token).apikey if self.token else None
                    except Exception:
                        task_apikey = None
                    await self._server.broadcast_server_event(
                        EVENT_TYPE.DASHBOARD,
                        {
                            'event': 'apaevt_dashboard',
                            'body': {
                                'action': 'task_error',
                                'timestamp': time.time(),
                                'taskId': self.id,
                                'exitCode': self._status.exitCode,
                                'exitMessage': self._status.exitMessage or None,
                            },
                        },
                        apikey=task_apikey,
                    )

        self.debug_message('Resource cleanup completed successfully')

    def _on_metrics_updated(self) -> None:
        """
        Handle metrics update notification from TaskMetrics.

        Sets the status update flag to trigger broadcast on next update cycle.
        """
        self._status_updated = True

    async def _send_status_update(self) -> None:
        """
        Send status update to all monitoring clients.

        Creates comprehensive status message and broadcasts to clients with
        passive monitoring subscriptions.
        """
        self._status_updated = False

        # Metrics and tokens are updated in-place by TaskMetrics

        # Create status update event
        status_message = self.build_event(
            'apaevt_status_update',
            id=self.id,
            body=self._status.model_dump(),
        )

        try:
            # Broadcast to monitoring clients
            await self._forward_task_event(
                EVENT_TYPE.SUMMARY,
                status_message,
            )

        except Exception as e:
            self.debug_message(f'Error broadcasting status update: {e}')

    async def _status_update_loop(self) -> None:
        """
        Background task for real-time status broadcasting.

        Runs continuously, monitoring status update flags and broadcasting
        when changes occur.
        """
        try:
            # Continue until terminal state
            while self._status.state not in [TASK_STATE.COMPLETED.value, TASK_STATE.CANCELLED.value]:
                if self._status_updated:
                    await self._send_status_update()

                await asyncio.sleep(CONST_STATUS_UPDATE_FREQ)

        except asyncio.CancelledError:
            self.debug_message('Status update loop cancelled')
            return

        except Exception as e:
            self.debug_message(f'Unexpected error in status update loop: {e}')

    async def _forward_task_event(
        self,
        type: EVENT_TYPE,
        message: Dict[str, Any] = None,
    ):
        """
        Forward events to appropriate monitoring clients.

        Args:
            event_type: Event category for routing
            message: Event payload
        """
        # Route debug events to debugger
        if type & EVENT_TYPE.DEBUGGER:
            # If we have an attach debugger
            if self._debugger is not None:
                try:
                    event = message.get('event', '')
                    body = message.get('body', {})

                    await self._debugger.send_event(
                        event=event,
                        id=self.id,
                        body=body,
                    )

                except Exception as e:
                    self.debug_message(f'Failed to send event to debugger: {e}')

        else:
            # Route through server broadcast system
            await self._server.broadcast_task_event(
                event_type=type,
                token=self.token,
                event=message,
            )

    def _update_status(self, message: Dict[str, Any]) -> None:
        """
        Update internal status based on subprocess events.

        Args:
            message: Status event message with type and data
        """
        event_type = message.get('event', '')
        body = message.get('body', {})

        # Handle current object updates
        if event_type == 'apaevt_status_object':
            self._status.currentObject = body.get('object', None)
            self._status.currentSize = body.get('size', 0)

        # Handle processing statistics
        elif event_type == 'apaevt_status_counts':
            self._status.totalSize = body.get('totalSize', 0)
            self._status.totalCount = body.get('totalCount', 0)
            self._status.completedSize = body.get('completedSize', 0)
            self._status.completedCount = body.get('completedCount', 0)
            self._status.failedSize = body.get('failedSize', 0)
            self._status.failedCount = body.get('failedCount', 0)
            self._status.wordsSize = body.get('wordsSize', 0)
            self._status.wordsCount = body.get('wordsCount', 0)
            self._status.rateSize = body.get('rateSize', 0)
            self._status.rateCount = body.get('rateCount', 0)

        # Handle error messages with buffer management
        elif event_type == 'apaevt_status_error':
            error_message = body.get('message', '')
            self._status.errors.append(error_message)

            if len(self._status.errors) > 50:
                self._status.errors = self._status.errors[-50:]

        # Handle warning messages with buffer management
        elif event_type == 'apaevt_status_warning':
            warning_message = body.get('message', '')
            self._status.warnings.append(warning_message)

            if len(self._status.warnings) > 50:
                self._status.warnings = self._status.warnings[-50:]

        # Handle download progress
        elif event_type == 'apaevt_status_download':
            download_info = body.get('info', {})
            download_name = download_info.get('name', 'unknown')
            self._status.status = f'Downloading "{download_name}"'

        # Handle performance metrics with merging
        elif event_type == 'apaevt_status_metrics':
            new_metrics = body.get('metrics', {})
            self._status.metrics = metrics.merge(self._status.metrics, new_metrics)

        # Handle general status messages
        elif event_type == 'apaevt_status_message':
            self._status.status = body.get('message', '')

        # Handle user notes
        elif event_type == 'apaevt_status_user':
            notes = body.get('notes', [])

            if not notes:
                self._status.notes = []
            else:
                for note in notes:
                    if isinstance(note, str):
                        # Handle string notes - simple replacement
                        note = note.replace('{token}', self.token)
                        note = note.replace('{public_auth}', self.public_auth)
                        self._status.notes.append(note)
                    elif isinstance(note, dict):
                        # Handle dict notes - walk through and replace in all string values
                        processed_note = {}
                        for key, value in note.items():
                            if isinstance(value, str):
                                # Replace tokens in string values
                                value = value.replace('{token}', self.token)
                                value = value.replace('{public_auth}', self.public_auth)
                            processed_note[key] = value
                        self._status.notes.append(processed_note)
                    else:
                        # Unknown type, append as-is
                        self._status.notes.append(note)

        # Handle info data from >INF* output
        elif event_type == 'apaevt_status_info':
            info_data = body.get('info', {})
            # Merge/update the info dictionary with new data
            self.info.update(info_data)

    async def on_event(self, message: Dict[str, Any]) -> None:
        """
        Process incoming events from subprocess.

        Central event dispatcher handling status updates, service state changes,
        debug output, and event forwarding to monitoring clients.

        Args:
            message: Event message from subprocess
        """
        # Update event timing
        self._last_event_time = time.time()

        # Add task token for correlation
        message['__id'] = self.id

        # Extract event details
        event_type = message.get('event', '')
        body = message.get('body', {})

        # Handle service state changes
        if event_type == 'apaevt_status_state':
            service_up = body.get('service', False)
            self._status.serviceUp = service_up

            if service_up:
                self._status.state = TASK_STATE.RUNNING.value
                self._status.notes = self._service_up_notes
            else:
                self._status.notes = self._service_down_notes

            # Send a status now
            await self._send_status_update()

        # Handle status updates
        elif event_type.startswith('apaevt_status_'):
            self._update_status(message)
            self._status_updated = True

            await self._forward_task_event(
                EVENT_TYPE.DETAIL,
                message,
            )

        elif event_type == 'apaevt_exit':
            # Get the exit info
            exit_code = body.get('exit_code', 1)
            exit_message = body.get('message', 'Task exited unexpectedly')

            # Save it
            self._status.exitCode = exit_code
            self._status.exitMessage = exit_message

            # Send out a status update when needed
            self._status_updated = True

        # Handle pipeline trace events to build summary and flow events
        elif event_type == 'apaevt_trace':
            operation = body.get('op', '')
            total_pipes = body.get('total_pipes', 0)
            pipe_index = body.get('id', '')
            component_name = body.get('pipe_id', '')
            trace = body.get('trace', {})

            self._status.pipeflow.totalPipes = total_pipes

            if pipe_index not in self._status.pipeflow.byPipe:
                self._status.pipeflow.byPipe[pipe_index] = []

            # Update execution stack
            if operation == 'begin':
                self._status.pipeflow.byPipe[pipe_index] = [component_name]
            elif operation == 'enter':
                self._status.pipeflow.byPipe[pipe_index].append(component_name)
            elif operation == 'leave':
                if self._status.pipeflow.byPipe[pipe_index]:
                    self._status.pipeflow.byPipe[pipe_index].pop()
            elif operation == 'end':
                self._status.pipeflow.byPipe[pipe_index] = []

            # Build the flow event
            body = {
                'id': pipe_index,
                'op': operation,
                'pipes': self._status.pipeflow.byPipe[pipe_index],
                'trace': trace or {},
                'project_id': self.project_id,
                'source': self.source,
            }
            flow = self.build_event('apaevt_flow', body=body)

            # Send out a status update when needed
            self._status_updated = True

            # If this task is started with tracing
            if self._pipelineTraceLevel:
                # Forward off the event
                await self._forward_task_event(EVENT_TYPE.FLOW, flow)

        # Handle real-time node-to-UI SSE messages (pass-through, no status tracking)
        elif event_type == 'apaevt_sse':
            await self._forward_task_event(EVENT_TYPE.SSE, message)

        # Handle debug output
        elif event_type == 'output':
            output_message = body.get('output', '')
            debug(output_message)

            self._status_trace.append(output_message)

            if len(self._status_trace) > 5000:
                self._status_trace = self._status_trace[-5000:]

            await self._forward_task_event(
                EVENT_TYPE.OUTPUT,
                message,
            )

        else:
            # Forward to debugging clients
            await self._forward_task_event(
                EVENT_TYPE.DEBUGGER,
                message,
            )

    def send_scheduled_updates(self):
        """Mark status as updated for next broadcast cycle."""
        self._status_updated = True

    def is_task_complete(self) -> bool:
        """
        Check if task has reached terminal state.

        Returns:
            True if completed or cancelled, False if still active
        """
        return self._status.state in [TASK_STATE.COMPLETED.value, TASK_STATE.CANCELLED.value]

    def is_attached(self, conn: TaskConn) -> bool:
        """
        Check if connection is attached as primary debugger.

        Args:
            conn: Connection to check

        Returns:
            True if connection is attached debugger, False otherwise
        """
        return self._debugger is not None and self._debugger == conn

    def has_attached_debugger(self) -> bool:
        """
        Check if debugging client is attached.

        Returns:
            True if debugger attached, False otherwise
        """
        return self._debugger is not None

    def get_connection_count(self) -> int:
        """
        Get number of active debugging connections.

        Returns:
            Number of active debugging connections (0 or 1)
        """
        return 1 if self._debugger is not None else 0

    async def wait_for_running(self) -> None:
        """
        Wait until task reaches RUNNING state with sliding timeout.

        Uses polling with 250ms intervals and sliding timeout that resets on subprocess events.
        More reliable than event-based waiting as it handles missed events gracefully.

        Raises:
            TimeoutError: If no subprocess events for 30 seconds
            RuntimeError: If task enters a terminal state before RUNNING
        """
        while True:
            # Check current state
            current_state = self._status.state

            # Success case - we're running!
            if current_state == TASK_STATE.RUNNING.value:
                return

            # We completed it, so raise an error -- this is about being read to accept data
            if current_state == TASK_STATE.COMPLETED.value:
                raise RuntimeError('Task has already completed')

            # If we were cancelled, throw an error
            if current_state == TASK_STATE.CANCELLED.value:
                raise RuntimeError(self._status.exitMessage)

            # Calculate timeouts
            time_since_last_event = time.time() - self._last_event_time

            # Check sliding timeout (resets on events)
            if time_since_last_event >= CONST_MAX_READY_TIME:
                raise TimeoutError(
                    f'No subprocess events received for {CONST_MAX_READY_TIME} seconds. Task stuck in state {current_state} (NONE=0, STARTING=1, INITIALIZING=2, RUNNING=3, STOPPING=4, COMPLETED=5, CANCELLED=6)'
                )

            # Wait before next poll
            await asyncio.sleep(CONST_READY_POLL_INTERVAL)

    def is_debug_available(self) -> bool:
        """
        Check if debug interface is available.

        Returns:
            True if debug interface available, False otherwise
        """
        return self._debug_port is not None

    def get_status(self) -> TASK_STATUS:
        """
        Get comprehensive task status.

        Returns:
            Complete task status including state, statistics, and metrics
        """
        return self._status

    def reset_idle_timer(self) -> None:
        """
        Reset the idle timer to 0, indicating recent activity.

        This should be called whenever the task receives data, processes requests,
        or performs any activity that indicates it's in active use.
        """
        self._idle_time = 0

    async def attach_task(self, conn: TaskConn) -> Dict[str, Any]:
        """
        Attach debugging client with debugpy interface setup.

        Args:
            conn: DAP connection to attach as primary debugger

        Returns:
            Pipeline configuration for debugging client

        Raises:
            RuntimeError: If debugger already attached or connection fails
        """
        if self._debugger:
            raise RuntimeError('Debugger is already attached to this task')

        if self._debug_port is None:
            raise RuntimeError('Debugging on this task is not enabled')

        try:
            self._debugger = conn
            self._status.debuggerAttached = True

            uri = f'tcp://localhost:{self._debug_port}'

            self._debug_python = Task.TaskDbgDebugpy(
                parent_task=self,
                id=self.id,
                token=self.token,
                uri=uri,
                launch_args=self._launch_args,
                launch_type=self._launch_type,
            )

            await self._debug_python.connect()
            await self._send_status_update()

            self.debug_message('Debugger attached successfully')

            return self._pipeline

        except Exception as e:
            self._status.debuggerAttached = False
            self._debug_python = None
            self._debugger = None

            self.debug_message(f'Failed to attach debugger to task: {e}')
            raise

    async def detach_task(self, conn: TaskConn) -> Dict[str, Any]:
        """
        Detach debugging client with cleanup.

        Args:
            conn: Connection to detach
        """
        if self._debugger != conn:
            return

        self._debugger = None
        self._status.debuggerAttached = False

        self.debug_message('Debugger detached from task')

    def _reset_status(self) -> None:
        """
        Reset all runtime status from the previous run in preparation for a restart.

        Clears processing statistics, counters, errors, warnings, notes, pipeflow,
        output trace, and info data. Identity fields (project_id, source, name) and
        timing (startTime) are preserved as they are updated by start_task / _check_pipeline.
        """
        self._status.state = TASK_STATE.NONE.value
        self._status.status = ''
        self._status.errors = []
        self._status.warnings = []
        self._status.notes = []
        self._status.currentObject = ''
        self._status.currentSize = 0
        self._status.totalSize = 0
        self._status.totalCount = 0
        self._status.completedSize = 0
        self._status.completedCount = 0
        self._status.failedSize = 0
        self._status.failedCount = 0
        self._status.wordsSize = 0
        self._status.wordsCount = 0
        self._status.rateSize = 0
        self._status.rateCount = 0
        self._status.serviceUp = False
        self._status.exitCode = None
        self._status.exitMessage = ''
        self._status.endTime = 0.0
        self._status.pipeflow = TASK_STATUS_FLOW()
        self._status_trace = []
        self.info = {}

    async def restart_task(
        self,
        pipeline: Dict[str, Any],
        project_id: str,
        source: str,
        provider: str,
    ) -> None:
        """
        Restart the task with new pipeline configuration.

        Uses stop_task() for full cleanup and start_task() for full initialization,
        preserving statistics across the restart cycle.

        Args:
            pipeline: New pipeline configuration
            project_id: Project identifier (must match existing)
            source: Source identifier (must match existing)
            provider: Provider name (may be updated)

        Raises:
            RuntimeError: If debugger attached or restart fails

        Process:
        1. Check debugger not attached
        2. Update configuration
        3. Stop task (full cleanup via _terminated)
        4. Wait for termination to complete
        5. Reset all status from the previous run
        6. Start task (full initialization)
        """
        try:
            self._server.debug_message(f'Task "{self.id}" restart initiated...')

            # Check if debugger is attached - fail if so
            if self.has_attached_debugger():
                raise RuntimeError('Cannot restart task while debugger is attached. Please detach the debugger first.')

            # Set the restart flag to inhibit termination/start events
            self._is_restarting = True

            # Update internal task configuration
            self._pipeline = pipeline
            self._pipeline['source'] = source
            self._pipeline['project_id'] = project_id
            self.project_id = project_id
            self.source = source
            self._provider = provider
            self._status.project_id = project_id
            self._status.source = source

            self._server.debug_message(f'Task "{self.id}" configuration updated, stopping...')

            # Stop the task (triggers full cleanup via _terminated)
            await self.stop_task()

            # Wait for termination to complete
            while not self.is_task_complete():
                await asyncio.sleep(0.1)

            self._server.debug_message(f'Task "{self.id}" stopped, resetting state for restart...')

            # Reset all status from the previous run
            self._reset_status()

            self._server.debug_message(f'Task "{self.id}" starting with new configuration...')

            # Start fresh (full initialization)
            await self.start_task()

            self._server.debug_message(
                f'Task "{self.id}" restarted successfully (source: {source}, provider: {provider})'
            )

        except Exception as e:
            self._server.debug_message(f'Task "{self.id}" restart failed: {str(e)}')
            raise RuntimeError(f'Failed to restart task: {str(e)}')

        finally:
            # Always reset this
            self._is_restarting = False

    async def start_task(self) -> None:
        """
        Launch subprocess and initialize communication interfaces.

        Performs complete startup sequence with environment detection,
        resource allocation, and interface initialization.

        Raises:
            RuntimeError: If already started or critical startup failure
            ValueError: If pipeline configuration invalid
            OSError: If subprocess creation or resource allocation fails
        """
        global copied_python_shim

        # Validate not already started
        if self._status.state != TASK_STATE.NONE.value:
            raise RuntimeError('Task has already been started')

        try:
            # Make sure some of our start is initialized in case we are restarting
            self._status.completed = False
            self._final_events_sent = False
            self._terminated_called = False
            self._service_up_notes = []
            self._service_down_notes = []
            self._stop_requested = False
            self._is_terminating = False

            # Set our current state
            self._status.state = TASK_STATE.STARTING.value

            # Resolve any ${...} in the pipeline
            self._pipeline = self._resolve_pipeline(self._pipeline)

            # Check it - throws on error
            self._check_pipeline(self._pipeline)

            # Mark the start time
            if not self._is_restarting:
                self._status.startTime = time.time()

            # Write it out
            self._tmpfile = await self._write_task_file()

            # Setup the first part of the command line args
            # --autoterm: exit when parent dies (stdin closes)
            child_args = [CONST_AI_NODE_SCRIPT, self._tmpfile, '--autoterm', '--monitor=app']

            # Configure execution environment
            if self._is_debugging() and self._get_attach_subprocesses():
                # VS Code subprocess debugging
                self._debug_subprocess = False

                execdir = os.path.dirname(sys.executable)
                _, ext = os.path.splitext(sys.executable)
                execpython = os.path.join(execdir, f'python{ext}')
                execengine = sys.executable

                if not copied_python_shim:
                    should_copy = not os.path.exists(execpython)
                    if not should_copy:
                        try:
                            should_copy = self._file_checksum(execengine) != self._file_checksum(execpython)
                        except Exception:
                            should_copy = True

                    if should_copy:
                        try:
                            shutil.copy2(execengine, execpython)
                        except Exception as e:
                            if not os.path.exists(execpython):
                                raise RuntimeError(f"Failed to create debug shim '{execpython}': {e}")

                    copied_python_shim = True

                exec_path = execpython
            else:
                # Production environment with full debug support
                self._debug_subprocess = True
                exec_path = sys.executable

                if not self._noDebug:
                    self._debug_port = self._server.assign_port()

                    child_args.extend(
                        [
                            f'--debug_port={self._debug_port}',
                            '--debug_host=localhost',
                        ]
                    )

                if self._launch_type == LAUNCH_TYPE.LAUNCH:
                    child_args.append('--wait_for_client')

            # Configure data communication
            self._data_port = self._server.assign_port()
            child_args.extend(
                [
                    f'--data_port={self._data_port}',
                    '--data_host=localhost',
                ]
            )
            # Pass model server address if configured
            modelserver = self._server._config.get('modelserver')
            if modelserver:
                child_args.append(f'--modelserver={modelserver}')

            user_args = self._launch_args.get('args', [])
            for arg in user_args:
                if ' ' in arg:
                    try:
                        child_args.extend(shlex.split(arg))
                    except ValueError as e:
                        self.debug_message(f'Failed to parse engine arg {arg!r}: {e}, using as-is')
                        child_args.append(arg)
                else:
                    child_args.append(arg)

            # Inherit parent engine's --trace setting if not explicitly provided
            if not any(a.startswith('--trace=') for a in child_args):
                for arg in startup_args():
                    if arg.startswith('--trace='):
                        child_args.append(arg)
                        break

            await self._send_status_update()

            # Launch subprocess - pass environment with account context for store access
            subprocess_env = os.environ.copy()
            subprocess_env['ROCKETRIDE_CLIENT_ID'] = self.client_id

            # avoidMocks: strip ROCKETRIDE_MOCK so node.py loads real libraries
            if self._pipeline.get('avoidMocks'):
                subprocess_env.pop('ROCKETRIDE_MOCK', None)

            self._engine_process = await asyncio.create_subprocess_exec(
                exec_path,
                *child_args,
                cwd=os.path.dirname(exec_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=CONST_SUBPROCESS_BUFFER_LIMIT,
                env=subprocess_env,
            )

            # Initialize stdio interface
            try:
                self._debug_stdio = Task.TaskDbgStdio(
                    parent_task=self,
                    id=self.id,
                    token=self.token,
                    process=self._engine_process,
                )
                await self._debug_stdio.connect()

            except Exception as e:
                self._debug_stdio = None
                self.debug_message(f'Failed to initialize stdio interface: {e}')

            # Initialize metrics tracking (uses default sample_interval from constants)
            try:
                self._task_metrics = TaskMetrics(
                    pid=self._engine_process.pid,
                    task_status=self._status,
                    on_update_callback=self._on_metrics_updated,
                )
                self._task_metrics.start_monitoring()
                self.debug_message(f'Started metrics monitoring for PID {self._engine_process.pid}')
            except Exception as e:
                self._task_metrics = None
                self.debug_message(f'Failed to initialize metrics tracking: {e}')

            # Setup to initializing
            self._status.state = TASK_STATE.INITIALIZING.value

            # Create the periodic status update task
            self._status_update_task = asyncio.create_task(self._status_update_loop())

            # If we are not restarting, notify of task action
            if not self._is_restarting:
                # Send out a begin message
                task_message = self.build_event(
                    'apaevt_task',
                    body={
                        'action': 'begin',
                        'name': self._status.name,
                        'projectId': self.project_id,
                        'source': self.source,
                    },
                    id=self.id,
                )
                await self._forward_task_event(
                    EVENT_TYPE.TASK,
                    task_message,
                )
            else:
                # Send out a restart message
                task_message = self.build_event(
                    'apaevt_task',
                    body={
                        'action': 'restart',
                        'name': self._status.name,
                        'projectId': self.project_id,
                        'source': self.source,
                    },
                    id=self.id,
                )
                await self._forward_task_event(
                    EVENT_TYPE.TASK,
                    task_message,
                )

            # Broadcast a status change
            await self._send_status_update()

            # And done
            self.debug_message(f'Task started successfully with PID {self._engine_process.pid}')

        except Exception as e:
            await self._terminated()
            self.debug_message(f'Task startup failed: {e}')
            raise

    async def stop_task(self) -> None:
        """
        Initiate graceful task termination with resource cleanup.
        """
        try:
            # Prevent race conditions
            async with self._termination_lock:
                # Get subprocess reference
                engine = self._engine_process

                # Mark as user-requested stop and block new operations
                self._stop_requested = True
                self._is_terminating = True

                # Handle subprocess termination
                if engine is not None and engine.returncode is None:
                    self.debug_message('Initiating subprocess termination')

                    # Graceful shutdown with timeout
                    try:
                        # Phase 1: Graceful termination
                        self.debug_message('Sending termination signal to subprocess')
                        engine.terminate()

                        try:
                            await asyncio.wait_for(engine.wait(), timeout=CONST_CANCEL_WAIT_TIMEOUT_SECONDS)
                            self.debug_message('Subprocess terminated gracefully')

                        except asyncio.TimeoutError:
                            # Phase 2: Force termination
                            self.debug_message('Graceful termination timed out, force-killing subprocess')
                            engine.kill()

                            try:
                                await asyncio.wait_for(engine.wait(), timeout=CONST_CANCEL_WAIT_TIMEOUT_SECONDS)
                                self.debug_message('Subprocess force-terminated successfully')
                            except asyncio.TimeoutError:
                                self.debug_message('Warning: Subprocess did not respond to force termination')

                    except Exception as e:
                        self.debug_message(f'Error during subprocess termination: {e}')

                # Wait for completion
                while self._status.state not in [TASK_STATE.COMPLETED.value, TASK_STATE.CANCELLED.value]:
                    await asyncio.sleep(0.1)

        except Exception as e:
            self.debug_message(f'Unexpected error during task termination: {e}')
