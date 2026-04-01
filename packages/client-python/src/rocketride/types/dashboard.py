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

from typing import Any, Dict, List, TypedDict


class DASHBOARD_OVERVIEW(TypedDict):
    """Server-level aggregate metrics (scoped to the caller's account)."""

    totalConnections: int  # Number of currently active WebSocket connections for this account
    activeTasks: int  # Number of tasks currently in the registry for this account
    serverUptime: float  # Seconds since server started


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
    clientInfo: Dict[str, str]  # Client name/version from auth handshake
    monitors: List[str]  # Active monitor subscription keys
    attachedTasks: List[str]  # Task IDs this connection is monitoring


class DASHBOARD_TASK(TypedDict, total=False):
    """Details for a single managed task."""

    id: str  # Human-readable task identifier (token[:8].source)
    projectId: str  # Project identifier
    source: str  # Source component identifier
    provider: str  # Provider name
    launchType: str  # 'launch' or 'execute'
    startTime: float  # Unix timestamp when task was created
    elapsedTime: float  # Runtime duration in seconds
    completed: bool  # Whether the task has finished
    status: str  # Current status message (running tasks only)
    exitCode: int  # Exit code (completed tasks only)
    endTime: float  # Unix timestamp of completion (completed tasks only)
    connections: int  # Number of attached client connections
    state: int  # TASK_STATE enum value
    idleTime: int  # Seconds since last activity
    ttl: int  # Time-to-live in seconds (0 = no timeout)
    metrics: Dict[str, Any]  # Performance metrics (timers, counters)


class DASHBOARD_RESPONSE(TypedDict):
    """Complete response from the rrext_dashboard command."""

    overview: DASHBOARD_OVERVIEW
    connections: List[DASHBOARD_CONNECTION]
    tasks: List[DASHBOARD_TASK]
