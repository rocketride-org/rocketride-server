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
    CONST_ANALYTICS_SLOWEST_DOCS,
)
from ai import CONST_AI_NODE_SCRIPT
from ai.common.dap import DAPBase, DAPClient, TransportWebSocket
from ai.modules.task.pipeflow import apply_pipeflow_event
from ai.modules.task.run_log import RunLogWriter
from rocketride import (
    TASK_STATUS,
    TASK_STATUS_FLOW,
    TASK_STATUS_COMPONENT_STAT,
    TASK_STATUS_SLOWEST_DOC,
    TASK_STATE,
    EVENT_TYPE,
)
from .dbg_debugpy import DbgDebugpy
from .dbg_stdio import DbgStdio
from .pipeline import resolve_pipeline_env
from .types import LAUNCH_TYPE, TaskError
from .task_conn import TaskConn
from .task_metrics import TaskMetrics

# Serialized-size cap for one trace payload. Trace (and its derived flow)
# is the only unbounded event payload — a component can attach whole
# documents or model responses — and every event fans out to EVERY
# subscribed websocket and into the run-log continuum. Payloads over the
# cap are replaced by an honest truncation marker.
CONST_TRACE_PAYLOAD_CAP = 1_000_000
# How much of the oversized payload the marker keeps: the cap minus a
# little headroom for the marker fields themselves — an over-cap payload
# still ships (just under) the full megabyte, clipped rather than shrunk.
CONST_TRACE_PREVIEW_BYTES = CONST_TRACE_PAYLOAD_CAP - 1_024


