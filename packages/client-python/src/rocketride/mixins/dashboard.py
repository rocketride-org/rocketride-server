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
Dashboard Mixin for RocketRide Client.

Provides the get_dashboard() method to retrieve a server dashboard snapshot
containing overview metrics, active connections, and task information, plus
list_connections() / list_tasks() — paginated views of the same rows
following the platform list-API convention.

Usage:
    dashboard = await client.get_dashboard()
    print(f"Connections: {dashboard['overview']['totalConnections']}")
    print(f"Active tasks: {dashboard['overview']['activeTasks']}")

    page = await client.list_tasks({'page': 1, 'page_size': 25})
    print(f"{page['total']} tasks, showing {len(page['rows'])}")
"""

from typing import Optional

from ..core import DAPClient
from ..types.dashboard import (
    DASHBOARD_RESPONSE,
    LIST_CONNECTIONS_RESPONSE,
    LIST_PAGE_REQUEST,
    LIST_TASKS_RESPONSE,
)


class DashboardMixin(DAPClient):
    """
    Provides server dashboard retrieval for the RocketRide client.

    This mixin adds get_dashboard() to fetch a real-time snapshot of
    server state via the DAP rrext_dashboard command, and
    list_connections() / list_tasks() for paginated views of the same
    caller-scoped rows. Requires the 'task.monitor' permission (or
    wildcard '*').

    This is automatically included when you use RocketRideClient.
    """

    def __init__(self, **kwargs):
        """Initialize dashboard functionality."""
        super().__init__(**kwargs)

    async def get_dashboard(self) -> DASHBOARD_RESPONSE:
        """
        Retrieve a server dashboard snapshot.

        Returns the current state of all connections, tasks, and aggregate
        metrics from the server. This is a point-in-time snapshot; for
        real-time updates, subscribe to DASHBOARD events via set_events().

        Returns:
            DASHBOARD_RESPONSE containing overview metrics, connection
            details, and task information.

        Raises:
            RuntimeError: If the server returns an error (e.g. permission denied).

        Example:
            dashboard = await client.get_dashboard()
            for task in dashboard['tasks']:
                print(f"{task['id']}: {task['status']} ({task['elapsedTime']:.0f}s)")
        """
        return await self.call('rrext_dashboard')

    async def list_connections(self, req: Optional[LIST_PAGE_REQUEST] = None) -> LIST_CONNECTIONS_RESPONSE:
        """
        Retrieve one page of the caller's active connections (platform
        list-API convention). Rows carry the same shape as the dashboard's
        connections list; the default sort is connectedAt ascending
        (registration order, matching the dashboard) with the monotonic id
        as tiebreak. Requires 'task.monitor' permission.

        Args:
            req: Optional LIST_PAGE_REQUEST with page, page_size, search,
                sort, and filters — server defaults apply for omitted keys.

        Returns:
            LIST_CONNECTIONS_RESPONSE: the standard {rows, total, page,
            pageSize} envelope.

        Raises:
            RuntimeError: If the server returns an error (e.g. permission denied).

        Example:
            page = await client.list_connections({'page': 1, 'page_size': 25})
            for conn in page['rows']:
                print(f"{conn['id']}: {conn['messagesIn']} msgs in")
        """
        # Forward only the supplied convention arguments as request kwargs
        return await self.call('rrext_list_connections', **(req or {}))

    async def list_tasks(self, req: Optional[LIST_PAGE_REQUEST] = None) -> LIST_TASKS_RESPONSE:
        """
        Retrieve one page of the caller's tasks (platform list-API
        convention). Rows carry the same shape as the dashboard's tasks
        list; the default sort is startTime ascending (creation order,
        matching the dashboard) with the task id as tiebreak. Requires
        'task.monitor' permission.

        Args:
            req: Optional LIST_PAGE_REQUEST with page, page_size, search,
                sort, and filters — server defaults apply for omitted keys.

        Returns:
            LIST_TASKS_RESPONSE: the standard {rows, total, page, pageSize}
            envelope.

        Raises:
            RuntimeError: If the server returns an error (e.g. permission denied).

        Example:
            page = await client.list_tasks({'search': 'ocr', 'page_size': 10})
            for task in page['rows']:
                print(f"{task['id']}: {task['name']}")
        """
        # Forward only the supplied convention arguments as request kwargs
        return await self.call('rrext_list_tasks', **(req or {}))
