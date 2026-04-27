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

from ..core import DAPClient
from ..types.dashboard import DASHBOARD_RESPONSE


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
