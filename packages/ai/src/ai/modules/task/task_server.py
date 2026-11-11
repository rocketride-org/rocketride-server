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
3. Provides an address-keyed task registry resolved with the caller's account
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
- Every lookup runs with the request's account: tasks are addressed by name
  (``developerId.pipelineId[.source]``) and authorized per run, never by a
  bearer token (there are none)
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
import errno
import socket
import sys
import asyncio
import uuid
from typing import List
from fastapi import WebSocket
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, Any, Optional, Set
from ai.constants import (
    CONST_CLEANUP_DELAY_TIME,
    CONST_CLEANUP_SLEEP_TIME,
    CONST_TEARDOWN_WAIT_TIMEOUT,
    CONST_DEFAULT_TTL,
    CONST_TTL_CHECK,
    CONST_MAX_UNAUTHED_CONNS_PER_IP,
    CONST_MAX_UNAUTHED_IPS,
)
from ai.common.dap import TransportWebSocket, DAPBase
from rocketride import EVENT_TYPE
from ai.web import WebServer
from ai.account.models import AccountInfo, resolve_run_permissions
from ai.account.store import Store
from .task_conn import TaskConn
from .task_engine import Task
from .types import LAUNCH_TYPE, TaskError
from .pipeline import resolve_implied_source
from .commands.cmd_monitor import owner_key
from .address import build_address, check_endpoint_scope, parse_address, validate_component_ids, validate_identity

from rocketlib import debug


