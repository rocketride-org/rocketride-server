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
MonitorCommands: DAP Event Monitoring and Subscription System.

This module implements a real-time event monitoring system for computational tasks
within a distributed debugging and execution environment. It manages event subscriptions
and forwards task-related events to interested DAP clients based on their monitoring
preferences and access permissions.

Primary Responsibilities:
--------------------------
1. Manages event subscriptions for task monitoring clients
2. Routes task events to subscribed monitors based on event types and access controls
3. Provides selective event filtering (passive, active, debug-only, or none)
4. Maintains monitor registrations with apikey-based access control
5. Handles real-time status updates and task state changes
6. Integrates with the DAP protocol for standardized event communication

Event Types (``EVENT_TYPE`` bitmask flags):
-------------------------------------------
- SUMMARY / DETAIL: task status and per-item lifecycle updates
- TASK:      task-scoped lifecycle events
- SSE:       real-time node-to-UI stream (pass-through data)
- FLOW:      pipeline component enter/leave trace events (when tracing)
- OUTPUT:    debug console output
- DEBUGGER:  debugger-protocol events (breakpoints, variables, etc.)
- DASHBOARD: server dashboard activity (connection/task changes)
- BILLING:   token/usage billing events
- NONE / ALL: unsubscribe from all / subscribe to all

Subscriptions are stored per monitor key as an ``EVENT_TYPE`` bitmask, so a
client can combine flags (e.g. ``SUMMARY | SSE``).

