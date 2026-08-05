# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Metrics collection singleton for pipeline billing and monitoring.

Provides a flat, thread-safe metrics accumulator.  Multiple pipe threads
can call ``timer()``, ``add_time()``, ``counter()``, and ``event()``
concurrently — each method acquires the lock only briefly.

Accumulated metrics are emitted to the parent process via the ``>MET*``
stdout protocol (see ``taskhook.py``).  The parent replaces its snapshot
on each report, so values here are cumulative totals for the current task.

Architecture:
    - One subprocess = one task.  No task_id tracking needed.
    - Timers store accumulated milliseconds as floats.
    - Counters store accumulated integer values.
    - Events store structured dicts (e.g. llamaparse page counts).
    - All mutations are protected by a single threading.Lock.
    - ``timer()`` captures perf_counter locally; only touches shared
      state under the lock on exit — safe for concurrent pipe threads.
    - ``add_time()`` accepts a dict of timer values, used by ModelClient
      to record server-reported perf counters in a single lock acquisition.
    - ``report()`` returns a snapshot (shallow copies) without clearing.

Usage:
    Local mode (wrapper times inference locally)::

        t0 = time.perf_counter()
        preprocessed = Loader.preprocess(model, inputs, metadata)
        t_pre = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        raw_output = Loader.inference(model, preprocessed, metadata)
        t_gpu = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        results = Loader.postprocess(model, raw_output, len(inputs), fields)
        t_post = (time.perf_counter() - t0) * 1000

        # Keys match model server's build_dap_result() perf dict
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': 0,
                'gpu_memory': model_gpu_gb(model) * inference_sec,
            }
        )
        metrics.counter('gpu_inference_count', 1)

    Model server mode (ModelClient records server-reported perf)::

        # In ModelClient.send_command(), after receiving response:
        perf = body.get('perf')
        if perf:
            metrics.add_time(perf)

    Node-level (nodes report what they own)::

        metrics.counter('pages', page_count)
        metrics.event({'llamaparse_pages': 10, 'mode': 'precise'})
"""

import threading
import time
from contextlib import contextmanager
from typing import Any, Dict


# ============================================================================
# METRICS MANAGER
# ============================================================================


class MetricsManager:
    """
    Thread-safe metrics accumulator for a single subprocess task.

    One subprocess = one task.  The parent process knows which task
    owns the ``>MET*`` output, so no task_id tracking is needed here.

    Attributes:
        _timers: Accumulated milliseconds per named timer (e.g. 'gpu').
        _counters: Accumulated integer values per named counter.
        _events: List of structured event dicts.
        _lock: Threading lock protecting all shared state.
    """

    def __init__(self):
        """Initialize empty accumulators and the thread lock."""
        # Timer accumulators — values are cumulative milliseconds
        self._timers: Dict[str, float] = {}

        # Counter accumulators — values are cumulative integers
        self._counters: Dict[str, int] = {}

        # Event log — list of structured dicts, appended in order
        self._events: list = []

        # Single lock protects all three collections
        self._lock = threading.Lock()

    # ========================================================================
    # RESET
    # ========================================================================

    def reset(self):
        """
        Clear all accumulators.

        Called by ``taskMetricsBegin`` at the start of each task to
        ensure a clean slate for the new task's metrics.
        """
        with self._lock:
            self._timers.clear()
            self._counters.clear()
            self._events.clear()

    # ========================================================================
    # TIMERS
    # ========================================================================

    @contextmanager
    def timer(self, name: str):
        """
        Context manager to time a block and accumulate milliseconds.

        Fully thread-safe: timing is captured locally via ``perf_counter``,
        the shared dict is only touched under the lock on exit.  Two pipe
        threads timing ``'gpu'`` concurrently each accumulate independently.

        Args:
            name: Timer key (e.g. ``'gpu'``, ``'preprocess'``).

        Usage::

            with metrics.timer('gpu'):
                result = model(inputs)
        """
        # Capture start time locally — no shared state involved
        start = time.perf_counter()
        try:
            yield
        finally:
            # Compute elapsed and accumulate under the lock
            elapsed_ms = (time.perf_counter() - start) * 1000
            with self._lock:
                self._timers[name] = self._timers.get(name, 0.0) + elapsed_ms

    def add_time(self, timers: Dict[str, float]):
        """
        Add milliseconds to one or more timers from a dict.

        Accumulates all entries in a single lock acquisition — more
        efficient than calling ``timer()`` multiple times.  Used by:

        - **Local-mode wrappers**: report ``preprocess``, ``gpu``,
          ``postprocess``, ``queue_wait``, and ``latency`` after
          manually timing each phase with ``perf_counter``.
        - **ModelClient**: relay server-reported perf counters from
          the model server's ``build_dap_result()`` response.

        Args:
            timers: ``{name: ms, ...}`` — values to accumulate into
                    the corresponding timer keys.
        """
        with self._lock:
            # Walk the dict and accumulate each timer
            for name, ms in timers.items():
                self._timers[name] = self._timers.get(name, 0.0) + ms

    # ========================================================================
    # COUNTERS
    # ========================================================================

    def counter(self, name: str, value: int):
        """
        Increment a named counter by the given value.

        Args:
            name: Counter key (e.g. ``'gpu_inference_count'``,
                  ``'requests'``, ``'pages'``).
            value: Amount to add (typically 1).
        """
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + value

    # ========================================================================
    # EVENTS
    # ========================================================================

    def event(self, data: Dict[str, Any]):
        """
        Record a structured event dict.

        Events are appended in order and included in every ``report()``
        snapshot.  Used by nodes to log billable events with metadata
        (e.g. llamaparse page counts, model names, parsing modes).

        Args:
            data: Event dict (e.g. ``{'llamaparse_pages': 10, ...}``).
        """
        with self._lock:
            self._events.append(data)

    # ========================================================================
    # REPORT
    # ========================================================================

    def report(self) -> dict:
        """
        Return a cumulative snapshot for the ``>MET*`` protocol.

        The parent process (``task_metrics.py``) replaces its previous
        snapshot with each new report via ``merge_subprocess_metrics()``,
        so values here must be running totals — not deltas.

        The snapshot contains shallow copies of all three collections
        so the caller can safely use/serialize them outside the lock.

        Returns:
            ``{'timers': {name: ms, ...},
              'counters': {name: int, ...},
              'events': [dict, ...]}``
        """
        with self._lock:
            # Shallow-copy each collection so the snapshot is independent
            return {
                'timers': dict(self._timers),
                'counters': dict(self._counters),
                'events': list(self._events),
            }


# ============================================================================
# GLOBAL SINGLETON
# ============================================================================

# Single instance used throughout the subprocess by wrappers, nodes,
# and taskhook.  Imported as: ``from ai.web.metrics import metrics``
metrics = MetricsManager()
