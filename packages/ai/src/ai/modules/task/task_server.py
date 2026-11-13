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
- Controls (``TaskControl``): the callers' views of runs, one per
  ``(owner, address, rung)``, each holding exactly one engine
- Engines (``TaskEngine``): the running processes, keyed by the content hash
  of the resolved spec and shared by every control whose spec hashes the
  same (across users only when the pipeline is certified shareable)
- DAP connections (debugging and control interfaces)
- Event broadcasting (real-time monitoring and notifications)
- Resource management (automatic cleanup and metrics)
- Multi-tenant security (API key isolation and access control)
"""

import time
import errno
import heapq
import socket
import sys
import asyncio
import uuid
from collections import deque
from collections.abc import Mapping, MutableMapping
from contextlib import asynccontextmanager
from typing import Deque, List
from fastapi import WebSocket
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Dict, Any, Optional, Set, Tuple
from ai.constants import (
    CONST_CLEANUP_DELAY_TIME,
    CONST_CLEANUP_SLEEP_TIME,
    CONST_TEARDOWN_WAIT_TIMEOUT,
    CONST_DEFAULT_MAX_THREADS,
    CONST_DEFAULT_TTL,
    CONST_ENGINE_IDLE_TTL,
    CONST_ENGINE_RESTART_BACKOFF,
    CONST_ENGINE_RESTART_MAX_PER_HOUR,
    CONST_REPOINT_STORM_MAX,
    CONST_REPOINT_STORM_WINDOW,
    CONST_TTL_CHECK,
    CONST_MAX_UNAUTHED_CONNS_PER_IP,
    CONST_MAX_UNAUTHED_IPS,
)
from ai.common.dap import TransportWebSocket, DAPBase
from rocketride import EVENT_TYPE
from ai.web import WebServer
from ai.account.app_deploy import developer_id_required
from ai.account.models import AccountInfo, home_team, resolve_run_permissions, resolve_task_permissions
from ai.account.pipe_deploy import Pin, resolve_pins, teams_to_probe
from ai.account.store import Store
from .task_conn import TaskConn
from .task_control import RUNGS, DeploymentRef, TaskControl, TeamContext, control_key, rung_of
from .engine_key import engine_content
from .task_engine import TaskEngine, component_facts
from .types import LAUNCH_TYPE, TaskError
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


#: What a spec call does when the caller's live presence runs other content (plan 3.4)
ON_CHANGE_MODES = ('error', 'keep', 'auto')


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


@asynccontextmanager
async def _gated(gates: Dict[str, _StartGate], key: str) -> AsyncIterator[None]:
    """
    Hold the start lock of ``key`` in ``gates``; the gate goes when its last user leaves.

    Args:
        gates: The gate table (per engine key, or per control key).
        key: The key to serialize on.
    """
    gate = gates.setdefault(key, _StartGate())
    gate.users += 1
    try:
        async with gate.lock:
            yield
    finally:
        gate.users -= 1
        if gate.users == 0 and gates.get(key) is gate:
            gates.pop(key, None)


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

    def _leave(self, key: str, gate: _StartGate) -> None:
        """One user left ``gate``; drop it when it was the last."""
        gate.users -= 1
        if gate.users == 0 and self._starts.get(key) is gate:
            self._starts.pop(key, None)

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


class ControlRegistry(MutableMapping):
    """
    The control registry and its two indexes (plan 3.2: lookups are indexed, never scanned).

    A mapping ``<rung>.<ownerId>.<address> -> TaskControl`` (``_by_key``)
    that keeps, in its ONE register path (``__setitem__``) and its ONE forget
    path (``__delitem__``, which ``pop`` goes through):

    - ``_by_address_owner[(address, ownerId)]``: the controls of one owner at
      one address (one per rung). ``@team`` probes it once per team the
      caller belongs to;
    - ``_sources[(developerId, pipeId)]``: the sources registered for a pipe,
      with the number of controls at each, so a two-segment address finds
      its sources without a walk;
    - ``_by_owner[ownerId]``: every control of one owner (user or team), so
      an owner-scoped lookup never walks the registry.

    ALB seam 2: callers outside the registry use ``get`` / ``get_or_create``
    / ``remove`` / ``for_owner`` (and the counted resolver probes below),
    never an iteration over every control.

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
        self._by_address_owner: Dict[Tuple[str, str], List[TaskControl]] = {}
        self._sources: Dict[Tuple[str, str], Dict[str, int]] = {}
        self._by_owner: Dict[str, Dict[str, TaskControl]] = {}
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
        THE register path: the key, the owner index and the source index.

        A control already under ``key`` is forgotten first, so a replacement
        never leaves its predecessor in an index.
        """
        # Step 1: a predecessor under the key leaves every index
        if key in self._by_key:
            del self[key]

        # Step 2: the exact key, the owner index and the pipe's sources
        self._by_key[key] = control
        self._by_address_owner.setdefault((control.address, control.owner_id), []).append(control)
        sources = self._sources.setdefault((control.developer_id, control.project_id or ''), {})
        sources[control.source or ''] = sources.get(control.source or '', 0) + 1
        self._by_owner.setdefault(control.owner_id, {})[key] = control

    def __delitem__(self, key: str) -> None:
        """THE forget path: out of the key, the owner index and the source index."""
        # Step 1: the exact key
        control = self._by_key.pop(key)

        # Step 2: the owner index entry, by identity
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

    def get_or_create(self, key: str, create: Callable[[], TaskControl]) -> Tuple[TaskControl, bool]:
        """
        The control under ``key``, or a new one built by ``create`` and registered.

        Args:
            key: The registry key.
            create: Builds the control when none is registered (its ``key`` must be ``key``).

        Returns:
            The control and True when it was created here.
        """
        existing = self._by_key.get(key)
        if existing is not None:
            return existing, False
        control = create()
        self[key] = control
        return control, True

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

    def lookup(self, key: str) -> Optional[TaskControl]:
        """One exact-key probe (``@dev``, ``@me``, ``@public``)."""
        self.probes += 1
        return self._by_key.get(key)

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
        _control_starts: Per-control-key locks for starts from a published artifact
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
        self._task_control = ControlRegistry()  # Control registry: <rung>.<ownerId>.<address>, indexed
        self._engines = EngineRegistry()  # Engine pool: content key -> engine, start lock inside
        self._engine_unavailable: Dict[str, Tuple[str, str]] = {}  # Control key -> (engineKey, reason)
        # Deployments whose holds were released (disabled/removed), by the monotonic
        # time of the release: a control registered through a deployment that was
        # revoked after its state was read, or still holding one that was revoked
        # later, is unavailable (plan 7.2, the kill switch has no back door)
        self._deployment_revoked: Dict[DeploymentRef, float] = {}
        self._control_starts: Dict[str, _StartGate] = {}  # Per-control-key locks for starts from an artifact
        self._engine_restarts: Dict[str, Deque[float]] = {}  # Engine key -> automatic restart times, last hour
        self._restart_tasks: Set[asyncio.Task] = set()  # Pending automatic listener restarts
        self._repoints: Dict[Tuple[str, str], Deque[float]] = {}  # (owner, address) -> repoint times (storm detector)
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
            if engine._expiry_gen != gen or engine._stop_requested or engine.is_task_complete():
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

        # Process all tasks for disconnection cleanup
        for control in list(self._task_control.values()):
            try:
                # Detach this connection from the task
                await control.task.detach_task(conn)

                # Auto-terminate launched tasks when the launching client
                # disconnects: that ends THIS control's hold; an engine other
                # controls hold keeps serving them
                if control.launch_type == LAUNCH_TYPE.LAUNCH and control.launch_owner == conn:
                    if self._shares_engine(control):
                        await self.remove_task(control.key)
                    else:
                        await self._stop_engine_now(control.task, 'user')
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
    ) -> TaskControl:
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

        def _verify(control: TaskControl) -> TaskControl:
            """Run-scoped permission check (owner-private for user-owned runs)."""
            return self._verify_control(control, account_info, require)

        # Team scope: the team's TEAM-OWNED deploy run. owner_kind must be
        # checked: an @me deploy carries the SAME billing teamId, and
        # matching it here would let any teammate reach a personal run
        # through team permissions.
        if team_id:
            for control in self._task_control.for_owner(team_id):
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
        # A @public control is user-owned and deploy-kind too: it is never
        # the caller's @me deploy.
        wanted_kind = run_kind or 'dev'
        for control in self._task_control.for_owner(account_info.userId):
            if (
                control.run_kind == wanted_kind
                and control.rung != 'public'
                and control.owner_id == account_info.userId
                and control.project_id == project_id
                and control.source == source
            ):
                return _verify(control)
        raise TaskError(TaskError.NOT_REGISTERED, 'Your pipeline is not running')

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

    def control_by_key(self, key: str) -> TaskControl:
        """
        Internal registry lookup by the control's own key.

        For code that already holds a control's key (the engine reporting
        back, cleanup, the scheduler) — never for a client-supplied value:
        clients send addresses, which ``resolve_control`` turns into a
        control under the request's account.

        Args:
            key (str): The registry key ``<rung>.<ownerId>.<address>``.

        Returns:
            TaskControl: The live control.

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
        *,
        team: Optional[str] = None,
    ) -> TaskControl:
        """
        THE resolver over the registry: an address plus the request's account yields one control.

        Walks the rungs in the fixed order and takes the first that answers
        (``@dev``: the caller's own presence, attach-only; ``@me``: the
        caller's personal deployment run; ``@team``: the first team in the
        caller's TEAM ORDER with a team-owned run of the address; ``@public``:
        the caller's control on a store publication). Starting a published
        rung from its artifact when nothing is registered is
        ``resolve_or_start``. Every hit is permission-checked; a key with an
        ``endpoints`` scope skips ``@dev`` (a production webhook must never
        land on the owner's Play'd run), probes its frozen team only, and is
        refused outside its scope. There is NO owner qualifier: nobody can
        name another user's control.

        Every probe is an index lookup (plan 3.2), never a registry walk:
        ``@dev``/``@me``/``@public`` are one exact key each
        (``<rung>.<userId>.<address>``), ``@team`` is one owner-index probe
        per team in the order (first hit wins; the order is total, so there
        is no ambiguity), and a two-segment address first reads the pipe's
        registered sources. The cost is O(caller's teams x sources) whatever
        the registry holds.

        The walk runs over LIVE controls first: a stopped run never answers
        its address while another rung has a live one (a dead ``@dev`` falls
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
            address (str): ``developerId.pipelineId[.source]`` (the token slot).
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
            control = self._walk_rungs(parsed, address, account_info, require, live_only, rungs, team)
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
        ``@dev`` (live only: a name never starts a dev run), ``@me``,
        ``@team`` slot by slot in the caller's team order (``team=``
        overrides it), ``@public``. So a live ``@team`` control of a LATER
        team never beats an earlier team's publication, and a live
        ``@team`` control never beats the caller's own ``@me`` deployment.
        A live ``@dev``/``@me`` hit answers without reading publications.

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
        # Step 1: a live control on any rung
        if account_info is None:
            raise PermissionError('Not authenticated')
        parsed = parse_address(address)
        rungs: List[str] = []
        live = self._walk_rungs(parsed, address, account_info, require, True, rungs, team)
        if live is not None and live.rung in ('dev', 'me'):
            return self._check_engine_available(live), False

        # Step 2: the publications that may come before it
        pins = await resolve_pins('pipe', account_info, address, team=team)
        probe = teams_to_probe(account_info, team)

        def _rank(rung: str, team_id: str) -> int:
            """Position of a rung slot in the fixed order (me, each team, public)."""
            if rung == 'me':
                return 0
            if rung == 'team':
                return 1 + (probe.index(team_id) if team_id in probe else len(probe))
            return 2 + len(probe)

        live_rank = _rank(live.rung, live.owner_id) if live is not None else None

        # Step 3: the earlier of the live control and each pin answers
        for pin in pins.pins:
            if live_rank is not None and live_rank <= _rank(pin.rung, pin.deployment.team_id):
                break
            control, started = await self._start_from_pin(pin, pins.address, account_info, require)
            if control is not None:
                return control, started
        if live is not None:
            return self._check_engine_available(live), False

        # Step 4: nothing on any rung
        raise self._not_registered(address, rungs)

    def _walk_rungs(
        self,
        parsed: Address,
        address: str,
        account_info: AccountInfo,
        require: Optional[str],
        live_only: bool,
        rungs: List[str],
        team: Optional[str] = None,
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
            """The caller's own control on ``rung``: one key per full address."""
            found = [registry.lookup(control_key(rung, user_id, a)) for a in addresses]
            return _pick([c for c in found if _usable(c)])

        # Step 2: @dev, the caller's own presence. Attach-only, and skipped
        # for a scoped (machine) credential.
        if endpoints is None:
            rungs.append('@dev')
            control = _exact('dev')
            if control is not None:
                return self._verify_control(control, account_info, require)

        # Step 3: @me, the caller's personal (user-owned) deployment run
        rungs.append('@me')
        control = _exact('me')
        if control is not None:
            check_endpoint_scope(endpoints, control.address)
            return self._verify_control(control, account_info, require)

        # Step 4: @team, the first team in the caller's team order (or the
        # team= override, or a scoped key's frozen team) with a team-owned
        # run of the address: one owner-index probe per team and address
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
            revoked = self._deployment_revoked.get(control.deployment) if control.deployment is not None else None
            if revoked is None or revoked <= control.registered_at:
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
        ``trigger='process'``. The control is owned by the CALLER: the user
        on ``@me`` and ``@public``, the answering team on ``@team``; its key
        is ``<rung>.<owner>.<address>``, its ``rung`` the pin's rung, its
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

        # Step 3: one start per control key; a concurrent request attaches
        async with _gated(self._control_starts, key):
            existing = self._task_control.get(key)
            if existing is not None and existing.live:
                return self._check_engine_available(self._verify_control(existing, account_info, require)), False
            pipeline['source'] = source
            started = await start_server_task_as_team(
                self,
                pipeline,
                org_id=org_id,
                team_id=billing_team,
                deployment=deployment,
                deployment_epoch=state_epoch,
                trigger='process',
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

    # ==== Holds ===================================================================

    @staticmethod
    def _shares_engine(control: TaskControl) -> bool:
        """True when another control also holds the engine ``control`` holds."""
        return control.task is not None and any(key != control.key for key in control.task.holds)

    def _unregister_control(self, control: TaskControl) -> None:
        """
        Take a control out of the registry and release its hold; its subscriptions stay.

        Args:
            control: The control to unregister.
        """
        # Out of the registry, unless a replacement already took the key
        if self._task_control.get(control.key) is control:
            self._task_control.pop(control.key, None)
            self._engine_unavailable.pop(control.key, None)

        # The control's one hold
        if control.task is not None:
            control.task.release(control.key)

    def _forget_control(self, control: TaskControl) -> None:
        """
        Drop a control: out of the registry, its subscriptions gone, its hold released.

        Never stops the engine: whether the engine stops is the caller's call
        (it does only when this was the last hold).

        Args:
            control: The control to drop.
        """
        self._unregister_control(control)

        # Remove monitor subscriptions that reference this control from all
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
        last_hold = not self._shares_engine(control)

        # Subscriptions go first and the hold with them: a subscription a
        # client installs for a replacement run during the await below must
        # survive
        self._forget_control(control)

        # The last hold dropped: the engine stops now, unless it already has
        if engine is not None and last_hold and not engine.is_task_complete() and not engine._stop_requested:
            await self._stop_engine_now(engine, reason)

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

        # Step 3: one start, every holder repointed onto it
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

    def _refuse_if_revoked(self, control: TaskControl, state_epoch: float) -> None:
        """
        Refuse to register a control through a deployment revoked since ``state_epoch``.

        Args:
            control: The control about to be registered.
            state_epoch: When its deployment's state was last read as enabled.

        Raises:
            TaskError: TASK_ENGINE_UNAVAILABLE with ``reason='unpublished'``.
        """
        if control.deployment is None:
            return
        revoked = self._deployment_revoked.get(control.deployment)
        if revoked is None or revoked <= state_epoch:
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
        owner's own @dev run of identical content) keep their engine.

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

        # Step 2: release every hold; one failure never stops the others
        released = 0
        failures: List[str] = []
        for control in list(self._task_control.values()):
            if control.deployment != deployment:
                continue
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
        on_change: Optional[str] = None,
        deployment_epoch: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Create a control and acquire its hold on an engine, starting one if needed.

        This method handles the complete task creation process including validation,
        registry management, resource allocation, and startup coordination. It
        supports both interactive debugging and batch execution modes.

        Args:
            request (Dict[str, Any]): Task creation request containing:
                - arguments: Task configuration including the pipeline; an
                  optional ``token`` overrides the pipeline-id segment of the
                  address (the spec's ``project_id``) and is not a credential
                - command: Launch type (launch/execute) determining task behavior
            conn (TaskConn, optional): Connection to associate with task for monitoring
            env_source: Loads the values for ${...} placeholders at each (re)start (see Task)
            developer_id: The owner org's developer id — the address namespace.
                Required: the address exists from the first run.
            deployment: The deployment a deployment run resolved through
                (trusted dispatch only); its disable/remove releases the hold.
            rung: The published rung a ``process(name)`` start answered on
                (trusted dispatch only): ``'me'``, ``'team'`` or ``'public'``.
                Empty derives it from ``run_kind``/``owner_kind``. A
                ``@public`` control is a user-owned deployment run that only
                this stamp tells apart from ``@me``.
            version: The artifact version a published rung started from.
            team_context: The team whose environment the control runs with
                (plan 6.2). Default: ``team_id`` as the home team of a dev
                run, the deploying team of a deployment run.
            on_change: Set by ``process(spec)`` (``'error'``/``'keep'``/
                ``'auto'``): a live presence at the address is reused, refused
                or repointed per plan 3.4 instead of the useExisting rule, and
                the result carries ``converged``/``specMatch`` stamps.
            deployment_epoch: Monotonic time the trusted dispatch READ the
                deployment's state, before it loaded the artifact. A
                disable/remove after that moment refuses the control instead
                of registering it (plan 7.2): the window between the state
                read and the registration is closed. Default: now.

        Returns:
            Dict[str, Any]: The task's identity; ``token`` carries the ADDRESS
                (``developerId.pipelineId.source``) for subsequent operations

        Raises:
            TaskError: TASK_INVALID_ARGUMENT when an identity, the project id
                (or the ``token`` override of it), the source or a component id
                breaks the address grammar, or when a dev launch does not name
                the authenticated user
            ValueError: If launch type is invalid or task already exists
            RuntimeError: If the pipeline is missing, empty or not an object
            Exception: If task creation or startup fails

        Task Creation Process:
        1. Parse and validate request parameters and identities
        2. Validate the pipeline and derive the address, rung and registry key
        3. Check for control uniqueness and handle conflicts
        4. Compute the engine key from the spec's content (plan 7.2)
        5. Under the engine key's start lock: attach to the live engine of
           that key, or create and start one
        6. Register the control holding the engine
        7. Return the address for client use

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

        def _return_results(
            control: TaskControl,
            reused: bool = False,
            *,
            converged: Optional[str] = None,
            spec_match: Optional[bool] = None,
            warnings: Optional[List[Dict[str, Any]]] = None,
        ) -> Dict[str, Any]:
            """
            Return the task's identity, the address in the token slot.

            Args:
                control (TaskControl): The existing task control structure
                reused (bool): True when this is a live instance returned under
                    useExisting rather than a task launched from the submitted
                    pipeline. Without it the two are indistinguishable to the
                    caller, and a run against stale configuration reads as a
                    successful run of the configuration just sent.
                converged: With ``on_change``: ``'none'``, ``'started'`` or
                    ``'repointed'`` (plan 3.1 stamps).
                spec_match: With ``on_change``: whether the engine runs the
                    submitted spec.
                warnings: ``address_collision`` / ``repoint_storm`` warnings.
            """
            result = {
                'id': control.id,
                'token': control.address,
                'projectId': control.project_id,
                'source': control.source,
                'provider': control.provider,
                'reused': reused,
                'engineKey': control.task.engine_key if control.task is not None else '',
            }
            if converged is not None:
                result['converged'] = converged
            if spec_match is not None:
                result['specMatch'] = spec_match
            if warnings:
                result['warnings'] = list(warnings)
            return result

        # Initialize task control structure for new task
        control = TaskControl()

        # For launch/exec token is in args. An explicit "arguments": null is a
        # request with no pipeline, refused by the guard below.
        args = request.get('arguments') or {}
        use_existing_task = args.get('useExisting', False)

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
        # records the spec it actually runs (useExisting compares against it).
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

        # The rung and the registry key: one control per (owner, address,
        # rung). The owner FIELD (user for dev and @me, team for @team) rides
        # owner_id, and the rung separates a user's dev run from their @me
        # deploy of the same pipeline — the only pair that shares an owner.
        # A published rung stamped by the trusted dispatch must fit the run:
        # @me and @public are user-owned deployment runs, @team a team-owned one
        derived = rung_of(control.run_kind, control.owner_kind)
        if rung and (rung not in RUNGS or derived != ('me' if rung == 'public' else rung) or derived == 'dev'):
            raise ValueError(f'rung {rung!r} does not fit a {control.owner_kind}-owned {control.run_kind} run')
        control.rung = rung or derived
        control.key = control_key(control.rung, control.owner_id, control.address)

        # Caller-side settings: they belong to the control and never enter
        # the engine key
        control.trigger = trigger
        control.ttl = CONST_DEFAULT_TTL if ttl is None else int(ttl)
        control.trace_level = args.get('pipelineTraceLevel')
        control.parameters = dict(control.pipeline.get('parameters') or {})
        control.origin = args.get('origin')
        control.deployment = deployment
        control.version = version
        control.team_context = team_context or TeamContext(
            control.teamId, 'home' if control.run_kind == 'dev' else 'deploying'
        )

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

            # Prevent duplicate active tasks. A dormant control (its engine
            # stopped on its inactivity timer) is reused when asked, else
            # replaced like a finished one
            reusable = use_existing_task or on_change is not None
            if not existing_control.task.is_task_complete() or (reusable and existing_control.dormant):
                # A Play/.use/process(spec) for a live presence whose engine runs
                # other content from another workspace: say so (plan 2.3)
                current_hash = existing_control.task.engine_key.split(':', 1)[0]
                new_hash = engine_content(control.pipeline, control.source, component_facts).content_hash
                warnings = self._collision_warnings(existing_control, control, current_hash, new_hash)

                # process(spec): on_change decides (plan 3.4)
                if on_change is not None:
                    return await self._converge(
                        existing_control,
                        control,
                        on_change,
                        current_hash=current_hash,
                        new_hash=new_hash,
                        launch_args=args,
                        env=env,
                        env_source=env_source,
                        warnings=warnings,
                        wait_for_running=wait_for_running,
                        results=_return_results,
                    )

                # This is an active task, if we are told we can use it, then,
                # make sure the user actually specified the task to use. If so,
                # then all is ok, just use the existing task
                if use_existing_task:
                    # A dormant control's engine starts again under its key
                    await self.ensure_engine(existing_control)

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
                    return _return_results(existing_control, reused=True, warnings=warnings)

                # We are absolutely supposed to create a task. Name the running
                # task, not this request's id: the two can differ by source.
                raise ValueError(
                    f'Pipeline is already running (task {existing_control.id}). '
                    'Reuse it (useExisting / use_existing), or stop it and run again.'
                )

            # Clean up the completed control with the same key (its engine is
            # done). Its subscriptions stay: they are the replacement's too.
            self._unregister_control(existing_control)
            self.debug_message(f'Replaced completed task "{control.id}"...')

        # The engine: content-addressed (plan 7.2). Threads come from policy
        # outside @dev; a @dev spec call that moves threads or args away from
        # policy gets an engine of its own, so a name call never attaches to a
        # developer's non-default shape.
        key, shared, threads = self._engine_shape(control, args)

        # The moment the deployment's state is known good: the dispatch's read,
        # or now for a run that resolved no deployment
        state_epoch = time.monotonic() if deployment_epoch is None else float(deployment_epoch)

        def _register(engine: TaskEngine) -> None:
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

        # Attach to the live engine of the key, or start one (the start gate)
        try:
            await self._acquire_engine(
                key,
                lambda: self._new_engine(
                    control,
                    key=key,
                    shared=shared,
                    threads=threads,
                    launch_args=args,
                    env={} if shared else (env or {}),
                    env_source=None if shared else env_source,
                ),
                _register,
            )

            self._debug_task_started(control, trigger, control.ttl)

            # Retrieve the task instance for status monitoring
            if wait_for_running:
                # Block until the engine transitions to running state
                await control.task.wait_for_running()

            # Return formatted results (a process(spec) start is 'started')
            if on_change is not None:
                return _return_results(control, converged='started', spec_match=True)
            return _return_results(control)

        except Exception:
            # Distinguish a genuine creation failure from a user-requested
            # stop that raced with startup / wait_for_running.  When the user
            # terminates before the task reaches RUNNING, the exception
            # propagates here but the task was NOT a creation failure.
            engine = control.task
            last_hold = not self._shares_engine(control)
            if engine is not None:
                self._unregister_control(control)
            if engine is not None and engine._stop_requested:
                self.debug_message(f'Task stopped during startup: {control.id}...')
            elif engine is not None and last_hold:
                self.debug_message(f'Task creation failed, cleaned up: {control.id}...')
                # Kill the subprocess so it doesn't linger as an orphan
                # consuming resources and reporting stale metrics. An engine
                # other controls hold is theirs and keeps running.
                self._drop_engine(engine)
                try:
                    await asyncio.wait_for(engine.stop_task(), timeout=30)
                except asyncio.TimeoutError:
                    self.debug_message(f'Warning: timed out stopping orphaned task: {control.id}')
                except Exception:
                    self.debug_message(f'Warning: failed to stop orphaned task: {control.id}')
            raise

    # ==== Spec calls: shape, convergence, collision, storm =======================

    @staticmethod
    def _engine_shape(control: TaskControl, launch_args: Dict[str, Any]) -> Tuple[str, bool, int]:
        """
        The engine key, cross-user sharing and thread count for ``control``'s spec (plan 7.2).

        Threads come from policy outside @dev; a @dev spec call that moves
        threads or args away from policy gets an engine of its own, so a name
        call never attaches to a developer's non-default shape.

        Args:
            control: The control (its pipeline, source, rung and owner are set).
            launch_args: The launch arguments (``threads``, ``args``).

        Returns:
            ``(engine key, shared, threads)``.
        """
        content = engine_content(control.pipeline, control.source, component_facts)
        threads = CONST_DEFAULT_MAX_THREADS
        custom_shape = False
        if control.rung == 'dev':
            requested_threads = launch_args.get('threads')
            if requested_threads is not None and requested_threads != CONST_DEFAULT_MAX_THREADS:
                threads = requested_threads
                custom_shape = True
            if launch_args.get('args'):
                custom_shape = True
        shared = content.shareable and not custom_shape
        return content.key(shared=shared, owner_id=control.owner_id), shared, threads

    @staticmethod
    def _collision_warnings(
        existing: TaskControl, incoming: TaskControl, current_hash: str, new_hash: str
    ) -> List[Dict[str, Any]]:
        """
        The ``address_collision`` warning (plan 2.3), or none.

        Fires when a spec call meets a live presence at the same address whose
        engine runs different content AND whose ``origin`` (workspace root +
        path) differs from the caller's: two workspaces reuse one short id.

        Returns:
            ``[{code, address, origins}]`` or ``[]``.
        """
        origins = [existing.origin, incoming.origin]
        if current_hash == new_hash or not all(origins) or origins[0] == origins[1]:
            return []
        return [{'code': 'address_collision', 'address': existing.address, 'origins': origins}]

    def _storm_warning(self, control: TaskControl, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """
        Count one repoint of ``control``'s address; the ``repoint_storm`` warning past the limit (plan 7.3).

        One owner repointing one address more than
        ``CONST_REPOINT_STORM_MAX`` times in ``CONST_REPOINT_STORM_WINDOW``
        seconds is a symptom of per-request values baked into the spec
        (they belong in ``params``/``data``).

        Returns:
            ``[{code, address, count, window}]`` or ``[]``.
        """
        now = time.monotonic() if now is None else now
        recent = self._repoints.setdefault((control.owner_id, control.address), deque())
        recent.append(now)
        while recent and recent[0] <= now - CONST_REPOINT_STORM_WINDOW:
            recent.popleft()
        if len(recent) <= CONST_REPOINT_STORM_MAX:
            return []
        return [
            {
                'code': 'repoint_storm',
                'address': control.address,
                'count': len(recent),
                'window': CONST_REPOINT_STORM_WINDOW,
            }
        ]

    async def _converge(
        self,
        existing: TaskControl,
        incoming: TaskControl,
        on_change: str,
        *,
        current_hash: str,
        new_hash: str,
        launch_args: Dict[str, Any],
        env: Optional[Dict[str, str]],
        env_source: Optional[Callable[[], Awaitable[Dict[str, str]]]],
        warnings: List[Dict[str, Any]],
        wait_for_running: bool,
        results: Callable[..., Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        A spec call against the caller's live @dev presence, per ``on_change`` (plan 3.4, 7.3).

        - the same content: reuse, ``converged:'none'``, ``specMatch:true``;
        - ``'error'``: refuse with ``TASK_SPEC_CHANGED`` and both hashes;
        - ``'keep'``: deliver to the existing engine, ``specMatch:false``;
        - ``'auto'``: REPOINT the control (release its hold on the old engine,
          acquire one on the new spec's engine, starting it if needed), stamp
          ``converged:'repointed'``. Nothing is killed: the old engine keeps
          serving its other holders and stops when none remain.

        Returns:
            The start result with the stamps.

        Raises:
            TaskError: TASK_INVALID_ARGUMENT (unknown ``on_change``) or
                TASK_SPEC_CHANGED (``{address, currentHash, newHash, warnings}``).
        """
        if on_change not in ON_CHANGE_MODES:
            raise TaskError(
                TaskError.INVALID_ARGUMENT,
                f'onChange must be one of {", ".join(ON_CHANGE_MODES)}',
                field='onChange',
            )

        # Step 1: the same content, or the caller keeps the running one
        if current_hash == new_hash or on_change == 'keep':
            await self.ensure_engine(existing)
            if wait_for_running:
                await existing.task.wait_for_running()
            return results(
                existing, reused=True, converged='none', spec_match=current_hash == new_hash, warnings=warnings
            )

        # Step 2: refuse
        if on_change == 'error':
            raise TaskError(
                TaskError.SPEC_CHANGED,
                f'{existing.address!r} runs another spec ({current_hash[:12]}); '
                "pass onChange='auto' to move to the new one or 'keep' to use the running one",
                address=existing.address,
                currentHash=current_hash,
                newHash=new_hash,
                warnings=warnings,
            )

        # Step 3: repoint onto the new spec's engine
        await self._repoint(existing, incoming.pipeline, launch_args=launch_args, env=env, env_source=env_source)
        if wait_for_running:
            await existing.task.wait_for_running()
        return results(
            existing,
            reused=True,
            converged='repointed',
            spec_match=True,
            warnings=warnings + self._storm_warning(existing),
        )

    async def _repoint(
        self,
        control: TaskControl,
        pipeline: Dict[str, Any],
        *,
        launch_args: Dict[str, Any],
        env: Optional[Dict[str, str]],
        env_source: Optional[Callable[[], Awaitable[Dict[str, str]]]],
    ) -> TaskEngine:
        """
        Move ``control``'s ONE hold onto the engine of ``pipeline`` (plan 7.3).

        The control's identity, ttl and subscriptions stay; its spec becomes
        ``pipeline``. The new engine is acquired through the start gate
        (attached when another control already runs that content). The old
        engine loses this hold only; it stops at once when that was its last
        hold (no linger, plan 7.2), and otherwise keeps serving its holders.

        Returns:
            The engine the control now holds.
        """
        old_engine, old_pipeline = control.task, control.pipeline
        control.pipeline = pipeline
        key, shared, threads = self._engine_shape(control, launch_args)

        def _move(engine: TaskEngine) -> None:
            if control.task is engine:
                return
            if control.task is not None:
                control.task.release(control.key)
            engine.acquire(control.key, control.ttl)
            control.task = engine

        try:
            engine = await self._acquire_engine(
                key,
                lambda: self._new_engine(
                    control,
                    key=key,
                    shared=shared,
                    threads=threads,
                    launch_args=launch_args,
                    env={} if shared else (env or {}),
                    env_source=None if shared else env_source,
                ),
                _move,
            )
        except Exception:
            # A failed start leaves the control on its old engine and spec
            failed = control.task
            if failed is not old_engine and failed is not None:
                failed.release(control.key)
                old_engine.acquire(control.key, control.ttl)
                control.task = old_engine
            control.pipeline = old_pipeline
            raise

        # The old engine's last hold went with this repoint: it stops now
        if old_engine is not None and old_engine is not engine and not old_engine.holds:
            if not old_engine.is_task_complete() and not old_engine._stop_requested:
                await self._stop_engine_now(old_engine, 'repointed')
        self.debug_message(f'Task "{control.id}" repointed to engine "{engine.engine_key}"')
        return engine

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
        traces nothing by default; a private engine is its owner's, as today.

        Args:
            control: The control the engine is started for.
            key: The engine key (plan 7.2).
            shared: True for a cross-user engine.
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
            if engine is not None and (engine.is_task_complete() or engine._stop_requested):
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
        SAME key through the start gate, and the control is repointed.
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

        def _repoint(engine: TaskEngine) -> None:
            # A concurrent request through this control may have repointed it
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
                _repoint,
            )

        except Exception:
            # Step 3: a failed start leaves the control dormant on the stopped
            # engine, so the next request tries again
            failed = control.task
            if failed is not stopped:
                failed.release(control.key)
                stopped.acquire(control.key, control.ttl)
                control.task = stopped
                if not failed.holds:
                    try:
                        await asyncio.wait_for(failed.stop_task(), timeout=30)
                    except Exception:
                        self.debug_message(f'Warning: failed to stop a failed engine start: {control.id}')
            raise

        finally:
            # Step 4: the gate is behind this request either way
            control.engine_starting = False

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
        9. Update TaskControl with new configuration (pipeline, provider)
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

            # A restart replaces the engine's content in place, so it is open
            # only to the sole holder of a private engine: an engine other
            # controls hold keeps serving them unchanged.
            # TODO(plan 3.4, C.7 phase 3): repoint the control onto the new
            # spec's engine instead (on_change 'auto').
            if self._shares_engine(control) or control.task.shared:
                raise RuntimeError(
                    'Cannot restart a pipeline whose engine other runs share. Stop it and run the new version instead.'
                )

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

            # The restarted engine runs different content, so it takes the new
            # content's key (the task file's taskId is written at the start).
            # When another engine already serves that key this one stays out of
            # the pool and serves only its own holder until it stops.
            engine = control.task
            new_key = engine_content(pipeline, control.source, component_facts).key(
                shared=False, owner_id=control.owner_id
            )
            self._engines.unregister(engine)
            engine.engine_key = new_key
            if new_key not in self._engines:
                self._engines.register(new_key, engine)

            # Call the engine's restart method to restart the engine process
            # This preserves all statistics and monitoring while restarting the subprocess
            await engine.restart_task(
                pipeline=pipeline,
                project_id=control.project_id,
                source=control.source,
                provider=control.provider,
            )

            # The restarted engine ages from now; a dormant one had no entry left
            self._schedule_engine(engine)

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

                # Other controls hold the engine: release only this hold and
                # drop the control; the engine keeps serving them
                if self._shares_engine(control):
                    await self.remove_task(control.key, reason=reason)
                    self.debug_message(f'Task "{control.id}" released its engine (reason: {reason})')
                    return

                # A dormant control: its engine already stopped, the control goes
                if control.dormant:
                    await self.remove_task(control.key, reason=reason)
                    self.debug_message(f'Task "{control.id}" released its stopped engine (reason: {reason})')
                    return

                # The last hold: the engine stops with it, at once
                self._drop_engine(engine)
                await engine.stop_task(reason)
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
                    # The engine stopped above: the removal only drops the control
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
