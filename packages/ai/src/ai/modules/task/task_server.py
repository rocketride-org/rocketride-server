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
- Controls (``TaskControl``): the callers' views of runs, identified by
  ``(owner, rung, project_id, hash(resolved config))`` and handled by a
  control id, each holding exactly one engine
- Engines (``TaskEngine``): the running processes, keyed by the SHAPE of the
  spec qualified by its owner (every rung in this PR; C.25 drops the owner
  on the published rungs) and shared by every control of that owner whose
  spec has that shape
- DAP connections (debugging and control interfaces)
- Event broadcasting (real-time monitoring and notifications)
- Resource management (automatic cleanup and metrics)
- Multi-tenant security (API key isolation and access control)
"""

import itertools
import time
import errno
import heapq
import socket
import sys
import asyncio
import copy
from collections import deque
from collections.abc import Mapping, MutableMapping
from contextlib import asynccontextmanager
from typing import Deque, List
from fastapi import WebSocket
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Dict, Any, Optional, Set, Tuple, Union
from ai.constants import (
    CONST_CLEANUP_DELAY_TIME,
    CONST_CLEANUP_SLEEP_TIME,
    CONST_TEARDOWN_WAIT_TIMEOUT,
    CONST_DEFAULT_MAX_THREADS,
    CONST_DEFAULT_TTL,
    CONST_ENGINE_IDLE_TTL,
    CONST_ENGINE_RESTART_BACKOFF,
    CONST_ENGINE_RESTART_MAX_PER_HOUR,
    CONST_TTL_CHECK,
    CONST_MAX_UNAUTHED_CONNS_PER_IP,
    CONST_MAX_UNAUTHED_IPS,
)
from ai.common.parameters import validate_parameters
from .pipeline import references_env, resolve_pipeline_env, substituted_env, validate_placeholders
from .task_convert import ConvertResult, convert_pipeline
from ai.common.dap import TransportWebSocket, DAPBase
from rocketride import EVENT_TYPE
from ai.web import WebServer
from ai.account.app_deploy import developer_id_required
from ai.account.base import OutOfCreditsError
from ai.account.models import AccountInfo, home_team, resolve_run_permissions, resolve_task_permissions
from ai.account.pipe_deploy import Pin, resolve_pins, teams_to_probe
from ai.account.store import Store
from .task_conn import TaskConn
from .trace_owner import TraceOwners
from .task_control import (
    RUNGS,
    CallerConfigError,
    DeploymentRef,
    TaskControl,
    TeamContext,
    config_hash,
    control_key,
    is_control_id,
    mint_control_id,
    rung_of,
)
from .engine_key import EngineContent, engine_content
from .node_id import node_id
from .task_engine import TaskEngine, component_facts, hosted_refusal, resolve_parameter_tokens
from .types import LAUNCH_TYPE, EngineState, TaskError
from .pipeline import MultipleSourcesError, resolve_implied_source
from .commands.cmd_monitor import owner_key
from .address import (
    Address,
    build_address,
    check_endpoint_scope,
    parse_address,
    validate_component_ids,
    validate_identity,
    validate_segment,
)

from rocketlib import debug, warning


def _apply_source_defaults(pipeline: Dict[str, Any], source: str) -> Dict[str, Any]:
    """
    Fill in the fields a launch stamps on a pipeline, so two copies compare equal.

    ``start_task`` writes the resolved source onto the pipeline and gives the
    source component an empty config when it has none, so a pipeline stored
    without those and the same pipeline after a launch read the same.

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


@dataclass
class _StartGate:
    """
    The per-engine-key start lock (plan 7.2).

    Concurrent starters of one engine key serialize on ``lock``; the first
    starts the engine, the rest find it registered and attach to it. ``users``
    counts the starters inside or waiting, so the gate is dropped when the
    last one leaves. This is the deploy rail's check-and-claim reservation
    (``try_reserve_run``/``release_run``) generalized from one deployment
    source to every engine key; the scheduler keeps its own per-source guard,
    which protects a team storage anchor rather than an engine start.
    """

    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


class EngineRegistry(Mapping):
    """
    The engine pool: running engines by content key, with the per-key start lock inside (plan 7.2).

    ALB seam 2: everything the server does with engines as a set goes through
    this interface (``get`` / ``try_start_lock`` / ``release_lock`` /
    ``register`` / ``unregister`` / ``holders``), so a second backend (a
    fleet-wide pool behind the ALB) replaces the dict without touching a
    caller. Read-only as a mapping (``key -> TaskEngine``); writes go through
    ``register``/``unregister``.

    The start lock is the deploy rail's check-and-claim reservation
    (``try_reserve_run``/``release_run``) generalized from one deployment
    source to every engine key: concurrent starters of one key serialize, the
    first starts the engine, the rest attach to it.
    """

    def __init__(self) -> None:
        """An empty pool with no start in progress."""
        self._engines: Dict[str, TaskEngine] = {}
        self._starts: Dict[str, _StartGate] = {}
        # Starts from a published artifact serialize per CONTROL key as well
        # (a concurrent request attaches to the one start); the same gate
        # mechanism, a second table, both inside the registry (ALB seam 2)
        self._control_starts: Dict[str, _StartGate] = {}

    # ==== Mapping =================================================================

    def __getitem__(self, key: str) -> TaskEngine:
        """The engine registered under ``key``."""
        return self._engines[key]

    def __iter__(self):
        """The registered engine keys."""
        return iter(self._engines)

    def __len__(self) -> int:
        """The number of registered engines."""
        return len(self._engines)

    # ==== Registration ============================================================

    def register(self, key: str, engine: TaskEngine) -> None:
        """Put ``engine`` in the pool under ``key`` (its engine key; a newer engine replaces an older one)."""
        self._engines[key] = engine

    def unregister(self, engine: TaskEngine) -> bool:
        """
        Take ``engine`` out of the pool, unless a newer engine already holds its key.

        Returns:
            True when ``engine`` was the registered one and is now gone.
        """
        if self._engines.get(engine.engine_key) is not engine:
            return False
        self._engines.pop(engine.engine_key, None)
        return True

    def holders(self, key: str) -> frozenset:
        """The control keys holding the engine of ``key`` (empty when none is registered)."""
        engine = self._engines.get(key)
        return engine.holds if engine is not None else frozenset()

    # ==== The start lock ==========================================================

    async def try_start_lock(self, key: str) -> None:
        """
        Take the start lock of ``key``, waiting behind any starter already holding it.

        Every call is paired with one ``release_lock(key)``; ``start_lock``
        does the pairing.
        """
        gate = self._starts.setdefault(key, _StartGate())
        gate.users += 1
        try:
            await gate.lock.acquire()
        except BaseException:
            self._leave(key, gate)
            raise

    def release_lock(self, key: str) -> None:
        """Give back the start lock of ``key``; the gate goes when its last user leaves."""
        gate = self._starts.get(key)
        if gate is None:
            return
        gate.lock.release()
        self._leave(key, gate)

    def _leave(self, key: str, gate: _StartGate, table: Optional[Dict[str, _StartGate]] = None) -> None:
        """One user left ``gate``; drop it when it was the last."""
        table = self._starts if table is None else table
        gate.users -= 1
        if gate.users == 0 and table.get(key) is gate:
            table.pop(key, None)

    @asynccontextmanager
    async def control_start_lock(self, key: str) -> AsyncIterator[None]:
        """
        Hold the start lock of CONTROL ``key`` for the ``async with`` body.

        One start per control key from a published artifact: the first
        request starts, the ones behind it find the control registered and
        attach (plan 3.2). The gate goes when its last user leaves.

        Args:
            key: The control key about to be started.
        """
        gate = self._control_starts.setdefault(key, _StartGate())
        gate.users += 1
        try:
            async with gate.lock:
                yield
        finally:
            self._leave(key, gate, self._control_starts)

    @asynccontextmanager
    async def start_lock(self, key: str) -> AsyncIterator[None]:
        """Hold the start lock of ``key`` for the ``async with`` body."""
        await self.try_start_lock(key)
        try:
            yield
        finally:
            self.release_lock(key)

    @property
    def starting(self) -> frozenset:
        """The engine keys with a start in progress (or starters waiting)."""
        return frozenset(self._starts)


def _require_converted(pipeline: Dict[str, Any]) -> ConvertResult:
    """
    Convert a pipeline from the old node-config format at the start door (plan 5.6.8).

    The converted pipeline is what runs (and what the engine key hashes); the
    stored file or artifact is never rewritten here. A component the converter
    cannot map is refused with the key named, never guessed.

    Args:
        pipeline: The pipeline about to start, as submitted.

    Returns:
        The conversion: ``.pipeline`` is the one to run (``pipeline`` itself
        when ``.touched`` is False), ``.warnings`` what changed.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT on ``pipeline`` naming every unmappable key.
    """
    result = convert_pipeline(pipeline)
    if result.errors:
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            'conversion: ' + '; '.join(e['message'] for e in result.errors),
            field='pipeline',
        )
    if not result.touched:
        result.pipeline = pipeline
    return result


def _require_valid_parameters(pipeline: Dict[str, Any]) -> None:
    """
    Refuse a pipeline whose ``parameters`` map is malformed (plan 5.4 item 1).

    Args:
        pipeline: The pipeline about to start.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT on ``parameters`` naming the first problem.
    """
    errors = validate_parameters(pipeline)
    if errors:
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            'parameters: ' + '; '.join(e['message'] for e in errors),
            field='parameters',
        )


def _require_valid_placeholders(pipeline: Dict[str, Any]) -> None:
    """
    Refuse a pipeline with a ``${...}`` placeholder outside a config value or outside ``ROCKETRIDE_*`` (plan 6.2).

    Args:
        pipeline: The pipeline about to start.

    Raises:
        TaskError: TASK_INVALID_ARGUMENT on ``pipeline`` naming the first problem.
    """
    errors = validate_placeholders(pipeline)
    if errors:
        raise TaskError(
            TaskError.INVALID_ARGUMENT,
            'placeholders: ' + '; '.join(e['message'] for e in errors),
            field='pipeline',
        )


