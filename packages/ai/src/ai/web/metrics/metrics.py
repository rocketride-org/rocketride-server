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
can call ``timer()``, ``add()``, ``counter()``, and ``event()``
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
    - ``add()`` accepts a dict of timer values, used by ModelClient
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

        metrics.add(
            {
                'preprocess': t_pre,
                'gpu': t_gpu,
                'postprocess': t_post,
                'queue_wait': 0,
                'latency': t_pre + t_gpu + t_post,
            }
        )
        metrics.counter('gpu_inference_count', 1)

    Model server mode (ModelClient records server-reported perf)::

        # In ModelClient.send_command(), after receiving response:
        perf = body.get('perf')
        if perf:
            metrics.add(perf)

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
        _metrics: Flat dict of accumulated values (ms, seconds, GB·sec, counts).
        _events: List of structured event dicts.
        _lock: Threading lock protecting all shared state.
    """

    def __init__(self):
        """Initialize empty accumulators and the thread lock."""
        # All metrics in one flat dict — no timer/counter distinction.
        # Values are cumulative floats (ms, seconds, GB·sec, counts, etc.)
        self._metrics: Dict[str, float] = {}

        # Event log — list of structured dicts, appended in order
        self._events: list = []

        # Single lock protects both collections
        self._lock = threading.Lock()

        # CPU/memory sampling state
        self._memory_samples: list = []  # RSS in MB, sampled every 15s
        self._memory_sample_interval = 15.0
        self._last_memory_sample = 0.0
        self._start_time = time.time()  # for computing cpu_memory GB·sec
        self._process = None  # psutil.Process, lazily created

        # Periodic reporter state
        self._reporter_thread: threading.Thread | None = None
        self._reporter_stop = threading.Event()
        self._report_callback = None  # set by start_reporter()

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
            self._metrics.clear()
            self._events.clear()
            self._memory_samples.clear()
            self._last_memory_sample = 0.0
            self._start_time = time.time()

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
                self._metrics[name] = self._metrics.get(name, 0.0) + elapsed_ms

    def add(self, values: Dict[str, float]):
        """
        Accumulate multiple metrics from a dict in a single lock acquisition.

        Used by:
        - **Local-mode wrappers**: report ``gpu_preprocess``, ``gpu_compute``,
          ``gpu_postprocess``, ``gpu_queue_wait`` after timing each phase.
        - **ModelClient**: relay server-reported perf dict from model server.

        Args:
            values: ``{name: value, ...}`` — values to accumulate.
        """
        with self._lock:
            for name, value in values.items():
                self._metrics[name] = self._metrics.get(name, 0.0) + value

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
            self._metrics[name] = self._metrics.get(name, 0.0) + value

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
    # PERIODIC REPORTER
    # ========================================================================

    def start_reporter(self, callback, interval: float = 5.0):
        """
        Start a background thread that calls callback(report) every N seconds.

        The callback receives the same cumulative snapshot as report().
        Typically this is rocketlib.monitorMetrics to emit >MET* to stdout.

        Args:
            callback: Function to call with report dict (e.g. monitorMetrics).
            interval: Seconds between reports (default 5.0).
        """
        if self._reporter_thread is not None:
            return  # Already running

        self._report_callback = callback
        self._reporter_stop.clear()

        def _loop():
            while not self._reporter_stop.wait(interval):
                snapshot = self.report()
                if snapshot and self._report_callback:
                    self._report_callback(snapshot)

            # Final report before exit — flush any remaining data
            snapshot = self.report()
            if snapshot and self._report_callback:
                self._report_callback(snapshot)

        self._reporter_thread = threading.Thread(
            target=_loop,
            name='MetricsReporter',
            daemon=True,
        )
        self._reporter_thread.start()

    def stop_reporter(self):
        """
        Stop the periodic reporter and send a final report.

        Signals the reporter thread to wake immediately, send one last
        report, and exit. Blocks until the thread is done (up to 2s).
        """
        if self._reporter_thread is None:
            return

        self._reporter_stop.set()
        self._reporter_thread.join(timeout=2.0)
        self._reporter_thread = None
        self._report_callback = None

    # ========================================================================
    # CPU / MEMORY SAMPLING
    # ========================================================================

    def _sample_memory(self) -> None:
        """
        Sample current RSS memory if the sampling interval has elapsed.

        Uses psutil for cross-platform RSS measurement (Windows, Mac, Linux).
        Called from report() — samples at most once per _memory_sample_interval.
        """
        now = time.time()
        if now - self._last_memory_sample < self._memory_sample_interval:
            return

        self._last_memory_sample = now

        try:
            if self._process is None:
                import psutil

                self._process = psutil.Process()

            rss_mb = self._process.memory_info().rss / (1024 * 1024)
            self._memory_samples.append(rss_mb)
        except Exception:
            pass  # psutil unavailable or process gone

    def _get_avg_memory_mb(self) -> float:
        """Average RSS in MB across all samples, or 0 if no samples yet."""
        if not self._memory_samples:
            return 0.0
        return sum(self._memory_samples) / len(self._memory_samples)

    # ========================================================================
    # REPORT
    # ========================================================================

    def report(self) -> dict:
        """
        Return a cumulative snapshot for the ``>MET*`` protocol.

        Includes:
        - metrics: flat dict of all accumulated values
          (gpu_preprocess, gpu_compute, gpu_memory, cpu_compute,
           cpu_memory, gpu_inference_count, requests, pages, etc.)
        - events: structured event dicts

        The parent process (``task_metrics.py``) replaces its previous
        snapshot with each new report via ``merge_subprocess_metrics()``,
        so values here must be running totals — not deltas.

        Returns:
            ``{'metrics': {name: value, ...}, 'events': [...]}``
        """
        # Sample memory if interval has elapsed (outside lock — psutil may be slow)
        self._sample_memory()

        with self._lock:
            snapshot = dict(self._metrics)
            # Inject CPU metrics alongside everything else
            # CPU compute: actual CPU seconds consumed (cumulative)
            snapshot['cpu_compute'] = time.process_time()

            # CPU memory for billing: average RSS in GB × elapsed = GB·seconds (cumulative)
            # Same unit as gpu_memory (GB·sec) — no special handling in billing
            avg_mb = self._get_avg_memory_mb()
            avg_gb = avg_mb / 1024
            elapsed = time.time() - self._start_time
            snapshot['cpu_memory'] = avg_gb * elapsed

            # CPU memory for display: current average RSS in MB (not for billing)
            snapshot['cpu_memory_avg_mb'] = avg_mb

            return {
                'metrics': snapshot,
                'events': list(self._events),
            }


# ============================================================================
# GLOBAL SINGLETON
# ============================================================================

# Single instance used throughout the subprocess by wrappers, nodes,
# and taskhook.  Imported as: ``from ai.web.metrics import metrics``
metrics = MetricsManager()
