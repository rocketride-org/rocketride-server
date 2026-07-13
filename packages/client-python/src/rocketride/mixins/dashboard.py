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
containing overview metrics, active connections, and task information.

Usage:
    dashboard = await client.get_dashboard()
    print(f"Connections: {dashboard['overview']['totalConnections']}")
    print(f"Active tasks: {dashboard['overview']['activeTasks']}")
"""

from typing import Optional

from ..core import DAPClient
from ..types.dashboard import DASHBOARD_PAGE_PARAMS, DASHBOARD_RESPONSE


class DashboardMixin(DAPClient):
    """
    Provides server dashboard retrieval for the RocketRide client.

    This mixin adds get_dashboard() to fetch a real-time snapshot of
    server state via the DAP rrext_dashboard command. Requires the
    'server.monitor' permission (or wildcard '*').

    This is automatically included when you use RocketRideClient.
    """

    def __init__(self, **kwargs):
        """Initialize dashboard functionality."""
        super().__init__(**kwargs)

    async def get_dashboard(
        self,
        tasks: Optional[DASHBOARD_PAGE_PARAMS] = None,
        connections: Optional[DASHBOARD_PAGE_PARAMS] = None,
    ) -> DASHBOARD_RESPONSE:
        """
        Retrieve a server dashboard snapshot, optionally paginated per section.

        Returns the current state of connections, tasks, and aggregate metrics.
        This is a point-in-time snapshot; for real-time updates, subscribe to
        DASHBOARD events via set_events().

        Args:
            tasks: Optional ``{offset, limit, sort_by, sort_order, state_filter}``
                pagination for the tasks section. ``limit=0`` omits the section;
                omitted returns all rows. Absent = unpaginated (all tasks).
            connections: Same pagination shape for the connections section.

        Returns:
            DASHBOARD_RESPONSE with ``overview`` and, per section, the requested
            page (``tasks`` / ``connections``, omitted when ``limit=0``) plus
            ``tasks_total`` / ``connections_total`` (rows matching the filter).

        Raises:
            RuntimeError: If the server returns an error (e.g. permission denied).

        Example:
            page = await client.get_dashboard(
                tasks={'offset': 0, 'limit': 25, 'sort_by': 'startTime', 'sort_order': 'desc'},
            )
            print(f"{len(page['tasks'])} of {page['tasks_total']} tasks")
        """
        # Only forward sections the caller supplied; empty kwargs -> unpaginated.
        kwargs = {}
        if tasks:
            kwargs['tasks'] = tasks
        if connections:
            kwargs['connections'] = connections
        return await self.call('rrext_dashboard', **kwargs)