class ControlRegistry(MutableMapping):
    """
    The control registry and its indexes (plan 3.2: lookups are indexed, never scanned).

    A mapping ``controlId -> TaskControl`` (``_by_key``: the control id is
    the registry key, plan section 1) that keeps, in its ONE register path
    (``__setitem__``) and its ONE forget path (``__delitem__``, which ``pop``
    goes through):

    - ``_by_index[<rung>.<ownerId>.<address>]``: the owner-filtered index a
      NAME resolves through (``control_key``); on ``spec`` one owner may
      hold several controls under one key (one ``project_id``, several
      configs), the most recently touched answering first;
    - ``_by_address_owner[(address, ownerId)]``: the controls of one owner at
      one address, across rungs. ``@team`` probes it once per team the
      caller belongs to;
    - ``_sources[(developerId, pipeId)]``: the sources registered for a pipe,
      with the number of controls at each, so a two-segment address finds
      its sources without a walk;
    - ``_by_owner[ownerId]``: every control of one owner (user or team), so
      an owner-scoped lookup never walks the registry.

    ALB seam 2: callers outside the registry use ``get`` / ``remove`` /
    ``for_owner`` (and the counted resolver probes below), never an
    iteration over every control.

    ``probes`` counts the index entries the resolver touched: the
    instrumentation behind the O(caller's teams) guarantee.
    """

    def __init__(self, controls: Optional[Dict[str, TaskControl]] = None) -> None:
        """
        Build an empty registry, or one holding ``controls``.

        Args:
            controls: Initial ``key -> control`` entries, registered one by one.
        """
        self._by_key: Dict[str, TaskControl] = {}
        self._by_index: Dict[str, List[TaskControl]] = {}
        self._by_address_owner: Dict[Tuple[str, str], List[TaskControl]] = {}
        self._sources: Dict[Tuple[str, str], Dict[str, int]] = {}
        self._by_owner: Dict[str, Dict[str, TaskControl]] = {}
        self._by_deployment: Dict[DeploymentRef, Dict[str, TaskControl]] = {}
        self.probes = 0
        for key, control in (controls or {}).items():
            self[key] = control

    # ==== Mapping =================================================================

    def __getitem__(self, key: str) -> TaskControl:
        """The control registered under ``key``."""
        return self._by_key[key]

    def __iter__(self):
        """The registered keys."""
        return iter(self._by_key)

    def __len__(self) -> int:
        """The number of registered controls."""
        return len(self._by_key)

    def __setitem__(self, key: str, control: TaskControl) -> None:
        """
        THE register path: the control id, the name index, the owner index and the source index.

        A control already under ``key`` is forgotten first, so a replacement
        never leaves its predecessor in an index.
        """
        # Step 1: a predecessor under the key leaves every index
        if key in self._by_key:
            del self[key]

        # Step 2: the control id, the name index, the owner index and the
        # pipe's sources
        self._by_key[key] = control
        self._by_index.setdefault(control.index_key, []).append(control)
        self._by_address_owner.setdefault((control.address, control.owner_id), []).append(control)
        sources = self._sources.setdefault((control.developer_id, control.project_id or ''), {})
        sources[control.source or ''] = sources.get(control.source or '', 0) + 1
        self._by_owner.setdefault(control.owner_id, {})[key] = control
        if control.deployment is not None:
            self._by_deployment.setdefault(control.deployment, {})[key] = control

    def __delitem__(self, key: str) -> None:
        """THE forget path: out of the key, the owner index and the source index."""
        # Step 1: the exact key
        control = self._by_key.pop(key)
        if control.deployment is not None:
            through = self._by_deployment.get(control.deployment, {})
            through.pop(key, None)
            if not through:
                self._by_deployment.pop(control.deployment, None)

        # Step 2: the name index entry and the owner index entry, by identity
        index = control.index_key
        under = [c for c in self._by_index.get(index, []) if c is not control]
        if under:
            self._by_index[index] = under
        else:
            self._by_index.pop(index, None)
        owner = (control.address, control.owner_id)
        held = [c for c in self._by_address_owner.get(owner, []) if c is not control]
        if held:
            self._by_address_owner[owner] = held
        else:
            self._by_address_owner.pop(owner, None)

        # Step 3: the pipe's source count
        pipe = (control.developer_id, control.project_id or '')
        sources = self._sources.get(pipe, {})
        source = control.source or ''
        if sources.get(source, 0) > 1:
            sources[source] -= 1
        else:
            sources.pop(source, None)
            if not sources:
                self._sources.pop(pipe, None)

        # Step 4: the owner index
        owned = self._by_owner.get(control.owner_id, {})
        owned.pop(key, None)
        if not owned:
            self._by_owner.pop(control.owner_id, None)

    # ==== Interface (ALB seam 2) =================================================

    def for_deployment(self, deployment: DeploymentRef) -> List[TaskControl]:
        """
        The controls that resolved through ``deployment`` (the kill switch's targets, plan 7.2).

        Args:
            deployment: The deployment a publisher disabled or removed.

        Returns:
            Those controls, a snapshot; never a walk of the registry.
        """
        return list(self._by_deployment.get(deployment, {}).values())

    def remove(self, key: str) -> Optional[TaskControl]:
        """Forget the control under ``key``; returns it, or None when none was registered."""
        if key not in self._by_key:
            return None
        control = self._by_key[key]
        del self[key]
        return control

    def for_owner(self, owner_id: str) -> List[TaskControl]:
        """Every control one owner (a user or a team) holds, in registration order."""
        self.probes += 1
        return list(self._by_owner.get(owner_id, {}).values())

    # ==== Resolver lookups (counted) ==============================================

    def lookup(self, index_key: str) -> List[TaskControl]:
        """
        One name-index probe (``@spec``, ``@me``, ``@public``): the caller's controls under ``index_key``.

        Args:
            index_key: ``control_key(rung, ownerId, address)``.

        Returns:
            Those controls, the most recently touched first (plan 3.2: when
            several live ``spec`` controls share the address, the most
            recently touched one answers); empty when none.
        """
        self.probes += 1
        return sorted(self._by_index.get(index_key, ()), key=lambda c: c.last_activity, reverse=True)

    def owned(self, address: str, owner_id: str) -> List[TaskControl]:
        """One owner-index probe: ``owner_id``'s controls at ``address``."""
        self.probes += 1
        return list(self._by_address_owner.get((address, owner_id), ()))

    def sources_of(self, developer_id: str, pipe_id: str) -> List[str]:
        """One source-index probe: the sources registered for a pipe, sorted."""
        self.probes += 1
        return sorted(self._sources.get((developer_id, pipe_id), {}))


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
        _task_control: Registry of the controls (the callers' views of runs)
        _engines: The engine pool (``EngineRegistry``): running engines by
            content key, with the per-key start lock inside
        _engine_unavailable: Controls whose engine an operator stopped, told once
        _engine_ids: The engine ids this server hands out, one per engine launch (the middle
            segment of every wire traceId, plan 7.4)
        _launched: Launching connection id -> keys of the controls it launched (auto-terminate on disconnect)
        _engine_restarts: Automatic listener-engine restarts per engine key (rolling hour)
        _restart_tasks: Pending automatic listener-engine restarts
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
        self._task_control = ControlRegistry()  # Control registry: control id, with the name index inside
        self._engines = EngineRegistry()  # Engine pool: content key -> engine, start lock inside
        self._engine_unavailable: Dict[str, Tuple[str, str]] = {}  # Control key -> (engineKey, reason)
        # Which control each live request tree belongs to, by wire traceId (plan 7.5)
        self.trace_owners = TraceOwners()
        # Deployments whose holds were released (disabled/removed), by the monotonic
        # time of the release: a control registered through a deployment that was
        # revoked after its state was read, or still holding one that was revoked
        # later, is unavailable (plan 7.2, the kill switch has no back door)
        self._deployment_revoked: Dict[DeploymentRef, float] = {}
        self._engine_ids = itertools.count(1)  # Engine ids handed to engine launches
        self._node_id = node_id()  # Taken once at startup: the first segment of every wire traceId (plan 7.4, P31)
        self._launched: Dict[int, Set[str]] = {}  # Launching connection id -> keys of the controls it launched
        self._engine_restarts: Dict[str, Deque[float]] = {}  # Engine key -> automatic restart times, last hour
        self._restart_tasks: Set[asyncio.Task] = set()  # Pending automatic listener restarts
        self._connections: Dict[int, TaskConn] = {}  # Active client connections
        self._connection_id = 0  # Monotonic connection identifier generator
        self._unauthed_by_ip: Dict[str, int] = {}  # Count of unauthenticated connections per client IP

        # Idle expiry (plan 7.1, 7.2): lazy-deletion min-heaps of
        # (deadline, generation, key|engine). A stored deadline is never later
        # than the real one, so a pass pops only what may be due and re-pushes
        # what was active since it was scheduled. Generations are unique, so
        # ties never compare the third member, and an entry whose generation
        # no longer matches its control or engine is stale and dropped.
        self._control_expiry: List[Tuple[float, int, str]] = []
        self._engine_expiry: List[Tuple[float, int, TaskEngine]] = []
        self._expiry_gen = 0

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

                    # Skip tasks that are still running, and dormant controls:
                    # their engine stopped on its inactivity timer or crashed
                    # after it confirmed running, and the control lives on
                    # until its own ttl (plan 7.2)
                    if not control.task.is_task_complete() or control.dormant:
                        continue

                    # Check if sufficient time has passed since completion
                    task_status = control.task.get_status()
                    if task_status.endTime + CONST_CLEANUP_DELAY_TIME < current_time:
                        # Remove the expired completed task
                        await self.remove_task(control.key)

                # An engine that finished with nobody holding it leaves the pool
                for engine in list(self._engines.values()):
                    if not engine.holds and engine.is_task_complete():
                        self._engines.unregister(engine)

            except Exception as e:
                # Log cleanup errors but continue operation to maintain system stability
                self.debug_message(f'Error during task cleanup cycle: {e}')

            # Wait before next cleanup cycle
            await asyncio.sleep(CONST_CLEANUP_SLEEP_TIME)

    async def _monitor_ttl(self) -> None:
        """
        Background process enforcing idle ttls on controls and on engines.

        Idle time is per CONTROL (plan 7.1): a request through one control
        never keeps another alive, so on a shared engine kept busy by one
        holder every other holder still expires on its own ttl. Each pass
        (every ``CONST_TTL_CHECK`` seconds, see ``_ttl_cycle``):

        - releases every control whose own idle time reached its ttl
          (``stop_task(key, reason='ttl')``): the engine keeps serving the
          other holders, and stops at once when that was its last hold; a
          control with ttl 0 never expires by idle;
        - stops every engine whose own inactivity reached
          ``CONST_ENGINE_IDLE_TTL`` (plan 7.2), even while controls hold it:
          they stay, dormant, and their next request starts the engine again
          (``ensure_engine``). An engine with a ttl-0 holder does not age.

        This method runs as a background async task throughout server lifetime.
        """
        while True:
            try:
                # Wait for the check interval before processing
                await asyncio.sleep(CONST_TTL_CHECK)
                await self._ttl_cycle()
                self._debug_task_census()

            except Exception as e:
                # Log errors but continue operation to maintain system stability
                self.debug_message(f'Error during TTL monitoring cycle: {e}')

    def _next_expiry_gen(self) -> int:
        """Hand out the next idle-expiry generation (unique, increasing)."""
        self._expiry_gen += 1
        return self._expiry_gen

    def _schedule_control(self, control: TaskControl) -> None:
        """
        Schedule a control's idle expiry: O(log n), once per registration.

        Activity afterwards only moves ``control.last_activity``; the pass
        that pops this entry re-pushes it at the later deadline. A control
        with ttl 0 is never scheduled: it does not expire by idle.

        Args:
            control: The registered control.
        """
        if not control.ttl:
            return
        control.expiry_gen = self._next_expiry_gen()
        heapq.heappush(self._control_expiry, (control.last_activity + control.ttl, control.expiry_gen, control.key))

    def _schedule_engine(self, engine: TaskEngine) -> None:
        """
        Schedule a running engine's inactivity stop: O(log n), once per start.

        Activity afterwards only moves the engine's idle clock; the pass that
        pops this entry re-pushes it at the later deadline. A new generation
        makes any earlier entry of the engine stale.

        Args:
            engine: The engine being started.
        """
        engine._expiry_gen = self._next_expiry_gen()
        heapq.heappush(self._engine_expiry, (engine.idle_since + CONST_ENGINE_IDLE_TTL, engine._expiry_gen, engine))

    async def _ttl_cycle(self, now: Optional[float] = None) -> int:
        """
        One TTL pass (see ``_monitor_ttl``): pops only the entries that are due.

        Per pass the cost is O(k log n) for the k entries whose stored
        deadline has passed, never a walk of the registry. A popped entry is
        stale (its control or engine is gone, replaced or rescheduled) and
        dropped; or re-pushed at its real deadline when there was activity
        since it was scheduled; or acted on.

        Args:
            now: Monotonic time of the pass (default: now).

        Returns:
            The number of heap entries the pass popped.
        """
        now = time.monotonic() if now is None else now
        popped = 0

        # Step 1: controls whose own idle time may have reached their ttl
        while self._control_expiry and self._control_expiry[0][0] <= now:
            _, gen, key = heapq.heappop(self._control_expiry)
            popped += 1

            # Stale: the control is gone, replaced under its key, or unbounded
            control = self._task_control.get(key)
            if control is None or control.expiry_gen != gen or not control.ttl or control.task is None:
                continue

            # Finished runs are the cleanup pass's; a dormant control (its
            # engine stopped on its inactivity timer or crashed after it
            # confirmed running) still ages on its ttl
            if control.task.is_task_complete() and not control.dormant:
                continue

            # A request in flight through the control holds its idle clock:
            # a call longer than the ttl is never expired mid-flight. Looked
            # at again one ttl later; end_request restarts the clock.
            if control.inflight:
                heapq.heappush(self._control_expiry, (now + control.ttl, gen, key))
                continue

            # Active since it was scheduled: back in at its real deadline
            idle = control.idle_seconds(now)
            if idle < control.ttl:
                heapq.heappush(self._control_expiry, (now - idle + control.ttl, gen, key))
                continue

            # Its own idle time reached its ttl: release this hold only.
            # Reason 'ttl', so the run records as completed, never as cancelled
            self.debug_message(f'Task "{control.id}" exceeded TTL ({int(idle)}s >= {control.ttl}s), releasing...')
            await self.stop_task(control.key, reason='ttl')

        # Step 2: engines whose own inactivity reached the policy timer
        while self._engine_expiry and self._engine_expiry[0][0] <= now:
            _, gen, engine = heapq.heappop(self._engine_expiry)
            popped += 1

            # Stale: rescheduled, stopping or finished
            if engine._expiry_gen != gen or not engine.is_live:
                continue

            # A ttl-0 holder (a listener source) keeps it from aging: looked
            # at again one timer later, in case that holder has gone
            if not engine.ages:
                heapq.heappush(self._engine_expiry, (now + CONST_ENGINE_IDLE_TTL, gen, engine))
                continue

            # Activity since it was scheduled: back in at its real deadline
            idle = engine.idle_seconds(now)
            if idle < CONST_ENGINE_IDLE_TTL:
                heapq.heappush(self._engine_expiry, (now - idle + CONST_ENGINE_IDLE_TTL, gen, engine))
                continue

            # Inactive for the whole timer: it stops, its holders stay. Their
            # next request starts it again under the same key (plan 7.2)
            self.debug_message(f'Engine "{engine.engine_key}" inactive for {int(idle)}s, stopping...')
            engine.dormant_reason = 'ttl'
            await self._stop_engine_now(engine, 'ttl')

        return popped

    async def shutdown(self) -> None:
        """Cancel all background tasks, pending listener restarts included."""
        bg_tasks = getattr(self, '_bg_tasks', []) + list(getattr(self, '_restart_tasks', ()))
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

        # Auto-terminate the tasks THIS connection launched: that ends each
        # control's hold; an engine other controls hold keeps serving them.
        # By the launch index, never a walk of the registry.
        for key in list(self._launched.pop(id(conn), set())):
            control = self._task_control.get(key)
            if control is None or control.launch_type != LAUNCH_TYPE.LAUNCH or control.launch_owner is not conn:
                continue
            try:
                await self.remove_task(control.key)
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

    @staticmethod
    def _verify_control(control: TaskControl, account_info: AccountInfo, require: Optional[str]) -> TaskControl:
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

    async def _resolve_control_env(self, control: TaskControl) -> Dict[str, str]:
        """
        The ``ROCKETRIDE_*`` values a control's bindings run with (plan 6.2).

        The team layer is the control's TEAM CONTEXT: the team whose
        publication answered a ``@team`` call, a scoped key's frozen team, the
        deploying team on the deploy rail, the caller's home team otherwise. A
        team-owned run applies no user layer (a deployment's configuration
        never depends on which human deployed it). Only the names the spec
        references are kept (least privilege): a pipeline using
        ``${ROCKETRIDE_OPENAI_KEY}`` never sees the caller's other variables.

        Args:
            control: The control, with its pipeline and team context set.

        Returns:
            ``{name: value}``; empty when the spec references nothing or the
            account could not answer (logged; the run then has no env).
        """
        pipeline = control.pipeline or {}
        if not substituted_env(pipeline, {}) and not references_env(pipeline):
            return {}
        from ai.account import account

        try:
            merged = await account.get_merged_env(
                user_id='' if control.owner_kind == 'team' else control.userId,
                org_id=control.orgId,
                team_id=control.team_context.team_id,
            )
        except Exception as e:
            self.debug_message(f'Environment for {control.key} could not be resolved: {e}')
            return {}
        return substituted_env(pipeline, merged)

    def control_by_key(self, key: str) -> TaskControl:
        """
        Internal registry lookup by the control's own key (its id), with no caller check.

        For code that already holds a control's key (the engine reporting
        back, cleanup, the scheduler, the in-process dispatch) — never for a
        client-supplied value: a client's control id goes through
        ``control_by_id``, which re-checks the caller.

        Args:
            key (str): The registry key: the control id.

        Returns:
            TaskControl: The live control.

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live task.
        """
        control = self._task_control.get(key) if key else None
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')
        return control

    def control_by_id(self, control_id: Any, account_info: AccountInfo, require: Optional[str] = None) -> TaskControl:
        """
        The control a client names by its id, re-checked against the caller (plan section 1).

        Every verb that names a control id comes here: the registry hit is
        followed by the owner check (the owner on ``@spec``/``@me``,
        membership on ``@team``, ``sys.admin`` anywhere), never by the id
        alone. A foreign id and an unknown id are refused the SAME way,
        ``permission_denied``: the registry is no existence oracle.

        Args:
            control_id: What the client put in the token slot.
            account_info: The request's account (required).
            require: The permission the request needs, or None for reachability only.

        Returns:
            The control.

        Raises:
            PermissionError: Unauthenticated; not a control id; not the
                caller's control (or no such control); the required
                permission is missing; outside a scoped key's endpoints.
        """
        # Step 1: the account and the id's shape
        if account_info is None:
            raise PermissionError('Not authenticated')
        if not is_control_id(control_id):
            raise PermissionError('The token slot carries a control id (32 hex characters)')

        # Step 2: the registry hit, then the caller: a foreign or unknown id
        # reads the same
        control = self._task_control.get(control_id)
        if control is None:
            raise PermissionError('Access denied: not your control, or it no longer exists')
        try:
            self._verify_control(control, account_info, require)
        except PermissionError as exc:
            raise PermissionError('Access denied: not your control, or it no longer exists') from exc
        check_endpoint_scope(getattr(account_info, 'endpoints', None), control.address)
        return self._check_engine_available(control)

    def resolve_token(
        self, token: Any, account_info: AccountInfo, require: Optional[str] = None, *, team: Optional[str] = None
    ) -> TaskControl:
        """
        A control id OR an address in the token slot, for the verbs that take either (plan 7.5).

        The monitor key builders send either the control id they were handed
        or an address, which resolves to the caller's own control; a
        standalone ``tool`` borrow resolves an address the way ``submit()``
        does (plan 3.6). An address always carries a dot, a control id never.

        Args:
            token: What the client put in the token slot.
            account_info: The request's account (required).
            require: The permission the request needs.
            team: Per-call ``@team`` override for an address.

        Returns:
            The control.

        Raises:
            PermissionError: As ``control_by_id`` / ``resolve_control``.
            TaskError: As ``resolve_control`` (an address nothing answers).
        """
        if is_control_id(token):
            return self.control_by_id(token, account_info, require)
        return self.resolve_control(str(token or ''), account_info, require, team=team)

    def resolve_control(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
        *,
        team: Optional[str] = None,
        rung: Optional[str] = None,
    ) -> TaskControl:
        """
        THE resolver over the registry: an address plus the request's account yields one control.

        ``rung`` holds the walk to ONE rung (``'spec'``, ``'me'``, ``'team'``,
        ``'public'``) for a caller that already knows which continuum it
        means (a monitor subscription keyed to the caller's dev run must
        never land on their personal deploy of the same address, nor the
        reverse); the default walks them all.

        Walks the rungs in the fixed order and takes the first that answers
        (``@spec``: the caller's own presence, attach-only; ``@me``: the
        caller's personal deployment run; ``@team``: the first team in the
        caller's TEAM ORDER with a team-owned run of the address; ``@public``:
        the caller's control on a store publication). Starting a published
        rung from its artifact when nothing is registered is
        ``resolve_or_start``. Every hit is permission-checked; a key with an
        ``endpoints`` scope skips ``@spec`` (a production webhook must never
        land on the owner's Play'd run), probes its frozen team only, and is
        refused outside its scope. There is NO owner qualifier: nobody can
        name another user's control.

        Every probe is an index lookup (plan 3.2), never a registry walk:
        ``@spec``/``@me``/``@public`` are one name-index probe each
        (``<rung>.<userId>.<address>``), ``@team`` is one owner-index probe
        per team in the order (first hit wins; the order is total, so there
        is no ambiguity), and a two-segment address first reads the pipe's
        registered sources. The cost is O(caller's teams x sources) whatever
        the registry holds.

        The walk runs over LIVE controls first: a stopped run never answers
        its address while another rung has a live one (a dead ``@spec`` falls
        through). A dormant control (its engine stopped on its inactivity
        timer, or crashed after it confirmed running) is live: its next
        request starts the engine again. Only when no rung has a live control
        is the walk repeated over every registered control, so a run that
        just finished keeps its final status readable until the cleanup pass
        removes it.

        A two-segment address (no source) resolves when exactly one live
        source answers; several live sources raise ``TASK_SOURCE_REQUIRED``.
        A finished source never counts against a live one.

        Args:
            address (str): ``developerId.pipelineId[.source]``.
            account_info (AccountInfo): The request's account (required).
            require (Optional[str]): The permission the request needs
                (``'task.data'``, ``'task.control'``, ``'task.monitor'`` ...).
            team (Optional[str]): Per-call ``@team`` override (one of the
                caller's teams).

        Returns:
            TaskControl: The resolved control.

        Raises:
            TaskError: TASK_INVALID_ARGUMENT (grammar), TASK_SOURCE_REQUIRED,
                or TASK_NOT_REGISTERED (with ``rungsTried``) when no rung answers.
            PermissionError: Unauthenticated, no permission, ``team`` is not
                the caller's, or outside the key's endpoints scope.
        """
        # Step 1: the account and the address grammar
        if account_info is None:
            raise PermissionError('Not authenticated')
        parsed = parse_address(address)
        rungs: List[str] = []

        # Step 2: live controls first, then anything still registered
        for live_only in (True, False):
            control = self._walk_rungs(parsed, address, account_info, require, live_only, rungs, team, only=rung)
            if control is not None:
                return self._check_engine_available(control)

        # Step 3: no rung answers
        raise self._not_registered(address, rungs)

    async def resolve_or_start(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
        *,
        team: Optional[str] = None,
    ) -> TaskControl:
        """
        Resolve a NAME call: the caller's control on the first rung that answers, started when needed.

        See ``resolve_name``; this returns the control only.
        """
        control, _started = await self.resolve_name(address, account_info, require, team=team)
        return control

    async def resolve_name(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
        *,
        team: Optional[str] = None,
    ) -> Tuple[TaskControl, bool]:
        """
        Resolve a NAME call rung by rung: live control or publication, whichever comes first.

        The fixed order of plan 3.2, each rung answered by its live control
        or, failing that, by its publication (started from the artifact):
        ``@spec`` (live only: a name never starts a spec run), ``@me``,
        ``@team`` slot by slot in the caller's team order (``team=``
        overrides it), ``@public``. So a live ``@team`` control of a LATER
        team never beats an earlier team's publication, and a live
        ``@team`` control never beats the caller's own ``@me`` deployment.
        A live ``@spec``/``@me`` hit answers without reading publications.

        Args:
            address: ``developerId.pipelineId[.source]``.
            account_info: The request's account (required).
            require: The permission the request needs.
            team: Per-call ``@team`` override.

        Returns:
            The control (``control.rung`` says which rung answered) and True
            when this call started it from an artifact.

        Raises:
            TaskError: As ``resolve_control``; TASK_NOT_REGISTERED lists the rungs tried.
            PermissionError: As ``resolve_control``.
        """
        parsed, rungs, candidates = await self.resolve_candidates(address, account_info, require, team=team)
        for candidate in candidates:
            if isinstance(candidate, TaskControl):
                return self._check_engine_available(candidate), False
            # A pinned artifact without the named source yields nothing; the
            # next candidate in the order answers
            control, started = await self._start_from_pin(candidate, parsed, account_info, require)
            if control is not None:
                return control, started
        raise self._not_registered(address, rungs)

    async def resolve_candidates(
        self,
        address: str,
        account_info: AccountInfo,
        require: Optional[str] = None,
        *,
        team: Optional[str] = None,
    ) -> Tuple[Address, List[str], List[Union[TaskControl, Pin]]]:
        """
        THE decision of a NAME call: what answers ``address`` for this caller, in the ladder's order.

        A pure read — nothing starts, nothing is held. Every verb that must
        agree on "which rung answers" asks this: ``resolve_name`` acts on the
        first candidate that can serve (starting a pin's engine when needed),
        ``interfaces`` reads the first candidate's spec. One order, one
        implementation (plan 3.2):

        - The caller's registered ``@spec`` or ``@me`` control, when there is
          one, is the whole answer: ``@spec`` has no publication to compare
          with, and nothing outranks ``@me``.
        - Otherwise the serving publications and the caller's registered
          control (``@team`` or ``@public``) are merged by rung rank — ``@me``,
          each team in the caller's team order, ``@public`` — a pin before a
          control of a LATER rung, the control before any pin of a later
          rung. A dormant control (engine stopped on its idle timer) counts
          as registered: its spec stays readable and its next request
          restarts it.

        Args:
            address: ``developerId.pipelineId[.source]``.
            account_info: The request's account (required).
            require: The permission the request needs.
            team: Per-call ``@team`` override.

        Returns:
            The parsed address, the rungs the control walk tried (for the
            not-registered message) and the candidates in answer order, each
            a ``TaskControl`` or a ``Pin``; empty when no rung has anything.

        Raises:
            TaskError: Bad address grammar, or TASK_SOURCE_REQUIRED.
            PermissionError: Unauthenticated, no permission, or outside the
                key's endpoints scope.
        """
        # Step 1: the caller's registered control on any rung
        if account_info is None:
            raise PermissionError('Not authenticated')
        parsed = parse_address(address)
        rungs: List[str] = []
        live = self._walk_rungs(parsed, address, account_info, require, True, rungs, team)
        if live is not None and live.rung in ('spec', 'me'):
            return parsed, rungs, [live]

        # Step 2: the publications, merged with the control by rung rank
        pins = await resolve_pins('pipe', account_info, address, team=team)
        probe = teams_to_probe(account_info, team)

        def _rank(rung: str, team_id: str) -> int:
            """Position of a rung slot in the fixed order (me, each team, public)."""
            if rung == 'me':
                return 0
            if rung == 'team':
                return 1 + (probe.index(team_id) if team_id in probe else len(probe))
            return 2 + len(probe)

        candidates: List[Union[TaskControl, Pin]] = []
        live_rank = _rank(live.rung, live.owner_id) if live is not None else None
        placed = False
        for pin in pins.pins:
            if (
                live is not None
                and not placed
                and live_rank is not None
                and live_rank <= _rank(pin.rung, pin.deployment.team_id)
            ):
                candidates.append(live)
                placed = True
            candidates.append(pin)
        if live is not None and not placed:
            candidates.append(live)
        return parsed, rungs, candidates

    def _walk_rungs(
        self,
        parsed: Address,
        address: str,
        account_info: AccountInfo,
        require: Optional[str],
        live_only: bool,
        rungs: List[str],
        team: Optional[str] = None,
        only: Optional[str] = None,
    ) -> Optional[TaskControl]:
        """
        One walk of the rungs over the registry indexes: the first hit, verified, or None.

        Args:
            parsed: The parsed address.
            address: The address as sent (for messages).
            account_info: The request's account.
            require: The permission the request needs.
            live_only: Consider only live (or dormant) controls.
            rungs: Filled with the rungs this walk tried, in order.
            team: Per-call ``@team`` override.
            only: Walk this one rung (``'spec'``/``'me'``/``'team'``/``'public'``) instead of all four.

        Returns:
            The control the first answering rung resolved, or None.

        Raises:
            TaskError: TASK_SOURCE_REQUIRED.
            PermissionError: No permission, ``team`` is not the caller's, or
                outside the key's endpoints scope.
        """
        registry = self._task_control
        endpoints = getattr(account_info, 'endpoints', None)
        user_id = account_info.userId
        rungs.clear()

        # Step 1: the full addresses: the one given, or one per registered source
        if parsed.source is not None:
            addresses = [address]
        else:
            sources = registry.sources_of(parsed.developer_id, parsed.pipe_id)
            addresses = [build_address(parsed.developer_id, parsed.pipe_id, source) for source in sources if source]

        def _usable(control: Optional[TaskControl]) -> bool:
            return control is not None and (control.live or not live_only)

        def _pick(candidates: List[TaskControl]) -> Optional[TaskControl]:
            """One control, or the source-required error when several sources answer."""
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

        def _exact(rung: str) -> Optional[TaskControl]:
            """The caller's own control on ``rung``: one index probe per full address, the most recent usable one."""
            found = []
            for a in addresses:
                usable = [c for c in registry.lookup(control_key(rung, user_id, a)) if _usable(c)]
                if usable:
                    found.append(usable[0])
            return _pick(found)

        def _wanted(rung: str) -> bool:
            """Whether this walk visits ``rung`` (every rung unless one was asked for)."""
            return only is None or only == rung

        # Step 2: @spec, the caller's own presence. Attach-only, and skipped
        # for a scoped (machine) credential.
        if endpoints is None and _wanted('spec'):
            rungs.append('@spec')
            control = _exact('spec')
            if control is not None:
                return self._verify_control(control, account_info, require)

        # Step 3: @me, the caller's personal (user-owned) deployment run
        if _wanted('me'):
            rungs.append('@me')
            control = _exact('me')
            if control is not None:
                check_endpoint_scope(endpoints, control.address)
                return self._verify_control(control, account_info, require)

        # Step 4: @team, the first team in the caller's team order (or the
        # team= override, or a scoped key's frozen team) with a team-owned
        # run of the address: one owner-index probe per team and address
        if _wanted('team'):
            rungs.append('@team')
            for team_id in teams_to_probe(account_info, team):
                runs = [
                    c
                    for a in addresses
                    for c in registry.owned(a, team_id)
                    if c.run_kind == 'deploy'
                    and c.owner_kind != 'user'
                    and _usable(c)
                    and resolve_run_permissions(account_info, c)
                ]
                control = _pick(runs)
                if control is not None:
                    check_endpoint_scope(endpoints, control.address)
                    return self._verify_control(control, account_info, require)

        # Step 5: @public, the caller's own control on a store publication
        if _wanted('public'):
            rungs.append('@public')
            control = _exact('public')
            if control is not None:
                check_endpoint_scope(endpoints, control.address)
                return self._verify_control(control, account_info, require)
        return None

    @staticmethod
    def _not_registered(address: str, rungs_tried: List[str]) -> TaskError:
        """The not-found error: the address and the rungs ACTUALLY tried (plan 3.8)."""
        return TaskError(
            TaskError.NOT_REGISTERED,
            f'Your pipeline is not running ({address!r}; tried {", ".join(rungs_tried)})',
            address=address,
            rungsTried=list(rungs_tried),
        )

    def _check_engine_available(self, control: TaskControl) -> TaskControl:
        """
        Tell a holder, once, that an operator stopped its engine.

        ``rrext_engine_stop`` stops an engine regardless of holds and marks
        every holder. The first request that resolves such a control gets
        ``TASK_ENGINE_UNAVAILABLE`` and the control is dropped, so the next
        call re-resolves (plan 3.8, 7.2).

        Args:
            control: The control the rungs resolved.

        Returns:
            ``control`` when its engine was not stopped out from under it.

        Raises:
            TaskError: TASK_ENGINE_UNAVAILABLE with ``address``, ``engineKey``
                and ``reason``.
        """
        told = self._engine_unavailable.get(control.key)
        if told is None:
            # A deployment revoked after this control was registered (or after
            # its state was read by the dispatch that started it) is the kill
            # switch catching a control the release pass did not reach
            if not self._revoked_after(control.deployment, control.registered_at):
                return control
            told = (control.task.engine_key if control.task is not None else '', 'unpublished')
        engine_key_value, reason = told
        self._forget_control(control)
        raise TaskError(
            TaskError.ENGINE_UNAVAILABLE,
            f'The engine serving {control.address!r} was stopped ({reason}); call again to re-resolve',
            address=control.address,
            engineKey=engine_key_value,
            reason=reason,
        )

    async def _start_from_pin(
        self,
        pin: Pin,
        parsed: Address,
        account_info: AccountInfo,
        require: Optional[str],
    ) -> Tuple[Optional[TaskControl], bool]:
        """
        The caller's control on ``pin``'s rung: attached when live, else started from the artifact.

        The start reuses the deploy-run dispatch (``start_server_task_as_team``,
        the path ``cmd_pipe``'s ``deploy.run`` and the scheduler take) with
        ``trigger='submit'``. The control is owned by the CALLER: the user
        on ``@me`` and ``@public``, the answering team on ``@team``; its index
        key is ``<rung>.<owner>.<address>``, its ``rung`` the pin's rung, its
        ``DeploymentRef`` the pinned publication's (so the publisher's
        disable/remove releases it) and its ``version`` the pinned version.
        Its TEAM CONTEXT (plan 6.2) is the answering team on ``@team``, the
        frozen team of a scoped key, and the caller's home team otherwise.
        ``@public`` bills the caller's home team (plan 8.3); ``@me`` and
        ``@team`` read the row's billing stamp until C.13 moves attribution
        to the caller. The ttl is policy (``CONST_DEFAULT_TTL``): a name call
        never sets it (plan 1).

        Args:
            pin: The serving publication.
            parsed: The parsed address.
            account_info: The request's account.
            require: The permission the request needs.

        Returns:
            The control (None when the pinned artifact has no such source)
            and True when this call started it.

        Raises:
            TaskError: TASK_SOURCE_REQUIRED (two-segment address, several
                sources and no default).
            PermissionError: No permission on the team, no home team for a
                public run, or outside the key's endpoints scope.
            ValueError: A personal deployment without its billing stamp.
        """
        # Deferred: the account singleton and the facade (which imports
        # TaskConn) load after this module
        from ai.account import account

        from .task_server_facade import start_server_task_as_team

        # Step 1: the pinned artifact and the source the address names. The
        # pin was read as enabled before this moment; a disable/remove from
        # here on refuses the control at registration (plan 7.2)
        deployment = pin.deployment
        state_epoch = time.monotonic()
        pipeline = dict(await account.deployments_artifact(deployment.org_id, deployment.project_id, pin.version))
        components = [c for c in pipeline.get('components') or [] if isinstance(c, dict)]
        source = parsed.source or pipeline.get('source')
        if not source:
            try:
                source = resolve_implied_source(pipeline)
            except MultipleSourcesError:
                source = None
        if not source:
            pipe_address = build_address(parsed.developer_id, parsed.pipe_id)
            raise TaskError(
                TaskError.SOURCE_REQUIRED,
                f'{pipe_address!r} has several sources and no default; name one',
                address=pipe_address,
                sources=sorted(str(c.get('id')) for c in components if (c.get('config') or {}).get('mode') == 'Source'),
            )
        if source not in {c.get('id') for c in components}:
            return None, False
        address = build_address(parsed.developer_id, parsed.pipe_id, source)
        endpoints = getattr(account_info, 'endpoints', None)
        check_endpoint_scope(endpoints, address)

        # Step 2: the owner, the paying team and the team context on this rung
        user_id = account_info.userId
        home = home_team(account_info)
        if pin.rung == 'team':
            owner_kind, owner_id, owner_user = 'team', deployment.team_id, ''
            billing_team = deployment.team_id
            context = TeamContext(deployment.team_id, 'key' if endpoints is not None else 'answering')
            perms = resolve_task_permissions(account_info, deployment.team_id)
            if not perms or (require and require not in perms):
                raise PermissionError(f'Permission {require or "task"!r} denied for this task')
        elif pin.rung == 'me':
            owner_kind, owner_id, owner_user = 'user', user_id, user_id
            billing_team = pin.billing_team_id
            context = TeamContext(home, 'key' if endpoints is not None else 'home')
            if not billing_team:
                raise ValueError('This deployment has no billing team; re-publish it')
        else:
            owner_kind, owner_id, owner_user = 'user', user_id, user_id
            billing_team = home
            context = TeamContext(home, 'key' if endpoints is not None else 'home')
            if not billing_team:
                raise PermissionError('Running a published pipeline needs a team; you are not a member of one')
        org = getattr(account_info, 'organization', None) or {}
        org_id = str(org.get('id') or deployment.org_id)
        key = control_key(pin.rung, owner_id, address)

        # Step 3: one start per index key; a concurrent request attaches
        async with self._engines.control_start_lock(key):
            existing = next((c for c in self._task_control.lookup(key) if c.live), None)
            if existing is not None:
                return self._check_engine_available(self._verify_control(existing, account_info, require)), False
            pipeline['source'] = source
            started = await start_server_task_as_team(
                self,
                pipeline,
                org_id=org_id,
                team_id=billing_team,
                deployment=deployment,
                deployment_epoch=state_epoch,
                trigger='submit',
                ttl=CONST_DEFAULT_TTL,
                owner_kind=owner_kind,
                owner_user_id=owner_user,
                rung=pin.rung,
                developer_id=parsed.developer_id,
                version=pin.version,
                team_context=context,
            )

        # Step 4: the started control, checked like any other hit
        return self._verify_control(self.control_by_key(started), account_info, require), True

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

    async def broadcast_task_event(
        self, event_type: EVENT_TYPE, key: str, event: Dict[str, Any], opener: Optional[int] = None
    ) -> None:
        """
        Broadcast a task-scoped event to all connections that are subscribed to the given task.

        Iterates over every active connection and calls send_task_event on each one.
        PermissionError is treated as a normal condition (a connection that does not
        hold task.monitor on the run) and silently skipped. All other exceptions are
        logged but do not abort the broadcast to remaining connections.

        OPENER FIRST (plan 7.5): when ``opener`` names the connection that opened
        the binding the event belongs to, it is delivered there before the
        subscription fan-out and skipped in it, so nothing arrives twice and an
        ``>SSE`` emitted before the SDK's subscribe round trip is not lost
        (``submit(on_sse=)`` relies on this).

        Args:
            event_type (EVENT_TYPE): Event type bitmask (e.g. SUMMARY, SSE) used by each
                connection's send_task_event to decide whether it should receive the event.
            key (str): The originating control's registry key. Each connection
                resolves it to its subscription key independently.
            event (Dict[str, Any]): Fully-formed DAP event payload to deliver.
                Expected keys: 'event' (str) and 'body' (Any).
            opener (int, optional): The connection that opened the event's
                binding: delivered first, directly, and skipped in the fan-out.
        """
        # If the task has already been removed from the registry (e.g.
        # cleanup raced with pending broadcasts), skip silently instead of
        # spamming "Your pipeline is not running" for every connection.
        if key not in self._task_control:
            return

        # Step 1: the opener, directly (its own permission checks still run
        # inside send_task_event; a connection that left is simply gone)
        opener_conn = self._connections.get(opener) if opener is not None else None
        if opener_conn is not None:
            try:
                await opener_conn.send_task_event(event_type, key=key, event=event, direct=True)
            except PermissionError:
                pass
            except Exception as e:
                self.debug_message(f'Failed to deliver event to its opener: {e}')

        # Step 2: everyone else, by subscription. Snapshot to list() so a
        # connection joining or dropping mid-broadcast does not raise
        # RuntimeError on the next iteration; matches broadcast_server_event.
        for conn in list(self._connections.values()):
            if conn is opener_conn:
                continue
            try:
                await conn.send_task_event(event_type, key=key, event=event)

            except PermissionError:
                # A normal outcome: the connection may not see this run
                continue

            except Exception as e:
                # Log individual monitor failures but continue broadcasting
                self.debug_message(f'Failed to broadcast event to connection: {e}')

    # ==== Holds ===================================================================

    @staticmethod
    def _shares_engine(control: TaskControl) -> bool:
        """True when another control also holds the engine ``control`` holds."""
        return control.task is not None and any(key != control.key for key in control.task.holds)

    def _unregister_control(self, control: TaskControl, *, keep_hold: bool = False) -> None:
        """
        Take a control out of the registry with its request trees; its subscriptions stay.

        The control's hold goes with it unless ``keep_hold`` is set, for a
        caller that releases it through ``release_hold`` (the rule that stops
        the engine when the last hold drops).

        Args:
            control: The control to unregister.
            keep_hold: Leave the hold to the caller.
        """
        # Out of the registry, unless a replacement already took the key
        if self._task_control.get(control.key) is control:
            self._task_control.pop(control.key, None)
            self._engine_unavailable.pop(control.key, None)
            self._forget_launch_owner(control)
            # Its request trees go with it (their records did)
            self.trace_owners.forget_control(control.key)

        # The control's one hold
        if not keep_hold and control.task is not None:
            control.task.release(control.key)

    async def _require_start_credit(self, control: TaskControl) -> None:
        """
        Refuse to start an owned run whose org may not spend (plan 0 S9).

        Args:
            control: The control about to launch.

        Raises:
            OutOfCreditsError: The account refused the spend.
        """
        from ai.account import account

        org_id = control.billing.org_id
        if not org_id:
            return
        refusal = await account.check_spend(org_id)
        if refusal:
            raise OutOfCreditsError(f'{refusal} ({control.address})')

    async def release_hold(self, engine: Optional[TaskEngine], control_key: str, reason: str) -> None:
        """
        Drop a control's hold on ``engine``: the ONE place the last hold stops an engine (plan 7.2).

        An engine nobody holds does not linger: when this was its last hold
        and it is live, it stops now. An engine already stopping, stopped or
        failed is left as it is. Every path that lets go of a hold (terminate,
        a restart's predecessor, a failed start) comes through here.

        Args:
            engine: The engine, or None.
            control_key: The releasing control's registry key.
            reason: Why the engine stops, when it does.
        """
        if engine is None:
            return
        if engine.release(control_key) == 0 and engine.is_live:
            await self._stop_engine_now(engine, reason)

    def _forget_control(self, control: TaskControl, *, keep_hold: bool = False) -> None:
        """
        Drop a control: out of the registry, its subscriptions gone, its hold released.

        Never stops the engine itself: a caller that may have to (the last
        hold) keeps the hold and releases it through ``release_hold``.

        Args:
            control: The control to drop.
            keep_hold: Leave the hold to the caller.
        """
        self._unregister_control(control, keep_hold=keep_hold)

        # Remove monitor subscriptions that reference this control from all
        # connections — keys are owner-scoped, so build from the control.
        # Matching is by ADDRESS EQUALITY: the run's own key, or a pipe-scoped
        # key whose prefix (everything before the last dot) IS that key —
        # never a prefix test, which a longer sibling source could satisfy.
        # The subscriptions stay while another control of the owner still
        # answers to the same key (another config of one project_id, plan
        # 3.4): they are its subscriptions too.
        project_key = owner_key(control.run_kind, control.owner_id, control.project_id, control.source)
        for sibling in self._task_control.for_owner(control.owner_id):
            if owner_key(sibling.run_kind, sibling.owner_id, sibling.project_id, sibling.source) == project_key:
                return
        for conn in self._connections.values():
            if hasattr(conn, '_monitors'):
                keys_to_remove = [k for k in conn._monitors if k == project_key or k.rsplit('.', 1)[0] == project_key]
                for monitor_key in keys_to_remove:
                    conn._monitors.pop(monitor_key, None)

    def _drop_engine(self, engine: TaskEngine) -> None:
        """Take ``engine`` out of the pool, unless a newer engine already holds its key."""
        self._engines.unregister(engine)

    async def _stop_engine_now(self, engine: TaskEngine, reason: str) -> None:
        """
        Stop an engine and take it out of the pool.

        Args:
            engine: The engine to stop.
            reason: Why ('user', 'ttl', 'ops', 'unpublished').
        """
        self._drop_engine(engine)
        await engine.stop_task(reason)

    async def remove_task(self, key: str, *, reason: str = 'user') -> TaskControl:
        """
        Remove a control from the registry and release its hold.

        When this was the engine's LAST hold the engine stops at once, with
        no linger (plan 7.2); an engine other controls hold keeps serving
        them. An engine that already stopped is left as it is.

        Args:
            key (str): The control's registry key
            reason (str): Why, when the engine stops ('user', 'ttl', 'unpublished', ...)

        Returns:
            TaskControl: The removed control, for caller cleanup

        Raises:
            TaskError: Code TASK_NOT_REGISTERED if the key names no live control
        """
        control = self._task_control.get(key)

        # If not there, it wasn't running
        if not control:
            raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

        engine = control.task

        # Subscriptions go first: a subscription a client installs for a
        # replacement run during the await below must survive. Then the hold,
        # through the one rule that stops the engine when it was the last
        self._forget_control(control, keep_hold=True)
        await self.release_hold(engine, control.key, reason)

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

    def engine_crashed(self, engine: TaskEngine) -> None:
        """
        An engine exited abnormally after it had confirmed running.

        Called by the engine from its teardown, in the same step that marks it
        dormant (``dormant_reason == 'crash'``). It leaves the pool like an
        engine stopped on its inactivity timer; its holders stay, dormant, and
        the next request through any of them starts it again under the same
        key (plan 7.2). An engine that never confirmed running does not come
        here: its holders see the failure as before. A LISTENER engine (one
        with a ttl-0 holder) gets no requests, so it is restarted
        automatically with backoff (``_schedule_listener_restart``);
        request/response engines are never restarted without a request.

        Args:
            engine: The crashed engine.
        """
        # Step 1: out of the pool, so the next start under the key builds anew
        self._drop_engine(engine)

        # Step 2: say what happened and who it leaves dormant
        status = engine.get_status()
        self.debug_message(
            f'Engine "{engine.engine_key}" crashed after it confirmed running '
            f'(exit code {status.exitCode}: {status.exitMessage or "no message"}); '
            f'{len(engine.holds)} holder(s) restart it on their next request'
        )

        # Step 3: a listener engine (a ttl-0 holder) receives no requests, so
        # it is restarted here; a request/response engine waits for a request
        if engine.holds and not engine.ages:
            self._schedule_listener_restart(engine)

    # ==== Listener auto-restart ==================================================

    def _listener_restart_delay(self, key: str, now: Optional[float] = None) -> Optional[float]:
        """
        Claim the next automatic restart of engine ``key``: its backoff, or None at the cap.

        Exponential backoff (plan 7.2): ``CONST_ENGINE_RESTART_BACKOFF``
        seconds before the first restart in a rolling hour, doubling with each
        further one, and at most ``CONST_ENGINE_RESTART_MAX_PER_HOUR``
        restarts per engine key per rolling hour. A claimed attempt counts
        whether or not the restart succeeds.

        Args:
            key: The engine key.
            now: Monotonic time of the claim (default: now).

        Returns:
            Seconds to wait before restarting, or None when the hour's cap is spent.
        """
        # Step 1: the attempts of the last hour
        now = time.monotonic() if now is None else now
        recent = self._engine_restarts.setdefault(key, deque())
        while recent and recent[0] <= now - 3600:
            recent.popleft()

        # Step 2: the cap, else the next doubling of the backoff
        if len(recent) >= CONST_ENGINE_RESTART_MAX_PER_HOUR:
            return None
        delay = CONST_ENGINE_RESTART_BACKOFF * (2 ** len(recent))
        recent.append(now)
        return delay

    def _schedule_listener_restart(self, engine: TaskEngine) -> None:
        """
        Schedule the automatic restart of a crashed listener engine, or leave it dormant at the cap.

        At the cap the engine stays stopped: its holders stay dormant and are
        listed ``stopped``, and their next request (if any) still restarts it.

        Args:
            engine: The crashed engine (still held by its dormant controls).
        """
        delay = self._listener_restart_delay(engine.engine_key)
        if delay is None:
            # TODO(C.9): route this to the OPS stream and the owner's run log
            message = (
                f'Engine "{engine.engine_key}" crashed again: {CONST_ENGINE_RESTART_MAX_PER_HOUR} automatic '
                'restarts in the last hour, leaving it stopped'
            )
            warning(message)
            self.debug_message(message)
            return
        self.debug_message(f'Engine "{engine.engine_key}" is a listener; restarting it in {delay:g}s')
        task = asyncio.ensure_future(self._restart_listener(engine, delay))
        self._restart_tasks.add(task)
        task.add_done_callback(self._restart_tasks.discard)

    async def _restart_listener(self, engine: TaskEngine, delay: float) -> None:
        """
        After ``delay``, start a crashed listener engine again for its dormant holders.

        Every holder still dormant on ``engine`` goes through ``ensure_engine``:
        the first starts the engine under the same key through the start gate,
        the rest attach to it. Nothing happens when the holders went or a
        request already restarted it, or when no ttl-0 holder is left. A
        restart that fails claims the next backoff (within the cap).

        Args:
            engine: The crashed engine.
            delay: Seconds to wait first.
        """
        # Step 1: the backoff
        await asyncio.sleep(delay)

        # Step 2: the holders still dormant on this engine
        holders = [
            control
            for key in sorted(engine.holds)
            if (control := self._task_control.get(key)) is not None and control.task is engine and control.dormant
        ]
        if not holders or engine.ages:
            return

        # Step 3: one start, every holder moved onto it
        try:
            for control in holders:
                await self.ensure_engine(control)
        except Exception as e:
            self.debug_message(f'Automatic restart of engine "{engine.engine_key}" failed: {e}')
            self._schedule_listener_restart(engine)

    async def stop_engine(self, key: str, reason: str = 'ops') -> None:
        """
        Stop an engine outright, whoever holds it (the operator's stop, plan 7.2).

        Every holder's control is told ``TASK_ENGINE_UNAVAILABLE`` on its next
        request and is then dropped, so the call after that re-resolves.
        Callers authorize first: this is ``sys.admin``/``internal`` only.

        Args:
            key: The engine key.
            reason: Why, as the holders will be told.

        Raises:
            TaskError: TASK_NOT_REGISTERED when no engine has that key.
        """
        engine = self._engines.get(key)
        if engine is None:
            raise TaskError(TaskError.NOT_REGISTERED, f'No engine {key!r} is running', engineKey=key)
        engine.unavailable_reason = reason
        for control_key_value in engine.holds:
            self._engine_unavailable[control_key_value] = (key, reason)
        await self._stop_engine_now(engine, reason)
        self.debug_message(f'Engine "{key}" stopped by an operator ({len(engine.holds)} holders told)')

    def next_engine_id(self) -> int:
        """
        The next engine launch's id: monotonic per server process, from 1.

        Minted at EVERY engine start, a dormant restart included, so a restart
        under the same key is a new id and a stale traceId can never name a pipe
        of the new launch. It is the middle segment of every wire traceId
        (``{nodeId}.{engineId}.{traceId}``, plan 7.4). Server state, never module
        state (ALB seam 2).

        Returns:
            int: The launch's engine id.
        """
        return next(self._engine_ids)

    @property
    def node_id(self) -> int:
        """This server's node id (plan 7.4): the first segment of every wire traceId, taken once at startup."""
        return self._node_id

    def _note_launch_owner(self, control: TaskControl, conn: Any) -> None:
        """Record that ``conn`` launched ``control`` (auto-terminated when it disconnects)."""
        if control.launch_owner is not None and control.launch_owner is not conn:
            self._launched.get(id(control.launch_owner), set()).discard(control.key)
        control.launch_owner = conn
        if conn is not None:
            self._launched.setdefault(id(conn), set()).add(control.key)

    def _forget_launch_owner(self, control: TaskControl) -> None:
        """Drop ``control`` from the launch index."""
        owner = control.launch_owner
        if owner is None:
            return
        keys = self._launched.get(id(owner))
        if keys is not None:
            keys.discard(control.key)
            if not keys:
                self._launched.pop(id(owner), None)

    def _revoked_after(self, deployment: Optional[DeploymentRef], epoch: float) -> bool:
        """
        Whether ``deployment`` was disabled or removed after ``epoch``.

        Args:
            deployment: The deployment a control resolved through, or None (never revoked).
            epoch: Monotonic time its state was last known good.

        Returns:
            True when the kill switch landed after ``epoch``.
        """
        if deployment is None:
            return False
        revoked = self._deployment_revoked.get(deployment)
        return revoked is not None and revoked > epoch

    def _refuse_if_revoked(self, control: TaskControl, state_epoch: float) -> None:
        """
        Refuse to register a control through a deployment revoked since ``state_epoch``.

        Args:
            control: The control about to be registered.
            state_epoch: When its deployment's state was last read as enabled.

        Raises:
            TaskError: TASK_ENGINE_UNAVAILABLE with ``reason='unpublished'``.
        """
        if not self._revoked_after(control.deployment, state_epoch):
            return
        raise TaskError(
            TaskError.ENGINE_UNAVAILABLE,
            f'The deployment serving {control.address!r} was disabled or removed while it started',
            address=control.address,
            engineKey='',
            reason='unpublished',
        )

    async def release_deployment_holds(self, deployment: DeploymentRef) -> int:
        """
        Release every hold whose control resolved through ``deployment``.

        The publisher's kill switch (disable/remove, plan 7.2): each such
        control is removed, and an engine stops when no hold remains on it.
        Holds of controls that did not resolve through the deployment (the
        owner's own @spec run of identical content) keep their engine.

        Args:
            deployment: The deployment that was disabled or removed.

        Returns:
            The number of holds released.
        """
        # Step 1: stamp the revocation FIRST. A control registered through this
        # deployment after this moment (its artifact was loading, its engine
        # starting), or one whose release below fails, is refused on its next
        # request by _check_engine_available: the kill switch does not depend
        # on this pass reaching every control.
        self._deployment_revoked[deployment] = time.monotonic()

        # Step 2: release every hold (by the deployment index, never a walk);
        # one failure never stops the others
        released = 0
        failures: List[str] = []
        for control in self._task_control.for_deployment(deployment):
            try:
                await self.remove_task(control.key, reason='unpublished')
                released += 1
            except Exception as exc:  # noqa: BLE001 - every remaining control is still released
                failures.append(f'{control.key}: {exc!r}')
        if released:
            self.debug_message(
                f'Released {released} hold(s) of {deployment.team_id}/{deployment.project_id} (unpublished)'
            )
        if failures:
            raise RuntimeError(
                f'{len(failures)} hold(s) of {deployment.team_id}/{deployment.project_id} could not be released '
                f'(their next request is refused): ' + '; '.join(failures)
            )
        return released

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
        deployment: Optional[DeploymentRef] = None,
        rung: str = '',
        version: Optional[int] = None,
        team_context: Optional[TeamContext] = None,
        deployment_epoch: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Resolve a spec to a control and acquire its hold on an engine, starting one if needed.

        A SPEC call (plan 3.3, 3.4): the caller's control with the same
        ``(rung, project_id, hash(resolved config))`` is reused (with
        ``useExisting``, their live control of that ``project_id`` whatever
        its configuration); otherwise one is created and holds the engine
        for the spec's shape, started when none is live. A spec whose config differs under the same
        ``project_id`` is simply another control on the same engine; nothing
        is moved between engines and nothing is refused.

        This method handles the complete task creation process including validation,
        registry management, resource allocation, and startup coordination. It
        supports both interactive debugging and batch execution modes.

        Args:
            request (Dict[str, Any]): Task creation request containing:
                - arguments: Task configuration including the pipeline, which
                  must carry its ``project_id``; an optional ``token`` overrides
                  that id and is not a credential
                - command: Launch type (launch/execute) determining task behavior
            conn (TaskConn, optional): Connection to associate with task for monitoring
            env_source: Loads the values for ${...} placeholders at each (re)start (see Task)
            developer_id: The owner org's developer id — the address namespace.
                Required: the address exists from the first run.
            deployment: The deployment a deployment run resolved through
                (trusted dispatch only); its disable/remove releases the hold.
            rung: The published rung a ``submit(name)`` start answered on
                (trusted dispatch only): ``'me'``, ``'team'`` or ``'public'``.
                Empty derives it from ``run_kind``/``owner_kind``. A
                ``@public`` control is a user-owned deployment run that only
                this stamp tells apart from ``@me``.
            version: The artifact version a published rung started from.
            team_context: The team whose environment the control runs with
                (plan 6.2). Default: ``team_id`` as the home team of a dev
                run, the deploying team of a deployment run.
            deployment_epoch: Monotonic time the trusted dispatch READ the
                deployment's state, before it loaded the artifact. A
                disable/remove after that moment refuses the control instead
                of registering it (plan 7.2): the window between the state
                read and the registration is closed. Default: now.

        Returns:
            Dict[str, Any]: The task's identity; ``token`` carries the CONTROL
                ID for every verb after this, ``address`` the
                ``developerId.pipelineId.source`` beside it, ``converged``
                ``'started'`` when this call created the control and
                ``'none'`` when an existing one answered

        Raises:
            TaskError: TASK_INVALID_ARGUMENT when the spec has no
                ``project_id`` (``field='project_id'``), or when an identity,
                the project id (or the ``token`` override of it), the source
                or a component id breaks the address grammar, or when a dev
                launch does not name the authenticated user
            ValueError: If launch type is invalid, or a deployment run is
                already live under its index key
            RuntimeError: If the pipeline is missing, empty or not an object
            Exception: If task creation or startup fails

        Task Creation Process:
        1. Parse and validate request parameters and identities
        2. Validate the pipeline and derive the address, the rung and the
           configuration identity (the resolved config by stack index)
        3. Reuse the caller's control of that identity when it is live
        4. Compute the engine key from the spec's shape (plan 7.2)
        5. Under the engine key's start lock: attach to the live engine of
           that key, or create and start one
        6. Register the control, minted with its id, holding the engine
        7. Return the control id for client use

        Launch Types:
        - LAUNCH: the control is destroyed when the launching connection closes
        - EXECUTE: the control lives on its own idle ttl
        """
        # The conversion from the old node-config format, once the submitted
        # pipeline has been through it (plan 5.6.8); the result stamps carry
        # the converted text so the caller can make its file current
        conversion: Dict[str, ConvertResult] = {}

        def _return_results(control: TaskControl, reused: bool = False) -> Dict[str, Any]:
            """
            Return the task's identity, the control id in the token slot (plan 3.1 stamps).

            Args:
                control (TaskControl): The control that answered.
                reused (bool): True when an existing control of the same
                    identity answered rather than one created by this call;
                    ``converged`` says the same in the plan's words.
            """
            result = {
                'id': control.id,
                'token': control.control_id,
                'address': control.address,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
                'reused': reused,
                'converged': 'none' if reused else 'started',
                'engineKey': control.task.engine_key if control.task is not None else '',
            }
            converted = conversion.get('result')
            if converted is not None and converted.touched:
                result['converted'] = converted.pipeline
                result['conversion'] = list(converted.warnings)
            return result

        # Initialize task control structure for new task
        control = TaskControl()

        # For launch/exec token is in args. An explicit "arguments": null is a
        # request with no pipeline, refused by the guard below.
        args = request.get('arguments') or {}
        # useExisting: attach to the caller's live @spec control of this
        # project_id whatever its configuration (the running spec is kept)
        use_existing = bool(args.get('useExisting', False))

        # Extract TTL from args (use server-configured default if not provided)
        ttl = args.get('ttl', CONST_DEFAULT_TTL)

        # The token argument overrides the pipeline-id segment of the address
        # (the spec's project_id). It is an identity choice inside the
        # caller's own namespace, never a credential: it is validated with the
        # same segment grammar as project_id, and the developer id, the owner
        # and the registry key are still derived by the server.
        token_override = args.get('token')
        if token_override is not None:
            validate_segment(token_override, 'token')

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
                developer_id_required('Running a pipeline'),
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

        # Apply the token override as the spec's project_id. The pipeline is
        # copied so the caller's object is not rewritten, and the control
        # records the spec it actually runs (its identity hashes it).
        if token_override is not None:
            control.pipeline = {**control.pipeline, 'project_id': token_override}

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
        # dot-free id. It is REQUIRED (plan 2.2, section 1): the control's
        # identity hangs off it, so nothing is minted in its place.
        control.project_id = control.pipeline.get('project_id', None)
        if not control.project_id:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                'The pipeline has no project_id; a spec names the pipeline it belongs to',
                field='project_id',
            )

        # The address grammar, enforced at execute: project id, source and
        # every component id are single dot-free segments. Then old-format node
        # config is converted (plan 5.6.8); the converted pipeline is what runs.
        validate_component_ids(control.pipeline)
        conversion['result'] = _require_converted(control.pipeline)
        control.pipeline = conversion['result'].pipeline
        _require_valid_parameters(control.pipeline)
        _require_valid_placeholders(control.pipeline)
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

        # The rung and the handle. The owner FIELD (user for spec and @me,
        # team for @team) rides owner_id, and the rung separates a user's
        # spec run from their @me deploy of the same pipeline — the only pair
        # that shares an owner. A published rung stamped by the trusted
        # dispatch must fit the run: @me and @public are user-owned
        # deployment runs, @team a team-owned one. The control id is minted
        # here and is the registry key; it leaves with the result only when
        # this call creates the control (plan section 1)
        derived = rung_of(control.run_kind, control.owner_kind)
        if rung and (rung not in RUNGS or derived != ('me' if rung == 'public' else rung) or derived == 'spec'):
            raise ValueError(f'rung {rung!r} does not fit a {control.owner_kind}-owned {control.run_kind} run')
        control.rung = rung or derived
        control.control_id = control.key = mint_control_id()

        # Caller-side settings: they belong to the control and never enter
        # the engine key
        control.trigger = trigger
        control.ttl = CONST_DEFAULT_TTL if ttl is None else int(ttl)
        control.trace_level = args.get('pipelineTraceLevel')
        control.setup_declared_parameters()
        control.deployment = deployment
        control.version = version
        control.team_context = team_context or TeamContext(
            control.teamId, 'home' if control.run_kind == 'dev' else 'deploying'
        )
        # The values this control's bindings run with, from its team context
        # (plan 6.2): resolved once here, carried on every frame's _caller
        control.env = await self._resolve_control_env(control)
        # Credit, before anything launches (plan 0 S9): a dev run's paying
        # unit is its control's org; a published rung's callers are checked
        # per request by the data path
        if control.run_kind == 'dev':
            await self._require_start_credit(control)

        # Parse and validate launch type from request command
        try:
            command = request.get('command', 'launch')
            control.launch_type = LAUNCH_TYPE(command)
        except (ValueError, TypeError):
            raise ValueError(f'Invalid launch type: "{command}"')

        # The spec's two identities (plan 7.2, section 1): the engine key
        # from its SHAPE, the control's configuration from its resolved
        # config by stack index. An unkeyable spec is engine_start_failed.
        key, threads, content = self._engine_shape(control, args)
        # What the open carries is the config as the spec stores it (the
        # engine resolves it); what identifies the control is the resolved
        # view (a spelled-out default is not another control)
        control.config = [dict(entry) for entry in content.stored_by_index]
        control.config_hash = config_hash(content.config_by_index)

        # The config the open will carry is built once here: an env value that
        # does not fit the typed leaf its placeholder sits on is refused at the
        # door, naming the leaf, never first by the engine
        try:
            control.caller_config()
        except CallerConfigError as exc:
            raise TaskError(TaskError.INVALID_ARGUMENT, f'The pipeline cannot start: {exc}', field=exc.path) from exc

        # The hosted policy (nosaas nodes, the stdio MCP transport) holds for
        # EVERY control before it holds an engine, a warm one included: an
        # engine's own start checked the config of its first control only
        refusal = hosted_refusal(resolve_pipeline_env(control.pipeline, control.env))
        if refusal:
            raise ValueError(refusal)

        def _same_spec(existing: TaskControl) -> bool:
            """Whether ``existing`` runs this call's spec: its configuration on the engine of this shape."""
            return existing.config_hash == control.config_hash and existing.task.engine_key == key

        # The caller's controls under the same index key (rung, owner,
        # address): on @spec the one with the same configuration ON THE
        # ENGINE OF THIS SHAPE is REUSED (plan 3.4); a finished one is
        # replaced; a stopping one and a restart's predecessor are passed
        # over; a different configuration, or the same configs rewired
        # (another engine), is left alone, another control. A deployment run
        # is one per index key: the pin path attaches before it starts
        for existing_control in self._task_control.lookup(control.index_key):
            engine = existing_control.task
            if existing_control.restarting:
                # Its successor is being set up: the restart decides its fate
                continue
            if engine.state is EngineState.STOPPING and not existing_control.dormant:
                # Its engine is in teardown: it takes no new hold, and a reused
                # control would hand out an id the teardown is about to retire.
                # It stays registered meanwhile: the terminal events and the
                # run-log close are delivered through it, and the stop that
                # began the teardown removes it once they are
                continue
            if engine.is_task_complete() and not existing_control.dormant:
                # Its engine is done: replaced. Its subscriptions stay: they
                # are the replacement's too
                self._unregister_control(existing_control)
                self.debug_message(f'Replaced finished task "{control.id}"...')
                continue
            if control.rung != 'spec':
                raise ValueError(f'Pipeline is already running (task {existing_control.id}); stop it and run again.')
            if not use_existing and not _same_spec(existing_control):
                continue
            # The same identity, or useExisting on the caller's live control
            # of this project_id: a dormant control's engine starts again
            # under its key, and the caller gets the control it already has.
            # The submitted pipeline is not applied to a running control: say
            # so when it differs, so an edit-and-rerun loop never silently
            # measures the old configuration (restart applies it)
            if not _same_spec(existing_control):
                self.debug_message(
                    f'Task "{existing_control.id}" is already running: reusing it (useExisting) and ignoring the '
                    'submitted pipeline, which differs from the running one. Restart the task to apply it.'
                )
            await self.ensure_engine(existing_control)
            if wait_for_running:
                await existing_control.task.wait_for_running()
            return _return_results(existing_control, reused=True)

        # The moment the deployment's state is known good: the dispatch's read,
        # or now for a run that resolved no deployment
        state_epoch = time.monotonic() if deployment_epoch is None else float(deployment_epoch)
        reused: Optional[TaskControl] = None

        def _register(engine: TaskEngine) -> None:
            nonlocal reused
            # A twin registered while this call waited in the gate (two
            # identical launches passed the lookup above together): the
            # caller gets that control and takes no hold of its own. A
            # deployment run reads as already running, as above
            for twin in self._task_control.lookup(control.index_key):
                if twin.restarting:
                    continue
                if twin.task is engine and twin.live and (use_existing or _same_spec(twin)):
                    if control.rung != 'spec':
                        raise ValueError(f'Pipeline is already running (task {twin.id}); stop it and run again.')
                    reused = twin
                    return
            # A deployment disabled or removed while the artifact loaded or the
            # engine started never gets a registered control (plan 7.2)
            self._refuse_if_revoked(control, state_epoch)
            # Hold it, register the control and schedule its idle expiry
            engine.acquire(control.key, control.ttl)
            control.task = engine
            control.registered_at = state_epoch
            self._task_control[control.key] = control
            control.touch()
            self._schedule_control(control)
            # Index the control under its launching connection for the
            # disconnect cleanup - AFTER a completed predecessor of the same
            # key was unregistered above, whose _forget_launch_owner would
            # otherwise drop this very key from the connection's index
            if control.launch_type == LAUNCH_TYPE.LAUNCH:
                self._note_launch_owner(control, conn)

        # Attach to the live engine of the key, or start one (the start gate)
        try:
            await self._acquire_engine(
                key,
                lambda: self._new_engine(
                    control,
                    key=key,
                    shared=False,
                    threads=threads,
                    launch_args=args,
                    env=env or {},
                    env_source=env_source,
                ),
                _register,
            )

            # The gate answered with a twin: the caller's control already runs
            if reused is not None:
                if wait_for_running:
                    await reused.task.wait_for_running()
                return _return_results(reused, reused=True)

            self._debug_task_started(control, trigger, control.ttl)

            # Retrieve the task instance for status monitoring
            if wait_for_running:
                # Block until the engine confirms running; an engine that never
                # does (no event for CONST_MAX_READY_TIME) is engine_start_failed
                try:
                    await control.task.wait_for_running()
                except TimeoutError as exc:
                    raise TaskError(
                        TaskError.ENGINE_START_FAILED,
                        f'The engine {control.task.engine_key!r} did not confirm running: {exc}',
                        address=control.address,
                        engineKey=control.task.engine_key,
                    ) from exc

            # Return formatted results: this call created the control
            return _return_results(control)

        except Exception:
            # Distinguish a genuine creation failure from a user-requested
            # stop that raced with startup / wait_for_running.  When the user
            # terminates before the task reaches RUNNING, the exception
            # propagates here but the task was NOT a creation failure.
            engine = control.task
            if engine is not None:
                self._unregister_control(control, keep_hold=True)
                if not engine.is_live:
                    self.debug_message(f'Task stopped during startup: {control.id}...')
                else:
                    self.debug_message(f'Task creation failed, cleaned up: {control.id}...')
                # The hold rule: an orphan nobody holds stops, an engine other
                # controls hold is theirs and keeps running
                await self.release_hold(engine, control.key, 'user')
            raise

    # ==== Spec calls: the two identities ========================================

    @staticmethod
    def _engine_shape(control: TaskControl, launch_args: Dict[str, Any]) -> Tuple[str, int, EngineContent]:
        """
        The engine key, thread count and resolved content of ``control``'s spec (plan 7.2).

        The key is the spec's SHAPE qualified by the control's owner on every
        rung in this PR (C.25 leaves the published rungs bare); the resolved
        config by stack index is the control's own identity and what its open
        carries. Threads come from policy outside @spec; a @spec call may set
        them (the starter's value holds for the engine's life).

        Args:
            control: The control (its pipeline, source, rung and owner are set).
            launch_args: The launch arguments (``threads``).

        Returns:
            ``(engine key, threads, content)``.

        Raises:
            TaskError: TASK_ENGINE_START_FAILED when the spec cannot be keyed.
        """
        try:
            # Parameter tokens are decoded here when the deployment secret is
            # set: the config rides the open as plain values, like the task
            # file carried them until now
            spec = resolve_parameter_tokens(copy.deepcopy(control.pipeline))
            content = engine_content(spec, control.source, component_facts)
        except Exception as exc:
            # An unknown node or a config outside its schema: the spec cannot
            # be keyed, so it is refused here instead of starting over its raw
            # config (audit 2026-11-12)
            raise TaskError(
                TaskError.ENGINE_START_FAILED,
                f'The pipeline cannot start: {exc}',
                address=control.address,
                engineKey='',
            ) from exc
        threads = CONST_DEFAULT_MAX_THREADS
        if control.rung == 'spec':
            requested_threads = launch_args.get('threads')
            if requested_threads is not None:
                threads = requested_threads
        return content.key(rung=control.rung, owner_id=control.owner_id), threads, content

    def _new_engine(
        self,
        control: TaskControl,
        *,
        key: str,
        shared: bool,
        threads: int,
        launch_args: Dict[str, Any],
        env: Optional[Dict[str, str]],
        env_source: Optional[Callable[[], Awaitable[Dict[str, str]]]],
    ) -> TaskEngine:
        """
        Build (not start) an engine for ``key`` on behalf of ``control``.

        A cross-user engine names no user (S13), anchors no storage, carries
        no caller's env (it holds the placeholders; env rides per call) and
        traces nothing by default; a private engine is its owner's. Every
        engine of this PR is private (owner-qualified on every rung).

        Args:
            control: The control the engine is started for.
            key: The engine key (plan 7.2).
            shared: True for a cross-user engine (never, before C.25).
            threads: The engine's thread count.
            launch_args: The launch arguments (``name``, ``args``).
            env: Fixed values for ${...} placeholders (private engines).
            env_source: Loads those values at each start (private engines).

        Returns:
            The new, not yet started engine.
        """
        return TaskEngine(
            server=self,
            id=control.id,
            project_id=control.project_id,
            source=control.source,
            engine_key=key,
            address=control.address,
            pipeline=control.pipeline,
            launch_args=launch_args,
            launch_type=control.launch_type,
            provider=control.provider,
            shared=shared,
            threads=threads,
            trace_level='none' if shared else control.trace_level,
            client_id='' if shared else control.client_id,
            team_id=control.teamId,
            org_id=control.orgId,
            env=env,
            env_source=env_source,
            run_kind=control.run_kind,
            owner_kind=control.owner_kind,
            trigger=control.trigger,
        )

    async def _acquire_engine(
        self,
        key: str,
        build: Callable[[], TaskEngine],
        hold: Callable[[TaskEngine], None],
    ) -> TaskEngine:
        """
        The start gate: attach to the live engine of ``key``, or start one.

        Concurrent callers of one key serialize on the key's lock: the first
        builds and starts the engine, the rest attach to it. A finished or
        stopping engine takes no new holds. ``start_task`` (a new control) and
        ``ensure_engine`` (a dormant control's next request) both come here,
        so a restart and a fresh start of the same key are one start.

        Args:
            key: The engine key.
            build: Builds the engine when none is live.
            hold: Takes the caller's hold on the engine (under the lock).

        Returns:
            The engine the hold is on.
        """
        # Step 1: one gate per key, removed when its last user leaves
        async with self._engines.start_lock(key):
            # Step 2: the live engine of the key, if any
            engine = self._engines.get(key)
            if engine is not None and not engine.accepting_holds:
                engine = None

            # Step 3: hold it, building one when none is live
            started = engine is None
            if started:
                engine = build()
            hold(engine)

            # Step 4: start the engine this caller built; a failed start
            # leaves the pool before the next waiter looks
            if started:
                self._engines.register(key, engine)
                self._schedule_engine(engine)
                try:
                    await engine.start_task()
                except Exception:
                    self._drop_engine(engine)
                    raise
            return engine

    async def ensure_engine(self, control: TaskControl) -> Optional[TaskEngine]:
        """
        The engine a request through ``control`` runs on, started again if dormant.

        A control entitles its caller to an engine but does not keep it
        running (plan 7.2): an engine that stopped on its inactivity timer, or
        crashed after it had confirmed running, is started again under the
        SAME key through the start gate, and the control holds the new one.
        Identity, holds, deployment and ttl are the control's and do not
        change. Concurrent requests (through this or any
        other holder of the stopped engine) attach to the one new engine.
        Startup is paid once; there is no error and no re-resolve.

        An engine that is running, or that stopped for any other reason (an
        operator's stop, a terminate, a natural completion, a failure before
        it confirmed running), is returned as it is.

        Args:
            control: The resolved control.

        Returns:
            The engine to send the request to.
        """
        # Step 1: anything but a dormant control is used as it is
        stopped = control.task
        if stopped is None or not control.dormant:
            return stopped

        def _hold(engine: TaskEngine) -> None:
            # A concurrent request through this control may have moved it
            if control.task is engine:
                return
            control.task.release(control.key)
            engine.acquire(control.key, control.ttl)
            control.task = engine

        # Step 2: the same key, the same engine shape, through the start gate.
        # The engine shape (key, sharing, threads, launch args, env source) is
        # the stopped engine's; the identity is the requesting control's.
        # While the request waits in the gate the control reads 'starting'.
        self.debug_message(
            f'Task "{control.id}" request on a stopped engine ({stopped.dormant_reason}), '
            f'starting "{stopped.engine_key}" again'
        )
        control.engine_starting = True
        try:
            return await self._acquire_engine(
                stopped.engine_key,
                lambda: self._new_engine(
                    control,
                    key=stopped.engine_key,
                    shared=stopped.shared,
                    threads=stopped._threads,
                    launch_args=stopped._launch_args or {},
                    env=None,
                    env_source=None if stopped.shared else stopped._env_source,
                ),
                _hold,
            )

        except Exception:
            # Step 3: a failed start leaves the control dormant on the stopped
            # engine, so the next request tries again
            failed = control.task
            if failed is not stopped:
                stopped.acquire(control.key, control.ttl)
                control.task = stopped
                await self.release_hold(failed, control.key, 'restart failed')
            raise

        finally:
            # Step 4: the gate is behind this request either way
            control.engine_starting = False

    async def restart_task(
        self,
        request: Dict[str, Any],
        conn: TaskConn = None,
        wait_for_running=False,
    ) -> Dict[str, Any]:
        """
        Restart a control on a new pipeline: terminate the control, create its successor (plan 7.3).

        There is ONE restart path, the IDE's Play on an existing run. The
        successor is created FIRST, holding the engine for the new spec's
        shape (the same engine when the shape is unchanged, one started when
        none is live), and only then is the predecessor's hold released
        through the hold rule: an engine the successor holds never stops and
        starts again, an engine nobody holds stops at once. The successor is
        a new control with a new id; its ttl, trace level and launching
        connection follow the request, its identity (owner, rung, address,
        deployment, team context) the predecessor. The monitor subscriptions
        keyed by the project stay: the successor answers to the same key.

        Args:
            request: DAP request (``token`` = the control id, ``pipeline``).
            conn: The requesting connection (its account resolves the control).
            wait_for_running: Wait until the engine confirmed running.

        Returns:
            ``{id, token (the new control id), address, projectId, source,
            provider, engineKey, converged}``: ``converged`` is ``'started'``
            when the successor holds another engine than the predecessor did,
            ``'none'`` when the engine stayed.

        Raises:
            ValueError: A missing control id or pipeline, or a source change.
            PermissionError: The control is not the caller's.
            TaskError: The spec cannot be keyed (engine_start_failed), or it
                has no ``project_id``.
        """
        try:
            args = request.get('arguments', {})

            control_id = args.get('token', None)
            if not control_id:
                raise ValueError('The control id is required for restart')

            pipeline = args.get('pipeline', None)
            if not pipeline:
                raise ValueError('Missing pipeline configuration in restart request')

            # Step 1: the control by its id, re-checked against the caller with
            # task.control (run-scoped: a user-owned run restarts only for its owner)
            account_info = getattr(conn, '_account_info', None) if conn else None
            control = self.control_by_id(control_id, account_info, 'task.control')
            self.debug_message(f'Restart requested for task "{control.id}"')

            # The source is part of the task's identity: checked on the REQUEST,
            # before normalisation stamps the control's source onto it
            requested_source = pipeline.get('source')
            if requested_source and requested_source != control.source:
                raise ValueError(
                    f"The source is part of the task's identity and cannot change on a restart "
                    f'({control.source!r} -> {requested_source!r})'
                )

            # Step 2: the conversion and the address grammar hold on restart
            # too: a restarted pipeline must not smuggle in a dotted component id
            validate_component_ids(pipeline)
            restart_conversion = _require_converted(pipeline)
            pipeline = restart_conversion.pipeline
            _require_valid_parameters(pipeline)
            _require_valid_placeholders(pipeline)
            pipeline = _apply_source_defaults(pipeline, control.source)
            if pipeline.get('project_id') != control.project_id:
                raise ValueError(
                    f"The project_id is part of the task's identity and cannot change on a restart "
                    f'({control.project_id!r} -> {pipeline.get("project_id")!r})'
                )

            # Step 3: the predecessor is marked restarting and STAYS
            # registered, keeping its hold: the successor's resolution never
            # answers with it, the engine it holds survives until the
            # successor holds its own, and an event its engine emits
            # meanwhile still finds it (broadcast_task_event delivers only to
            # a registered control), as does a request naming its id
            old_engine = control.task
            control.restarting = True
            successor = {
                'command': control.launch_type.value,
                'arguments': {
                    # Never useExisting: the successor is created, not attached
                    # to another live control of the project
                    **{key: value for key, value in args.items() if key not in ('token', 'useExisting')},
                    'pipeline': pipeline,
                    'source': control.source,
                    'ttl': args.get('ttl', control.ttl),
                    'pipelineTraceLevel': args.get('pipelineTraceLevel', control.trace_level),
                },
            }
            try:
                result = await self.start_task(
                    successor,
                    conn,
                    wait_for_running=wait_for_running,
                    client_id=control.client_id,
                    user_id=control.userId,
                    team_id=control.teamId,
                    org_id=control.orgId,
                    env_source=None if old_engine is None or old_engine.shared else old_engine._env_source,
                    run_kind=control.run_kind,
                    owner_kind=control.owner_kind,
                    trigger=control.trigger,
                    developer_id=control.developer_id,
                    deployment=control.deployment,
                    rung='' if control.rung == 'spec' else control.rung,
                    version=control.version,
                    team_context=control.team_context,
                    # The predecessor's state epoch carries over: a deployment
                    # revoked since it registered refuses the successor too
                    deployment_epoch=control.registered_at,
                )
            except Exception:
                # Step 3b: a predecessor whose deployment was revoked meanwhile
                # is not kept: it goes the way the kill switch takes every hold
                if self._revoked_after(control.deployment, control.registered_at):
                    held = control.task
                    self._unregister_control(control, keep_hold=True)
                    await self.release_hold(held, control.key, 'unpublished')
                    raise
                # Otherwise it is as it was: it never left the registry, its
                # hold was never released, its request trees never forgotten,
                # its subscriptions never touched
                control.restarting = False
                raise

            # Step 4: the successor is committed: the predecessor leaves the
            # registry with its request trees, and its hold goes through the
            # hold rule (the engine stops only when that was its last hold).
            # The hold released is the one the predecessor holds NOW: a request
            # naming its id while the successor was set up may have restarted
            # a dormant engine and moved the hold onto the replacement
            # (ensure_engine), so old_engine is kept for the convergence
            # comparison only
            held = control.task
            self._unregister_control(control, keep_hold=True)
            await self.release_hold(held, control.key, 'restart')
            new_control = self.control_by_key(result['token'])
            converged = 'none' if new_control.task is old_engine else 'started'
            self.debug_message(f'Task "{control.id}" restarted as {new_control.control_id}: {converged}')
            result['converged'] = converged
            return result

        except Exception as e:
            self.debug_message(f'Failed to restart task: {str(e)}')
            raise

    async def stop_task(self, key: str, reason: str = 'user'):
        """
        Terminate a control: release its hold, stopping the engine if it was the last.

        ``terminate`` is a release (plan 7.2): an engine other controls hold
        keeps serving them and only this control goes. When this was the last
        hold the engine stops at once: there is no linger. A dormant control
        (its engine already stopped on its inactivity timer) just goes.

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
                engine = control.task

                # Other controls hold the engine (it keeps serving them), or
                # the engine already stopped: the control goes, that is all
                if self._shares_engine(control) or control.dormant:
                    await self.remove_task(control.key, reason=reason)
                    self.debug_message(f'Task "{control.id}" released its engine (reason: {reason})')
                    return

                # The last hold: the engine stops with it, at once
                self._drop_engine(engine)
                await engine.stop_task(reason)
                self.debug_message(f'Task "{control.id}" stopped on request (reason: {reason})')

                # A @spec control ends with its run: no grace window and no
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
                    # The engine stopped above: the removal only drops the control
                    if self._task_control.get(control.key) is control:
                        await self.remove_task(control.key)

        except Exception as e:
            # Log but ignore errors - task may already be stopped or removed
            self.debug_message(f'Task stop request handled (may have been already stopped): {e}')

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

    def _debug_task_started(self, control: TaskControl, trigger: str, ttl: int) -> None:
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
            if c.ttl == 0
        ]
        message = f'Tasks running: {len(live)} ({kinds}), unbounded: {len(unbounded)}'
        if unbounded:
            oldest, lifetime = max(unbounded, key=lambda item: item[1])
            message += f', oldest unbounded: "{oldest.id}" {lifetime}s'
        self.debug_message(message)