def cap_trace_payload(trace: Any) -> Any:
    """Clamp one trace payload to ``CONST_TRACE_PAYLOAD_CAP`` serialized bytes.

    Under the cap the payload passes through untouched. Over it, the whole
    structure is replaced with a marker — ``{'truncated': True,
    'originalBytes': N, 'preview': <first bytes of the serialized JSON>}`` —
    because pruning arbitrary nested user data field-by-field is guesswork,
    while the marker is honest and bounded. Applied ONCE where apaevt_trace
    is parsed, so the broadcast trace, the derived flow, and the run-log
    continuum all carry the same clamped payload (replay reproduces exactly
    what live viewers saw).

    Args:
        trace: The raw trace payload from the engine event.

    Returns:
        The payload unchanged, or the truncation marker.
    """
    if not trace:
        return trace
    try:
        raw = json.dumps(trace)
    except (TypeError, ValueError):
        # Unserializable payloads fail later anyway — leave them for the
        # transport's own error handling rather than masking the bug here.
        return trace
    if len(raw) <= CONST_TRACE_PAYLOAD_CAP:
        return trace
    # The bound must hold for the marker AS IT TRAVELS: `preview` holds
    # already-serialized JSON text, and re-serializing it escapes every
    # quote/backslash (control chars become 6-byte \uXXXX escapes), so an
    # object-heavy preview inflates well past its slice length. Size the
    # serialized marker and trim proportionally until it fits.
    preview = raw[:CONST_TRACE_PREVIEW_BYTES]
    while preview:
        marker = {'truncated': True, 'originalBytes': len(raw), 'preview': preview}
        size = len(json.dumps(marker))
        if size <= CONST_TRACE_PAYLOAD_CAP:
            return marker
        # Proportional trim converges in a couple of passes; the -1 makes
        # progress even when the ratio rounds to no change.
        preview = preview[: max(0, len(preview) * CONST_TRACE_PAYLOAD_CAP // size - 1)]
    return {'truncated': True, 'originalBytes': len(raw), 'preview': ''}


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

            Stamps the run-log continuum fields (body.eventTime) at the
            ingress point — where raw engine stdout frames have just become
            JSON events — then routes to the parent Task for broadcasting to
            connected clients and (L2) appending to the run log.

            Args:
                event: DAP event message from subprocess
            """
            # Stamp the TIME at true ingress so eventTime reflects emission,
            # not forwarding time. The logSeq is deliberately NOT assigned
            # here: some ingress events are consumed without ever being
            # delivered (apaevt_trace becomes a derived apaevt_flow), and a
            # seq burned on an undelivered message leaves gaps in the
            # continuum. logSeqs are assigned exactly once at the delivery
            # point (_forward_task_event / the run-log writer), which
            # preserves arrival order because the whole
            # ingress->handler->forward path is synchronous per message.
            self._parent_task.stamp_log_event(event, assign_seq=False)
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
        team_id: str = '',
        org_id: str = '',
        env: Dict[str, str] = None,
        run_kind: str = 'dev',
        trigger: str = 'manual',
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
            team_id: Owning team id (rides the task file as trusted identity)
            org_id: Owning org id (rides the task file as trusted identity)
            run_kind: Run classification ('dev' | 'deploy') — picks the
                run-log continuum; only the trusted dispatch sets 'deploy'
            trigger: What fired the run ('' | 'manual' | 'schedule');
                '' is the interactive-dev spelling (only the trusted
                dispatch stamps manual/schedule); stamped on the
                run-begin marker
            **kwargs: Additional DAP configuration (forwarded to DAPBase)
        """
        # Store authentication
        self.id = id
        self.project_id = project_id
        self.source = source
        self.token = token
        self.public_auth = public_auth
        self.client_id = client_id
        self.team_id = team_id
        self.org_id = org_id

        # TTL management - count-up timer approach
        self._ttl = ttl  # Maximum idle time in seconds
        self._idle_time = 0  # Current idle time in seconds (resets on activity)

        # Have the final events been sent yet
        self._final_events_sent = False

        # Guard against _terminated() being called more than once
        self._terminated_called = False

        # Per-run dir where installed node capsules are materialized from the
        # store for the task subprocess to load via --node_path (removed on stop).
        self._node_path_dir = None

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
        # WHY the stop was requested ('user' | 'ttl'); None until requested.
        # A ttl-window expiry is SUCCESS (the run stayed up exactly as
        # configured), so the run-log outcome derives from this.
        self._stop_reason: 'str | None' = None

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

        # Run analytics accumulators (componentStats / slowestDocs in the
        # status body). THE PIPE ID IS THE CORRELATION KEY: concurrent
        # completions run the same component on different pipes and their
        # begins/ends interleave (BEGIN[parse]:0, BEGIN[parse]:32,
        # END[parse]:0, END[parse]:32) — keying by component would clobber
        # one pipe's begin with another's. Aggregation rolls up by component
        # AFTER correlation happened by pipe.
        self._an_open_by_pipe: Dict[Any, Dict[str, Any]] = {}
        self._an_component_open: Dict[Any, List[float]] = {}

        # Pipe-unused (idle) accumulation — INTERNAL closed totals plus the
        # moment the pipe last went quiet. The status body carries only
        # display-ready numbers: _refresh_idle_status folds the still-open
        # quiet stretch in server-side at every publish point, so clients
        # never compute idle time themselves.
        self._an_idle_total = 0.0
        self._an_idle_longest = 0.0
        self._an_idle_longest_at = 0.0
        self._an_idle_since = 0.0

        # Run-log continuum sequencing (see stamp_log_event). A fresh stream
        # starts at 1; the run-log writer (L2) raises the floor to
        # control.lastSeq + 1 after reading the stream's catalog, so the
        # continuum always continues where the recorded stream left off.
        # Header `seq` is NOT this counter — seq belongs to the DAP
        # per-connection message stream; the continuum rides in `logSeq`.
        self._log_seq_next = 1

        # Run-log writer — the per-task event continuum (created at subprocess
        # start; None if logging setup failed, which must never break the run).
        # run_kind separates the dev and deploy continua; the deploy feature's
        # trusted dispatch path sets 'deploy', everything else logs as 'dev'.
        # Both classifications gate storage anchors, run-log scoping, and
        # token ownership downstream — reject anything outside the closed
        # vocabulary HERE, the one construction choke point, so a bad value
        # can never pick a storage scope. ('' trigger = an interactive dev
        # run: only the trusted dispatch stamps manual/schedule.)
        if run_kind not in ('dev', 'deploy'):
            raise ValueError(f'invalid run_kind: {run_kind!r}')
        if trigger not in ('', 'manual', 'schedule'):
            raise ValueError(f'invalid trigger: {trigger!r}')
        self._run_log: Optional[RunLogWriter] = None
        self._run_kind: str = run_kind
        self._run_trigger: str = trigger

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
        self._env: Dict[str, str] = env or {}

        # Initialize DAP base
        super().__init__(f'TASK-{self.id}', **kwargs)

    def _resolve_pipeline(self, pipeline: Dict[str, Any]) -> Dict[str, Any]:
        """Replace ``${KEY}`` placeholders using the merged environment dict.

        Delegates to :func:`pipeline.resolve_pipeline_env`.
        """
        return resolve_pipeline_env(pipeline, self._env)

    # Providers that connect to the per-tenant RocketRide cloud database and
    # therefore need ROCKETRIDE_DB_DSN injected into the task subprocess.
    _ROCKETRIDE_DB_PROVIDERS = frozenset({'rocketride_sql', 'rocketride_vector', 'rocketride_graph'})

    def _pipeline_uses_rocketride_db(self) -> bool:
        """True when any pipeline component is a RocketRide cloud DB node."""
        components = self._pipeline.get('components') or []
        return any(
            isinstance(component, dict) and component.get('provider') in self._ROCKETRIDE_DB_PROVIDERS
            for component in components
        )

    async def _build_subprocess_env(self) -> Dict[str, str]:
        """Build the environment for the task subprocess.

        Credential hygiene for the RocketRide cloud DB path:

        - The broker credential can resolve ANY tenant's DSN — it must never
          reach node subprocesses, which run user pipeline code.
        - A DSN inherited from the parent environment must not leak into
          pipelines that didn't resolve one (and must not survive a broker
          failure as a stale value pointing at who-knows-which tenant).

        Children only ever get the single DSN resolved here, for pipelines
        that actually contain one of the DB nodes. Identity is NOT delivered
        through the environment (it rides the task file's 'identity' block —
        the ROCKETRIDE_* env namespace is caller-influenced by design).
        """
        subprocess_env = os.environ.copy()

        subprocess_env.pop('ROCKETRIDE_DB_BROKER_URL', None)
        subprocess_env.pop('ROCKETRIDE_DB_BROKER_TOKEN', None)
        subprocess_env.pop('ROCKETRIDE_DB_DSN', None)
        subprocess_env.pop('ROCKETRIDE_DB_RESOLVE_ERROR', None)

        # Resolve the per-tenant DSN server-side (the SaaS account context
        # exists only in this process) and hand it to the node subprocess via
        # env — the same delivery mechanism as ROCKETRIDE_CLIENT_ID. Scoped to
        # pipelines that actually contain one of the DB nodes so unrelated
        # tasks never trigger provisioning. Resolution failure is non-fatal
        # here: the node surfaces its own clear error, with the failure reason
        # passed down so it isn't misreported as a sign-in problem.
        if self._pipeline_uses_rocketride_db():
            try:
                from ai.account import account

                dsn = await account.resolve_db_dsn(self.client_id)
                subprocess_env['ROCKETRIDE_DB_DSN'] = dsn
            except NotImplementedError:
                # Broker env not configured (open-source default) — the
                # node raises the sign-in message itself.
                pass
            except Exception as e:
                self.debug_message(f'RocketRide DB DSN resolution failed: {e}')
                reason = (str(e).strip().splitlines() or [repr(e)])[0]
                subprocess_env['ROCKETRIDE_DB_RESOLVE_ERROR'] = reason

        return subprocess_env

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

    def _build_task(self, pipeline: Dict[str, Any]) -> Dict[str, Any]:
        """
        Construct complete task configuration for subprocess.

        Args:
            pipeline: Resolved pipeline dict (secrets already substituted). Must
                      not be stored — caller discards it after the temp file is written.

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
                'version': pipeline.get('version', 1),
                'source': pipeline.get('source'),
                'project_id': pipeline.get('project_id'),
                'name': pipeline.get('name'),
                'description': pipeline.get('description'),
                'components': pipeline.get('components', []),
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
            # Trusted identity for in-process tools (surfaced to nodes as
            # IEndpoint.endpoint.jobConfig['identity']). Rides the 0600 task
            # file — point-to-point, never the environment, so caller env can
            # never pollute it and descendants never inherit it.
            'identity': {
                'userId': self.client_id,
                'teamId': self.team_id,
                'orgId': self.org_id,
            },
            # Storage anchor for in-process tools (chroot semantics): node
            # paths are always plain and relative, and resolve under this
            # root — dev runs get the owner's whole tree (today's behavior);
            # deploy runs get a task-specific subtree of TEAM storage so a
            # deployed task has no user dependency and concurrent
            # deployments never share working storage. Node-level paths are
            # therefore identical in both modes.
            'storage': {
                'root': self._storage_root(),
            },
        }

    def _storage_root(self) -> str:
        """The task's storage anchor (see the 'storage' task-file block).

        Validated HERE so a malformed component — project_id is
        client-supplied and only uuid-defaulted when absent — fails the
        launch with a clear error instead of surfacing later inside the
        subprocess as tool_filesystem disabling itself mid-run.
        """
        from ai.account.file_store import validate_storage_root

        if self._run_kind == 'deploy':
            if not self.team_id:
                raise ValueError('deploy runs require a team_id for their storage anchor')
            return validate_storage_root(f'teams/{self.team_id}/files/tasks/{self.project_id}')
        # Anonymous dev runs (client_id='' — OSS/standalone launches) carry
        # NO anchor instead of failing the launch: identity.userId rides
        # empty too, so engine_file_store() yields None and the storage
        # tools disable themselves — the same degradable posture as the
        # run-log writer ('users//files' must never be composed).
        if not self.client_id:
            return ''
        return validate_storage_root(f'users/{self.client_id}/files')

    async def _write_task_file(self, pipeline: Dict[str, Any]) -> str:
        """
        Write task configuration to temporary file.

        Uses mkstemp for secure temporary file creation:
        - Owner-only permissions (0o600) to protect API keys in pipeline config
        - Unpredictable filename to prevent symlink attacks
        - O_EXCL flag to prevent TOCTOU race conditions

        Args:
            pipeline: Resolved pipeline dict (secrets already substituted). The
                      caller must not retain a reference after this returns.

        Returns:
            Path to temporary task configuration file

        Raises:
            OSError: If file cannot be created or written
        """
        pipeline_task = self._build_task(pipeline)
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
                uri = f'ws://127.0.0.1:{self._data_port}/task/data'

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

        # Propagate subprocess failures so callers don't silently
        # receive success for a failed operation.
        if self._data_client.did_fail(response):
            raise RuntimeError(response.get('message', 'Data request failed'))

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

        # NOTE: the final zeroed status and the run-log close happen at the
        # END of teardown (after metrics stop + terminal state assignment) —
        # see below. Emitting them here shipped a bug once: the teardown's
        # later status broadcast overwrote the zero as "last known" and
        # charts held a stale residual reading forever.

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

        # Send final status update — the stream's LAST status. For a real
        # termination the utilization gauges are explicitly zeroed: the
        # process is gone, so CPU/RAM/VRAM are zero BY DATA and charts
        # render generically from status events without
        # inferring process death. This MUST be the last status-shaped
        # broadcast of the task: it is emitted after metrics teardown and
        # the terminal-state assignment, and nothing may send status after
        # it — a later broadcast becomes the new "last known" reading and
        # silently undoes the zero (that bug shipped once). body['final']
        # marks it so the run-log sampler always records it.
        if self._is_restarting:
            await self._send_status_update()
        else:
            try:
                self._status.metrics.cpu_percent = 0.0
                self._status.metrics.cpu_memory_mb = 0.0
                self._status.metrics.gpu_memory_mb = 0.0
                final_body = self._status.model_dump()
                final_body['final'] = True
                await self._forward_task_event(
                    EVENT_TYPE.SUMMARY,
                    self.build_event('apaevt_status_update', id=self.id, body=final_body),
                )
            except Exception as e:
                self.debug_message(f'Final zeroed status emit failed: {e}')

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
                        **({'reason': self._stop_reason} if self._stop_reason else {}),
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
                        task_user_id = self._server.get_task_control(self.token).userId if self.token else None
                    except Exception:
                        task_user_id = None
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
                        user_id=task_user_id,
                    )

        # Close out (or annotate) the run-log continuum LAST — after the
        # final zeroed status AND every terminal task event (exited /
        # terminated / apaevt_task end) has been forwarded, because
        # forwarding is what appends them to the log: closing any earlier
        # loses the task-end from the recorded continuum. The run-end
        # marker therefore remains the stream's true last line. A restart
        # is NOT a new run: the chapter continues and only a restart marker
        # is recorded; a real termination completes the chapter with its
        # outcome. Best-effort — never blocks or breaks teardown.
        if self._run_log is not None:
            try:
                if self._is_restarting:
                    self._run_log.note_restart()
                else:
                    # A ttl-window expiry is SUCCESS: the run stayed up
                    # exactly as configured, then shut down. Only a real
                    # stop (or abnormal exit) reads as cancelled.
                    if self._status.state == TASK_STATE.CANCELLED.value:
                        outcome = 'ok' if self._stop_reason == 'ttl' else 'cancelled'
                    elif self._status.exitCode == 0:
                        outcome = 'ok'
                    else:
                        outcome = 'error'
                    await self._run_log.end_run(outcome, self._status.exitMessage or '', reason=self._stop_reason)
                    self._run_log = None
            except Exception as e:
                self.debug_message(f'Run-log close failed: {e}')

        self.debug_message('Resource cleanup completed successfully')

    def _on_metrics_updated(self) -> None:
        """
        Handle metrics update notification from TaskMetrics.

        Sets the status update flag to trigger broadcast on next update cycle.
        """
        self._status_updated = True

    def raise_log_seq_floor(self, floor: int) -> None:
        """
        Raise the continuum seq counter to at least ``floor``.

        Called by the run-log writer after reading the stream's control file so
        the next issued logSeq is control.lastSeq + 1 — the continuum continues
        exactly where the recorded stream left off. (A crash's unpersisted tail
        may re-issue values, accepted: the crash also drops every websocket, so
        clients reconnect with fresh sessions and fresh live buckets.)

        Args:
            floor: Minimum value for the next issued seq (exclusive of past).
        """
        # Only ever move forward — the counter is strictly monotonic.
        if floor > self._log_seq_next:
            self._log_seq_next = floor

    def build_event(
        self, event: str, *, id: str = None, body: Optional[Dict[str, Any]] = None, event_time: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Build a Task event carrying the run-log continuum headers.

        Overrides the DAP base builder: build_event IS the logSeq assigner for
        every event the Task itself constructs, so no caller ever assigns a
        second one (the downstream stamp calls are idempotent no-ops for built
        events). The base class's per-endpoint DAP seq is left untouched —
        each forwarding connection mints its own on send.

        Args:
            event: The DAP event name.
            id: Optional correlation identifier.
            body: Optional event payload.
            event_time: Optional inherited emission time — derived events
                (e.g. apaevt_flow) carry their source event's time.

        Returns:
            The stamped event message.
        """
        return self.stamp_log_event(super().build_event(event, id=id, body=body), event_time=event_time)

    def stamp_log_event(
        self, message: Dict[str, Any], *, event_time: Optional[float] = None, assign_seq: bool = True
    ) -> Dict[str, Any]:
        """
        Stamp a DAP event message with the run-log continuum fields.

        Adds two fields to the event BODY (never the DAP envelope — the
        envelope is pure protocol: seq belongs to each connection's own
        message stream, and overloading it with the continuum broke DAP
        sequencing the moment one connection monitored two tasks):
        - ``body.eventTime``: epoch seconds float — set once at ingress and
          never overwritten (an engine-provided stamp wins if one appears).
        - ``body.logSeq``: the per-task continuum sequence — catalog-seeded
          (control.lastSeq + 1; a fresh stream starts at 1), strictly
          monotonic across runs and engine restarts. Idempotent: a body
          already carrying logSeq passes through untouched.

        The stamps ride beside the body's project_id + source identity — the
        body is the complete task-scoped record; the envelope is transport.

        Args:
            message: The event message dict (mutated in place).
            event_time: Optional explicit emission time — used by derived
                events (e.g. apaevt_flow) to inherit the source event's time.
            assign_seq: When False, stamp only ``eventTime``. Used at points
                where the message may never be delivered (stdout ingress, the
                trace->flow derivation): seqs are assigned exactly once, at the
                delivery point (_forward_task_event / the log writer), so a
                consumed-but-never-forwarded message does not burn a seq and
                leave gaps in the continuum.

        Returns:
            The same message dict, stamped.
        """
        # The stamps live in the body; an event without one gets an empty
        # body to carry them (DAP treats body as event-specific payload).
        body = message.get('body')
        if not isinstance(body, dict):
            body = {}
            message['body'] = body

        # Emission time: set once; derived events may inherit their source's.
        if 'eventTime' not in body:
            body['eventTime'] = event_time if event_time is not None else time.time()

        # Continuum seq: idempotent — assign once, never rewrite.
        if assign_seq and 'logSeq' not in body:
            body['logSeq'] = self._log_seq_next
            self._log_seq_next += 1

        return message

    async def _send_status_update(self) -> None:
        """
        Send status update to all monitoring clients.

        Creates comprehensive status message and broadcasts to clients with
        passive monitoring subscriptions.
        """
        self._status_updated = False

        # Metrics and tokens are updated in-place by TaskMetrics

        # Fold the still-open quiet stretch into the idle counters — during
        # silence no trace events arrive, so the periodic broadcast is what
        # keeps the published idle numbers current.
        self._refresh_idle_status()

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
        # Safety net: every broadcast event carries the continuum headers.
        # Idempotent — events stamped at ingress or at their build site pass
        # through unchanged; anything constructed on a path that missed a
        # stamp (e.g. status updates built in _send_status_update) is stamped
        # here, immediately before the one shared dict fans out to clients.
        self.stamp_log_event(message)

        # Safety net #2: every task-scoped event carries its identity in
        # the body (project_id + source) so clients filter uniformly by
        # body fields — raw engine events (output, SSE, granular status)
        # arrive from the child without it. Idempotent: events that already
        # carry project_id pass through untouched.
        body = message.get('body') if isinstance(message, dict) else None
        if isinstance(body, dict) and 'project_id' not in body:
            body['project_id'] = self.project_id
            body['source'] = self.source
        # Concrete identity stamp: teamId/userId/runKind ride every event
        # body so watchers can scope streams client-side (two teams or two
        # devs running the SAME project no longer alias in a watch UI), and
        # server-side subscription filters can match these fields verbatim
        # when they land. Idempotent like the project_id stamp above.
        if isinstance(body, dict) and 'runKind' not in body:
            body['runKind'] = self._run_kind
            body['teamId'] = self.team_id
            body['userId'] = self.client_id

        # Append to the run-log continuum: what clients see is what replay
        # reproduces (the writer filters/samples/caps internally; never
        # blocks on the store).
        if self._run_log is not None:
            try:
                self._run_log.append(message)
            except Exception as e:
                self.debug_message(f'Run-log append failed: {e}')

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

        # Handle subprocess billing metrics (from >MET* protocol)
        elif event_type == 'apaevt_status_metrics':
            new_metrics = body.get('metrics', {})
            if self._task_metrics:
                self._task_metrics.merge_subprocess_metrics(new_metrics)

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
                        # getattr: partially-initialized tasks (and test stubs)
                        # may not carry the identity attributes at all.
                        project_id = getattr(self, 'project_id', None)
                        source = getattr(self, 'source', None)
                        if project_id is not None:
                            note = note.replace('{project_id}', str(project_id))
                        if source is not None:
                            note = note.replace('{source}', str(source))
                        self._status.notes.append(note)
                    elif isinstance(note, dict):
                        # Handle dict notes - walk through and replace in all string values
                        processed_note = {}
                        for key, value in note.items():
                            if isinstance(value, str):
                                # Replace tokens in string values
                                value = value.replace('{token}', self.token)
                                value = value.replace('{public_auth}', self.public_auth)
                                project_id = getattr(self, 'project_id', None)
                                source = getattr(self, 'source', None)
                                if project_id is not None:
                                    value = value.replace('{project_id}', str(project_id))
                                if source is not None:
                                    value = value.replace('{source}', str(source))
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

            # Gate billing accumulation on pipeline readiness so users
            # are not charged for startup time (model loading, deps, etc.)
            if self._task_metrics:
                self._task_metrics.set_service_up(service_up)

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
            raw_trace = body.get('trace', {})

            # total_pipes=0 marks a synthetic trace (tool-call events emit it
            # as "unknown") — keep the data lane's real pipe count.
            if total_pipes:
                self._status.pipeflow.totalPipes = total_pipes

            # Update the per-pipe execution stack and get a stable snapshot chain.
            # See pipeflow.apply_pipeflow_event for why leave pops by identity and the
            # snapshot is copied (reentrant sub-invocations share one pipe_index and
            # interleave across threads).
            pipes = apply_pipeflow_event(self._status.pipeflow.byPipe, pipe_index, operation, component_name)

            # Build the flow event. `component` names the component this op refers to
            # (for 'leave', the leaving one) so consumers can pair enter/leave by identity
            # rather than assuming strict LIFO order — reentrant agent sub-invocations
            # interleave under one pipe_index. `pipes` remains the current component stack.
            # Identity (project_id + source) is stamped centrally by
            # _forward_task_event — not duplicated here.
            body = {
                'id': pipe_index,
                'op': operation,
                'pipes': pipes,
                'component': component_name,
                # Filled below only when tracing is on — the clamp
                # serializes the whole trace, wasted work for a body that
                # never leaves this method (synthetic tool-call traces
                # arrive regardless of trace level).
                'trace': {},
            }
            # Send out a status update when needed
            self._status_updated = True

            # If this task is started with tracing
            if self._pipelineTraceLevel:
                # Clamp oversized payloads HERE, before the rebuilt body
                # fans out to the broadcast, the derived flow, and the
                # run-log continuum.
                body['trace'] = cap_trace_payload(raw_trace) or {}
                # Build the derived flow event only when it will actually be
                # delivered — build_event assigns its continuum seq, and a
                # built-but-unsent event would leave a gap. It inherits the
                # source trace message's emission time.
                flow = self.build_event(
                    'apaevt_flow', body=body, event_time=(message.get('body') or {}).get('eventTime')
                )

                # Accumulate run analytics from the derived flow (its body
                # carries the stamped eventTime, and for 'begin' its logSeq
                # is the trace's permanent identity). Gated on tracing like
                # the flow derivation itself — no traces, honest empties.
                self._accumulate_analytics(operation, pipe_index, component_name, pipes, flow['body'])

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
                raise TaskError(TaskError.COMPLETED, 'Task has already completed')

            # If we were cancelled, throw an error
            if current_state == TASK_STATE.CANCELLED.value:
                raise TaskError(TaskError.STOPPED, self._status.exitMessage or 'Task was stopped')

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

    def _accumulate_analytics(
        self, operation: str, pipe_index: Any, component_name: str, pipes: List[str], flow_body: Dict[str, Any]
    ) -> None:
        """
        Fold one trace operation into the status body's run analytics.

        Computed HERE — where every event is born — so statusAt(position)
        reads are exact anywhere on the continuum (live, replayed, or
        mid-scrub) with no client fold-window or recency caveats. The pipe
        id correlates; the component aggregates.

        Args:
            operation: Trace op (begin / enter / leave / end).
            pipe_index: The REAL pipe id the op runs on (correlation key).
            component_name: The component this op refers to.
            pipes: Current component stack (pipes[0] = the object name that
                a begin carries).
            flow_body: The derived flow event's body — carries the stamped
                eventTime and, for 'begin', the continuum logSeq that IS the
                trace identity.
        """
        event_time = float(flow_body.get('eventTime') or time.time())

        if operation == 'begin':
            # Activity resumes: close the quiet period the last end opened.
            if not self._an_open_by_pipe and self._an_idle_since:
                gap = round(max(0.0, event_time - self._an_idle_since), 2)
                self._an_idle_total = round(self._an_idle_total + gap, 2)
                if gap > self._an_idle_longest:
                    self._an_idle_longest = gap
                    self._an_idle_longest_at = self._an_idle_since
                self._an_idle_since = 0.0
                self._refresh_idle_status(event_time)
            # A pipe hosts one completion at a time — its end looks up THIS.
            self._an_open_by_pipe[pipe_index] = {
                'name': str(pipes[0] if pipes else component_name)[:200],
                'beginTime': event_time,
                'beginSeq': flow_body.get('logSeq'),
            }

        elif operation == 'enter':
            # Reentrancy within one pipe stacks; key = (pipe, component).
            self._an_component_open.setdefault((pipe_index, component_name), []).append(event_time)

        elif operation == 'leave':
            stack = self._an_component_open.get((pipe_index, component_name))
            if stack:
                delta = max(0.0, event_time - stack.pop())
                stat = self._status.componentStats.get(component_name)
                if stat is None:
                    stat = TASK_STATUS_COMPONENT_STAT()
                    self._status.componentStats[component_name] = stat
                stat.calls += 1
                stat.totalSeconds = round(stat.totalSeconds + delta, 2)
                stat.maxSeconds = max(stat.maxSeconds, round(delta, 2))

        elif operation == 'end':
            begun = self._an_open_by_pipe.pop(pipe_index, None)
            if begun is not None:
                elapsed = round(max(0.0, event_time - begun['beginTime']), 2)
                self._status.completionSeconds = round(self._status.completionSeconds + elapsed, 2)
                # Insert-sorted, bounded top list (slowest first).
                entry = TASK_STATUS_SLOWEST_DOC(
                    name=begun['name'], elapsed=elapsed, beginTime=begun['beginTime'], beginSeq=begun['beginSeq']
                )
                docs = self._status.slowestDocs
                docs.append(entry)
                docs.sort(key=lambda d: d.elapsed, reverse=True)
                del docs[CONST_ANALYTICS_SLOWEST_DOCS:]
                # Last completion out — the pipe is unused from HERE until
                # the next begin (or a status publish) closes the gap.
                if not self._an_open_by_pipe:
                    self._an_idle_since = event_time

    def _refresh_idle_status(self, now: Optional[float] = None) -> None:
        """
        Publish the pipe-unused counters into the status body.

        The closed totals live in internal state; the still-open quiet
        stretch is extended HERE to the given clock — no trace events
        arrive during silence, so this runs at every status publish (and at
        gap boundaries) to keep the emitted numbers current. Clients render
        the fields verbatim and never compute idle time themselves.

        Args:
            now: Clock to extend the open stretch to (wall clock if None).
        """
        # The open stretch exists only while zero completions are in flight.
        open_gap = 0.0
        if self._an_idle_since and not self._an_open_by_pipe:
            open_gap = round(max(0.0, (now if now is not None else time.time()) - self._an_idle_since), 2)
        self._status.idleSeconds = round(self._an_idle_total + open_gap, 2)
        # The open stretch may already be the longest the run has seen.
        if open_gap > self._an_idle_longest:
            self._status.idleLongestSeconds = open_gap
            self._status.idleLongestAt = self._an_idle_since
        else:
            self._status.idleLongestSeconds = self._an_idle_longest
            self._status.idleLongestAt = self._an_idle_longest_at

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
        self._status.componentStats = {}
        self._status.slowestDocs = []
        self._status.completionSeconds = 0.0
        self._status.idleSeconds = 0.0
        self._status.idleLongestSeconds = 0.0
        self._status.idleLongestAt = 0.0
        # Correlation state dies with the run — pipe ids recycle across runs.
        self._an_open_by_pipe = {}
        self._an_component_open = {}
        self._an_idle_total = 0.0
        self._an_idle_longest = 0.0
        self._an_idle_longest_at = 0.0
        self._an_idle_since = 0.0
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
            self._stop_reason = None
            self._is_terminating = False

            # Set our current state
            self._status.state = TASK_STATE.STARTING.value

            # Resolve ${...} placeholders into a local variable — never stored on self
            # so secrets are not retained in memory beyond the temp file write.
            resolved = self._resolve_pipeline(self._pipeline)

            # Check it - throws on error
            self._check_pipeline(resolved)

            # Mark the start time
            if not self._is_restarting:
                self._status.startTime = time.time()

            # Write it out, then let `resolved` go out of scope
            self._tmpfile = await self._write_task_file(resolved)
            del resolved

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
                    '--data_host=127.0.0.1',
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

            # Load the caller's installed node capsules: materialize them from the
            # store into a per-run dir and point --node_path there, so installed
            # nodes load with no manual flag (docker/SaaS). When nothing is
            # installed this returns None and we fall back to inheriting the parent
            # engine's --node_path (the VSCode-workspace path) exactly as before.
            if not any(a.startswith('--node_path=') for a in child_args):
                materialized = await self._materialize_installed_nodes()
                if materialized:
                    child_args.append(f'--node_path={materialized}')
                else:
                    for arg in startup_args():
                        if arg.startswith('--node_path='):
                            child_args.append(arg)
                            break

            await self._send_status_update()

            # Launch subprocess. Identity travels in the TASK FILE (see
            # _build_task's 'identity' block), never the environment — the
            # ROCKETRIDE_* env namespace is caller-influenced by design.
            # _build_subprocess_env additionally scrubs the RocketRide DB
            # broker credentials and injects the resolved per-tenant DSN.
            subprocess_env = await self._build_subprocess_env()

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

            # Open the run-log continuum for this run. Logging is best-effort
            # observability: any failure here is logged and the task runs
            # unlogged rather than failing execution.
            try:
                # The account-scoped FileStore handles user path scoping (and
                # REFUSES an empty client_id — such a task runs unlogged and
                # says so, rather than writing into a collapsed users/ path).
                # Internal identity: the run-log writer is the ONLY legal
                # writer of .logs content (the store's policy denies every
                # user identity — internal-only entry).
                from ai.account import RequestContext, Store

                # The store view anchors at the run's OWNER namespace: the
                # TEAM for deploy runs (which carry no user identity — every
                # path they write is '@/Team/=<id>/'-prefixed anyway), the
                # user for dev runs. An internal-context store REQUIRES a
                # concrete anchor — an empty one raises, and the except below
                # would silently disable the run log for the whole run.
                self._run_log = RunLogWriter(
                    Store.file_store(
                        RequestContext.internal('run-log'),
                        client_id=self.team_id if self._run_kind == 'deploy' else self.client_id,
                    ),
                    self.client_id,
                    self.project_id,
                    self.source,
                    self._run_kind,
                    self.stamp_log_event,
                    self.raise_log_seq_floor,
                    # Deploy runs write the TEAM continuum (teams are the
                    # environments — teammates watch/replay the same stream);
                    # dev runs stay in the owner's tree. The writer's scope
                    # helper turns this into the '@/Team/=<id>/' store prefix.
                    team_id=self.team_id if self._run_kind == 'deploy' else '',
                    debug=self.debug_message,
                )
                await self._run_log.open(
                    trigger=self._run_trigger,
                    user=self.client_id,
                    pipeline_hash=hashlib.sha256(
                        json.dumps(self._pipeline, sort_keys=True, default=str).encode('utf-8')
                    ).hexdigest()[:16],
                    trace_level=self._pipelineTraceLevel,
                )
            except Exception as e:
                self._run_log = None
                self.debug_message(f'Run-log setup failed (task continues unlogged): {e}')

            # Initialize metrics tracking (uses default sample_interval from constants)
            try:
                # Resolve billing identity from task control
                _control = self._server.get_task_control(self.token) if self.token else None
                self._task_metrics = TaskMetrics(
                    pid=self._engine_process.pid,
                    task_status=self._status,
                    task_id=self.id,
                    client_id=self.client_id,
                    user_id=getattr(_control, 'userId', '') if _control else '',
                    team_id=getattr(_control, 'teamId', '') if _control else '',
                    org_id=getattr(_control, 'orgId', '') if _control else '',
                    pipeline_name=self._task_name or '',
                    source_name=self._status.name or self.source or '',
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
                        # The run's CHAPTER identity: the run-begin marker's
                        # seq (the writer opened just above). Lets clients
                        # synthesize the chapter locally with the exact key
                        # the server's chapter list will carry.
                        'beginSeq': self._run_log.chapter_begin_seq if self._run_log is not None else None,
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

    async def _materialize_installed_nodes(self):
        """Copy the caller's installed node capsules from the store into a per-run
        dir and return it (to pass as ``--node_path``), or None when none are
        installed. Any parent ``--node_path`` local_nodes are merged in first, and
        installed capsules win on a name collision — so the workspace fallback
        survives alongside installed capsules. Best-effort: failures return None.
        """
        from ai.account import RequestContext, Store

        names = []
        fs = None
        try:
            fs = Store.file_store(RequestContext.internal('node-materialize'), client_id=self.client_id)
            listing = await fs.list_dir('local_nodes')
            names = [e['name'] for e in listing.get('entries', []) if e.get('type') == 'dir']
        except Exception as e:
            self.debug_message(f'no installed node capsules to materialize: {e}')
        if not names:
            return None  # nothing installed → caller forwards the parent --node_path unchanged

        node_dir = tempfile.mkdtemp(prefix='rr-nodes-')
        self._node_path_dir = node_dir
        dst_root = os.path.join(node_dir, 'local_nodes')
        os.makedirs(dst_root, exist_ok=True)
        open(os.path.join(dst_root, '__init__.py'), 'w', encoding='utf-8').close()

        # Merge the parent --node_path workspace nodes first; store capsules win.
        for arg in startup_args():
            if arg.startswith('--node_path='):
                parent_local = os.path.join(arg[len('--node_path=') :], 'local_nodes')
                if os.path.isdir(parent_local):
                    for entry in os.listdir(parent_local):
                        src = os.path.join(parent_local, entry)
                        if entry != '__pycache__' and os.path.isdir(src):
                            shutil.copytree(src, os.path.join(dst_root, entry), dirs_exist_ok=True)
                break

        for name in names:
            await self._copy_store_tree(fs, f'local_nodes/{name}', os.path.join(dst_root, name))
        self.debug_message(f'materialized {len(names)} installed node(s) at {node_dir}')
        return node_dir

    async def _copy_store_tree(self, fs, store_path: str, dst: str) -> None:
        """Recursively copy a store subtree to a local dir (utf-8-safe bytes)."""
        os.makedirs(dst, exist_ok=True)
        listing = await fs.list_dir(store_path)
        for e in listing.get('entries', []):
            src = f'{store_path}/{e["name"]}'
            target = os.path.join(dst, e['name'])
            if e.get('type') == 'dir':
                await self._copy_store_tree(fs, src, target)
            else:
                with open(target, 'wb') as fh:
                    fh.write(await fs.read(src))

    def _cleanup_materialized_nodes(self) -> None:
        """Remove the per-run materialized local_nodes dir, if one was created."""
        node_dir = self._node_path_dir
        self._node_path_dir = None
        if node_dir:
            shutil.rmtree(node_dir, ignore_errors=True)

    async def stop_task(self, reason: str = 'user') -> None:
        """
        Initiate graceful task termination with resource cleanup.

        Args:
            reason: WHY the stop happens — 'user' (explicit request) or
                'ttl' (the run window elapsed). Drives the recorded run
                outcome: a ttl expiry is a successful run, not a cancel.
        """
        try:
            # Prevent race conditions
            async with self._termination_lock:
                # Get subprocess reference
                engine = self._engine_process

                # Mark as a requested stop and block new operations.
                self._stop_requested = True
                self._stop_reason = reason
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
        finally:
            # Remove the per-run materialized node dir regardless of how we stopped.
            self._cleanup_materialized_nodes()
