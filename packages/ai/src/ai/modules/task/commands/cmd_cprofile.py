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
CProfileCommands: DAP Command Handler for Process Profiling.

This module implements DAP handlers for cProfile-based process profiling.
It supports two modes of operation:

Direct mode (target is None):
    Profiles the local server process (eaas) by calling the process-level
    CProfileManager singleton directly.

Proxy mode (target is a task token):
    Forwards the profiling command to a pipeline's engine subprocess via
    Task._send_data(), the same mechanism used for rrext_process commands.
    The engine subprocess has its own CProfileManager singleton.

Primary Responsibilities:
--------------------------
1. Handles DAP 'rrext_cprofile_start' — start a profiling session
2. Handles DAP 'rrext_cprofile_stop' — stop and generate report
3. Handles DAP 'rrext_cprofile_status' — query active/inactive state
4. Handles DAP 'rrext_cprofile_report' — retrieve the pstats report text

Architecture:
-------------
- Inherits from DAPConn to leverage DAP protocol handling
- Uses the module-level profiler singleton from ai.common.cprofile_manager
- Proxies to engine subprocesses via the same path as cmd_data.py
"""

from typing import TYPE_CHECKING, Dict, Any
from ai.common.dap import DAPConn, TransportBase
from ai.common.cprofile_manager import profiler

# Only import for type checking to avoid circular import errors
if TYPE_CHECKING:
    from ..task_server import TaskServer


# =============================================================================
# CPROFILE COMMANDS MIXIN
# =============================================================================


class CProfileCommands(DAPConn):
    """
    DAP command handler for cProfile process profiling.

    Supports direct profiling of the local process and proxy profiling
    of pipeline engine subprocesses.  Each handler checks the ``target``
    argument to decide which mode to use.

    Key Features:
    - Start/stop named profiling sessions with ownership tracking
    - Query status from any connection (even if not the owner)
    - Retrieve full pstats reports
    - Proxy commands to engine subprocesses via Task._send_data()

    Attributes:
        _server: Reference to the TaskServer for task lookup
        _connection_id: Unique identifier for this DAP connection
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialize a new CProfileCommands instance.

        Args:
            connection_id (int): Unique identifier for this DAP connection session
            server (TaskServer): The server instance for task lookup and management
            transport (TransportBase): Communication transport layer for DAP messages
            **kwargs: Additional arguments passed to parent DAPConn constructor
        """
        pass

    def _owner_id(self) -> str:
        """Build the owner identifier for this connection."""
        return f'task:{self._connection_id}'

    async def _proxy_to_task(self, request: Dict[str, Any], target: str) -> Dict[str, Any]:
        """
        Forward a cProfile command to a pipeline's engine subprocess.

        Looks up the task by its token, waits for it to be running, then
        sends the request via Task._send_data().  The subprocess response
        body is re-wrapped with the original inbound request's seq so the
        client can correlate it.

        Args:
            request: The original inbound DAP request from the client.
            target: The task token identifying which pipeline to profile.

        Returns:
            DAP response with the subprocess result body.
        """
        # Look up the task control entry by token
        control = self._server.get_task_control(target)
        task = control.task

        # Wait for the task to reach running state
        await task.wait_for_running()

        # Forward the command — _send_data builds a fresh DAP envelope
        # with its own seq for the eaas→subprocess hop
        subprocess_response = await task._send_data(request)

        # Re-wrap with the original client request seq
        return self.build_response(
            request,
            body=subprocess_response.get('body'),
        )

    async def on_rrext_cprofile_start(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_cprofile_start' command to begin profiling.

        If target is None, profiles the local eaas server process.
        If target is a task token, proxies the command to that pipeline's
        engine subprocess.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments.target (str, optional): Task token, or None for local
                - arguments.session (str, optional): Human-readable session name

        Returns:
            Dict[str, Any]: DAP response with status, session, owner, start_time

        Usage Examples:
        - Local: { "command": "rrext_cprofile_start", "arguments": { "session": "test" } }
        - Proxy: { "command": "rrext_cprofile_start", "arguments": { "target": "tk_abc", "session": "test" } }
        """
        self.verify_permission('task.control')
        args = request.get('arguments', {})
        target = args.get('target', None)

        # Proxy mode — forward to engine subprocess
        if target:
            return await self._proxy_to_task(request, target)

        # Direct mode — profile the local process
        session = args.get('session', None)
        result = profiler.start(self._owner_id(), session)
        return self.build_response(request, body=result)

    async def on_rrext_cprofile_stop(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_cprofile_stop' command to end profiling.

        If target is None, stops profiling on the local process.
        If target is a task token, proxies to the engine subprocess.
        Only the connection that started the session can stop it.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments.target (str, optional): Task token, or None for local

        Returns:
            Dict[str, Any]: DAP response with status, session, runtime

        Usage Example:
        { "command": "rrext_cprofile_stop" }
        """
        self.verify_permission('task.control')
        args = request.get('arguments', {})
        target = args.get('target', None)

        # Proxy mode
        if target:
            return await self._proxy_to_task(request, target)

        # Direct mode
        result = profiler.stop(self._owner_id())
        return self.build_response(request, body=result)

    async def on_rrext_cprofile_status(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_cprofile_status' command to query profiling state.

        Returns whether profiling is active, who owns it, and the runtime.
        Any connection can call this regardless of ownership.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments.target (str, optional): Task token, or None for local

        Returns:
            Dict[str, Any]: DAP response with active, owner, session, runtime

        Usage Example:
        { "command": "rrext_cprofile_status" }
        """
        self.verify_permission('task.control')
        args = request.get('arguments', {})
        target = args.get('target', None)

        # Proxy mode
        if target:
            return await self._proxy_to_task(request, target)

        # Direct mode
        result = profiler.status()
        return self.build_response(request, body=result)

    async def on_rrext_cprofile_report(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_cprofile_report' command to retrieve the full report.

        Returns the pstats text from the last completed profiling session.
        Any connection can call this regardless of ownership.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments.target (str, optional): Task token, or None for local

        Returns:
            Dict[str, Any]: DAP response with report text

        Usage Example:
        { "command": "rrext_cprofile_report" }
        """
        self.verify_permission('task.control')
        args = request.get('arguments', {})
        target = args.get('target', None)

        # Proxy mode
        if target:
            return await self._proxy_to_task(request, target)

        # Direct mode
        result = profiler.report()
        return self.build_response(request, body=result)

    async def on_rrext_cprofile_report_tree(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle DAP 'rrext_cprofile_report_tree' command to retrieve a structured call tree.

        Returns a hierarchical JSON tree built from the pstats callers data of the
        last completed session.  Suitable for flame graph, sunburst, and icicle
        visualisations.  Supports optional max_depth and min_pct pruning parameters.

        Args:
            request (Dict[str, Any]): DAP request containing:
                - arguments.target (str, optional): Task token, or None for local
                - arguments.max_depth (int, optional): Max tree depth (default 50)
                - arguments.min_pct (float, optional): Min cumtime % threshold (default 0.1)

        Returns:
            Dict[str, Any]: DAP response with tree, total_time, total_calls

        Usage Example:
        { "command": "rrext_cprofile_report_tree", "arguments": { "max_depth": 30, "min_pct": 0.5 } }
        """
        self.verify_permission('task.control')
        args = request.get('arguments', {})
        target = args.get('target', None)

        # Proxy mode — forward to engine subprocess
        if target:
            return await self._proxy_to_task(request, target)

        # Direct mode — build the tree from the local profiler's stored stats
        max_depth = args.get('max_depth', 50)
        min_pct = args.get('min_pct', 0.1)
        include_system = args.get('include_system', True)
        result = profiler.report_tree(
            max_depth=max_depth,
            min_pct=min_pct,
            include_system=include_system,
        )
        return self.build_response(request, body=result)

    def release_profiler(self) -> None:
        """
        Release profiler ownership for this connection.

        Called on disconnect to auto-stop any abandoned profiling session
        owned by this connection.  Safe to call even if this connection
        does not own the session (silent no-op).
        """
        profiler.release(self._owner_id())
