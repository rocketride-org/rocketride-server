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

import os
import time
import errno
import socket
import sys
import asyncio
import uuid
from typing import List
from fastapi import WebSocket
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, Set
from ai.constants import (
    CONST_CLEANUP_DELAY_TIME,
    CONST_CLEANUP_SLEEP_TIME,
    CONST_DEFAULT_TTL,
    CONST_TTL_CHECK,
    CONST_MAX_UNAUTHED_CONNS_PER_IP,
    CONST_MAX_UNAUTHED_IPS,
    CONST_DEFAULT_REPLICAS,
    CONST_MAX_REPLICAS,
    CONST_DEFAULT_TORCH_THREADS,
)
from ai.common.dap import TransportWebSocket, DAPBase
from rocketride import TASK_STATUS, TASK_STATE, EVENT_TYPE
from ai.web import WebServer
from ai.account.models import AccountInfo, resolve_task_permissions
from ai.account.store import Store
from .task_conn import TaskConn
from .task_engine import Task
from .types import LAUNCH_TYPE, TaskError, decode_pipe_id
from .pipeline import resolve_implied_source
from .commands.cmd_monitor import owner_key

from rocketlib import debug


def _is_task_running(task: Task) -> bool:
    """True when an engine is in the RUNNING state and can take work."""
    return task.get_status().state == TASK_STATE.RUNNING.value


def resolve_replicas(requested: Any) -> int:
    """Parse and clamp the requested replica count (None → server default)."""
    if requested is None:
        requested = CONST_DEFAULT_REPLICAS
    try:
        value = int(requested)
    except (TypeError, ValueError):
        value = 1
    return max(1, min(value, CONST_MAX_REPLICAS))