Architecture:
-------------
This system enables multiple clients to monitor the same task simultaneously
with different event subscription levels. It acts as an event distribution
hub that respects access permissions and client preferences.
"""

import asyncio
import time
from typing import TYPE_CHECKING, Dict, Any, List
from ai.common.dap import DAPConn, TransportBase
from ai.account.models import RequestContext, resolve_task_permissions
from ai.constants import CONST_CONN_OUT_QUEUE_MAX
from rocketride import EVENT_TYPE, TASK_STATE, TASK_STATUS
from rocketride.types.client import DAPRequest, DAPResponse


# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer, TASK_CONTROL


# ============================================================================
# DASHBOARD PAGINATION HELPERS
# ============================================================================


def _sort_key(value: Any):
    """
    Build a total-ordering sort key that tolerates mixed / missing values.

    ``sort_by`` comes straight from the request, so a caller can sort by any
    field — including dict/list columns (``clientInfo``, ``monitors``,
    ``metrics``) or a column whose rows mix scalar types. A naive ``(value is
    None, value)`` key would then raise ``TypeError`` when Python tried to
    compare unlike values. The first tuple element separates ``None`` from real
    values, the second buckets by type, and only the third (like-typed within a
    bucket) is ever compared — so no ``TypeError`` is possible.
    """
    if value is None:
        return (1, 0, '')
    if isinstance(value, bool):
        return (0, 0, int(value))
    if isinstance(value, (int, float)):
        return (0, 1, value)
    if isinstance(value, str):
        return (0, 2, value.casefold())
    return (0, 3, repr(value))


def _paginate(items: List[Dict[str, Any]], params: Dict[str, Any]) -> tuple:
    """
    Apply ``sort_by``/``sort_order`` then ``offset``/``limit`` to a section.

    Args:
        items:  The already-filtered rows (tasks or connections).
        params: A ``DashboardPageParams`` dict — any of ``offset``, ``limit``,
                ``sort_by``, ``sort_order`` (all optional).

    Returns:
        ``(page, total)`` where ``total`` is the pre-slice row count and
        ``page`` is the requested slice — or ``None`` when ``limit`` is 0,
        signalling the caller to omit the section entirely. ``limit`` absent
        means "return everything from ``offset``".
    """
    total = len(items)
    params = params or {}

    sort_by = params.get('sort_by')
    if sort_by:
        reverse = str(params.get('sort_order', 'desc')).lower() == 'desc'
        items = sorted(items, key=lambda row: _sort_key(row.get(sort_by)), reverse=reverse)

    offset = max(int(params.get('offset', 0) or 0), 0)
    limit = params.get('limit')
    if limit is None:
        return items[offset:], total
    limit = int(limit)
    if limit <= 0:
        return None, total  # limit=0 -> caller omits the section
    return items[offset : offset + limit], total


class MonitorCommands(DAPConn):
    """
    DAP-based event monitoring and subscription manager for task events.

    This class handles event subscriptions from DAP clients and manages the
    real-time distribution of task-related events. It maintains a registry
    of active monitors and their subscription preferences, ensuring that
    events are routed only to authorized and interested clients.

    Key Features:
    - Multi-client event subscription management
    - Selective event filtering based on subscription type
    - Access control using apikey-based authentication
    - Real-time event forwarding with DAP protocol compliance
    - Dynamic subscription management (subscribe/unsubscribe)

    Attributes:
        _monitors: Dictionary mapping "apikey:token" to EVENT_TYPE subscriptions
                  Controls which events each client receives for specific tasks
        _server: Reference to TaskServer for task access and status queries
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new MonitorCommands instance for event subscription management.

        Sets up the monitoring system with an empty subscription registry
        and establishes connection to the task management server.

        Args:
            connection_id (int): Unique identifier for this monitoring connection
            server (TaskServer): The server managing task instances and lifecycle
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        # Initialize the monitor subscription registry
        # Format: "apikey:token" -> EVENT_TYPE mapping
        self._monitors: Dict[str, EVENT_TYPE] = {}

        # Per-connection outbound event delivery (see enqueue_task_event /
        # _drain_events). broadcast_task_event enqueues here instead of sending
        # inline so per-connection ordering is preserved, events are never
        # GC-dropped, and a slow WebSocket never head-of-line-blocks the parent
        # event loop. Created lazily on first enqueue (needs a running loop).
        self._out_q: 'asyncio.Queue | None' = None
        self._drain_task: 'asyncio.Task | None' = None
        self._overflow_close_task: 'asyncio.Task | None' = None

    async def send_server_event(
        self,
        event_type: EVENT_TYPE,
        event: Dict[str, Any],
        user_id: str = None,
        org_id: str = None,
    ) -> None:
        """
        Send a server-level event if this connection is subscribed via the '*' wildcard.

        This is an event DELIVERY method called by TaskServer.broadcast_server_event
        on each connection — not a command handler.  Uses connection-level
        ``self._account_info`` for scoping (OSS: one user per connection).

        Filtering order (each check short-circuits if it fails):
        1. Connection must have '*' in its monitor subscriptions
        2. The event_type bitmask must match the subscription
        3. If org_id is specified, connection's primary org must match
        4. If user_id is specified, connection's userId must match

        Args:
            event_type: Event type bitmask (e.g. EVENT_TYPE.DASHBOARD, EVENT_TYPE.BILLING).
            event:      DAP event payload with 'event' and 'body' keys.
            user_id:    Optional user scope — only deliver to this user.
            org_id:     Optional org scope — only deliver to connections in this org.
        """
        # Step 1: must be subscribed to wildcard
        if '*' not in self._monitors:
            return
        # Step 2: bitmask must match
        if not (event_type & self._monitors['*']):
            return
        # Step 3: org scoping
        if org_id is not None and hasattr(self, '_account_info') and self._account_info:
            conn_org = ''
            if hasattr(self._account_info, 'organization') and self._account_info.organization:
                org = self._account_info.organization
                conn_org = org.get('id', '') if isinstance(org, dict) else getattr(org, 'id', '')
            if conn_org != org_id:
                return
        # Step 4: user scoping
        if user_id is not None and hasattr(self, '_account_info') and self._account_info:
            if self._account_info.userId != user_id:
                return
        await self.send_event(event.get('event', 'unknown'), body=event.get('body'))

    # =========================================================================
    # OUTBOUND EVENT QUEUE — ordered, non-blocking task-event delivery
    # =========================================================================

    def enqueue_task_event(self, event_type: EVENT_TYPE, token: str, event: Dict[str, Any]) -> None:
        """
        Queue a task event for ordered delivery by this connection's drain task.

        Called by ``TaskServer.broadcast_task_event`` for every connection.
        Returns immediately (never awaits a WebSocket write), so a slow consumer
        cannot head-of-line-block the broadcast loop.  The drain applies the
        subscription/permission filter via ``send_task_event``, so non-subscribers
        drain instantly and only a genuinely slow subscriber backs up.

        Overflow: SSE streams cannot tolerate dropped chunks, so a backed-up
        consumer is disconnected; idempotent snapshots (status/summary/dashboard)
        drop the oldest in favour of the newest.

        Args:
            event_type: Event type bitmask.
            token:      Task token identifying the originating task.
            event:      Fully-formed DAP event payload.
        """
        # Lazily start the drain (we are on the event loop during broadcast).
        # Covers every registration path, including the pod/orchestrator conn.
        if self._drain_task is None:
            self._start_event_drain()
        if self._out_q is None:
            return

        try:
            self._out_q.put_nowait((event_type, token, event))
        except asyncio.QueueFull:
            if event_type == EVENT_TYPE.SSE:
                # A slow SSE consumer cannot keep up; dropping chunks would
                # corrupt the stream silently, so disconnect it. Retain the task
                # so it is not garbage-collected mid-flight.
                if self._overflow_close_task is None or self._overflow_close_task.done():
                    self._overflow_close_task = asyncio.create_task(self._overflow_disconnect())
            else:
                # Idempotent snapshot — keep the latest, drop the oldest.
                try:
                    self._out_q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    self._out_q.put_nowait((event_type, token, event))
                except asyncio.QueueFull:
                    pass

    def _start_event_drain(self) -> None:
        """Create the outbound queue and start the drain task (idempotent)."""
        if self._drain_task is not None:
            return
        self._out_q = asyncio.Queue(maxsize=CONST_CONN_OUT_QUEUE_MAX)
        self._drain_task = asyncio.create_task(self._drain_events())

    def stop_event_drain(self) -> None:
        """Cancel the drain task and drop the queue (called on disconnect)."""
        if self._drain_task is not None:
            self._drain_task.cancel()
            self._drain_task = None
        if self._overflow_close_task is not None:
            self._overflow_close_task.cancel()
            self._overflow_close_task = None
        self._out_q = None

    async def _drain_events(self) -> None:
        """
        Deliver queued task events in FIFO order for this connection.

        One drain task per connection guarantees per-connection ordering.
        ``send_task_event`` applies the subscription/permission filter and does
        the actual WebSocket write; ``PermissionError`` is a normal skip and any
        other error is logged without killing the drain.
        """
        while True:
            event_type, token, event = await self._out_q.get()
            try:
                await self.send_task_event(event_type, token, event)
            except PermissionError:
                pass
            except Exception as e:
                self.debug_message(f'Failed to deliver task event: {e}')

    async def _overflow_disconnect(self) -> None:
        """Disconnect a connection whose SSE stream overflowed its outbound queue."""
        self.debug_message('Outbound SSE queue overflow — disconnecting slow consumer')
        try:
            await self._transport.disconnect()
        except Exception:
            pass

    async def send_task_event(
        self,
        event_type: EVENT_TYPE,
        token: str,
        event: Dict[str, Any] = None,
    ) -> None:
        """
        Forward a task event to subscribed monitors based on their subscription preferences.

        This method implements the core event routing logic, checking if any
        monitors are subscribed to events for the specified task and whether
        the event type matches their subscription level.

        Args:
            type (EVENT_TYPE): The type/category of the event being forwarded
            id (str): Unique identifier for the specific task instance
            token (str): Unique task identifier associated with the event
            event (Dict[str, Any]): The event payload containing:
                - event: String identifier for the event type
                - body: Event-specific data payload

        Event Routing Logic:
        - Events are only sent to monitors with matching apikey:token subscriptions
        - No forwarding occurs if no monitors are subscribed to the task
        """

        async def _send_event(pref: EVENT_TYPE) -> None:
            """
            Conditionally forward a single event to this connection.

            Checks whether the event_type bits are set in the caller's subscription
            preference (pref). If so, extracts the event name and body from the outer
            event dict and sends it over the DAP transport using the task's short id.

            Args:
                pref (EVENT_TYPE): The merged subscription bitmask for this connection.
                    The event is only forwarded when (event_type & pref) is non-zero.
            """
            # If this is not being listened for, skip the forwarding
            if not (event_type & pref):
                return

            # Extract event details for DAP-compliant forwarding
            evt_name = event.get('event', 'unknown')
            body = event.get('body', None)

            # Send the event to the subscribed client using DAP protocol
            await self.send_event(
                evt_name,
                id=control.id,
                body=body,
            )

        # Get the task by token
        control = self._server.get_task_control_by_token(token)

        # Verify we are allowed to receive events for this task.
        # Uses self._account_info (connection-level) because this is event
        # delivery called by TaskServer.broadcast_task_event, not a command handler.
        info = self._account_info
        if not info:
            return

        # For SSE events, requires data access; for all others, monitor access.
        # Internal and sys.admin credentials get full permissions from
        # resolve_task_permissions — no special bypass needed.
        perms = resolve_task_permissions(info, control.teamId)
        if not perms:
            return
        if event_type == EVENT_TYPE.SSE and 'task.data' not in perms:
            return
        if event_type != EVENT_TYPE.SSE and 'task.monitor' not in perms:
            return

        # Internal connections always receive SSE events (no subscription
        # needed — the orchestrator filters locally). This avoids rrext_monitor
        # churn for every pipe open/close.
        is_internal = 'internal' in getattr(info, 'sysPermissions', [])
        if is_internal and event_type == EVENT_TYPE.SSE:
            await _send_event(EVENT_TYPE.SSE)
            return

        # Build the base project-scoped key
        project_key = f'p.{control.project_id}.{control.source}'

        # Gather all matching subscription keys and merge their preferences
        # so each subscriber receives the event at most once.
        merged_preference = EVENT_TYPE(0)

        # Pipe-scoped check (most specific) — SSE events embed pipe_id in body
        pipe_id = (event or {}).get('body', {}).get('pipe_id')
        if pipe_id is not None:
            pipe_key = f'{project_key}.{pipe_id}'
            if pipe_key in self._monitors:
                merged_preference |= self._monitors[pipe_key]

        # Project-scoped check (exact source match)
        if project_key in self._monitors:
            merged_preference |= self._monitors[project_key]

        # Project-wildcard check (all sources within a project: p.{projectId}.*)
        project_wildcard_key = f'p.{control.project_id}.*'
        if project_wildcard_key != project_key and project_wildcard_key in self._monitors:
            merged_preference |= self._monitors[project_wildcard_key]

        # Global wildcard check (all tasks)
        if '*' in self._monitors:
            merged_preference |= self._monitors['*']

        # Send once with the merged preference
        if merged_preference:
            await _send_event(merged_preference)

        return

    async def _send_updates(
        self,
        control: 'TASK_CONTROL | None',
        prev: EVENT_TYPE,
        curr: EVENT_TYPE,
        project_id: str = None,
        source: str = None,
    ) -> None:
        """
        Send immediate catch-up events for newly enabled subscription bits.

        When a client subscribes to new event types (i.e. bits that were not
        previously set), this method sends the current state for those types
        so the client does not have to wait for the next natural event. This
        keeps clients in sync with the task even if they connect mid-run.

        Currently handled catch-up types:
        - SUMMARY: If the task is running, sends its current status snapshot.
          If the task is not running, sends an empty TASK_STATE.NONE status
          so the client can display a "not running" indicator.
        - TASK: Sends the list of all currently active tasks owned by this user,
          so the client knows which tasks are already in-progress.

        Args:
            control (TASK_CONTROL | None): The task control for the subscription,
                or None if the task is not currently running.
            prev (EVENT_TYPE): The bitmask of event types that were subscribed
                before this call (used to compute which bits are newly set).
            curr (EVENT_TYPE): The new bitmask of event types after the update.
            project_id (str, optional): Project identifier used to build an empty
                status payload when control is None.
            source (str, optional): Source component identifier used alongside
                project_id when control is None.
        """
        # Figure out what was just turned on
        new = curr & ~prev  # Bits that are in curr but NOT in prev

        # If we just turned on summary
        if new & EVENT_TYPE.SUMMARY:
            try:
                if control:
                    # Task is running: send current status
                    await self.send_event(
                        event='apaevt_status_update',
                        id=control.id,
                        body=control.task.get_status().model_dump(),
                    )
                elif project_id is not None and source is not None:
                    # Task is not running: send empty state so client shows "not running"
                    empty_status = TASK_STATUS(
                        state=TASK_STATE.NONE.value,
                        project_id=project_id,
                        source=source,
                        status='Not running',
                    )
                    await self.send_event(
                        event='apaevt_status_update',
                        id=f'{project_id}.{source}',
                        body=empty_status.model_dump(),
                    )
            except Exception:
                pass

        # If we just turned on task
        if new & EVENT_TYPE.TASK:
            try:
                # Loop through all active tasks the caller has access to
                tasks: List[Dict[str, Any]] = []
                for token, target in self._server._task_control.items():
                    # Skip tasks the caller has no team membership for
                    if not resolve_task_permissions(self._account_info, target.teamId):
                        continue

                    # Get the task status once
                    status = target.task.get_status()

                    # Only include tasks that are "active" (not idle, not completed)
                    # Active states: STARTING(1), INITIALIZING(2), RUNNING(3), STOPPING(4)
                    # Exclude: NONE(0), COMPLETED(5), CANCELLED(6)
                    if status.state in [
                        TASK_STATE.STARTING.value,
                        TASK_STATE.INITIALIZING.value,
                        TASK_STATE.RUNNING.value,
                        TASK_STATE.STOPPING.value,
                    ]:
                        tasks.append(
                            {
                                'id': target.id,
                                'name': status.name,
                                'projectId': target.project_id,
                                'source': target.source,
                            }
                        )

                # We use the standard send event since we may not have a control
                await self.send_event(
                    event='apaevt_task',
                    body={
                        'action': 'running',
                        'tasks': tasks,
                    },
                )
            except Exception:
                pass

        # And done
        return

    # =========================================================================
    # OVERRIDABLE HOOKS
    # =========================================================================

    def _resolve_task_by_token(self, token: str):
        """
        Resolve a task token to its control structure.

        OSS (TaskConn): returns the local TASK_CONTROL from TaskServer.
        Orchestrator: overrides to return None (tasks live on EAAS, not locally).

        Args:
            token: Task token string.

        Returns:
            TASK_CONTROL-like object with project_id, source, id, teamId,
            or None if the task cannot be resolved locally.
        """
        return self._server.get_task_control_by_token(token)

    def _resolve_task_by_project(self, project_id: str, source: str):
        """
        Resolve a project_id/source pair to its task control.

        Pure lookup — no permission check. Callers must verify access
        separately using ``verify_task_access()``.

        OSS (TaskConn): returns the local TASK_CONTROL from TaskServer.
        Orchestrator: overrides to look up from _task_table.

        Args:
            project_id: Pipeline project UUID.
            source:     Source component ID.

        Returns:
            TASK_CONTROL-like object, or None if not found locally.
        """
        try:
            return self._server.get_task_control_by_project(project_id, source)
        except RuntimeError:
            return None

    async def _on_monitor_changed(self, event_key: str, subscribed: bool) -> None:
        """
        Hook called after a monitor subscription changes.

        OSS (TaskConn): no-op — events are delivered via local broadcast.
        Orchestrator: overrides to subscribe/unsubscribe the EventBus
        Redis pub/sub channel so task events flow to this connection.

        Args:
            event_key:  The subscription key (e.g. ``'p.{pid}.{src}'`` or ``'*'``).
            subscribed: True if subscribed, False if unsubscribed.
        """
        pass

    # =========================================================================
    # MONITOR PERMISSION CHECK
    # =========================================================================

    def _verify_monitor_permissions(self, team_id: str, event_type: EVENT_TYPE) -> None:
        """
        Verify the caller has the right permissions for the requested event types.

        ``task.monitor`` is required for non-SSE events (SUMMARY, FLOW, etc.).
        ``task.data`` is required for SSE events (data pipe streaming).

        Mirrors the delivery-time check in ``send_task_event`` but rejects
        the subscription upfront instead of silently dropping events later.

        Args:
            team_id:    Team that owns the task.
            event_type: EVENT_TYPE bitmask the caller is requesting.

        Raises:
            PermissionError: If the caller lacks the required permission.
        """
        # NONE removes a subscription. Removal must always be allowed — a caller
        # whose team access was revoked still needs to clear its stale monitor,
        # otherwise the entry lingers in _monitors and keeps receiving events.
        if event_type == EVENT_TYPE.NONE:
            return

        perms = resolve_task_permissions(self._account_info, team_id)
        if not perms:
            raise PermissionError('Access denied: no permissions for this task')

        # Check specific permission for the requested event types
        has_sse = bool(event_type & EVENT_TYPE.SSE)
        has_non_sse = bool(event_type & ~EVENT_TYPE.SSE)
        if has_non_sse and 'task.monitor' not in perms:
            raise PermissionError('task.monitor permission required')
        if has_sse and 'task.data' not in perms:
            raise PermissionError('task.data permission required')

    # =========================================================================
    # SET MONITOR
    # =========================================================================

    async def set_monitor(
        self,
        token: str = None,
        project_id: str = None,
        source: str = None,
        pipe_id: int = None,
        type: EVENT_TYPE = EVENT_TYPE.NONE,
    ) -> Dict[str, Any]:
        """
        Configure event monitoring subscription for a specific task.

        Updates the ``_monitors`` registry to add, modify, or remove event
        subscriptions.  Calls ``_resolve_task_by_token`` / ``_resolve_task_by_project``
        for task resolution (overridable) and ``_on_monitor_changed`` after
        the subscription changes (overridable for EventBus integration).

        Works identically on OSS standalone (TaskConn) and the Orchestrator
        (OrchestratorConn) — subclasses only override the hooks above.

        Args:
            token:      Task token, or ``'*'`` for all tasks.
            project_id: Alternative to token — project UUID.
            source:     Alternative to token — source component ID.
            pipe_id:    Optional pipe-level filter.
            type:       EVENT_TYPE bitmask.  NONE removes the subscription.

        Returns:
            event_id string for the response body, or None.
        """
        control = None

        # ── Resolve subscription target ──────────────────────────────────

        if token == '*':
            # Wildcard: monitor all tasks
            if project_id or source:
                raise ValueError('You must specify either token or project_id/source, not both')
            event_key = '*'
            event_id = None
            filter_name = '<all>'

        elif token:
            # Token: resolve to project_id/source
            if project_id or source:
                raise ValueError('You must specify either token or project_id/source, not both')

            control = self._resolve_task_by_token(token)

            if control:
                # Verify the caller has permission for the requested event types
                self._verify_monitor_permissions(control.teamId, type)
                event_key = f'p.{control.project_id}.{control.source}'
                event_id = control.id
                filter_name = control.id
            else:
                # Task not resolvable locally (orchestrator) — derive key from token
                event_key = f't.{token}'
                event_id = None
                filter_name = f'<token:{token[:8]}>'

        elif project_id and source:
            # Project/source: resolve directly
            event_key = f'p.{project_id}.{source}'

            control = self._resolve_task_by_project(project_id, source)
            if control:
                # Verify the caller has permission for the requested event types
                self._verify_monitor_permissions(control.teamId, type)
                event_id = control.id
                filter_name = control.id
            else:
                event_id = None
                filter_name = f'<Project:{project_id[:8]}.{source}>'

        else:
            raise ValueError('You must specify either token or project_id/source')

        # Narrow to pipe if specified
        if pipe_id is not None and event_key != '*':
            event_key = f'{event_key}.{pipe_id}'
            filter_name = f'{filter_name}.pipe{pipe_id}'

        # ── Update subscription registry ─────────────────────────────────

        try:
            if type == EVENT_TYPE.NONE:
                # Unsubscribe
                self._monitors.pop(event_key, None)
                self.debug_message(f'Removed monitoring for "{filter_name}"')

                # Notify hook (EventBus unsubscribe on orchestrator)
                await self._on_monitor_changed(event_key, subscribed=False)

                # Dashboard notification
                await self._server.broadcast_server_event(
                    EVENT_TYPE.DASHBOARD,
                    {
                        'event': 'apaevt_dashboard',
                        'body': {
                            'action': 'monitor_changed',
                            'timestamp': time.time(),
                            'connectionId': self.get_connection_id(),
                            'clientName': self._client_info.get('name'),
                            'clientVersion': self._client_info.get('version'),
                            'key': filter_name,
                            'change': 'unsubscribed',
                        },
                    },
                    user_id=self._account_info.userId if self._account_info else None,
                )
            else:
                # Subscribe or update
                prev = self._monitors.get(event_key, EVENT_TYPE.NONE)
                self._monitors[event_key] = type
                self.debug_message(f'Set "{filter_name}" monitoring to {type}')

                # Notify hook (EventBus subscribe on orchestrator)
                await self._on_monitor_changed(event_key, subscribed=True)

                # Dashboard notification
                await self._server.broadcast_server_event(
                    EVENT_TYPE.DASHBOARD,
                    {
                        'event': 'apaevt_dashboard',
                        'body': {
                            'action': 'monitor_changed',
                            'timestamp': time.time(),
                            'connectionId': self.get_connection_id(),
                            'clientName': self._client_info.get('name'),
                            'clientVersion': self._client_info.get('version'),
                            'key': filter_name,
                            'change': 'subscribed',
                        },
                    },
                    user_id=self._account_info.userId if self._account_info else None,
                )

                # Send catch-up events for newly enabled bits
                await self._send_updates(control, prev, type, project_id=project_id, source=source)

            return event_id

        except Exception as e:
            self.debug_message(f'Error configuring monitoring: {str(e)}')
            raise

    async def on_rrext_monitor(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP 'rrext_monitor' command to establish or modify event subscriptions.

        This is the main entry point for clients to configure their event monitoring
        preferences. It processes the monitoring request, updates subscriptions,
        and optionally sends an immediate status update for active tasks.

        Args:
            request (Dict[str, Any]): DAP monitor request containing:
                - apikey: Authentication key for task access
                - token: Task identifier to monitor
                - arguments: Configuration options including:
                    - listenType: int with EVENT_TYPE bit flags

        Returns:
            Dict[str, Any]: DAP-compliant response acknowledging subscription change

        Workflow:
        1. Extract authentication and task identification from request
        2. Parse subscription preferences from request arguments
        3. Update monitor registry with new subscription settings
        4. Attempt to send immediate status update if task is active
        5. Return confirmation response to client

        Raises:
            Exception: If subscription setup or status update fails
        """

        def strings_to_bitmask(event_strings: List[str]) -> int:
            """
            Convert an array of event type name strings into a combined integer bitmask.

            Each string is matched case-insensitively against the EVENT_TYPE enum.
            Unrecognised strings are silently ignored (with a console warning) so that
            clients sending unknown type names do not cause a hard failure.

            Args:
                event_strings (List[str]): List of EVENT_TYPE member names, e.g.
                    ['SUMMARY', 'TASK', 'SSE'].

            Returns:
                int: OR-combination of the matching EVENT_TYPE values.
                    Returns 0 if the list is empty or all names are unrecognised.
            """
            bitmask = 0
            for event_str in event_strings:
                try:
                    # Convert string to enum and OR it into the bitmask
                    event_type = EVENT_TYPE[event_str.upper()]
                    bitmask |= event_type.value
                except KeyError:
                    print(f"Warning: Unknown event type '{event_str}' ignored")
            return bitmask

        # Verify permission and extract the task token
        token = self.get_task_token(request, ctx, 'task.monitor')

        # Parse monitoring configuration from request arguments
        args = request.get('arguments', {})

        # Get the project_id/source/pipeId if specified
        project_id = args.get('projectId', None)
        source = args.get('source', None)
        pipe_id = args.get('pipeId', None)

        # Determine the desired event subscription level
        types = args.get('types', None)

        # Handle string array, integer bitmask, and legacy listenType formats
        if isinstance(types, list):
            bitmask_value = strings_to_bitmask(types)
        elif isinstance(types, int):
            bitmask_value = types
        elif isinstance(types, str) and types.isdigit():
            bitmask_value = int(types)
        else:
            # Fallback to legacy listenType or no events
            listen_type = args.get('listenType', 0)
            bitmask_value = int(listen_type) if isinstance(listen_type, (int, float)) else 0

        # Create EVENT_TYPE enum from the bitmask
        event_type = EVENT_TYPE(bitmask_value)

        # Update the subscription registry
        await self.set_monitor(
            token=token,
            project_id=project_id,
            source=source,
            pipe_id=pipe_id,
            type=event_type,
        )

        # Acknowledge successful subscription setup
        return self.build_response(request)

    # =========================================================================
    # DASHBOARD
    # =========================================================================

    async def on_rrext_dashboard(self, request: DAPRequest, ctx: RequestContext) -> DAPResponse:
        """
        Handle DAP 'rrext_dashboard' command to retrieve server dashboard data.

        Returns a snapshot of the server's current state including overview
        metrics, active connections, and task information for administrative
        monitoring dashboards.

        Args:
            request: DAP request. Optional ``arguments`` carry per-section
                pagination: ``tasks`` / ``connections`` ->
                ``{offset, limit, sort_by, sort_order, state_filter}``. A section
                with ``limit=0`` is omitted from the response; an absent
                ``limit`` returns all rows from ``offset``.
            ctx:     RequestContext with authenticated caller identity.

        Returns:
            DAP response containing:
                - body.overview: server-level aggregate metrics (over ALL
                  accessible tasks, independent of the page).
                - body.tasks / body.connections: the requested page (omitted
                  when that section's ``limit`` is 0).
                - body.tasks_total / body.connections_total: row counts matching
                  the (state-)filtered set, for the pagination UI.
        """
        try:
            # Require monitor permission
            self.verify_permission('task.monitor', ctx)

            server = self._server
            current_time = time.time()
            caller_user_id = ctx.account_info.userId

            # Per-section pagination parameters (all optional).
            args = request.get('arguments') or {}
            task_params = args.get('tasks') or {}
            conn_params = args.get('connections') or {}

            # Snapshot tasks the caller has access to (own, teammate, org admin)
            task_controls = [
                c for c in server._task_control.values() if resolve_task_permissions(ctx.account_info, c.teamId)
            ]
            # Connections are user-scoped (not task-scoped), so filter by userId
            conn_items = [
                (cid, conn)
                for cid, conn in server._connections.items()
                if hasattr(conn, '_account_info') and conn._account_info and conn._account_info.userId == caller_user_id
            ]

            # Task-scoped tokens (tk_) can only see their own task
            caller_auth = ctx.account_info.auth if hasattr(ctx.account_info, 'auth') else ''
            if caller_auth.startswith('tk_'):
                task_controls = [c for c in task_controls if c.token == caller_auth]
                conn_items = [(cid, conn) for cid, conn in conn_items if cid == self._connection_id]

            # Build connection-to-task mapping by scanning task controls
            conn_tasks: Dict[int, List[str]] = {}
            for control in task_controls:
                if control.task is None:
                    continue
                task_name = getattr(control.task.get_status(), 'name', None) or control.source
                for cid, conn in conn_items:
                    if not hasattr(conn, '_monitors'):
                        continue
                    project_key = f'p.{control.project_id}.{control.source}'
                    project_wildcard_key = f'p.{control.project_id}.*'
                    pipe_prefix = f'{project_key}.'
                    if (
                        project_key in conn._monitors
                        or project_wildcard_key in conn._monitors
                        or '*' in conn._monitors
                        or any(k.startswith(pipe_prefix) for k in conn._monitors)
                    ):
                        conn_tasks.setdefault(cid, []).append(task_name)

            # Build project ID → friendly name map from task controls
            # so monitor keys like p.{uuid}.{source} can be displayed readably
            project_names: Dict[str, str] = {}
            source_names: Dict[str, str] = {}
            for control in task_controls:
                if control.task is None:
                    continue
                status = control.task.get_status()
                task_name = getattr(status, 'name', None) or control.source
                # Use the task_name prefix (before the dot) as project label
                name_parts = task_name.split('.', 1)
                project_names.setdefault(control.project_id, name_parts[0])
                source_names.setdefault(
                    f'{control.project_id}.{control.source}', name_parts[-1] if len(name_parts) > 1 else control.source
                )

            # Build connections list
            connections = []
            for conn_id, conn in conn_items:
                conn_info: Dict[str, Any] = {
                    'id': conn_id,
                    'connectedAt': getattr(conn, '_connected_at', current_time),
                    'lastActivity': getattr(conn, '_last_activity', current_time),
                    'messagesIn': getattr(conn, '_messages_in', 0),
                    'messagesOut': getattr(conn, '_messages_out', 0),
                    'authenticated': getattr(conn, '_authenticated', False),
                    'clientId': None,
                    'clientInfo': getattr(conn, '_client_info', {}),
                    'appName': getattr(conn, '_app_name', ''),
                    'monitors': self._build_monitors_list(conn._monitors, project_names, source_names)
                    if hasattr(conn, '_monitors')
                    else [],
                    'attachedTasks': conn_tasks.get(conn_id, []),
                }
                if hasattr(conn, '_account_info') and conn._account_info:
                    conn_info['clientId'] = conn._account_info.userId
                connections.append(conn_info)

            # Build tasks list
            tasks = []
            for control in task_controls:
                try:
                    task_status = control.task.get_status()
                    start = getattr(task_status, 'startTime', 0) or 0
                    end = getattr(task_status, 'endTime', 0) or 0
                    completed = getattr(task_status, 'completed', False)
                    if completed and start > 0 and end > 0:
                        elapsed = end - start
                    elif start > 0:
                        elapsed = current_time - start
                    else:
                        elapsed = 0

                    # Convert Pydantic metrics model to plain dict for JSON serialization
                    metrics_raw = getattr(task_status, 'metrics', None)
                    metrics_dict = metrics_raw.model_dump() if hasattr(metrics_raw, 'model_dump') else metrics_raw

                    tasks.append(
                        {
                            'id': control.id,
                            'name': getattr(task_status, 'name', control.source),
                            'projectId': control.project_id,
                            'source': control.source,
                            'provider': control.provider,
                            'launchType': control.launch_type.value,
                            'startTime': start,
                            'elapsedTime': elapsed,
                            'completed': completed,
                            'status': getattr(task_status, 'status', None) if not completed else None,
                            'exitCode': getattr(task_status, 'exitCode', None) if completed else None,
                            'endTime': end if completed else None,
                            'connections': control.task.get_connection_count(),
                            'state': getattr(task_status, 'state', 0),
                            'idleTime': getattr(control.task, '_idle_time', 0),
                            'ttl': getattr(control.task, '_ttl', 0),
                            'metrics': metrics_dict,
                            'totalCount': getattr(task_status, 'totalCount', 0),
                            'completedCount': getattr(task_status, 'completedCount', 0),
                            'rateCount': getattr(task_status, 'rateCount', 0),
                            'rateSize': getattr(task_status, 'rateSize', 0),
                        }
                    )
                except Exception as e:
                    self.debug_message(f'Error building task info for "{control.id}": {e}')
                    continue

            # Build overview — derive from the sanitized tasks list to avoid
            # re-calling get_status() on potentially torn-down controls. The
            # overview is a global snapshot over ALL accessible tasks, so it is
            # computed BEFORE the state_filter / pagination applied below.
            active_count = sum(1 for task in tasks if not task['completed'])
            completed_count = len(tasks) - active_count
            start_time = getattr(server._server, '_startTime', None) or current_time
            overview = {
                'totalConnections': len(conn_items),
                'activeTasks': active_count,
                'completedTasks': completed_count,
                'totalTasks': len(tasks),
                'serverUptime': current_time - start_time,
                'eaasNodes': 0,
            }

            # Apply the tasks state_filter (running vs completed) before paging;
            # tasks_total then reflects the count matching the filter.
            state_filter = task_params.get('state_filter')
            if state_filter == 'running':
                tasks = [t for t in tasks if not t['completed']]
            elif state_filter == 'completed':
                tasks = [t for t in tasks if t['completed']]

            # Sort + slice each section; *_total is the pre-slice filtered count.
            tasks_page, tasks_total = _paginate(tasks, task_params)
            connections_page, connections_total = _paginate(connections, conn_params)

            body: Dict[str, Any] = {
                'overview': overview,
                'tasks_total': tasks_total,
                'connections_total': connections_total,
            }
            # A section whose limit is 0 is omitted (page is None).
            if tasks_page is not None:
                body['tasks'] = tasks_page
            if connections_page is not None:
                body['connections'] = connections_page

            return self.build_response(request, body=body)

        except Exception as e:
            self.debug_message(f'Failed to retrieve dashboard data: {str(e)}')
            raise

    @staticmethod
    def _build_monitors_list(
        monitors: Dict[str, 'EVENT_TYPE'],
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> List[Dict[str, Any]]:
        """Convert the _monitors dict into a list of {key, flags} objects for the dashboard."""
        result = []
        for key, flags in monitors.items():
            flag_names = [f.name.lower() for f in EVENT_TYPE if f.value and f in flags]
            label = MonitorCommands._resolve_monitor_label(key, project_names, source_names)
            result.append({'key': label, 'flags': flag_names})
        return result

    @staticmethod
    def _resolve_monitor_label(
        key: str,
        project_names: Dict[str, str],
        source_names: Dict[str, str],
    ) -> str:
        """Resolve a raw monitor key into a human-friendly label."""
        if key == '*':
            return 'All tasks'

        if not key.startswith('p.'):
            return 'Task monitor'

        # Strip the 'p.' prefix and split: projectId, source, [pipeId]
        parts = key[2:].split('.', 2)
        project_id = parts[0]
        project_label = project_names.get(project_id, project_id[:8])

        if len(parts) == 1 or (len(parts) == 2 and parts[1] == '*'):
            return f'{project_label}.*'

        source = parts[1]
        source_label = source_names.get(f'{project_id}.{source}', source)

        if len(parts) == 3:
            return f'{project_label}.{source_label}.pipe{parts[2]}'

        return f'{project_label}.{source_label}'
