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
CProfile Mixin for RocketRide Client.

Provides methods to start/stop cProfile profiling sessions on the server
process or on pipeline engine subprocesses, and retrieve pstats reports.

Usage:
    # Profile the server process
    result = await client.cprofile_start(session='my_test')
    # ... do work ...
    result = await client.cprofile_stop()
    report = await client.cprofile_report()
    print(report['report'])

    # Profile a specific pipeline
    result = await client.cprofile_start(target='tk_abc123', session='pipeline_test')
"""

from typing import Any, Dict, Optional
from ..core import DAPClient


# =============================================================================
# CPROFILE MIXIN
# =============================================================================


class CProfileMixin(DAPClient):
    """
    Provides cProfile process profiling for the RocketRide client.

    This mixin adds cprofile_start(), cprofile_stop(), cprofile_status(),
    and cprofile_report() methods that send rrext_cprofile_* DAP commands.
    Each method accepts an optional ``target`` parameter: when None, the
    server process itself is profiled; when a task token, the corresponding
    pipeline's engine subprocess is profiled via the server's proxy.

    This is automatically included when you use RocketRideClient.
    """

    def __init__(self, **kwargs):
        """Initialize cProfile mixin."""
        super().__init__(**kwargs)

    async def cprofile_start(self, target: Optional[str] = None, session: Optional[str] = None) -> Dict[str, Any]:
        """
        Start a cProfile profiling session.

        Args:
            target: Task token to profile a pipeline subprocess, or None
                    to profile the server process itself.
            session: Optional human-readable name for the session.

        Returns:
            Dict with status, session name, owner, and start_time.

        Raises:
            RuntimeError: If profiling is already active.

        Example:
            result = await client.cprofile_start(session='load_test')
            print(f"Started: {result['session']}")
        """
        # Build arguments — only include non-None values
        args: Dict[str, Any] = {}
        if target:
            args['target'] = target
        if session:
            args['session'] = session
        return await self.call('rrext_cprofile_start', args)

    async def cprofile_stop(self, target: Optional[str] = None) -> Dict[str, Any]:
        """
        Stop the active cProfile profiling session.

        Args:
            target: Task token if profiling a pipeline, or None for server.

        Returns:
            Dict with status, session name, and runtime.

        Raises:
            RuntimeError: If no session is active or caller is not the owner.

        Example:
            result = await client.cprofile_stop()
            print(f"Ran for {result['runtime']:.2f}s")
        """
        args: Dict[str, Any] = {}
        if target:
            args['target'] = target
        return await self.call('rrext_cprofile_stop', args)

    async def cprofile_status(self, target: Optional[str] = None) -> Dict[str, Any]:
        """
        Get the current cProfile profiling status.

        Args:
            target: Task token if querying a pipeline, or None for server.

        Returns:
            Dict with active flag, owner, session name, and runtime.

        Example:
            status = await client.cprofile_status()
            if status['active']:
                print(f"Profiling '{status['session']}' for {status['runtime']:.1f}s")
        """
        args: Dict[str, Any] = {}
        if target:
            args['target'] = target
        return await self.call('rrext_cprofile_status', args)

    async def cprofile_report(self, target: Optional[str] = None) -> Dict[str, Any]:
        """
        Get the full cProfile report from the last completed session.

        Args:
            target: Task token if querying a pipeline, or None for server.

        Returns:
            Dict with 'report' key containing the full pstats text.

        Example:
            result = await client.cprofile_report()
            print(result['report'])
        """
        args: Dict[str, Any] = {}
        if target:
            args['target'] = target
        return await self.call('rrext_cprofile_report', args)

    async def cprofile_report_tree(
        self,
        target: Optional[str] = None,
        max_depth: int = 50,
        min_pct: float = 0.1,
        include_system: bool = True,
    ) -> Dict[str, Any]:
        """
        Get a structured call tree from the last completed profiling session.

        Returns a hierarchical JSON tree suitable for flame graph, sunburst,
        and icicle visualisations.  Supports optional depth and minimum
        percentage pruning parameters.

        Args:
            target: Task token if querying a pipeline, or None for server.
            max_depth: Maximum tree depth before pruning (default 50).
            min_pct: Minimum cumtime percentage threshold for inclusion (default 0.1).
            include_system: Include stdlib/system functions in the tree (default True).
                When False, the server filters out system nodes and promotes
                project-code children.

        Returns:
            Dict with 'tree' (root node), 'total_time', and 'total_calls'.

        Example:
            result = await client.cprofile_report_tree(max_depth=30, min_pct=0.5)
            tree = result['tree']
            print(f"Root has {len(tree['children'])} top-level functions")
        """
        # Build arguments — only include target if provided, always send depth/pct
        args: Dict[str, Any] = {
            'max_depth': max_depth,
            'min_pct': min_pct,
            'include_system': include_system,
        }
        if target:
            args['target'] = target
        return await self.call('rrext_cprofile_report_tree', args)
