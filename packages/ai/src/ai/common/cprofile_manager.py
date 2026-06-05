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
CProfileManager: Process-Level cProfile Singleton.

Provides a single, thread-safe cProfile session per Python process.
Any DAP connection handler can import the module-level ``profiler``
instance and call start/stop/status/report.

Only one profiling session can be active at a time.  The connection
that starts a session "owns" it — other connections can query status
and read reports but cannot stop someone else's session.

Usage:
    from ai.common.cprofile_manager import profiler

    result = profiler.start('task:42', session='my_test')
    # ... server handles requests ...
    result = profiler.stop('task:42')
    report = profiler.report()
"""

import cProfile
import io
import pstats
import threading
import time
from typing import Dict, Any, List, Optional, Tuple


# =============================================================================
# CPROFILE MANAGER
# =============================================================================


class CProfileManager:
    """
    Process-level singleton managing a single cProfile session.

    Thread-safe via a threading.Lock — safe to call from asyncio handlers
    and from worker threads in the model server.

    Attributes:
        _profiler: The active cProfile.Profile instance, or None.
        _owner_id: Identifier of the connection that started the session.
        _session_name: Human-readable name for the session.
        _start_time: Unix timestamp when profiling started.
        _last_report: Text of the most recently completed pstats report.
        _lock: Guards all mutable state.
    """

    def __init__(self) -> None:
        """Initialize an idle CProfileManager with no active session."""
        # Active profiler instance (None when not profiling)
        self._profiler: Optional[cProfile.Profile] = None

        # Connection that owns the current session
        self._owner_id: Optional[str] = None

        # Human-readable session label
        self._session_name: Optional[str] = None

        # When profiling started (unix timestamp)
        self._start_time: Optional[float] = None

        # Most recent completed report text
        self._last_report: Optional[str] = None

        # Raw pstats data from the last completed session, used by report_tree().
        # Stored as the pstats.Stats.stats dict — keys are (filename, lineno, funcname)
        # tuples, values are (cc, nc, tt, ct, callers) where callers maps caller
        # tuples to (cc, nc, tt, ct).
        self._last_stats_data: Optional[Dict] = None

        # Thread lock protecting all mutable state
        self._lock = threading.Lock()

    def start(self, owner_id: str, session: Optional[str] = None) -> Dict[str, Any]:
        """
        Start a new cProfile profiling session.

        Creates a fresh cProfile.Profile, enables it, and records the owner.
        Returns an error dict if a session is already active.

        Args:
            owner_id: Identifier for the connection claiming ownership
                      (e.g. "task:42", "model:3").
            session: Optional human-readable name for the session.
                     Defaults to "session_{timestamp}" if not provided.

        Returns:
            Dict with status, session name, owner, and start_time on success,
            or status='error' with a message on failure.
        """
        with self._lock:
            # Reject if a session is already running
            if self._profiler is not None:
                return {
                    'status': 'error',
                    'message': f'Profiling already active (owned by {self._owner_id})',
                    'owner': self._owner_id,
                }

            # Assign session name (auto-generate if not provided)
            self._session_name = session or f'session_{int(time.time())}'
            self._owner_id = owner_id
            self._start_time = time.time()

            # Create and enable the profiler
            self._profiler = cProfile.Profile()
            self._profiler.enable()

            return {
                'status': 'started',
                'session': self._session_name,
                'owner': self._owner_id,
                'start_time': self._start_time,
            }

    def stop(self, owner_id: str) -> Dict[str, Any]:
        """
        Stop the active profiling session and generate a pstats report.

        Only the owning connection may stop the session.  The generated
        report is stored in ``_last_report`` for later retrieval.

        Args:
            owner_id: Must match the owner that started the session.

        Returns:
            Dict with status, session name, runtime, and a summary of the
            top functions on success, or status='error' on failure.
        """
        with self._lock:
            # Reject if nothing is running
            if self._profiler is None:
                return {
                    'status': 'error',
                    'message': 'No active profiling session',
                }

            # Only the owner can stop
            if self._owner_id != owner_id:
                return {
                    'status': 'error',
                    'message': f'Session owned by {self._owner_id}, not {owner_id}',
                    'owner': self._owner_id,
                }

            # Disable the profiler
            self._profiler.disable()
            end_time = time.time()
            runtime = end_time - self._start_time

            # Generate the pstats report into a string buffer
            report_buf = io.StringIO()
            report_buf.write(f'Session: {self._session_name}\n')
            report_buf.write(f'Owner: {self._owner_id}\n')
            report_buf.write(f'Duration: {runtime:.2f}s\n')
            report_buf.write('=' * 80 + '\n\n')

            # Build Stats object once, reuse for both text reports and raw data
            stats = pstats.Stats(self._profiler, stream=io.StringIO())

            # Save raw stats dict for report_tree() — must copy before Profile
            # is released, as pstats.Stats references the Profile internally
            self._last_stats_data = dict(stats.stats)

            # Cumulative time sort — full stats
            stats_buf = io.StringIO()
            stats.stream = stats_buf
            stats.sort_stats('cumulative')
            stats.print_stats()
            report_buf.write('FUNCTIONS BY CUMULATIVE TIME:\n')
            report_buf.write('-' * 50 + '\n')
            report_buf.write(stats_buf.getvalue())
            report_buf.write('\n')

            # Total time sort — top 30
            stats_buf = io.StringIO()
            stats.stream = stats_buf
            stats.sort_stats('tottime')
            stats.print_stats(30)
            report_buf.write('TOP 30 BY TOTAL TIME:\n')
            report_buf.write('-' * 50 + '\n')
            report_buf.write(stats_buf.getvalue())

            # Store the report
            self._last_report = report_buf.getvalue()

            # Capture session info before clearing
            session_name = self._session_name

            # Reset state
            self._profiler = None
            self._owner_id = None
            self._session_name = None
            self._start_time = None

            return {
                'status': 'completed',
                'session': session_name,
                'runtime': runtime,
            }

    def status(self) -> Dict[str, Any]:
        """
        Return the current profiling status.

        Anyone can call this — no ownership check.

        Returns:
            Dict with active flag, owner, session name, and runtime
            (if active), or history info (if inactive).
        """
        with self._lock:
            if self._profiler is not None:
                # Active session
                runtime = time.time() - self._start_time if self._start_time else 0
                return {
                    'active': True,
                    'owner': self._owner_id,
                    'session': self._session_name,
                    'runtime': runtime,
                }
            else:
                # No active session
                return {
                    'active': False,
                    'owner': None,
                    'session': None,
                    'runtime': None,
                    'has_report': self._last_report is not None,
                }

    def report(self) -> Dict[str, Any]:
        """
        Return the last completed profiling report.

        Anyone can call this — no ownership check.

        Returns:
            Dict with 'report' key containing the full pstats text,
            or a placeholder message if no report is available.
        """
        with self._lock:
            return {
                'report': self._last_report or 'No profiling data available. Run a session first.',
            }

    def report_tree(
        self,
        max_depth: int = 50,
        min_pct: float = 0.1,
    ) -> Dict[str, Any]:
        """
        Build a hierarchical call-tree from the last completed profiling session.

        Inverts the pstats callers dict to produce a parent→children tree
        suitable for flame graph / sunburst / icicle visualisations.
        Functions appearing in multiple call paths are duplicated (each parent
        gets its own copy with caller-specific timing from the callers dict).

        Args:
            max_depth: Maximum tree depth before pruning (default 50).
            min_pct:   Minimum percentage of total cumtime a node must have
                       to be included in the tree (default 0.1).

        Returns:
            Dict with 'tree' (root node), 'total_time', and 'total_calls',
            or an error message if no stats data is available.
        """
        # Validate and clamp max_depth to a reasonable integer range
        try:
            max_depth = int(max_depth)
        except (TypeError, ValueError):
            max_depth = 50
        max_depth = max(1, min(max_depth, 500))

        # Validate and clamp min_pct to a reasonable float range
        try:
            min_pct = float(min_pct)
        except (TypeError, ValueError):
            min_pct = 0.1
        min_pct = max(0.0, min(min_pct, 100.0))

        with self._lock:
            if self._last_stats_data is None:
                return {
                    'tree': None,
                    'total_time': 0,
                    'total_calls': 0,
                    'error': 'No profiling data available. Run a session first.',
                }

            # Copy the stats data while under the lock so we can process
            # outside of it without holding it for the tree-building work
            stats_data = dict(self._last_stats_data)

        # --- Build the tree outside the lock (read-only on stats_data) ---
        return self._build_tree(stats_data, max_depth, min_pct)

    @staticmethod
    def _build_tree(
        stats_data: Dict,
        max_depth: int,
        min_pct: float,
    ) -> Dict[str, Any]:
        """
        Transform raw pstats stats dict into a JSON-serializable call tree.

        The pstats dict is keyed by (filename, lineno, funcname) tuples.
        Each value is (primitive_calls, total_calls, tottime, cumtime, callers)
        where callers maps caller-key → (cc, nc, tt, ct).

        This method inverts the callers relationships to build a top-down tree:
        for each function, every key in its callers dict becomes a parent, and
        the function becomes a child of that parent with the timing data from
        the caller relationship.

        Args:
            stats_data: Raw pstats.Stats.stats dict.
            max_depth: Maximum recursion depth for tree building.
            min_pct: Minimum cumtime percentage threshold for inclusion.

        Returns:
            Dict with 'tree', 'total_time', and 'total_calls'.
        """
        # Step 1: Compute total cumtime across all root-level functions for
        # the min_pct threshold calculation
        total_time = 0.0
        total_calls = 0
        for _key, (cc, nc, tt, ct, _callers) in stats_data.items():
            total_time = max(total_time, ct)
            total_calls += nc

        # Minimum absolute time threshold (convert percentage to seconds)
        min_time = total_time * (min_pct / 100.0) if total_time > 0 else 0

        # Step 2: Build parent→children adjacency map.
        # For each function, iterate its callers and record the function as
        # a child of each caller with the caller-specific timing.
        #
        # children_map[parent_key] = list of (child_key, cc, nc, tt, ct)
        children_map: Dict[
            Tuple[str, int, str],
            List[Tuple[Tuple[str, int, str], int, int, float, float]],
        ] = {}

        # Track which functions have callers (non-roots)
        has_caller: set = set()

        for func_key, (cc, nc, tt, ct, callers) in stats_data.items():
            if callers:
                for caller_key, caller_timing in callers.items():
                    has_caller.add(func_key)
                    # caller_timing can be (nc, nc, tt, ct) or (cc, nc, tt, ct)
                    c_cc, c_nc, c_tt, c_ct = caller_timing
                    if caller_key not in children_map:
                        children_map[caller_key] = []
                    children_map[caller_key].append((func_key, c_cc, c_nc, c_tt, c_ct))

        # Step 3: Identify root nodes — functions that have no callers
        root_keys = [k for k in stats_data if k not in has_caller]

        # When profiling an already-running process (e.g. asyncio event loop),
        # all recorded functions may have callers because the calling functions
        # were already on the stack when profiling started.  These "phantom
        # callers" appear in children_map but not in stats_data.
        if not root_keys:
            # Promote children of phantom callers to roots — these are the
            # real entry points of the profiled portion
            phantom_callers = set(children_map.keys()) - set(stats_data.keys())
            promoted: set = set()
            for pc in phantom_callers:
                for child_key, _c_cc, _c_nc, _c_tt, _c_ct in children_map[pc]:
                    promoted.add(child_key)
            root_keys = list(promoted)

        # Last resort fallback — pick the highest-cumtime functions
        if not root_keys:
            root_keys = sorted(
                stats_data.keys(),
                key=lambda k: stats_data[k][3],  # index 3 = cumtime
                reverse=True,
            )[:5]

        # Step 4: Recursively build the tree with cycle detection.
        # In asyncio servers, _run_once → handlers → callbacks → _run_once
        # creates cycles.  We track the ancestor path and emit a leaf node
        # tagged "[cycle]" when a function is encountered that already
        # appears in the current call path.
        def build_node(
            func_key: Tuple[str, int, str],
            nc: int,
            tt: float,
            ct: float,
            depth: int,
            ancestors: Optional[set] = None,
        ) -> Optional[Dict[str, Any]]:
            """
            Recursively build a tree node for a single function.

            Args:
                func_key: (filename, lineno, funcname) tuple.
                nc: Number of calls from the parent context.
                tt: Total time from the parent context.
                ct: Cumulative time from the parent context.
                depth: Current recursion depth.
                ancestors: Set of func_keys on the current call path (cycle detection).

            Returns:
                A dict representing the node, or None if pruned.
            """
            # Prune nodes below the minimum time threshold
            if ct < min_time and depth > 1:
                return None

            filename, lineno, funcname = func_key

            # Initialise ancestor tracking on first call
            if ancestors is None:
                ancestors = set()

            # Cycle detection — if this function is already on the current
            # call path, emit a leaf node tagged "[cycle]" instead of recursing
            if func_key in ancestors:
                return {
                    'name': f'{funcname} [cycle]',
                    'file': filename,
                    'line': lineno,
                    'ncalls': nc,
                    'tottime': round(tt, 6),
                    'cumtime': round(ct, 6),
                    'children': [],
                }

            # Add this function to the ancestor path
            path = ancestors | {func_key}

            # Build child nodes if within depth limit
            children: List[Dict[str, Any]] = []
            if depth < max_depth and func_key in children_map:
                for child_key, c_cc, c_nc, c_tt, c_ct in children_map[func_key]:
                    child_node = build_node(
                        child_key,
                        c_nc,
                        c_tt,
                        c_ct,
                        depth + 1,
                        path,
                    )
                    if child_node is not None:
                        children.append(child_node)

                # Sort children by cumulative time descending for consistent layout
                children.sort(key=lambda n: n['cumtime'], reverse=True)

            return {
                'name': funcname,
                'file': filename,
                'line': lineno,
                'ncalls': nc,
                'tottime': round(tt, 6),
                'cumtime': round(ct, 6),
                'children': children,
            }

        # Step 5: Build root children from the identified root functions
        root_children: List[Dict[str, Any]] = []
        for rk in root_keys:
            cc, nc, tt, ct, _callers = stats_data[rk]
            node = build_node(rk, nc, tt, ct, depth=0)
            if node is not None:
                root_children.append(node)

        # Sort root children by cumulative time descending
        root_children.sort(key=lambda n: n['cumtime'], reverse=True)

        # Step 6: Wrap in a synthetic root node
        root = {
            'name': '<root>',
            'file': '',
            'line': 0,
            'ncalls': total_calls,
            'tottime': 0.0,
            'cumtime': round(total_time, 6),
            'children': root_children,
        }

        return {
            'tree': root,
            'total_time': round(total_time, 6),
            'total_calls': total_calls,
        }

    def release(self, owner_id: str) -> None:
        """
        Release ownership if this connection owns the active session.

        Called on connection disconnect to auto-stop an abandoned session.
        If the owner_id doesn't match, this is a silent no-op.

        Args:
            owner_id: The disconnecting connection's identifier.
        """
        with self._lock:
            # Only release if this connection owns the session
            if self._profiler is not None and self._owner_id == owner_id:
                # Disable without generating a report (session was abandoned)
                self._profiler.disable()
                self._profiler = None
                self._owner_id = None
                self._session_name = None
                self._start_time = None


# =============================================================================
# MODULE-LEVEL SINGLETON
# =============================================================================

# Every process that imports this module gets its own CProfileManager.
# eaas, model_server, and engine subprocesses each have their own instance.
profiler = CProfileManager()