@dataclass
class TASK_CONTROL:
    """
    Task control structure containing all metadata and references for a managed task.

    This dataclass encapsulates the complete state and metadata required to
    manage a computational task throughout its lifecycle. It serves as the
    central registry entry that tracks task ownership, configuration, and status.

    Attributes:
        address (str): The task's public name ``developerId.pipelineId.source``
            — what clients send in the token slot, the display id, and the
            name every event carries
        key (str): The registry key ``runKind.ownerId.address`` — internal,
            never sent to a client
        task (Optional[Task]): Reference to the actual Task instance managing execution
        launch_type (LAUNCH_TYPE): The method used to create this task (launch/execute)
        pipeline (Optional[Dict[str, Any]]): Task configuration and execution parameters
    """

    # Display id — the address (used for display and events)
    id: str = ''

    # Connection identifier (the launching user's id on every dev run)
    client_id: str = ''

    # The address ``developerId.pipelineId.source`` and the registry key
    # ``runKind.ownerId.address``. The address omits the owner on purpose:
    # the same address names different controls for different callers, and
    # the resolver picks the caller's own.
    developer_id: str = ''
    address: str = ''
    key: str = ''

    # User, team, and org identity (derived from AccountInfo after auth)
    userId: str = ''
    teamId: str = ''
    orgId: str = ''

    # Run classification: 'dev' | 'deploy'. Part of task identity — the
    # OWNER of a dev run is its user, the owner of a deploy run is its
    # team, and the registry key, monitor keys, and lookups all scope by
    # that owner. teamId above remains billing/permission attribution and
    # is NOT the owner for dev runs.
    run_kind: str = 'dev'

    # Owner scope: 'user' | 'team'. Decides the VISIBILITY owner INDEPENDENTLY
    # of run_kind — a deployed run may be team-owned (@team) or user-owned
    # (@me, a personal deploy). Empty falls back to the run_kind default
    # (deploy -> team, else user) for a control built before it is stamped.
    owner_kind: str = ''

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

    @property
    def owner_id(self) -> str:
        """
        The identity that OWNS this run — what monitor keys, the registry key,
        and identity lookups scope by (never the attribution teamId of a
        user-owned run).

        owner_kind is the authority: a team-owned run resolves to teamId, a
        user-owned run to userId. When owner_kind is unset (a control built
        before it is stamped) it falls back to the run_kind default.
        """
        kind = self.owner_kind or ('team' if self.run_kind == 'deploy' else 'user')
        return self.teamId if kind == 'team' else self.userId


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
    - Every task lookup runs with the request's account (owner-scoped,
      permission-checked); nothing is reachable by bearer token
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

                    # Skip tasks that are still actively runnings
                    if not control.task.is_task_complete():
                        continue

                    # Check if sufficient time has passed since completion
                    task_status = control.task.get_status()
                    if task_status.endTime + CONST_CLEANUP_DELAY_TIME < current_time:
                        # Remove the expired completed task
                        await self.remove_task(control.key)

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
                        self.debug_message(
                            f'Task "{control.id}" exceeded TTL ({control.task._idle_time}s >= {control.task._ttl}s), terminating...'
                        )
                        # Terminate the idle task — reason 'ttl', so the
                        # run records as completed, never as cancelled.
                        await self.stop_task(control.key, reason='ttl')

                self._debug_task_census()

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

        # No dev-overlay cleanup: dev previews are LOCAL-FIRST — the
        # registration lives in preview pages and dies with them; the
        # server holds no per-connection dev state.

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
                # Detach this connection from the task
                await control.task.detach_task(conn)

                # Auto-terminate launched tasks when the launching client disconnects
                if control.launch_type == LAUNCH_TYPE.LAUNCH and control.launch_owner == conn:
                    await control.task.stop_task()
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

    def get_task_control_by_project(
        self,
        project_id: str,
        source: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
        team_id: str = '',
        run_kind: str = '',
    ) -> TASK_CONTROL:
        """
        Retrieve task control structure by its owner-scoped identity.

        ``team_id`` set addresses the team's (team-OWNED) DEPLOY run of
        ``project_id``/``source``. ``team_id`` absent addresses the
        caller's OWN run (owner = ``account_info.userId``), where
        ``run_kind`` picks the continuum: ''/'dev' is the dev run;
        'deploy' is the caller's personal @me deploy run — deploy-kind but
        user-owned, the one case teamId-presence cannot express. All are
        unique by construction — task identity is
        {runKind}.{owner}.{project}.{source}. There is no account-less
        scan: every lookup is scoped to the caller.

        Args:
            project_id (str): Project identity of the run
            source (str): Source component id of the run
            account_info (AccountInfo): Caller identity for scoping and
                permission checks (required)
            require (Optional[str]): Permission that must be granted on the
                run's team (e.g. 'task.monitor')
            team_id (str): Owner team — addresses that team's team-owned
                deploy run; empty addresses the caller's own run
            run_kind (str): Teamless continuum selector: ''/'dev' = the
                caller's dev run, 'deploy' = the caller's @me deploy run.
                Ignored when team_id is set.

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if no matching task exists
            PermissionError: If the caller is unauthenticated or the
                permission check fails
        """
        if account_info is None:
            raise PermissionError('Not authenticated')

        def _verify(control: TASK_CONTROL) -> TASK_CONTROL:
            """Run-scoped permission check (owner-private for user-owned runs)."""
            return self._verify_control(control, account_info, require)

        # Team scope: the team's TEAM-OWNED deploy run. owner_kind must be
        # checked: an @me deploy carries the SAME billing teamId, and
        # matching it here would let any teammate reach a personal run
        # through team permissions.
        if team_id:
            for control in self._task_control.values():
                if (
                    control.run_kind == 'deploy'
                    and control.owner_kind != 'user'
                    and control.teamId == team_id
                    and control.project_id == project_id
                    and control.source == source
                ):
                    return _verify(control)
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Own scope: the caller's run in the selected continuum (dev by
        # default; the caller's @me deploy when run_kind says so) — unique
        # per user per continuum by construction.
        wanted_kind = run_kind or 'dev'
        for control in self._task_control.values():
            if (
                control.run_kind == wanted_kind
                and control.owner_id == account_info.userId
                and control.project_id == project_id
                and control.source == source
            ):
                return _verify(control)
        raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

    @staticmethod
    def _verify_control(control: TASK_CONTROL, account_info: AccountInfo, require: Optional[str]) -> TASK_CONTROL:
        """
        Run-scoped permission check, applied to EVERY resolution.

        A user-owned run grants its OWNER full access by identity — surviving
        an org switch (the owner is unchanged, the team is now foreign) — and
        nobody else; a team-owned run resolves through team membership;
        sys.admin and internal identities pass inside the resolver.

        Args:
            control: The candidate control.
            account_info: The request's account.
            require: The permission the request needs, or None for reachability only.

        Returns:
            ``control`` when the caller may reach it.

        Raises:
            PermissionError: No access, or the required permission is missing.
        """
        perms = resolve_run_permissions(account_info, control)
        if not perms:
            raise PermissionError('Access denied: no permissions for this task')
        if require and require not in perms:
            raise PermissionError(f'Permission {require!r} denied for this task')
        return control

    def control_by_key(self, key: str) -> TASK_CONTROL:
        """
        Internal registry lookup by the control's own key.

        For code that already holds a control's key (the engine reporting
        back, cleanup, the scheduler) — never for a client-supplied value:
        clients send addresses, which ``resolve_control`` turns into a
        control under the request's account.

        Args:
            key (str): The registry key ``runKind.ownerId.address``.

        Returns:
            TASK_CONTROL: The live control.

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live task.
        """
        control = self._task_control.get(key) if key else None
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')
        return control

    def resolve_control(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
    ) -> TASK_CONTROL:
        """
        THE resolver: an address plus the request's account yields one control.

        Walks the rungs in the fixed order and takes the first that answers
        (``@dev`` — the caller's own live presence, attach-only; ``@me`` — the
        caller's personal deployment run; ``@team`` — a team-owned deployment
        run on a team where the caller holds ``require``). Published rungs
        that are not live start from the artifact — that step is
        ``_resolve_published_rungs``, which the TaskControl/TaskEngine split
        fills in with ``resolve_pipe_pins``. Every hit is permission-checked;
        a key with an ``endpoints`` scope skips ``@dev`` (a production webhook
        must never land on the owner's Play'd run) and is refused outside
        its scope. There is NO owner qualifier: nobody can name another
        user's control.

        The walk runs over LIVE controls first: a stopped run never answers
        its address while another rung has a live one (a dead ``@dev`` falls
        through). Only when no rung has a live control is the walk repeated
        over every registered control, so a run that just finished keeps its
        final status readable until the cleanup pass removes it.

        A two-segment address (no source) resolves when exactly one live
        source answers; several live sources raise ``TASK_SOURCE_REQUIRED``.
        A finished source never counts against a live one.

        Args:
            address (str): ``developerId.pipelineId[.source]`` (the token slot).
            account_info (AccountInfo): The request's account (required).
            require (Optional[str]): The permission the request needs
                (``'task.data'``, ``'task.control'``, ``'task.monitor'`` ...).

        Returns:
            TASK_CONTROL: The resolved control.

        Raises:
            TaskError: TASK_INVALID_ARGUMENT (grammar), TASK_SOURCE_REQUIRED,
                TASK_AMBIGUOUS (several of the caller's teams run the address
                and none is the caller's development team), or
                TASK_NOT_REGISTERED when no rung answers.
            PermissionError: Unauthenticated, no permission, or outside the
                key's endpoints scope.
        """
        if account_info is None:
            raise PermissionError('Not authenticated')
        parsed = parse_address(address)
        endpoints = getattr(account_info, 'endpoints', None)

        def _matches(control: TASK_CONTROL) -> bool:
            return (
                control.developer_id == parsed.developer_id
                and control.project_id == parsed.pipe_id
                and (parsed.source is None or control.source == parsed.source)
            )

        def _pick(candidates: List[TASK_CONTROL]) -> Optional[TASK_CONTROL]:
            """One control, or the source-required error when several sources are live."""
            if not candidates:
                return None
            if len(candidates) > 1:
                sources = sorted({c.source for c in candidates})
                raise TaskError(
                    TaskError.SOURCE_REQUIRED,
                    f'{address!r} has several live sources ({", ".join(sources)}); name one',
                    address=address,
                    sources=sources,
                )
            return candidates[0]

        user_id = account_info.userId
        rungs: List[str] = []

        def _walk(pool: List[TASK_CONTROL]) -> Optional[TASK_CONTROL]:
            """The rungs in order over ``pool``: the first hit, verified, or None."""
            rungs.clear()

            # @dev: the caller's own presence. Attach-only, and skipped for a
            # scoped (machine) credential.
            if endpoints is None:
                rungs.append('@dev')
                control = _pick([c for c in pool if c.run_kind == 'dev' and c.owner_id == user_id and _matches(c)])
                if control is not None:
                    return self._verify_control(control, account_info, require)

            # @me: the caller's personal (user-owned) deployment run.
            rungs.append('@me')
            control = _pick(
                [
                    c
                    for c in pool
                    if c.run_kind == 'deploy' and c.owner_kind == 'user' and c.owner_id == user_id and _matches(c)
                ]
            )
            if control is not None:
                check_endpoint_scope(endpoints, control.address)
                return self._verify_control(control, account_info, require)

            # @team: a team-owned deployment run the caller may reach. The address
            # carries no owner, so two of the caller's teams can each have it live:
            # the caller's active (development) team answers; with neither run on
            # it the choice is the caller's, so the lookup is ambiguous, not a guess.
            rungs.append('@team')
            team_runs = [
                c
                for c in pool
                if c.run_kind == 'deploy'
                and c.owner_kind != 'user'
                and _matches(c)
                and resolve_run_permissions(account_info, c)
            ]
            teams = sorted({c.owner_id for c in team_runs})
            if len(teams) > 1:
                active_team = getattr(account_info, 'devTeam', None)
                team_runs = [c for c in team_runs if c.owner_id == active_team]
                if not team_runs:
                    raise TaskError(
                        TaskError.AMBIGUOUS,
                        f'{address!r} is deployed by several of your teams ({", ".join(teams)}); '
                        'make the one you mean your development team',
                        address=address,
                        teams=teams,
                    )
            control = _pick(team_runs)
            if control is not None:
                check_endpoint_scope(endpoints, control.address)
                return self._verify_control(control, account_info, require)
            return None

        # Live controls first: a finished run never shadows a running one on
        # this or a later rung
        controls = list(self._task_control.values())
        control = _walk([c for c in controls if not c.task.is_task_complete()])
        if control is not None:
            return control

        # Nothing live answers: a finished run still in the registry does, so
        # its final status stays readable until the cleanup pass removes it
        control = _walk(controls)
        if control is not None:
            return control

        return self._resolve_published_rungs(address, account_info, require, rungs)

    def _resolve_published_rungs(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str],
        rungs_tried: List[str],
    ) -> TASK_CONTROL:
        """
        SEAM for the published rungs (@me/@team/@public from the artifact).

        The TaskControl/TaskEngine split replaces this with ``resolve_pipe_pins``
        (the twin of ``resolve_app_pins``): find the caller's deployment or
        publication for ``address`` and start it from the artifact when no
        control is live. Until then a name with no live control is not found,
        and the error says which rungs were tried.

        Raises:
            TaskError: Code TASK_NOT_REGISTERED with ``address`` and ``rungsTried``.
        """
        raise TaskError(
            TaskError.NOT_REGISTERED,
            f'Your pipeline is not running ({address!r}; tried {", ".join(rungs_tried)})',
            address=address,
            rungsTried=list(rungs_tried),
        )

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
            # The pushed body blanks userToken (to_push_result) so a
            # connection on a narrower key never adopts the session key.
            try:
                fresh = await account._service.get_authentication_result(user_id, conn._account_info.auth)
                conn._account_info = fresh
                await conn.send_event('apaext_account', body=fresh.to_push_result())
            except Exception as e:
                self.debug_message(f'push_account_update failed for conn {conn.get_connection_id()}: {e}')

    async def push_org_update(self, org_id: str) -> None:
        """
        Rebuild AccountInfo from the DB and push an apaext_account event to
        every open connection whose primary org is ``org_id``.

        The org-wide sibling of push_account_update: called after an operation
        mutates an ORG-level property carried in the identity payload (plan,
        subscriptions, developer id) so every member's client refreshes — not
        just the caller's connections.
        """
        from ai.account import account

        notified = 0
        for conn in list(self._connections.values()):
            info = getattr(conn, '_account_info', None)
            if not info:
                continue
            # Match any connection whose primary org matches the mutated org
            conn_org = ''
            if hasattr(info, 'organization') and info.organization:
                org = info.organization
                conn_org = org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')
            if conn_org != org_id:
                continue
            try:
                fresh = await account._service.get_authentication_result(info.userId, info.auth)
                conn._account_info = fresh
                await conn.send_event('apaext_account', body=fresh.to_push_result())
                notified += 1
            except Exception as e:
                self.debug_message(f'push_org_update failed for conn {conn.get_connection_id()}: {e}')

        if notified:
            self.debug_message(f'push_org_update notified {notified} connection(s) for org={org_id}')

    async def push_org_changed(self, user_id: str, org_id: str) -> None:
        """
        Notify every full-user connection of ``user_id`` that their default
        org changed.

        A pure NOTIFICATION: the server never swaps a live connection's
        identity in place (that strands per-connection state on the old
        org's identity) and never dictates a response. Each client reacts
        its own way — typically by reloading/re-authenticating, which
        resolves the new default org. A connection that ignores the event
        simply keeps its current identity until its next re-auth.

        Connections on THIS server only (one process today).
        """
        for conn in list(self._connections.values()):
            if not getattr(conn, '_account_info', None):
                continue
            if conn._account_info.userId != user_id:
                continue
            try:
                await conn.send_event('apaext_org_changed', body={'orgId': org_id})
            except Exception as e:
                self.debug_message(f'push_org_changed failed for conn {conn.get_connection_id()}: {e}')

    async def broadcast_task_event(self, event_type: EVENT_TYPE, key: str, event: Dict[str, Any]) -> None:
        """
        Broadcast a task-scoped event to all connections that are subscribed to the given task.

        Iterates over every active connection and calls send_task_event on each one.
        PermissionError is treated as a normal condition (a connection that does not
        hold task.monitor on the run) and silently skipped. All other exceptions are
        logged but do not abort the broadcast to remaining connections.

        Args:
            event_type (EVENT_TYPE): Event type bitmask (e.g. SUMMARY, SSE) used by each
                connection's send_task_event to decide whether it should receive the event.
            key (str): The originating control's registry key. Each connection
                resolves it to its subscription key independently.
            event (Dict[str, Any]): Fully-formed DAP event payload to deliver.
                Expected keys: 'event' (str) and 'body' (Any).
        """
        # If the task has already been removed from the registry (e.g.
        # cleanup raced with pending broadcasts), skip silently instead of
        # spamming "Your pipeline is not running" for every connection.
        if key not in self._task_control:
            return

        # Snapshot to list() so a connection joining or dropping mid-broadcast
        # does not raise RuntimeError on the next iteration; matches the
        # pattern used by broadcast_server_event / push_account_update above.
        for conn in list(self._connections.values()):
            try:
                await conn.send_task_event(event_type, key=key, event=event)

            except PermissionError:
                # A normal outcome: the connection may not see this run
                continue

            except Exception as e:
                # Log individual monitor failures but continue broadcasting
                self.debug_message(f'Failed to broadcast event to connection: {e}')

    async def remove_task(self, key: str) -> TASK_CONTROL:
        """
        Remove task from registry and perform comprehensive cleanup.

        This method handles complete task removal including resource cleanup,
        registry maintenance, and proper task termination. It ensures no
        resources are leaked and all associated components are properly cleaned up.

        Args:
            key (str): The control's registry key

        Returns:
            TASK_CONTROL: The removed task control structure for caller cleanup

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live task

        Cleanup Process:
        1. Validate task ownership and existence
        2. Remove task from central registry
        3. Stop task execution and cleanup resources
        4. Remove all monitoring subscriptions
        5. Log removal for audit trail
        6. Return control structure for additional caller-specific cleanup
        """
        # Remove task from central registry
        # pop with a default: without one an unknown key raises KeyError and the
        # TaskError below never runs, so the failure reaches the caller unclassified.
        control = self._task_control.pop(key, None)

        # If not there, it wasn't running
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        # Ensure task is properly stopped and resources are cleaned up
        await control.task.stop_task()

        # Remove monitor subscriptions that reference this task from all
        # connections — keys are owner-scoped, so build from the control.
        # Matching is by ADDRESS EQUALITY: the run's own key, or a pipe-scoped
        # key whose prefix (everything before the last dot) IS that key —
        # never a prefix test, which a longer sibling source could satisfy.
        project_key = owner_key(control.run_kind, control.owner_id, control.project_id, control.source)
        for conn in self._connections.values():
            if hasattr(conn, '_monitors'):
                keys_to_remove = [k for k in conn._monitors if k == project_key or k.rsplit('.', 1)[0] == project_key]
                for monitor_key in keys_to_remove:
                    conn._monitors.pop(monitor_key, None)

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
        wait_for_running=False,
        client_id: str = '',
        user_id: str = '',
        team_id: str = '',
        org_id: str = '',
        env: Dict[str, str] | None = None,
        env_source: Optional[Callable[[], Awaitable[Dict[str, str]]]] = None,
        run_kind: str = 'dev',
        owner_kind: str = '',
        trigger: str = '',
        developer_id: str = '',
    ) -> Dict[str, Any]:
        """
        Create and start a new computational task with full lifecycle management.

        This method handles the complete task creation process including validation,
        registry management, resource allocation, and startup coordination. It
        supports both interactive debugging and batch execution modes.

        Args:
            request (Dict[str, Any]): Task creation request containing:
                - arguments: Task configuration including the pipeline
                - command: Launch type (launch/execute) determining task behavior
            conn (TaskConn, optional): Connection to associate with task for monitoring
            env_source: Loads the values for ${...} placeholders at each (re)start (see Task)
            developer_id: The owner org's developer id — the address namespace.
                Required: the address exists from the first run.

        Returns:
            Dict[str, Any]: The task's identity; ``token`` carries the ADDRESS
                (``developerId.pipelineId.source``) for subsequent operations

        Raises:
            TaskError: TASK_INVALID_ARGUMENT when an identity, the project id,
                the source or a component id breaks the address grammar, when
                a client tries to name the registry key, or when a dev launch
                does not name the authenticated user
            ValueError: If launch type is invalid or task already exists
            RuntimeError: If the pipeline is missing, empty or not an object
            Exception: If task creation or startup fails

        Task Creation Process:
        1. Parse and validate request parameters and identities
        2. Validate the pipeline and derive the address and registry key
        3. Check for task uniqueness and handle conflicts
        4. Create Task instance with full configuration
        5. Register task in central registry with security metadata
        6. Set up initial monitoring if connection provided
        7. Start task execution
        8. Return the address for client use

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

        def _return_results(control: TASK_CONTROL, reused: bool = False) -> Dict[str, Any]:
            """
            Return the task's identity, the address in the token slot.

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
                'token': control.address,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
                'reused': reused,
            }

        # Initialize task control structure for new task
        control = TASK_CONTROL()

        # For launch/exec token is in args. An explicit "arguments": null is a
        # request with no pipeline, refused by the guard below.
        args = request.get('arguments') or {}
        use_existing_task = args.get('useExisting', False)

        # Extract TTL from args (use server-configured default if not provided)
        ttl = args.get('ttl', CONST_DEFAULT_TTL)

        # Nothing mints a registry key but the server: a caller naming one
        # could alias another run.
        if args.get('token') is not None:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                'token is not accepted on execute: tasks are addressed by name, which the server derives',
                field='token',
            )

        # Identity boundary: the ids that enter the registry key, the monitor
        # keys and the storage tree carry no path or audience characters.
        # A deploy run owned by its team carries no user id.
        control.client_id = client_id
        control.userId = validate_identity(user_id, 'userId') if (user_id or run_kind == 'dev') else ''
        control.teamId = validate_identity(team_id, 'teamId')
        control.orgId = org_id
        # Run classification MUST be set before the key is built below: the
        # registry key scopes by the run's OWNER (user for dev, team for
        # deploy), which is derived from run_kind.
        control.run_kind = run_kind
        # The identity block of the task file is filled from client_id; on a
        # dev launch that MUST be the authenticated user (plan S13).
        if run_kind == 'dev' and client_id != user_id:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                'A dev run must be launched as the authenticated user',
                field='userId',
            )
        # Owner scope: explicit when the launch path knows the rung (@me -> user,
        # @team -> team); else derived from run_kind. MUST precede key
        # building and monitor-key building — both scope by the owner.
        # A team-owned DEV run is rejected outright: no launch path produces
        # it, and its key would collide with the same team's deploy run.
        if owner_kind == 'team' and run_kind == 'dev':
            raise ValueError('owner_kind="team" is only valid for deploy runs')
        control.owner_kind = owner_kind or ('team' if run_kind == 'deploy' else 'user')
        # The address namespace: every run has one from its first start.
        if not developer_id:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                'Your organization has no developer id yet: an org admin must claim one before pipelines can run',
                field='developerId',
            )
        control.developer_id = developer_id
        control.pipeline = args.get('pipeline', None)
        control.source = args.get('source', None)

        # Validate required pipeline configuration. Checked before the first
        # read of the pipeline below, which would otherwise fail first with an
        # AttributeError or TypeError that does not say what is missing. An
        # empty pipeline or one that is not an object (such as a .pipe path
        # sent as `pipeline`) is refused the same way.
        if not isinstance(control.pipeline, dict) or not control.pipeline:
            raise RuntimeError(
                'Pipeline configuration is missing or invalid. Pass the pipeline object itself; '
                'to run a .pipe file, pass its path as filepath.'
            )

        # If a source was not specified, in the args, get it from the pipeline
        if not control.source:
            control.source = control.pipeline.get('source', None)

        # If the pipeline doesn't have a source, find the implied source
        if not control.source:
            control.source = resolve_implied_source(control.pipeline)
            if control.source is None:
                raise ValueError(
                    'Pipeline has no source. Select a source component or add a node configured as a source.'
                )

        # Find the actual source component
        # Stamp the resolved source and give the source component a config if it has
        # none. Shared with restart_task so a restarted pipeline is stored in the same
        # shape a launched one is, and the two compare equal.
        _apply_source_defaults(control.pipeline, control.source)

        # Project identity is project_id on the flat project: the SHORT,
        # dot-free id. A missing id is minted as a GUID (dot-free by
        # construction).
        control.project_id = control.pipeline.get('project_id', None)
        if not control.project_id:
            control.project_id = str(uuid.uuid4())

        # The address grammar, enforced at execute: project id, source and
        # every component id are single dot-free segments.
        validate_component_ids(control.pipeline)
        control.address = build_address(control.developer_id, control.project_id, control.source)
        control.id = control.address

        # Find the component so we can look up the provider
        components = control.pipeline.get('components', [])

        # Find the component
        for component in components:
            id = component.get('id', '')
            if id == control.source:
                control.provider = component.get('provider', None)
                break

        if not control.provider:
            raise ValueError(f'Source "{control.source}" not found in pipeline')

        # The registry key: one control per (owner, address, rung). The
        # owner FIELD (user for dev and @me, team for @team) rides owner_id,
        # and run_kind separates a user's dev run from their @me deploy of
        # the same pipeline — the only pair that shares an owner.
        control.key = f'{control.run_kind}.{control.owner_id}.{control.address}'

        # Parse and validate launch type from request command
        try:
            command = request.get('command', 'launch')
            control.launch_type = LAUNCH_TYPE(command)
        except (ValueError, TypeError):
            raise ValueError(f'Invalid launch type: "{command}"')

        # Save the owner so we know when to stop the task
        if control.launch_type == LAUNCH_TYPE.LAUNCH:
            control.launch_owner = conn

        # Handle task uniqueness and potential conflicts
        if control.key in self._task_control:
            # Get the existing task control
            existing_control = self._task_control[control.key]

            # Prevent duplicate active tasks
            if not existing_control.task.is_task_complete():
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
                    if wait_for_running:
                        await existing_control.task.wait_for_running()
                    return _return_results(existing_control, reused=True)

                # We are absolutely supposed to create a task. Name the running
                # task, not this request's id: the two can differ by source.
                raise ValueError(
                    f'Pipeline is already running (task {existing_control.id}). '
                    'Reuse it (useExisting / use_existing), or stop it and run again.'
                )

            # Clean up completed task with the same key
            self._task_control.pop(control.key, None)
            self.debug_message(f'Replaced completed task "{control.id}"...')

        try:
            # Create new Task instance with complete configuration
            control.task = Task(
                server=self,
                id=control.id,
                project_id=control.project_id,
                source=control.source,
                key=control.key,
                address=control.address,
                pipeline=control.pipeline,
                launch_args=args,
                launch_type=control.launch_type,
                provider=control.provider,
                ttl=ttl,
                client_id=control.client_id,
                team_id=control.teamId,
                org_id=control.orgId,
                env=env or {},
                env_source=env_source,
                run_kind=run_kind,
                owner_kind=control.owner_kind,
                trigger=trigger,
            )

            # Register task in central registry
            self._task_control[control.key] = control

            # Start task execution
            await control.task.start_task()

            self._debug_task_started(control, trigger, ttl)

            # Retrieve the task instance for status monitoring
            if wait_for_running:
                # Block until the task transitions to running state
                await control.task.wait_for_running()

            # Return formatted results
            return _return_results(control)

        except Exception:
            # Distinguish a genuine creation failure from a user-requested
            # stop that raced with startup / wait_for_running.  When the user
            # terminates before the task reaches RUNNING, the exception
            # propagates here but the task was NOT a creation failure.
            if control.task and control.task._stop_requested:
                self.debug_message(f'Task stopped during startup: {control.id}...')
            else:
                self.debug_message(f'Task creation failed, cleaned up: {control.id}...')
                # Kill the subprocess so it doesn't linger as an orphan
                # consuming resources and reporting stale metrics.
                if control.task:
                    try:
                        await asyncio.wait_for(control.task.stop_task(), timeout=30)
                    except asyncio.TimeoutError:
                        self.debug_message(f'Warning: timed out stopping orphaned task: {control.id}')
                    except Exception:
                        self.debug_message(f'Warning: failed to stop orphaned task: {control.id}')
            self._task_control.pop(control.key, None)
            raise

    async def restart_task(
        self,
        request: Dict[str, Any],
        conn: TaskConn = None,
        *,
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
            wait_for_running (bool): If True, wait for task to reach running state

        Returns:
            Dict[str, Any]: Task information including:
                - id: Task identifier (unchanged)
                - token: Task token (unchanged)
                - projectId / source / provider (unchanged)
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
        12. Transfer launch ownership to the caller (only once 10-11 succeeded)
        13. Return task information

        Note:
        - Task identity (address, project_id, source) remains unchanged
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

            # Extract the address from the token slot
            address = args.get('token', None)
            if not address:
                raise ValueError('Task address is required for restart')

            # Extract pipeline from request
            pipeline = args.get('pipeline', None)
            if not pipeline:
                raise ValueError('Missing pipeline configuration in restart request')

            # Resolve under the caller's account with task.control (run-scoped:
            # a user-owned run restarts only for its owner)
            account_info = getattr(conn, '_account_info', None) if conn else None
            control = self.resolve_control(address, account_info, 'task.control')

            self.debug_message(f'Restart requested for task "{control.id}"')

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

            # The address grammar holds on restart too: a restarted pipeline
            # must not smuggle in a dotted component id.
            validate_component_ids(pipeline)

            # Normalise BEFORE anything is stopped. This is also the validation: it
            # raises when the source component is missing, and doing that after the
            # restart would leave the task stopped, the new pipeline already stored
            # by Task.restart_task, and control.pipeline still naming the old one.
            pipeline = _apply_source_defaults(pipeline, control.source)

            # Call the Task's restart method to restart the engine process
            # This preserves all statistics and monitoring while restarting the subprocess
            await control.task.restart_task(
                pipeline=pipeline,
                project_id=control.project_id,
                source=control.source,
                provider=control.provider,
            )

            # The control now describes the pipeline that is running: without this the
            # record still holds whatever was launched originally, so a later
            # useExisting compares against a configuration that was replaced here.
            control.pipeline = pipeline

            # Wait for running state if requested
            if wait_for_running:
                await control.task.wait_for_running()

            # Ownership transfers ONLY once the restart has actually SUCCEEDED:
            # a rejected authorization, a malformed pipeline, a failed
            # restart_task() or a wait that never reaches running must not leave
            # this conn as launch_owner, or its later disconnect would stop a
            # LAUNCH task it never owned. Until then the previous owner keeps
            # the task, which is the state the caller failed to take over.
            control.launch_owner = conn

            # Log successful restart
            self.debug_message(f'Task "{control.id}" restarted successfully')

            # Return task information, the address in the token slot
            return {
                'id': control.id,
                'token': control.address,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
            }

        except Exception as e:
            # Log restart failure with context
            self.debug_message(f'Failed to restart task: {str(e)}')
            raise

    async def stop_task(self, key: str, reason: str = 'user'):
        """
        Stop a running task with proper cleanup and resource management.

        This method handles task termination requests by validating ownership
        and performing clean shutdown for appropriate task types. It ensures
        proper resource cleanup while handling various edge cases gracefully.

        Args:
            key (str): The control's registry key (resolved by the caller
                under the request's account)
            reason (str): Why the task stops ('user', 'ttl', ...)

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
            # Locate the task by its key (ownership was validated by the caller)
            control = self.control_by_key(key)

            # Only terminate tasks that were launched or executed directly
            if control.launch_type in (LAUNCH_TYPE.LAUNCH, LAUNCH_TYPE.EXECUTE):
                await control.task.stop_task(reason)
                self.debug_message(f'Task "{control.id}" stopped on request (reason: {reason})')

                # A @dev control ends with its run: no grace window and no
                # reaper (plan 7.1). Wait for the teardown first, because the
                # final status, the terminal events and the run-log close are
                # delivered through the registered control. A new run started
                # under the same key meanwhile is not this control's to remove.
                # The wait is bounded: a stalled terminal-event forward must not
                # hold this caller (the ttl monitor stops tasks serially); on a
                # timeout the control is left to the cleanup pass instead.
                if control.run_kind == 'dev':
                    try:
                        await asyncio.wait_for(control.task.wait_terminated(), timeout=CONST_TEARDOWN_WAIT_TIMEOUT)
                    except asyncio.TimeoutError:
                        self.debug_message(
                            f'Task "{control.id}" teardown exceeded {CONST_TEARDOWN_WAIT_TIMEOUT}s; left to cleanup'
                        )
                        return
                    if self._task_control.get(control.key) is control:
                        await self.remove_task(control.key)

        except Exception as e:
            # Log but ignore errors - task may already be stopped or removed
            self.debug_message(f'Task stop request handled (may have been already stopped): {e}')

    async def detach_task(self, request: Dict[str, Any], conn: TaskConn):
        """
        Detach a DAP connection from a task with optional termination.

        This method safely disconnects a client from a task while preserving
        the task state for other connected clients. It optionally terminates
        the task if requested by the detaching client.

        Args:
            request (Dict[str, Any]): Detach request containing:
                - arguments: Optional parameters including:
                    - token: The task address to detach from
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
        args = request.get('arguments', {})
        address = args.get('token', 'not-specified')
        terminate_task = args.get('terminateDebuggee', False)

        try:
            # Resolve under the connection's account (ownership validated inside)
            control = self.resolve_control(address, getattr(conn, '_account_info', None) if conn else None)

            # Detach connection from task's debugging interface
            await control.task.detach_task(conn)

            # Remove monitoring subscription for this connection
            if conn:
                await conn.set_monitor(
                    token=control.address,
                    type=EVENT_TYPE.NONE,
                )

            # Terminate task if requested by client
            if terminate_task:
                await self.stop_task(control.key)

            # Log successful detachment
            self.debug_message(f'Connection detached from task "{control.id}"')

        except Exception as e:
            # Handle errors gracefully - task may not exist or be accessible
            self.debug_message(f'Task detachment handled (task may be gone): "{address}": {e}')

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

    def _debug_task_started(self, control: TASK_CONTROL, trigger: str, ttl: int) -> None:
        """Log a started task with its launch type, run classification and run window."""
        run = control.run_kind if control.run_kind == 'dev' or not trigger else f'{control.run_kind}/{trigger}'
        window = f'{ttl}s' if ttl else 'none'
        self.debug_message(
            f'Task "{control.id}" started... (type: {control.launch_type.value}, run: {run}, ttl: {window})'
        )

    def _debug_task_census(self) -> None:
        """
        Log a one-line summary of live tasks.

        Counts running tasks by run kind and how many are unbounded (ttl 0,
        never stopped by the TTL monitor), naming the oldest unbounded one.
        Silent when no task is running.
        """
        live = [c for c in list(self._task_control.values()) if c and c.task and not c.task.is_task_complete()]
        if not live:
            return

        by_kind: Dict[str, int] = {}
        for control in live:
            by_kind[control.run_kind] = by_kind.get(control.run_kind, 0) + 1
        kinds = ', '.join(f'{kind}: {count}' for kind, count in sorted(by_kind.items()))

        now = time.time()
        unbounded = [
            (c, int(now - c.task.get_status().startTime) if c.task.get_status().startTime else 0)
            for c in live
            if c.task._ttl == 0
        ]
        message = f'Tasks running: {len(live)} ({kinds}), unbounded: {len(unbounded)}'
        if unbounded:
            oldest, lifetime = max(unbounded, key=lambda item: item[1])
            message += f', oldest unbounded: "{oldest.id}" {lifetime}s'
        self.debug_message(message)
