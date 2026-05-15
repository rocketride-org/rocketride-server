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
from typing import Dict, Any, Optional


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

            # Cumulative time sort — full stats
            stats_buf = io.StringIO()
            stats = pstats.Stats(self._profiler, stream=stats_buf)
            stats.sort_stats('cumulative')
            stats.print_stats()
            report_buf.write('FUNCTIONS BY CUMULATIVE TIME:\n')
            report_buf.write('-' * 50 + '\n')
            report_buf.write(stats_buf.getvalue())
            report_buf.write('\n')

            # Total time sort — top 30
            stats_buf = io.StringIO()
            stats = pstats.Stats(self._profiler, stream=stats_buf)
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
