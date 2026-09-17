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
CProfileManager: Process-Level yappi Profiler Singleton.

Provides a single, thread-safe profiling session per Python process using
yappi.  Unlike cProfile, yappi profiles more than the calling thread — but
only threads that exist when the session starts or that start through
``threading.Thread``.  A thread that first enters Python mid-session (e.g.
an engine worker thread) must call ``register_current_thread()``.

Any DAP connection handler can import the module-level ``profiler``
instance and call start/stop/status/report.

Only one profiling session can be active at a time.  The connection
that starts a session "owns" it — other connections can query status
and read reports but cannot stop someone else's session.

Usage:
    from ai.common.cprofile_manager import profiler

    result = profiler.start('task:42', session='my_test')
    # ... server handles requests across all threads ...
    result = profiler.stop('task:42')
    report = profiler.report()
"""

import os
import sys
import threading
import time
from typing import Dict, Any, List, Optional, Tuple

import yappi


# =============================================================================
# PATH RELATIVIZATION (strip absolute paths from profiler output)
# =============================================================================

# Derive the dist server root from sys.executable
# e.g. C:\Projects\saas\dist\server\engine.exe → C:\Projects\saas\dist\server
_SERVER_ROOT = os.path.dirname(sys.executable).replace('\\', '/').rstrip('/') + '/'

# Source-tree markers — when running in dev mode, yappi reports paths from
# the source tree (e.g. .../rocketride-server/packages/ai/src/ai/common/foo.py).
# We strip everything up to and including the marker so the result is ./ai/common/foo.py.
_SOURCE_MARKERS = [
    '/packages/ai/src/',  # .../packages/ai/src/ai/...         → ./ai/...
    '/nodes/src/',  # .../nodes/src/nodes/...            → ./nodes/...
    '/engine-lib/rocketlib-python/lib/',  # .../engine-lib/.../lib/rocketlib/  → ./rocketlib/...
]


def _relativize_path(path: str) -> str:
    """
    Strip absolute prefixes from a module path, returning a relative './...' path.

    Handles two cases:
    1. Dist paths:   C:/Projects/saas/dist/server/Lib/...  → ./Lib/...
    2. Source paths:  .../rocketride-server/packages/ai/src/ai/common/foo.py → ./ai/common/foo.py
                      .../rocketride-server/nodes/src/nodes/agent/foo.py    → ./nodes/agent/foo.py

    Args:
        path: Absolute or relative module file path from yappi.

    Returns:
        Relative path prefixed with './', or the original if no prefix matched.
    """
    normalised = path.replace('\\', '/')

    # Case 1: dist server root
    if normalised.startswith(_SERVER_ROOT):
        return './' + normalised[len(_SERVER_ROOT) :]

    # Case 2: source tree dev-mode paths
    for marker in _SOURCE_MARKERS:
        idx = normalised.find(marker)
        if idx >= 0:
            # Strip up to and including the marker
            return './' + normalised[idx + len(marker) :]

    # Final guard: never expose absolute host paths
    if normalised.startswith('/') or (len(normalised) >= 2 and normalised[1] == ':'):
        return './<system>'
    return normalised


# Prefixes that identify project code (not system/stdlib).
# Used by report_tree() to filter when include_system=False.
_PROJECT_PREFIXES = (
    './nodes/',  # pipeline node implementations
    './ai/',  # AI server code
    './lib/',  # engine native library wrappers
    './libs/',  # additional native libraries
    './rocketlib/',  # engine rocketlib Python wrappers
    'engLib:',  # engine C library functions
)


def _is_project_code(path: str) -> bool:
    """Check whether a relativized module path belongs to project code."""
    return path.startswith(_PROJECT_PREFIXES)


# Text report column layout.  Numeric widths and the two-space gap are yappi's
# print_all() defaults (yappi.py:1015-1025); the name column is deliberately
# wider than its 36, which truncated almost every row to an unidentifiable tail
# ("..' of '_queue.SimpleQueue' objects>").  Safe to widen: profiler-ui renders
# the report in a <pre> with pre-wrap, so longer lines wrap (ReportText.tsx:59).
_COLUMNS = (('name', 72), ('ncall', 5), ('tsub', 8), ('ttot', 8), ('tavg', 8))
_COLUMN_GAP = '  '

# Unpacked once so rows and the header cannot drift apart
_NAME_W, _NCALL_W, _TSUB_W, _TTOT_W, _TAVG_W = (width for _, width in _COLUMNS)


def _ltrim(text: Any, size: int) -> str:
    """Drop the head behind '..' when too long, else pad to size (yappi.py:393)."""
    text = str(text)
    if len(text) > size:
        return '..' + text[-size:][2:]
    return text.ljust(size)


def _rtrim(text: Any, size: int) -> str:
    """Drop the tail after '..' when too long, else pad to size (yappi.py:393).

    Padding is right-hand in both directions — yappi's StatString pads short
    values identically whichever trim was asked for, so columns read as left
    aligned.  Kept as-is: the report is user-visible and this is not the commit
    to restyle it.
    """
    text = str(text)
    if len(text) > size:
        return text[:size][:-2] + '..'
    return text.ljust(size)


def _fmt_time(value: float) -> str:
    """Format a duration to fit a column, dropping precision as needed."""
    for precision in range(6, 0, -1):
        formatted = f'{value:0.{precision}f}'
        if len(formatted) <= 8:
            return formatted
    return formatted


# Column header line for the text report sections
_COLUMN_HEADER = _COLUMN_GAP.join(
    _ltrim(name, size) if name == 'name' else _rtrim(name, size) for name, size in _COLUMNS
)


# =============================================================================
# CPROFILE MANAGER
# =============================================================================


class CProfileManager:
    """
    Process-level singleton managing a single yappi profiling session.

    Thread-safe via a threading.RLock — safe to call from asyncio handlers
    and from worker threads in the model server.

    yappi is process-global (start/stop are module-level), so this manager
    provides ownership tracking and prevents concurrent sessions.

    Attributes:
        _active: Whether a profiling session is currently running.
        _owner_id: Identifier of the connection that started the session.
        _session_name: Human-readable name for the session.
        _start_time: Unix timestamp when profiling started.
        _last_report: Cached report text, built on demand by report().
        _last_stats_data: Structured stats from the last session for report_tree().
        _last_session_name: Session name of the last completed session.
        _last_owner_id: Owner of the last completed session.
        _last_runtime: Duration of the last completed session.
        _last_clock_type: yappi clock the last session's timings came from.
        _session_seq: Counter bumped by every stop(), used to detect stale builds.
        _lock: Guards all mutable state.
    """

    def __init__(self) -> None:
        """Initialize an idle CProfileManager with no active session."""
        # Whether profiling is currently active
        self._active: bool = False

        # Connection that owns the current session
        self._owner_id: Optional[str] = None

        # Human-readable session label
        self._session_name: Optional[str] = None

        # When profiling started (unix timestamp)
        self._start_time: Optional[float] = None

        # Most recent completed report text. Built lazily by report() — stop()
        # only captures the data, so it never formats while holding the lock
        self._last_report: Optional[str] = None

        # Header fields of the last completed session, kept for the lazy report
        self._last_session_name: Optional[str] = None
        self._last_owner_id: Optional[str] = None
        self._last_runtime: Optional[float] = None
        self._last_clock_type: Optional[str] = None

        # Bumped by every stop(); lets report() detect that the data it built
        # from has since been replaced, and skip caching a stale result
        self._session_seq: int = 0

        # Structured stats from the last completed session for report_tree().
        # Stored as a list of dicts, each with:
        #   key: (module, lineno, name)
        #   ncall: int
        #   ttot: float (cumulative time)
        #   tsub: float (self time)
        #   builtin: bool (affects how the text report names it)
        #   children: list of (child_key, ncall, ttot, tsub)
        self._last_stats_data: Optional[List[Dict]] = None

        # Guards all mutable state. Reentrant because register_current_thread()
        # is reachable from the engine's GIL-attach path on every thread.
        self._lock = threading.RLock()

    def start(
        self,
        owner_id: str,
        session: Optional[str] = None,
        clock_type: str = 'wall',
    ) -> Dict[str, Any]:
        """
        Start a new yappi profiling session across all threads.

        Creates a fresh profiling session, clears any prior data, and begins
        profiling.  Returns an error dict if a session is already active.

        Args:
            owner_id: Identifier for the connection claiming ownership
                      (e.g. "task:42", "model:3").
            session: Optional human-readable name for the session.
                     Defaults to "session_{timestamp}" if not provided.
            clock_type: Clock type for timing — 'wall' (default) for
                        wall-clock time or 'cpu' for CPU time.

        Returns:
            Dict with status, session name, owner, and start_time on success,
            or status='error' with a message on failure.
        """
        with self._lock:
            # Reject if a session is already running
            if self._active:
                return {
                    'status': 'error',
                    'message': f'Profiling already active (owned by {self._owner_id})',
                    'owner': self._owner_id,
                }

            # Assign session name (auto-generate if not provided)
            self._session_name = session or f'session_{int(time.time())}'
            self._owner_id = owner_id
            self._start_time = time.time()

            # Clear any stale data from prior sessions
            yappi.clear_stats()

            # Set clock type — 'wall' for wall-clock, 'cpu' for CPU time
            if clock_type not in ('wall', 'cpu'):
                return {
                    'status': 'error',
                    'message': f"Invalid clock_type '{clock_type}': must be 'wall' or 'cpu'",
                }
            yappi.set_clock_type(clock_type)

            # Start profiling all threads (including builtins)
            yappi.start(builtins=True)
            self._active = True

            return {
                'status': 'started',
                'session': self._session_name,
                'owner': self._owner_id,
                'start_time': self._start_time,
            }

    def stop(self, owner_id: str) -> Dict[str, Any]:
        """
        Stop the active profiling session and generate reports.

        Only the owning connection may stop the session.  The generated
        report and structured stats are stored for later retrieval.

        Args:
            owner_id: Must match the owner that started the session.

        Returns:
            Dict with status, session name, and runtime on success,
            or status='error' on failure.
        """
        with self._lock:
            # Reject if nothing is running
            if not self._active:
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

            # Stop profiling
            yappi.stop()
            end_time = time.time()
            runtime = end_time - self._start_time

            # Capture function stats before clearing
            func_stats = yappi.get_func_stats()

            # Build structured stats data for report_tree()
            self._last_stats_data = self._capture_stats_data(func_stats)

            # Clear yappi's internal data to free memory
            yappi.clear_stats()

            # Capture session info before clearing ownership
            session_name = self._session_name

            # Keep what the report header needs; the text itself is formatted on
            # demand in report(), so no cold worker thread blocks on _lock here
            # waiting for a full sort-and-format of every profiled function
            self._last_session_name = session_name
            self._last_owner_id = self._owner_id
            self._last_runtime = runtime
            # yappi printed this per section; keep it, the default is not 'wall'
            self._last_clock_type = yappi.get_clock_type()
            self._last_report = None
            self._session_seq += 1

            # Reset state
            self._active = False
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
            if self._active:
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
                    # Captured data counts as a report — the text is built on demand
                    'has_report': self._last_report is not None or self._last_stats_data is not None,
                }

    def report(self) -> Dict[str, Any]:
        """
        Return the last completed profiling report.

        Anyone can call this — no ownership check.

        The text is formatted here rather than in stop(), so stop() never holds
        _lock across a full sort-and-format — every engine worker thread's first
        Python entry would otherwise block on it.  Follows the same "copy under
        lock, process outside" shape as report_tree().

        Returns:
            Dict with 'report' key containing the full report text,
            or a placeholder message if no report is available.
        """
        with self._lock:
            # No session has ever completed
            if self._last_stats_data is None:
                return {'report': 'No profiling data available. Run a session first.'}

            # Already formatted for this session
            if self._last_report is not None:
                return {'report': self._last_report}

            stats_data = list(self._last_stats_data)
            session_name = self._last_session_name
            owner_id = self._last_owner_id
            runtime = self._last_runtime
            clock_type = self._last_clock_type
            built_from = self._session_seq

        # Format outside the lock (read-only on the copied data)
        text = self._build_text_report_from_data(stats_data, session_name, owner_id, runtime, clock_type)

        with self._lock:
            # Cache only if this is still the current session. A newer stop()
            # owns the cache slot; this text is still the right answer for the
            # session that was current when the call arrived, so return it
            if self._session_seq == built_from:
                self._last_report = text

        return {'report': text}

    def report_tree(
        self,
        max_depth: int = 50,
        min_pct: float = 0.1,
        include_system: bool = True,
    ) -> Dict[str, Any]:
        """
        Build a hierarchical call-tree from the last completed profiling session.

        Uses yappi's callee data to produce a parent→children tree suitable
        for flame graph / sunburst / icicle visualisations.

        Args:
            max_depth: Maximum tree depth before pruning (default 50).
            min_pct:   Minimum percentage of total cumtime a node must have
                       to be included in the tree (default 0.1).
            include_system: If False, filter out system/stdlib functions and
                            only return project code (./ai/, ./nodes/, etc.).
                            System nodes are collapsed — their project-code
                            children are promoted to the nearest project ancestor.

        Returns:
            Dict with 'tree' (root node), 'total_time', and 'total_calls',
            or an error message if no stats data is available.
        """
        # Validate and clamp max_depth
        try:
            max_depth = int(max_depth)
        except (TypeError, ValueError):
            max_depth = 50
        max_depth = max(1, min(max_depth, 500))

        # Validate and clamp min_pct
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

            # Copy data under lock, process outside
            stats_data = list(self._last_stats_data)

        # Build the tree outside the lock (read-only on stats_data)
        result = self._build_tree(stats_data, max_depth, min_pct)

        # Filter out system calls if requested
        if not include_system and result.get('tree'):
            result['tree'] = self._filter_system_calls(result['tree'])

        return result

    @staticmethod
    def _filter_system_calls(node: Dict[str, Any]) -> Dict[str, Any]:
        """
        Filter a tree node to only include project code.

        System nodes are collapsed out — their project-code children are
        promoted up to the nearest project-code ancestor.

        Args:
            node: A tree node dict with name, file, children, etc.

        Returns:
            A new tree node with only project-code descendants.
        """

        def collect_project_children(n: Dict[str, Any]) -> List[Dict[str, Any]]:
            """Recursively collect project-code descendants, skipping system nodes."""
            result = []
            for child in n.get('children', []):
                if _is_project_code(child.get('file', '')):
                    # Keep this child, recursively filter its children
                    filtered = dict(child)
                    filtered['children'] = collect_project_children(child)
                    result.append(filtered)
                else:
                    # Skip this system node, promote its project-code descendants
                    result.extend(collect_project_children(child))
            return result

        filtered = dict(node)
        filtered['children'] = collect_project_children(node)
        return filtered

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
            if self._active and self._owner_id == owner_id:
                # Stop yappi and clear without generating a report
                yappi.stop()
                yappi.clear_stats()
                self._active = False
                self._owner_id = None
                self._session_name = None
                self._start_time = None

    def register_current_thread(self) -> bool:
        """
        Hook the calling thread into the active profiling session.

        yappi only hooks threads that exist at start() or that start through
        threading.Thread.  Engine worker threads get their PyThreadState lazily
        on first Python entry, so one entering mid-session stays invisible
        unless it registers itself here (the engine calls this once per thread).

        The check and the install must stay under _lock: stop() and release()
        call yappi.clear_stats(), and installing the bootstrap after that sends
        the next profile event into freed memory and crashes the process.

        Returns:
            True if the thread was hooked into an active session, False if no
            session is running.
        """
        with self._lock:
            # Installing the hook with no session active breaks yappi globally
            if not self._active:
                return False

            # yappi's per-thread bootstrap; its first event registers the context
            sys.setprofile(yappi._profile_thread_callback)
            return True

    # =========================================================================
    # PRIVATE HELPERS
    # =========================================================================

    @staticmethod
    def _build_text_report_from_data(
        stats_data: List[Dict],
        session_name: Optional[str],
        owner_id: Optional[str],
        runtime: Optional[float],
        clock_type: Optional[str] = None,
    ) -> str:
        """
        Generate a pstats-style text report from captured stats data.

        Works from the plain dicts captured by _capture_stats_data() rather than
        a live yappi stats object, so it can run outside the lock and long after
        yappi.clear_stats() freed the C-level data.  Reproduces yappi's
        print_all() layout: entries are in whatever order yappi yielded them, so
        each section sorts explicitly.

        Args:
            stats_data: Captured entries, each with key/ncall/ttot/tsub.
            session_name: Human-readable session name.
            owner_id: Connection that owned the session.
            runtime: Total profiling duration in seconds.
            clock_type: yappi clock the timings came from ('wall' or 'cpu').

        Returns:
            Formatted report string.
        """
        lines = [
            f'Session: {session_name}',
            f'Owner: {owner_id}',
            f'Duration: {runtime or 0.0:.2f}s',
            f'Clock: {clock_type or "unknown"}',
            '=' * 80,
            '',
        ]

        def section(title: str, entries: List[Dict]) -> None:
            """Append one sorted, formatted stats section."""
            lines.append(f'{title}:')
            lines.append('-' * 50)
            lines.append(_COLUMN_HEADER)
            for entry in entries:
                module, lineno, func = entry['key']
                # Match yappi's full_name: dotted for builtins, located otherwise
                full_name = f'{module}.{func}' if entry.get('builtin') else f'{module}:{lineno} {func}'
                ncall = entry['ncall']
                # yappi derives tavg; guard the division it never has to
                tavg = entry['ttot'] / ncall if ncall else 0.0
                lines.append(
                    _COLUMN_GAP.join(
                        (
                            _ltrim(full_name, _NAME_W),
                            _rtrim(ncall, _NCALL_W),
                            _rtrim(_fmt_time(entry['tsub']), _TSUB_W),
                            _rtrim(_fmt_time(entry['ttot']), _TTOT_W),
                            _rtrim(_fmt_time(tavg), _TAVG_W),
                        )
                    )
                )
            lines.append('')

        by_ttot = sorted(stats_data, key=lambda e: e['ttot'], reverse=True)
        section('FUNCTIONS BY CUMULATIVE TIME', by_ttot)

        by_tsub = sorted(stats_data, key=lambda e: e['tsub'], reverse=True)
        section('TOP 30 BY TOTAL TIME', by_tsub[:30])

        return '\n'.join(lines)

    @staticmethod
    def _capture_stats_data(func_stats: yappi.YFuncStats) -> List[Dict]:
        """
        Capture yappi function stats into a serializable structure.

        Iterates all profiled functions and their callees to build a
        list of dicts that report_tree() can use to construct the
        call-tree hierarchy.

        Args:
            func_stats: yappi's function statistics object.

        Returns:
            List of dicts, each with key, ncall, ttot, tsub, and children.
        """
        stats_list = []
        for stat in func_stats:
            # Build the unique key — relativize module path to strip server root
            func_key = (_relativize_path(stat.module), stat.lineno, stat.name)

            # Capture children (callees) with their timing.
            # NOTE: stat.children is a PROPERTY (YChildFuncStats), not a method.
            children = []
            for child in stat.children:
                child_key = (_relativize_path(child.module), child.lineno, child.name)
                children.append(
                    {
                        'key': child_key,
                        'ncall': child.ncall,
                        'ttot': child.ttot,
                        'tsub': child.tsub,
                    }
                )

            stats_list.append(
                {
                    'key': func_key,
                    'ncall': stat.ncall,
                    'ttot': stat.ttot,
                    'tsub': stat.tsub,
                    # Builtins are named 'module.name', not 'module:lineno name'
                    # (yappi.py:167). Only the text report needs this, so it is
                    # not carried on children, which only the tree consumes.
                    'builtin': bool(stat.builtin),
                    'children': children,
                }
            )

        return stats_list

    @staticmethod
    def _build_tree(
        stats_data: List[Dict],
        max_depth: int,
        min_pct: float,
    ) -> Dict[str, Any]:
        """
        Transform captured yappi stats into a JSON-serializable call tree.

        Uses the children (callee) relationships directly provided by yappi
        to build a top-down tree.

        Args:
            stats_data: List of stat dicts from _capture_stats_data().
            max_depth: Maximum recursion depth for tree building.
            min_pct: Minimum cumtime percentage threshold for inclusion.

        Returns:
            Dict with 'tree', 'total_time', and 'total_calls'.
        """
        # Step 1: Build lookup from key → stat entry
        lookup: Dict[Tuple[str, int, str], Dict] = {}
        for entry in stats_data:
            lookup[entry['key']] = entry

        # Step 2: Compute totals for threshold calculation
        # (sum, not max — max would skew to one hotspot)
        total_time = 0.0
        total_calls = 0
        for entry in stats_data:
            total_time += entry['ttot']
            total_calls += entry['ncall']

        # Minimum absolute time threshold
        min_time = total_time * (min_pct / 100.0) if total_time > 0 else 0

        # Step 3: Identify root nodes — functions not appearing as anyone's child
        all_child_keys: set = set()
        for entry in stats_data:
            for child in entry['children']:
                all_child_keys.add(child['key'])

        root_keys = [e['key'] for e in stats_data if e['key'] not in all_child_keys]

        # When profiling a running process, all functions may have callers
        # because the calling functions were on the stack when profiling started.
        # Always promote phantom-caller children (not just when root_keys is
        # empty), otherwise phantom-rooted branches are silently dropped.
        all_keys = set(lookup.keys())
        phantom_parent_keys = all_child_keys - all_keys
        if phantom_parent_keys:
            promoted: set = set()
            for entry in stats_data:
                for child in entry['children']:
                    if entry['key'] not in all_keys:
                        promoted.add(child['key'])
            root_keys = list(set(root_keys) | promoted)

        # Last resort — pick highest cumtime functions
        if not root_keys:
            sorted_entries = sorted(stats_data, key=lambda e: e['ttot'], reverse=True)
            root_keys = [e['key'] for e in sorted_entries[:5]]

        # Step 4: Recursively build tree with cycle detection
        def build_node(
            func_key: Tuple[str, int, str],
            ncall: int,
            ttot: float,
            tsub: float,
            depth: int,
            ancestors: Optional[set] = None,
        ) -> Optional[Dict[str, Any]]:
            """
            Recursively build a tree node for a single function.

            Args:
                func_key: (module, lineno, name) tuple.
                ncall: Number of calls from the parent context.
                ttot: Cumulative time from the parent context.
                tsub: Self time from the parent context.
                depth: Current recursion depth.
                ancestors: Set of func_keys on the current path (cycle detection).

            Returns:
                A dict representing the node, or None if pruned.
            """
            # Prune below minimum time threshold
            if ttot < min_time and depth > 1:
                return None

            module, lineno, name = func_key

            # Initialise ancestor tracking
            if ancestors is None:
                ancestors = set()

            # Cycle detection — emit a tagged leaf instead of recursing
            if func_key in ancestors:
                return {
                    'name': f'{name} [cycle]',
                    'file': module,
                    'line': lineno,
                    'ncalls': ncall,
                    'tottime': round(tsub, 6),
                    'cumtime': round(ttot, 6),
                    'children': [],
                }

            # Add to ancestor path
            path = ancestors | {func_key}

            # Build children from the lookup
            children: List[Dict[str, Any]] = []
            if depth < max_depth and func_key in lookup:
                for child_info in lookup[func_key]['children']:
                    child_node = build_node(
                        child_info['key'],
                        child_info['ncall'],
                        child_info['ttot'],
                        child_info['tsub'],
                        depth + 1,
                        path,
                    )
                    if child_node is not None:
                        children.append(child_node)

                # Sort by cumulative time descending
                children.sort(key=lambda n: n['cumtime'], reverse=True)

            return {
                'name': name,
                'file': module,
                'line': lineno,
                'ncalls': ncall,
                'tottime': round(tsub, 6),
                'cumtime': round(ttot, 6),
                'children': children,
            }

        # Step 5: Build root children
        root_children: List[Dict[str, Any]] = []
        for rk in root_keys:
            if rk in lookup:
                entry = lookup[rk]
                node = build_node(rk, entry['ncall'], entry['ttot'], entry['tsub'], depth=0)
                if node is not None:
                    root_children.append(node)

        # Sort by cumulative time descending
        root_children.sort(key=lambda n: n['cumtime'], reverse=True)

        # Step 6: Wrap in synthetic root node
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


# =============================================================================
# MODULE-LEVEL SINGLETON
# =============================================================================

# Every process that imports this module gets its own CProfileManager.
# eaas, model_server, and engine subprocesses each have their own instance.
profiler = CProfileManager()
