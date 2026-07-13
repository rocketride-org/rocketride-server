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
Dashboard Types for RocketRide Server Monitor.

Defines TypedDict structures for the server dashboard API response
(rrext_dashboard command), providing typed access to server overview
metrics, connection details, and task information.

Usage:
    from rocketride.types import DASHBOARD_RESPONSE

    dashboard: DASHBOARD_RESPONSE = await client.get_dashboard()
    print(f"Active tasks: {dashboard['overview']['activeTasks']}")
    for conn in dashboard['connections']:
        print(f"Connection {conn['id']}: {conn['messagesIn']} msgs in")
"""

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union


class DASHBOARD_OVERVIEW(TypedDict):
    """Server-level aggregate metrics (scoped to the caller's account)."""

    totalConnections: int  # Number of currently active WebSocket connections for this account
    activeTasks: int  # Number of tasks currently running for this account
    completedTasks: int  # Number of accessible tasks that have completed
    totalTasks: int  # Total accessible tasks (active + completed)
    serverUptime: float  # Seconds since server started
    eaasNodes: int  # Number of EAAS worker nodes (SaaS; 0 in OSS)


class DASHBOARD_MONITOR(TypedDict):
    """A single monitor subscription with its event flags."""

    key: str  # Human-friendly subscription label
    flags: List[str]  # Active event type flags (e.g. ['summary', 'task'])


class DASHBOARD_CONNECTION(TypedDict, total=False):
    """Details for a single active WebSocket connection."""

    id: int  # Unique monotonic connection identifier
    connectedAt: float  # Unix timestamp when connection was established
    lastActivity: float  # Unix timestamp of last received message
    messagesIn: int  # Total messages received from this client
    messagesOut: int  # Total messages sent to this client
    authenticated: bool  # Whether the connection has completed auth
    clientId: str  # AccountInfo.clientid (account identifier)
    apikey: str  # Masked API key (first 4 + last 4 chars)
    clientInfo: Dict[str, str]  # Client SDK name/version from auth handshake (immutable)
    appName: str  # App-level display name set by identify() (mutable)
    monitors: List[DASHBOARD_MONITOR]  # Active monitor subscriptions with flags
    attachedTasks: List[str]  # Task display names this connection is monitoring


class DASHBOARD_TASK(TypedDict, total=False):
    """Details for a single managed task."""

    id: str  # Human-readable task identifier (token_hash[:8].source)
    name: str  # Display name ({task_name|task_id}.{component_name|source})
    projectId: str  # Project identifier
    source: str  # Source component identifier
    provider: str  # Provider name
    launchType: str  # 'launch' or 'execute'
    startTime: float  # Unix timestamp when task was created
    elapsedTime: float  # Runtime duration in seconds
    completed: bool  # Whether the task has finished
    status: Optional[str]  # Current status message (running tasks only)
    exitCode: Optional[int]  # Exit code (completed tasks only)
    endTime: Optional[float]  # Unix timestamp of completion (completed tasks only)
    connections: int  # Number of attached client connections
    state: int  # TASK_STATE enum value
    idleTime: int  # Seconds since last activity
    ttl: int  # Time-to-live in seconds (0 = no timeout)
    metrics: Optional[Dict[str, Any]]  # Performance metrics (timers, counters)
    totalCount: int  # Total items to process
    completedCount: int  # Items completed so far
    rateCount: int  # Current processing rate (items/sec)
    rateSize: int  # Current processing rate (bytes/sec)


class DASHBOARD_PAGE_PARAMS(TypedDict, total=False):
    """Per-section pagination / sort / filter for a dashboard request."""

    offset: int  # Row offset into the filtered, sorted list (default 0)
    limit: int  # Max rows to return; 0 omits the section; absent returns all
    sort_by: str  # Field to sort by (e.g. 'startTime', 'name')
    sort_order: Literal['asc', 'desc']  # Sort direction (default 'desc')
    state_filter: Literal['running', 'completed']  # Tasks only: filter by state


class DASHBOARD_REQUEST(TypedDict, total=False):
    """Optional arguments for the rrext_dashboard command (per section)."""

    tasks: DASHBOARD_PAGE_PARAMS
    connections: DASHBOARD_PAGE_PARAMS


class _DASHBOARD_RESPONSE_BASE(TypedDict):
    """Required keys of the rrext_dashboard response (always present)."""

    overview: DASHBOARD_OVERVIEW


class DASHBOARD_RESPONSE(_DASHBOARD_RESPONSE_BASE, total=False):
    """
    Complete response from the rrext_dashboard command.

    ``overview`` is always present. ``tasks`` / ``connections`` are omitted when
    that section's ``limit`` is 0; ``tasks_total`` / ``connections_total`` give
    the row counts matching the (state-)filtered set, for the pagination UI.
    """

    tasks: List[DASHBOARD_TASK]
    tasks_total: int
    connections: List[DASHBOARD_CONNECTION]
    connections_total: int


# ============================================================================
# Dashboard Activity Events
# ============================================================================


class _DASHBOARD_EVENT_BASE(TypedDict):
    """Base fields shared by all dashboard events."""

    timestamp: float  # Unix timestamp when the event occurred


class DASHBOARD_EVENT_CONNECTION_ADDED(_DASHBOARD_EVENT_BASE):
    """A new connection authenticated with the server."""

    action: Literal['connection_added']
    connectionId: int
    clientName: Optional[str]
    clientVersion: Optional[str]
    clientId: Optional[str]


class DASHBOARD_EVENT_CONNECTION_REMOVED(_DASHBOARD_EVENT_BASE):
    """A connection was closed."""

    action: Literal['connection_removed']
    connectionId: int
    clientName: Optional[str]
    clientVersion: Optional[str]


class DASHBOARD_EVENT_TASK_STARTED(_DASHBOARD_EVENT_BASE):
    """A task was started or restarted."""

    action: Literal['task_started']
    taskId: str


class DASHBOARD_EVENT_TASK_STOPPED(_DASHBOARD_EVENT_BASE):
    """A task stopped (completed or errored)."""

    action: Literal['task_stopped']
    taskId: str


class DASHBOARD_EVENT_TASK_REMOVED(_DASHBOARD_EVENT_BASE):
    """A completed task was cleaned up from the registry."""

    action: Literal['task_removed']
    taskId: str


class DASHBOARD_EVENT_TASK_ERROR(_DASHBOARD_EVENT_BASE):
    """A task exited with a non-zero exit code."""

    action: Literal['task_error']
    taskId: str
    exitCode: int
    exitMessage: Optional[str]


class DASHBOARD_EVENT_AUTH_FAILED(_DASHBOARD_EVENT_BASE):
    """An authentication attempt failed."""

    action: Literal['auth_failed']
    connectionId: int
    reason: str


class DASHBOARD_EVENT_MONITOR_CHANGED(_DASHBOARD_EVENT_BASE):
    """A monitor subscription changed on a connection."""

    action: Literal['monitor_changed']
    connectionId: int
    clientName: Optional[str]
    clientVersion: Optional[str]
    key: str
    change: Literal['subscribed', 'unsubscribed']


DASHBOARD_EVENT = Union[
    DASHBOARD_EVENT_CONNECTION_ADDED,
    DASHBOARD_EVENT_CONNECTION_REMOVED,
    DASHBOARD_EVENT_TASK_STARTED,
    DASHBOARD_EVENT_TASK_STOPPED,
    DASHBOARD_EVENT_TASK_REMOVED,
    DASHBOARD_EVENT_TASK_ERROR,
    DASHBOARD_EVENT_AUTH_FAILED,
    DASHBOARD_EVENT_MONITOR_CHANGED,
]