def resolve_torch_threads(requested: Any, replicas: int) -> int:
    """
    Resolve the per-replica BLAS/OMP thread count.

    The rule, in order: an explicit positive value wins; otherwise the
    server-wide default; otherwise, with more than one replica,
    ``cpu_count // replicas``; otherwise 0, meaning inject nothing at all.
    """
    raw = requested if requested is not None else CONST_DEFAULT_TORCH_THREADS

    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 0

    if value > 0:
        return value

    if replicas > 1:
        return max(1, (os.cpu_count() or 1) // replicas)

    return 0


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
        task (Optional[Task]): The PRIMARY engine (replica 0) — the one every
            status, attach, debug and monitor path talks to
        replica_tasks (List[Task]): The additional engines (replicas 1..N-1)
            running the same pipeline behind the same token
        launch_type (LAUNCH_TYPE): The method used to create this task (launch/execute)
        pipeline (Optional[Dict[str, Any]]): Task configuration and execution parameters
    """

    # Short of the pipe — used for display and events
    id: str = ''

    # Connection and task identifiers
    client_id: str = ''
    token: str = ''

    # User, team, and org identity (derived from AccountInfo after auth)
    userId: str = ''
    teamId: str = ''
    orgId: str = ''

    # Run classification: 'dev' | 'deploy'. Part of task identity — the
    # OWNER of a dev run is its user, the owner of a deploy run is its
    # team, and the token digest, monitor keys, and lookups all scope by
    # that owner. teamId above remains billing/permission attribution and
    # is NOT the owner for dev runs.
    run_kind: str = 'dev'

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

    # And finally, the task reference. `task` is the PRIMARY engine (replica
    # 0) and stays the single answer for every status / attach / debug /
    # monitor path, so all the callers that predate replicas keep working
    # unchanged. `replica_tasks` holds replicas 1..N-1 — same token, same
    # pipeline, same launch args, separate subprocesses.
    task: Optional[Task] = None
    replica_tasks: List[Task] = field(default_factory=list)

    # Round-robin cursor for pick_data_task. Not an index into `tasks`: it
    # only ever advances, and the modulo is taken against the currently
    # running set, so replicas coming and going cannot make it point past
    # the end.
    data_cursor: int = 0

    # Latch: has an apaevt_task 'begin' already been broadcast for this
    # control? Every replica emits its own, but clients fold task events by
    # {projectId, source, action} — N begins read as N pipelines starting.
    # The FIRST replica to begin speaks for the control.
    begin_broadcast: bool = False

    # Latch: has an apaevt_task 'end' already been broadcast for this
    # control? Two replicas finishing in the same gather can both observe
    # "all complete" — only the first gets to speak for the token.
    end_broadcast: bool = False

    @property
    def tasks(self) -> List[Task]:
        """
        Every engine behind this token, primary first.

        The primary is included so the single-replica case (the overwhelming
        majority) is just a one-element list — lifecycle code iterates this
        and needs no branch for "replicated or not".
        """
        if self.task is None:
            return list(self.replica_tasks)
        return [self.task, *self.replica_tasks]

    @property
    def replicas(self) -> int:
        """How many engines are running behind this token."""
        return len(self.tasks)

    def pick_data_task(self) -> Task:
        """
        Choose the engine that should receive the next input, round-robin.

        Only RUNNING engines are candidates: a replica that is still
        initializing, or one whose subprocess died, would otherwise take a
        1/N share of the traffic and block or fail it. When nothing is
        running yet the primary is returned — the data path awaits
        ``wait_for_running()`` on it, which is exactly the pre-replica
        behavior for a task that has not finished starting.

        Returns:
            Task: The engine to send to.
        """
        tasks = self.tasks

        # The common case: no replicas, nothing to choose between.
        if len(tasks) == 1:
            return tasks[0]

        running = [task for task in tasks if _is_task_running(task)]
        if not running:
            return self.task

        picked = running[self.data_cursor % len(running)]
        self.data_cursor += 1
        return picked

    def route_data_request(self, request: Dict[str, Any]) -> tuple:
        """
        Resolve ONE data request to the engine that must serve it.

        No ``pipe_id``: round-robin. A ``pipe_id``: decode the replica out of
        it, route there, and localise the id. Unreplicated: passthrough.

        Returns:
            tuple: ``(task, request_to_send)``.

        Raises:
            ValueError: The id names a replica this control lacks, or one
                that is not running.
        """
        tasks = self.tasks
        if len(tasks) <= 1:
            return self.task, request

        args = request.get('arguments') or {}
        wire_id = args.get('pipe_id', None)

        # Nothing to be affine to — spread the load.
        if not isinstance(wire_id, int):
            return self.pick_data_task(), request

        local_id, index = decode_pipe_id(wire_id)
        if index >= len(tasks):
            raise ValueError(f'Pipe id {wire_id} names replica {index}, but this pipeline runs {len(tasks)} replica(s)')

        task = tasks[index]
        if not _is_task_running(task):
            # Fail loudly. Re-routing to a live replica would find no such
            # pipe there and report a confusing "pipe not found" instead of
            # the truth: the engine holding that pipe is gone.
            raise ValueError(
                f'Pipe id {wire_id} belongs to replica {index} of this pipeline, which is no longer running'
            )

        localised = dict(request)
        localised_args = dict(args)
        localised_args['pipe_id'] = local_id
        localised['arguments'] = localised_args
        return task, localised

    def get_status(self) -> TASK_STATUS:
        """
        The status of the TOKEN — every replica folded into one row.

        Counters are per-engine, and inputs are round-robined, so reading the
        primary alone reports roughly 1/N of the work a replicated pipeline
        actually did. Counters, resources and billing sum; startTime/endTime
        take the outermost bound; ``completed`` means every replica has ended;
        warnings and errors are concatenated. ``state`` and the run analytics
        (``completionSeconds``, ``idleSeconds``, ``componentStats``,
        ``slowestDocs``, ``pipeflow``) stay the PRIMARY's — the process every
        attach/debug path talks to.

        Returns:
            TASK_STATUS: The primary's own status object when unreplicated
                (no copy, no cost); otherwise an aggregate copy.
        """
        tasks = self.tasks
        primary = tasks[0].get_status()
        if len(tasks) == 1:
            return primary

        statuses = [primary, *[task.get_status() for task in tasks[1:]]]

        # Copy so the primary's live status object is never mutated — it is
        # the same instance the Task keeps updating.
        merged = primary.model_copy(deep=True)

        for name in (
            'totalSize',
            'totalCount',
            'completedSize',
            'completedCount',
            'failedSize',
            'failedCount',
            'wordsSize',
            'wordsCount',
            'rateSize',
            'rateCount',
        ):
            setattr(merged, name, sum(getattr(status, name, 0) or 0 for status in statuses))

        # The run spans from the first engine to start to the last to finish.
        merged.startTime = min((status.startTime for status in statuses if status.startTime), default=0.0)
        # endTime is only meaningful once every replica has reported one; a
        # live engine reports endTime == 0.0.
        if all(status.endTime for status in statuses):
            merged.endTime = max(status.endTime or 0.0 for status in statuses)
        else:
            merged.endTime = 0.0
        # Same fact as endTime above: every replica has ended.
        merged.completed = all(status.completed for status in statuses)

        # Resource usage is the sum across processes (that is what the box
        # actually spends); peaks are the sum of peaks — an upper bound, and
        # the number that matters for capacity.
        for name in (
            'cpu_percent',
            'cpu_memory_mb',
            'gpu_memory_mb',
            'peak_cpu_percent',
            'peak_cpu_memory_mb',
            'peak_gpu_memory_mb',
            'avg_cpu_percent',
            'avg_cpu_memory_mb',
            'avg_gpu_memory_mb',
        ):
            setattr(
                merged.metrics,
                name,
                sum(getattr(status.metrics, name, 0.0) or 0.0 for status in statuses),
            )

        # Billing is cumulative per process; the token's cost is their sum.
        for name in ('cpu_utilization', 'cpu_memory', 'gpu_memory', 'gpu_inference', 'total'):
            setattr(
                merged.tokens,
                name,
                sum(getattr(status.tokens, name, 0.0) or 0.0 for status in statuses),
            )

        # Warnings and errors from every engine, or a failing replica is
        # invisible to anyone watching the token.
        for status in statuses[1:]:
            merged.warnings.extend(status.warnings)
            merged.errors.extend(status.errors)

        return merged

    @property
    def idle_time(self) -> float:
        """
        The token's idle time: the BUSIEST replica's.

        Inputs round-robin, so the group has only been idle as long as the
        replica that most recently did something.
        """
        # Completed replicas stop aging (the TTL monitor skips them), so they
        # would pin the group's idle time at a stale low value.
        live = [task for task in self.tasks if not task.is_task_complete()] or self.tasks
        return min((task._idle_time for task in live), default=0)

    @property
    def owner_id(self) -> str:
        """
        The identity that OWNS this run: the team for deploy runs, the
        user for dev runs. Monitor keys and identity lookups scope by this
        value — never by the attribution teamId of a dev run.
        """
        return self.teamId if self.run_kind == 'deploy' else self.userId

    def should_forward_event(self, event: Dict[str, Any]) -> bool:
        """
        Decide whether one replica's ``apaevt_task`` speaks for the whole token.

        - ``begin``: first replica to begin (latched), rest dropped.
        - ``end``: last replica to finish, latched so two finishing in the
          same tick cannot both pass.
        - ``restart``: the primary only.
        - Everything else (status, output, trace, flow, SSE) passes through.

        Returns:
            bool: True to broadcast.
        """
        # An unreplicated token has nothing to fold — never touch its stream.
        if len(self.tasks) <= 1:
            return True

        if event.get('event') != 'apaevt_task':
            return True

        body = event.get('body') or {}
        action = body.get('action')

        if action == 'begin':
            if self.begin_broadcast:
                return False
            self.begin_broadcast = True
            return True

        if action == 'end':
            if self.end_broadcast:
                return False
            if not all(task.is_task_complete() for task in self.tasks):
                return False
            self.end_broadcast = True
            return True

        if action == 'restart':
            return body.get('replica', 0) == 0

        return True


def _apply_source_defaults(pipeline: Dict[str, Any], source: str) -> Dict[str, Any]:
    """
    Fill in the fields a launch stamps on a pipeline, so two copies compare equal.

    ``start_task`` writes the resolved source onto the pipeline and gives the
    source component an empty config when it has none. A pipeline stored without
    those looks different from the same pipeline after a launch, which turns a
    useExisting comparison into a false "differs".

    Args:
        pipeline: The pipeline to normalise, mutated in place.
        source: The resolved source component id.

    Returns:
        The same pipeline.

    Raises:
        ValueError: If the source component is not in the components list.
    """
    pipeline['source'] = source
    for component in pipeline.get('components', []):
        if component.get('id') == source:
            if 'config' not in component:
                component['config'] = {}
            return pipeline
    raise ValueError(f'Pipeline source component "{source}" not found in components list')


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
        self._unauthed_by_ip: Dict[str, int] = {}  # Count of unauthenticated connections per client IP

        # Global port allocation tracking
        self._allocated_ports: List[int] = []

        # Ports the operating system refuses to bind — Windows exclusion ranges,
        # POSIX privileged ports. Re-probing them cannot change the answer while
        # this process lives, so the verdict is kept. Ports merely held by
        # another socket are deliberately not remembered: that owner can exit.
        self._reserved_ports: Set[int] = set()

        # Shared store instance (lazy-loaded via property)

        # Start background tasks that must be cancelled on shutdown.
        self._bg_tasks: List[asyncio.Task] = [
            # Cleanup for completed tasks
            asyncio.create_task(self._cleanup_tasks()),
            # TTL monitoring
            asyncio.create_task(self._monitor_ttl()),
        ]

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
        # The process-wide singleton — TaskServer no longer owns a private
        # instance, so server code and Store.file_store(ctx) call sites can
        # never diverge onto different stores.
        return Store.instance()

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

                    # Skip tasks that are still actively running. A replicated
                    # control is complete only when EVERY replica is: removing
                    # it while one still runs would orphan that subprocess and
                    # leave its events broadcasting under a dead token.
                    control_tasks = control.tasks
                    if any(not task.is_task_complete() for task in control_tasks):
                        continue

                    # Check if sufficient time has passed since completion —
                    # measured from the LAST replica to finish.
                    end_time = max(task.get_status().endTime for task in control_tasks)
                    if end_time + CONST_CLEANUP_DELAY_TIME < current_time:
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

                    # Skip TTL enforcement if ttl is 0 (no timeout). All
                    # replicas of a token carry the same ttl (one launch, one
                    # value), so the primary's answer is the group's.
                    if control.task._ttl == 0:
                        continue

                    # Age every replica that is still alive. Completed ones
                    # are the cleanup loop's business and must not hold the
                    # group's idle clock back.
                    live = [task for task in control.tasks if not task.is_task_complete()]
                    if not live:
                        continue

                    for task in live:
                        task._idle_time += check_interval

                    # THE GROUP IS IDLE ONLY WHEN EVERY REPLICA IS. Inputs are
                    # round-robined, so one busy replica means the pipeline is
                    # in use — killing the token because its siblings happened
                    # to be between documents would cut a live run short.
                    if all(task._idle_time >= task._ttl for task in live):
                        idle = min(task._idle_time for task in live)
                        self.debug_message(
                            f'Task "{control.id}" exceeded TTL ({idle}s >= {control.task._ttl}s) '
                            f'across all {len(live)} replica(s), terminating...'
                        )
                        # Terminate the idle task — reason 'ttl', so the
                        # run records as completed, never as cancelled.
                        await self.stop_task(control.token, reason='ttl')

            except Exception as e:
                # Log errors but continue operation to maintain system stability
                self.debug_message(f'Error during TTL monitoring cycle: {e}')

    async def shutdown(self) -> None:
        """Cancel all background tasks."""
        bg_tasks = getattr(self, '_bg_tasks', [])
        for task in bg_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*bg_tasks, return_exceptions=True)

    def release_unauthed_slot(self, ip: str) -> None:
        """
        Decrement the unauthenticated connection count for an IP.

        Called when a connection authenticates successfully (so its slot is freed
        for new unauthenticated connections from the same IP) or when an
        unauthenticated connection disconnects.
        """
        if not ip:
            return
        count = self._unauthed_by_ip.get(ip, 0)
        if count <= 1:
            self._unauthed_by_ip.pop(ip, None)
        else:
            self._unauthed_by_ip[ip] = count - 1

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
        debug(f'[CONN] connected: id={connection_id} ip={conn._client_ip}')

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
        debug(f'[CONN] disconnected: id={connection_id} authenticated={getattr(conn, "_authenticated", False)}')

        # Release any cProfile session owned by this connection
        if hasattr(conn, 'release_profiler'):
            conn.release_profiler()

        # Remove connection from active connections registry
        if connection_id in self._connections:
            del self._connections[connection_id]

        # If this connection never authenticated, release its unauthenticated slot
        if not getattr(conn, '_authenticated', False):
            self.release_unauthed_slot(getattr(conn, '_client_ip', ''))

        conn_user_id = getattr(getattr(conn, '_account_info', None), 'userId', None)

        # Expire this connection's dev-overlay entries (a closed dev session
        # must not leave a stale bundle override in the user's manifest) and
        # refresh the user's REMAINING connections so their shells drop it.
        if conn_user_id:
            try:
                from ai.account.dev_overlay import drop_connection, push_refresh

                if drop_connection(conn_user_id, connection_id):
                    await push_refresh(self, conn_user_id, source='expiry')
            except Exception as e:
                self.debug_message(f'dev overlay disconnect cleanup failed: {e}')

        await self.broadcast_server_event(
            EVENT_TYPE.DASHBOARD,
            {
                'event': 'apaevt_dashboard',
                'body': {
                    'action': 'connection_removed',
                    'timestamp': time.time(),
                    'connectionId': connection_id,
                    'clientName': getattr(conn, '_client_info', {}).get('name'),
                    'clientVersion': getattr(conn, '_client_info', {}).get('version'),
                },
            },
            user_id=conn_user_id,
        )

        # Process all tasks for disconnection cleanup
        for control in list(self._task_control.values()):
            try:
                # Only the primary is ever attached (attach_task is primary-only).
                await control.task.detach_task(conn)

                # Auto-terminate launched tasks when the launching client disconnects
                if control.launch_type == LAUNCH_TYPE.LAUNCH and control.launch_owner == conn:
                    stop_results = await asyncio.gather(
                        *(task.stop_task() for task in control.tasks),
                        return_exceptions=True,
                    )
                    for result in stop_results:
                        if isinstance(result, BaseException):
                            self.debug_message(f'Error stopping a replica of task "{control.id}": {result}')
                    self.debug_message(f'Auto-terminated launched task "{control.id}" after client disconnect')

            except Exception as e:
                # Log cleanup errors but continue processing other tasks
                self.debug_message(f'Error during disconnection cleanup for task "{control.id}": {e}')

        # Close any open file store handles for this connection. The handle
        # registry is Store-wide (shared across all FileStore instances), so
        # this covers every store the connection ever constructed.
        try:
            await self.store.close_all_handles(connection_id)
        except Exception as e:
            self.debug_message(f'Error closing file handles for connection {connection_id}: {e}')

        # Log successful disconnection cleanup
        self.debug_message(f'Connection {connection_id} disconnected and cleaned up.')

    def _build_task_account_info(self, token: str, control: 'TASK_CONTROL', permissions: list) -> AccountInfo:
        """Build a minimal AccountInfo for pk_*/tk_* task-scoped authentication."""
        return AccountInfo(
            auth=token,
            userToken=token,
            userId=control.userId,
            displayName='',
            givenName='',
            familyName='',
            preferredUsername='',
            email='',
            emailVerified=False,
            phoneNumber='',
            phoneNumberVerified=False,
            locale='',
            defaultTeam=control.teamId,
            organization={
                'id': control.orgId,
                'name': '',
                'permissions': [],
                'teams': [{'id': control.teamId, 'name': '', 'permissions': permissions}],
            },
        )

    async def authenticate(self, authorization: str) -> Optional[AccountInfo]:
        """
        Validate task-scoped keys (pk_*, tk_*) and return a minimal AccountInfo.
        All other credential types fall through to account.authenticate().

        Args:
            authorization (str): Authentication key

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live task.
                Subclasses RuntimeError; these two branches raised ValueError
                before task errors carried codes.
        """
        if authorization.startswith('pk_'):
            for control in self._task_control.values():
                if control.public_auth == authorization:
                    return self._build_task_account_info(
                        authorization,
                        control,
                        ['task.data'],
                    )
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        if authorization.startswith('tk_'):
            control = self._task_control.get(authorization)
            if control:
                return self._build_task_account_info(
                    authorization,
                    control,
                    ['task.control', 'task.data', 'task.monitor', 'task.debug', 'task.store'],
                )
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Not a task key — delegate to account layer
        return None

    def get_task_control_by_project(
        self,
        project_id: str,
        source: str,
        account_info: Optional[AccountInfo] = None,
        require: Optional[str] = None,
        team_id: str = '',
    ) -> TASK_CONTROL:
        """
        Retrieve task control structure by its owner-scoped identity.

        The scope IS the kind: ``team_id`` set addresses the team's DEPLOY
        run of ``project_id``/``source``; ``team_id`` absent addresses the
        caller's own DEV run (owner = ``account_info.userId``). Both are
        unique by construction — task identity is {owner}.{project}.{source}.

        Without ``account_info`` (legacy/OSS/HTTP fallback) the pair is
        scanned unscoped: a single match returns, multiple matches raise
        instead of silently returning an arbitrary run.

        Args:
            project_id (str): Project identity of the run
            source (str): Source component id of the run
            account_info (Optional[AccountInfo]): Caller identity for scoping
                and permission checks
            require (Optional[str]): Permission that must be granted on the
                run's team (e.g. 'task.monitor')
            team_id (str): Owner team — addresses that team's deploy run;
                empty addresses the caller's dev run

        Raises:
            RuntimeError: If no (or ambiguously many) matching tasks exist
            PermissionError: If the permission check fails
        """

        def _verify(control: TASK_CONTROL) -> TASK_CONTROL:
            """Apply the team permission check against the run's team."""
            if account_info is not None:
                perms = resolve_task_permissions(account_info, control.teamId)
                if not perms:
                    raise PermissionError('Access denied: no permissions for this task')
                if require and require not in perms:
                    raise PermissionError(f'Permission {require!r} denied for this task')
            return control

        # Team scope: the team's deploy run. A team scope without a caller
        # identity is never legitimate — permission must resolve somewhere.
        if team_id:
            if account_info is None:
                raise PermissionError('Not authenticated')
            for control in self._task_control.values():
                if (
                    control.run_kind == 'deploy'
                    and control.teamId == team_id
                    and control.project_id == project_id
                    and control.source == source
                ):
                    return _verify(control)
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Dev scope: the caller's own run — unique per user by construction.
        if account_info is not None:
            for control in self._task_control.values():
                if (
                    control.run_kind == 'dev'
                    and control.userId == account_info.userId
                    and control.project_id == project_id
                    and control.source == source
                ):
                    return _verify(control)
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Legacy unscoped scan (OSS single-user / HTTP fallback): tolerate a
        # unique match; refuse to guess between several runs.
        matches = [
            control
            for control in self._task_control.values()
            if control.project_id == project_id and control.source == source
        ]
        if len(matches) == 1:
            return matches[0]
        if matches:
            raise TaskError(TaskError.AMBIGUOUS, 'Multiple pipelines are running for this project; specify a scope')
        raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

    def get_task_control_by_public_key(self, public_auth: str) -> TASK_CONTROL:
        """
        Retrieve task control structure with a given project/source id.

        Args:
            token (str): The token to retrieve

        Returns:
            TASK_CONTROL: Complete task control structure with metadata and references

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live task
        """
        # Look for it
        for control in self._task_control.values():
            if control.public_auth == public_auth:
                return control

        # Couldn't find it
        raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

    def get_task_control(
        self,
        token: str,
        account_info: Optional[AccountInfo] = None,
        require: Optional[str] = None,
    ) -> TASK_CONTROL:
        """
        Retrieve task control structure by token.

        If account_info is provided and require is specified, checks that the
        authenticated user has the required permission for the task's team.

        Raises:
            ValueError: If token is not specified
            RuntimeError: If task doesn't exist
            PermissionError: If permission check fails
        """
        if not token:
            raise ValueError('Task token is required')

        control = self._task_control.get(token, None)
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Resolve against the TASK'S team (the old resolve_team_permissions
        # call raised on foreign teams instead of denying uniformly).
        # sys.admin and internal identities bypass INSIDE the resolver — it
        # returns the full permission set for them — so no outer short-circuit.
        if account_info is not None and require:
            perms = resolve_task_permissions(account_info, control.teamId)
            if not perms:
                raise PermissionError('Access denied: no permissions for this task')
            if require not in perms:
                raise PermissionError(f'Permission {require!r} denied for this task')

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
            ValueError: If token is not specified
            TaskError: Code TASK_NOT_REGISTERED if the token names no live task

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
        Allocate an available port from the managed pool.

        Returns the first port in the window that is neither already handed out
        nor rejected by a bind probe, so the child that receives the number on
        its command line can actually listen on it. OS-forbidden ports are
        cached; ports merely held by another socket are re-probed every call.

        Two consequences of probing without SO_REUSEADDR: on POSIX a port still
        in TIME_WAIT reads as in-use even though the child could bind it, so a
        just-released port is not handed straight back; and the sweep runs
        synchronously on the event loop, one socket()/bind()/close() per
        candidate. Both are acceptable at this window size.

        Returns:
            int: An available port number inside the configured window.

        Raises:
            RuntimeError: If no port in the window can be bound. The message
                names whichever cause accounts for most of the window.
        """
        base_port = self._config.get('base_port', 20000)

        # Port 0 means "any ephemeral port" to bind(), so it always probes free.
        # Above 65535 bind() raises OverflowError, not OSError.
        first_port = max(base_port, 1)
        last_port = min(base_port + 9999, 65535)

        # Windows exclusion ranges come and go with Hyper-V, WSL and Docker, so
        # a cached verdict can outlive the reservation. Without a retry the
        # usable window could only ever shrink. One retry, never more.
        for attempt in range(2):
            num_allocated = num_occupied = num_reserved = num_unexpected = 0
            unexpected_errno = None

            # Skipped on a cached verdict rather than a live probe: only these
            # can be stale, so only these justify a retry.
            trusted_cache = 0

            # Snapshot: the list stays authoritative for release_port, but a
            # linear scan per candidate would make a full window quadratic.
            already_allocated = set(self._allocated_ports)

            for port in range(first_port, last_port + 1):
                if port in already_allocated:
                    num_allocated += 1
                    continue

                if port in self._reserved_ports:
                    num_reserved += 1
                    trusted_cache += 1
                    continue

                failure = self._probe_port(port)

                if failure is None:
                    self._allocated_ports.append(port)
                    if num_occupied or num_reserved or num_unexpected:
                        self.debug_message(
                            f'Assigned port {port}, having skipped {num_occupied} in use, '
                            f'{num_reserved} reserved and {num_unexpected} unexpected'
                        )
                    return port

                if failure == errno.EACCES:
                    self._reserved_ports.add(port)
                    num_reserved += 1
                elif failure == errno.EADDRINUSE:
                    num_occupied += 1
                else:
                    num_unexpected += 1
                    unexpected_errno = failure

            # A window exhausted by live probes has nothing stale to forget.
            if attempt or not trusted_cache:
                break

            self.debug_message(
                f'No port free in {first_port}-{last_port}; dropping {len(self._reserved_ports)} '
                f'cached OS reservations and probing again'
            )
            self._reserved_ports.clear()

        # Every failure was ours, not the pool's — an fd ceiling, say. Nothing
        # was learned about these ports, and the child has its own fd table, so
        # degrade to the old behaviour rather than refuse to launch.
        if num_unexpected and not num_occupied and not num_reserved:
            name = errno.errorcode.get(unexpected_errno, str(unexpected_errno))
            for port in range(first_port, last_port + 1):
                if port not in already_allocated:
                    self._allocated_ports.append(port)
                    self.debug_message(
                        f'Could not probe any port in {first_port}-{last_port} (errno '
                        f'{unexpected_errno} / {name}); assigning {port} unverified'
                    )
                    return port

        tallies = {
            'allocated': num_allocated,
            'occupied': num_occupied,
            'reserved': num_reserved,
            'unexpected': num_unexpected,
        }
        raise RuntimeError(self._no_ports_message(base_port, first_port, last_port, tallies, unexpected_errno))

    def release_port(self, port: int) -> None:
        """
        Release port back to available pool.

        Args:
            port: Port number to release
        """
        if port in self._allocated_ports:
            self._allocated_ports.remove(port)

    async def broadcast_server_event(
        self,
        type: EVENT_TYPE,
        event: Dict[str, Any],
        user_id: str = None,
        org_id: str = None,
    ) -> None:
        """
        Broadcast a server-level event to all connections subscribed via the '*' wildcard.

        Iterates over every active connection and calls send_server_event on each one.
        Delivery failures for individual connections are silently swallowed so that a
        single bad connection cannot interrupt the broadcast to others.

        Args:
            type (EVENT_TYPE): Event type bitmask used to filter subscribed connections.
                Only connections whose '*' subscription includes this bit will receive the event.
            event (Dict[str, Any]): Fully-formed DAP event payload to deliver.
                Expected keys: 'event' (str) and 'body' (Any).
            user_id (str, optional): When provided, restricts delivery to connections
                whose authenticated userId matches this value (tenant scoping).
            org_id (str, optional): When provided, restricts delivery to connections
                whose primary org matches this value (org scoping for billing events).
        """
        for conn in list(self._connections.values()):
            try:
                await conn.send_server_event(type, event=event, user_id=user_id, org_id=org_id)
            except Exception as e:
                self.debug_message(f'Failed to broadcast server event to connection: {e}')

    async def push_account_update(self, user_id: str) -> None:
        """
        Rebuild AccountInfo from the DB for user_id and push an apaext_account
        event to every open connection belonging to that user.

        Called after any operation that mutates identity, org, or team membership.
        The connection's _account_info is updated in-place so subsequent permission
        checks use the fresh data.
        """
        from ai.account import account

        for conn in list(self._connections.values()):
            if not getattr(conn, '_account_info', None):
                continue
            if conn._account_info.userId != user_id:
                continue
            try:
                fresh = await account._service.get_authentication_result(user_id, conn._account_info.auth)
                conn._account_info = fresh
                await conn.send_event('apaext_account', body=fresh.to_connect_result())
            except Exception as e:
                self.debug_message(f'push_account_update failed for conn {conn.get_connection_id()}: {e}')

    async def broadcast_task_event(self, event_type: EVENT_TYPE, token: str, event: Dict[str, Any]) -> None:
        """
        Broadcast a task-scoped event to all connections that are subscribed to the given task.

        Iterates over every active connection and calls send_task_event on each one.
        PermissionError is treated as a normal condition (e.g. a public-key connection that
        does not hold task.monitor) and silently skipped. All other exceptions are logged
        but do not abort the broadcast to remaining connections.

        Args:
            event_type (EVENT_TYPE): Event type bitmask (e.g. SUMMARY, SSE) used by each
                connection's send_task_event to decide whether it should receive the event.
            token (str): Unique task token identifying the originating task. Each connection
                resolves this token to its subscription key independently.
            event (Dict[str, Any]): Fully-formed DAP event payload to deliver.
                Expected keys: 'event' (str) and 'body' (Any).
        """
        # If the task has already been removed from the registry (e.g.
        # cleanup raced with pending broadcasts), skip silently instead of
        # spamming "Your pipeline is not running" for every connection.
        if token not in self._task_control:
            return

        # One lifecycle event per TOKEN, not per replica.
        if not self._task_control[token].should_forward_event(event):
            return

        # Snapshot to list() so a connection joining or dropping mid-broadcast
        # does not raise RuntimeError on the next iteration; matches the
        # pattern used by broadcast_server_event / push_account_update above.
        for conn in list(self._connections.values()):
            try:
                await conn.send_task_event(event_type, token=token, event=event)

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
            ValueError: If token is not specified
            TaskError: Code TASK_NOT_REGISTERED if the token names no live task
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
            TaskError: Code TASK_NOT_REGISTERED if the token names no live task

        Cleanup Process:
        1. Validate task ownership and existence
        2. Remove task from central registry
        3. Stop task execution and cleanup resources
        4. Remove all monitoring subscriptions
        5. Log removal for audit trail
        6. Return control structure for additional caller-specific cleanup
        """
        # Remove task from central registry
        # pop with a default: without one an unknown token raises KeyError and the
        # TaskError below never runs, so the failure reaches the caller unclassified.
        control = self._task_control.pop(token, None)

        # If not there, it wasn't running
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Ensure every engine behind the token is stopped and cleaned up.
        # Concurrently: each stop waits out its own subprocess termination
        # timeout, and serialising N of those turns a removal into minutes.
        # return_exceptions keeps one stubborn replica from stranding the rest.
        results = await asyncio.gather(*(task.stop_task() for task in control.tasks), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                self.debug_message(f'Error stopping a replica of task "{control.id}": {result}')

        # Remove monitor subscriptions that reference this task from all
        # connections — keys are owner-scoped, so build from the control
        project_key = owner_key(control.owner_id, control.project_id, control.source)
        for conn in self._connections.values():
            if hasattr(conn, '_monitors'):
                # Remove exact source key, pipe-scoped keys, and token-scoped keys
                keys_to_remove = [
                    k
                    for k in conn._monitors
                    if k == project_key or k.startswith(f'{project_key}.') or k == token or k.startswith(f'{token}.')
                ]
                for key in keys_to_remove:
                    conn._monitors.pop(key, None)

        # Notify dashboard subscribers
        await self.broadcast_server_event(
            EVENT_TYPE.DASHBOARD,
            {
                'event': 'apaevt_dashboard',
                'body': {'action': 'task_removed', 'timestamp': time.time(), 'taskId': control.id},
            },
            user_id=control.userId,
        )

        # Log task removal for audit trail and debugging
        self.debug_message(f'Task status for "{control.id}" removed')
        return control

    async def start_task(
        self,
        request: Dict[str, Any],
        conn: TaskConn = None,
        *,
        attach_debugger=False,
        wait_for_running=False,
        client_id: str = '',
        user_id: str = '',
        team_id: str = '',
        org_id: str = '',
        env: Dict[str, str] | None = None,
        run_kind: str = 'dev',
        trigger: str = '',
    ) -> str:
        """
        Create and start a new computational task with full lifecycle management.

        This method handles the complete task creation process including validation,
        registry management, resource allocation, and startup coordination. It
        supports both interactive debugging and batch execution modes.

        Args:
            request (Dict[str, Any]): Task creation request containing:
                - arguments: Task configuration including Optional(token), pipeline,
                  and optionally `replicas` (engine subprocesses behind this one
                  token, clamped to 1..CONST_MAX_REPLICAS) and `torchThreads`
                  (per-replica BLAS/OMP threads; omitted means the auto rule in
                  resolve_torch_threads)
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

        def _return_results(control: TASK_CONTROL, reused: bool = False) -> str:
            """
            Return task token for the task.

            This inner function encapsulates the logic for returning the tokens.

            Args:
                control (TASK_CONTROL): The existing task control structure
                reused (bool): True when this is a live instance returned under
                    useExisting rather than a task launched from the submitted
                    pipeline. Without it the two are indistinguishable to the
                    caller, and a run against stale configuration reads as a
                    successful run of the configuration just sent.
            """
            return {
                'id': control.id,
                'token': control.token,
                'publicToken': control.public_auth,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
                'reused': reused,
                # How many engines actually run behind this token. Callers
                # sizing their own concurrency need the number the server
                # settled on, not the one they asked for (it is clamped).
                'replicas': control.replicas,
            }

        # Initialize task control structure for new task
        control = TASK_CONTROL()

        # For launch/exec token is in args
        args = request.get('arguments', {})
        use_existing_task = args.get('useExisting', False)

        # Extract TTL from args (use server-configured default if not provided)
        ttl = args.get('ttl', CONST_DEFAULT_TTL)

        # Replication: N engine subprocesses behind ONE token, inputs
        # round-robined across them. This is the only lever that parallelises
        # inference — `threads` is admission width, and one engine holds one
        # model copy behind one lock however wide that is.
        replicas = resolve_replicas(args.get('replicas', None))
        torch_threads = resolve_torch_threads(args.get('torchThreads', None), replicas)

        # Parse task configuration from request arguments
        control.client_id = client_id
        control.userId = user_id
        control.teamId = team_id
        control.orgId = org_id
        # Run classification MUST be set before token generation below: the
        # token digest scopes by the run's OWNER (user for dev, team for
        # deploy), which is derived from run_kind.
        control.run_kind = run_kind
        control.token = args.get('token', None)
        control.pipeline = args.get('pipeline', None)
        control.source = args.get('source', None)

        # If a source was not specified, in the args, get it from the pipeline
        if not control.source:
            control.source = control.pipeline.get('source', None)

        # If the pipeline doesn't have a source, find the implied source
        if not control.source:
            control.source = resolve_implied_source(control.pipeline)
            if control.source is None:
                raise ValueError('Pipeline does not have a source component defined')

        # Find the actual source component
        # Stamp the resolved source and give the source component a config if it has
        # none. Shared with restart_task so a restarted pipeline is stored in the same
        # shape a launched one is, and the two compare equal.
        _apply_source_defaults(control.pipeline, control.source)

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

        # Owner-scoped token identity: a task is uniquely
        # {owner}.{projectId}.{source} — the owner FIELD NAME (userId vs
        # teamId) disambiguates dev from deploy even if the id spaces ever
        # collided, so a dev run and a deploy run of the same pipeline
        # never hash to the same token, and neither do two teams' deploys
        # or two users' dev runs. Dev = once per user (total); deploy =
        # once per team (actor-independent — deploy dispatch carries no
        # user identity). The 'kind' discriminator keeps the tk_ and pk_
        # DIGESTS distinct, not just their prefixes.
        if control.run_kind == 'deploy':
            owner_content = {'teamId': control.teamId}
        else:
            owner_content = {'userId': control.userId}

        # Build the token
        if control.token is None:
            control.token = self._server.account.generate_token(
                content={
                    'kind': 'task',
                    **owner_content,
                    'project_id': control.project_id,
                    'source': control.source,
                },
                prefix='tk_',
            )

        # Build the public token
        control.public_auth = self._server.account.generate_token(
            content={
                'kind': 'public',
                **owner_content,
                'project_id': control.project_id,
                'source': control.source,
            },
            prefix='pk_',
        )

        # Display id: 8-char hash (stripping known auth prefixes) + source component id
        _AUTH_PREFIXES = ('tk_', 'pk_')
        token_hash = control.token
        for _p in _AUTH_PREFIXES:
            if token_hash.startswith(_p):
                token_hash = token_hash[len(_p) :]
                break
        control.id = f'{token_hash[:8]}.{control.source}'

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
            if any(not task.is_task_complete() for task in existing_control.tasks):
                # This is an active task, if we are told we can use it, then,
                # make sure the user actually specified the task to use. If so,
                # then all is ok, just use the existing task
                if use_existing_task:
                    # The submitted pipeline is not applied to a running instance.
                    # Say so when it differs from what is actually running, otherwise
                    # an edit-and-rerun loop silently measures the old configuration.
                    if control.pipeline != existing_control.pipeline:
                        self.debug_message(
                            f'Task "{existing_control.id}" is already running: reusing it and ignoring the '
                            'submitted pipeline, which differs from the running one. Restart the task to '
                            'apply it.'
                        )
                    # Replica count is not applied to a running instance either,
                    # and it is the throughput knob — silently serving 1 replica
                    # to a caller who asked for 8 reads as a measurement of 8.
                    existing_replicas = existing_control.replicas
                    if replicas != existing_replicas:
                        self.debug_message(
                            f'Task "{existing_control.id}" is already running with {existing_replicas} '
                            f'replica(s): reusing it and ignoring the requested {replicas}, which differs '
                            'from the running one. Restart the task to apply it.'
                        )
                    if wait_for_running:
                        # Every replica: the caller is told the TOKEN is ready.
                        await asyncio.gather(*(task.wait_for_running() for task in existing_control.tasks))
                    return _return_results(existing_control, reused=True)

                # We are absolutely supposed to create a task or the user did
                # not specify the token (which means a random collision)
                raise ValueError('Pipeline is already running.')

            # Clean up completed task with same token
            self._task_control.pop(control.token, None)
            self.debug_message(f'Replaced completed task "{control.id}"...')

        try:
            # Create the engine instances. Replicas share the token, the
            # pipeline and the launch args, and differ in exactly three
            # things: their display/temp-file id, their replica index, and
            # the ports they are handed (assign_port hands out a distinct
            # one per call, and Task calls it during its own start_task).
            engines = [
                Task(
                    server=self,
                    # A distinct id per replica: it names the temp task file,
                    # the DAP module and the metrics row. Sharing one would
                    # make the three indistinguishable in a log.
                    id=control.id if index == 0 else f'{control.id}#{index}',
                    project_id=control.project_id,
                    source=control.source,
                    token=control.token,
                    public_auth=control.public_auth,
                    pipeline=control.pipeline,
                    launch_args=args,
                    launch_type=control.launch_type,
                    provider=control.provider,
                    ttl=ttl,
                    client_id=control.client_id,
                    team_id=control.teamId,
                    org_id=control.orgId,
                    env=env or {},
                    run_kind=run_kind,
                    trigger=trigger,
                    replica_index=index,
                    replica_count=replicas,
                    torch_threads=torch_threads,
                )
                for index in range(replicas)
            ]

            # Replica 0 is the primary: the task every status, attach, debug
            # and monitor path resolves to.
            control.task = engines[0]
            control.replica_tasks = engines[1:]

            # Register task in central registry
            self._task_control[control.token] = control

            # Start every engine concurrently. Serially, N replicas would pay
            # N model-load times before the token answers at all — and the
            # loads are the whole reason a replica is expensive.
            results = await asyncio.gather(*(task.start_task() for task in engines), return_exceptions=True)
            failures = [result for result in results if isinstance(result, BaseException)]
            if failures:
                # A partial start is not a working pipeline: the ones that
                # came up are torn down here, and the FIRST failure is what
                # the caller sees (the others are usually its consequences).
                raise failures[0]

            # Log successful task creation
            self.debug_message(
                f'Task "{control.id}" started... (type: {control.launch_type.value}, replicas: {replicas})'
            )

            # If debugging is available, attach to it. The debugger attaches
            # to the PRIMARY only — one client, one process, one set of
            # breakpoints; replicas run undebugged (and `replicas` is a
            # throughput knob, not a debugging one).
            if attach_debugger and control.task.is_debug_available():
                await self.attach_task(control.token, conn)

            # Retrieve the task instance for status monitoring
            if wait_for_running:
                # Block until EVERY replica transitions to running state: the
                # token is only as ready as its slowest engine, and inputs
                # start round-robining across all of them immediately.
                await asyncio.gather(*(task.wait_for_running() for task in engines))

            # Return formatted results
            return _return_results(control)

        except Exception:
            # Distinguish a genuine creation failure from a user-requested
            # stop that raced with startup / wait_for_running.  When the user
            # terminates before the task reaches RUNNING, the exception
            # propagates here but the task was NOT a creation failure.
            if control.task and control.task._stop_requested:
                self.debug_message(f'Task stopped during startup: {control.id}...')
                # The user's stop named the token, and the primary already
                # honoured it; any replica it did not reach is still an
                # orphan and has to go the same way.
                orphans = [task for task in control.tasks if not task._stop_requested]
            else:
                self.debug_message(f'Task creation failed, cleaned up: {control.id}...')
                # Kill the subprocesses so they don't linger as orphans
                # consuming resources and reporting stale metrics.
                orphans = control.tasks

            # Concurrently — one stubborn orphan should not delay stopping the rest.
            orphan_results = await asyncio.gather(
                *(asyncio.wait_for(task.stop_task(), timeout=30) for task in orphans),
                return_exceptions=True,
            )
            for task, result in zip(orphans, orphan_results):
                if isinstance(result, asyncio.TimeoutError):
                    self.debug_message(f'Warning: timed out stopping orphaned task: {task.id}')
                elif isinstance(result, BaseException):
                    self.debug_message(f'Warning: failed to stop orphaned task: {task.id}: {result}')

            self._task_control.pop(control.token, None)
            raise

    async def restart_task(
        self,
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
            ValueError: If pipeline invalid, source not found,
                    project_id/source don't match existing values, or token not provided
            TaskError: Code TASK_NOT_REGISTERED if the token names no live task
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

            # Verify the caller has control permissions for this task
            if conn and hasattr(conn, '_account_info') and conn._account_info:
                perms = resolve_task_permissions(conn._account_info, control.teamId)
                if not perms:
                    raise PermissionError('Cannot restart task: no permissions for this task')
                if 'task.control' not in perms:
                    raise PermissionError("Permission 'task.control' denied for this task")

            # Check if debugger is attached - fail if so
            if control.task.has_attached_debugger():
                raise RuntimeError('Cannot restart task while debugger is attached. Please detach the debugger first.')

            # Find and validate the provider from new pipeline
            components = pipeline.get('components', [])
            if type(components) is not list:
                raise ValueError('Invalid components in pipeline')

            # The source is part of the task's identity and a restart cannot change
            # it. _apply_source_defaults stamps control.source onto the pipeline, so
            # a different explicit source would be overwritten without a word —
            # refuse it instead, which is what the docstring above promises.
            requested_source = pipeline.get('source')
            if requested_source and requested_source != control.source:
                raise ValueError(
                    f'Cannot change the source on restart: task "{control.id}" runs '
                    f'"{control.source}", the request asks for "{requested_source}"'
                )

            # Normalise BEFORE anything is stopped. This is also the validation: it
            # raises when the source component is missing, and doing that after the
            # restart would leave the task stopped, the new pipeline already stored
            # by Task.restart_task, and control.pipeline still naming the old one.
            pipeline = _apply_source_defaults(pipeline, control.source)

            # Call the Task's restart method to restart the engine process.
            # This preserves all statistics and monitoring while restarting
            # the subprocess. EVERY replica restarts: they are one pipeline
            # behind one token, and leaving some on the old configuration
            # would make the token answer differently per request.
            results = await asyncio.gather(
                *(
                    task.restart_task(
                        pipeline=pipeline,
                        project_id=control.project_id,
                        source=control.source,
                        provider=control.provider,
                    )
                    for task in control.tasks
                ),
                return_exceptions=True,
            )
            failures = [result for result in results if isinstance(result, BaseException)]
            if failures:
                # A partial restart leaves the group half old / half new pipeline,
                # answering the same token two different ways — worse than no
                # token at all. Tear the whole thing down and raise the first
                # failure (the others are usually its consequences).
                await self.remove_task(control.token)
                raise failures[0]

            # The control now describes the pipeline that is running: without this the
            # record still holds whatever was launched originally, so a later
            # useExisting compares against a configuration that was replaced here.
            control.pipeline = pipeline

            # Wait for running state if requested — for every replica, since
            # the caller is told the token is ready, not one engine of it.
            if wait_for_running:
                await asyncio.gather(*(task.wait_for_running() for task in control.tasks))

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
                'replicas': control.replicas,
            }

        except Exception as e:
            # Log restart failure with context
            self.debug_message(f'Failed to restart task: {str(e)}')
            raise

    async def stop_task(self, token: str, reason: str = 'user'):
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
                # Every replica, concurrently — the token is the unit a user
                # stops, and a surviving replica would keep serving inputs
                # under a token its owner believes is gone.
                results = await asyncio.gather(
                    *(task.stop_task(reason) for task in control.tasks),
                    return_exceptions=True,
                )
                for result in results:
                    if isinstance(result, BaseException):
                        self.debug_message(f'Error stopping a replica of task "{control.id}": {result}')
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
            ValueError: If token is not specified
            TaskError: Code TASK_NOT_REGISTERED if the token names no live task

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
            self.debug_message(f'Task detachment handled (task may be gone): "{token}": {e}')

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

        # Per-IP unauthenticated connection limit — reject if the client already
        # has too many open unauthenticated connections.
        client_ip = websocket.client.host if websocket.client else ''
        current_unauthed = self._unauthed_by_ip.get(client_ip, 0)
        if client_ip and current_unauthed >= CONST_MAX_UNAUTHED_CONNS_PER_IP:
            await websocket.close(code=1008)  # 1008 = Policy Violation
            return
        # Global cap on number of distinct IPs holding slots: per-IP decrement
        # prunes entries as they drop to zero, but an attacker rotating through
        # many IPs (each at 1 slot) can still grow _unauthed_by_ip unbounded.
        # Reject new IPs once the table is full; existing IPs keep working.
        if client_ip and client_ip not in self._unauthed_by_ip and len(self._unauthed_by_ip) >= CONST_MAX_UNAUTHED_IPS:
            await websocket.close(code=1008)  # 1008 = Policy Violation
            return
        if client_ip:
            self._unauthed_by_ip[client_ip] = current_unauthed + 1

        # Create DAP transport layer for WebSocket communication
        transport = TransportWebSocket()

        # Create unified DAP connection handler; account_info set when client sends auth as first message
        conn = TaskConn(
            connection_id=connection_id,
            server=self,
            transport=transport,
        )
        conn._client_ip = client_ip

        # Register new connection and update server statistics
        await self._dapbase_on_connected(conn)

        try:
            # Accept WebSocket connection and start message processing
            # This call blocks until the connection is terminated
            await transport.accept(websocket=websocket)

        finally:
            # Ensure cleanup occurs regardless of how connection ends
            await self._dapbase_on_disconnected(conn)

    @staticmethod
    def _probe_port(port: int) -> Optional[int]:
        """
        Test whether a TCP port can be bound right now.

        IPv4 loopback is what both consumers bind: the data WebServer on
        '127.0.0.1', and pydevd's AF_INET listener on the given '--debug_host'.

        No socket options, deliberately: on Windows SO_REUSEADDR turns a busy
        port's EADDRINUSE into EACCES, which assign_port caches for the life of
        the process — the allocator would blacklist ports that are merely busy.
        Adding options here means revisiting that cache.

        Args:
            port (int): TCP port number to test.

        Returns:
            Optional[int]: None when the port binds, otherwise the failure's
                errno — EACCES when the OS forbids the port, EADDRINUSE when
                another socket holds it. Never None for a failure.
        """
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(('127.0.0.1', port))
        except OSError as e:
            # None is the success sentinel and an OSError may carry no errno,
            # so fail closed.
            return e.errno or errno.EADDRINUSE

        return None

    @staticmethod
    def _no_ports_message(
        base_port: int,
        first_port: int,
        last_port: int,
        tallies: Dict[str, int],
        unexpected_errno: Optional[int],
    ) -> str:
        """
        Build the error message for an exhausted port window.

        Names whichever cause accounts for most of the window, so nobody hunts
        a foreign process for ports this server holds. Only the two outward
        causes carry a platform command.

        Args:
            base_port (int): The configured base port, before clamping.
            first_port (int): First port the scan considered.
            last_port (int): Last port the scan considered.
            tallies (Dict[str, int]): Counts keyed 'allocated', 'occupied',
                'reserved' and 'unexpected'.
            unexpected_errno (Optional[int]): Last errno that was neither
                EACCES nor EADDRINUSE, if one occurred.

        Returns:
            str: A message beginning 'No available ports'.
        """
        if first_port > last_port:
            return f'No available ports: configured base_port {base_port} leaves no ports at or below 65535.'

        # On a tie, dict order would silently always pick the same cause.
        highest = max(tallies.values())
        leaders = [name for name, count in tallies.items() if count == highest]
        kind = leaders[0]

        if kind == 'allocated':
            cause = 'most of the range is already allocated by this server'
            hint = (
                'This server holds that many task ports; look for tasks that never released one, or widen its window.'
            )
        elif kind == 'unexpected':
            name = errno.errorcode.get(unexpected_errno, str(unexpected_errno))
            cause = f'most probes failed unexpectedly, last with errno {unexpected_errno} ({name})'
            hint = (
                'That is this process running out of resources rather than a port conflict; check its open descriptors.'
            )
        elif kind == 'reserved':
            cause = 'most of the range is reserved by the operating system'
            if sys.platform == 'win32':
                hint = (
                    'List the exclusions with `netsh int ipv4 show excludedportrange protocol=tcp` '
                    '(and the ipv6 equivalent) and move base_port outside them.'
                )
            else:
                hint = 'Ports below 1024 need elevated privileges; move base_port higher.'
        else:
            cause = 'most of the range is in use by other processes'
            if sys.platform == 'win32':
                hint = 'List current listeners with `netstat -ano`.'
            elif sys.platform == 'darwin':
                hint = 'List current listeners with `lsof -nP -iTCP -sTCP:LISTEN`.'
            else:
                hint = 'List current listeners with `ss -ltn`.'

        # The hint can only speak for one cause, so name the other.
        if len(leaders) > 1:
            labels = {
                'allocated': 'ports this server holds',
                'occupied': 'ports other processes hold',
                'reserved': 'ports the operating system reserves',
                'unexpected': 'probes that failed unexpectedly',
            }
            also = ', '.join(labels[name] for name in leaders[1:])
            cause += f' — tied with {also}, so this hint covers only one of them'

        # Otherwise "widen its window" is advice that cannot be followed upward.
        clamped = ''
        if last_port < base_port + 9999:
            clamped = (
                f' The window is {last_port - first_port + 1} ports, not 10000: base_port {base_port} '
                f'would run past 65535, so it was clamped.'
            )

        return (
            f'No available ports in the range {first_port}-{last_port}: {cause} '
            f'({tallies["allocated"]} allocated by this server, {tallies["occupied"]} in use by other processes, '
            f'{tallies["reserved"]} reserved by the operating system, '
            f'{tallies["unexpected"]} unexpected probe failures). {hint}{clamped}'
        )
