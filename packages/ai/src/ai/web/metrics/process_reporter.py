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
Process resource reporter — subprocess self-reporting for live metrics and billing.

Runs on a dedicated daemon thread within the task subprocess.  Every second it:

1. Samples CPU utilization via ``getrusage`` (Linux) or ``psutil`` (Windows)
2. Reads current RSS from ``/proc/self/statm`` (Linux) or ``psutil`` (Windows)
3. Reads GPU VRAM via ``pynvml`` (0 in model-server mode or when no GPU)
4. Emits ``>MET*`` with live point-in-time values for the dashboard
5. Accumulates billing values (``cpu_compute``, ``cpu_memory``) into MetricsManager
   via ``set_value()`` and emits a cumulative ``>USG*`` billing snapshot on the
   billing cadence (``CONST_BILLING_REPORT_INTERVAL``) — in addition to the
   object-boundary ``>USG*`` from taskhook — so idle pipelines that hold GPU/RAM
   without processing objects are still billed

The parent (EAAS node) is a passive receiver — no psutil, no pynvml, no polling.

Usage (called from taskhook.py)::

    from ai.web.metrics.process_reporter import process_reporter

    process_reporter.start()  # begin reporting
    process_reporter.stop()  # final sample + stop thread
"""

import json
import os
import sys
import threading
import time
from typing import Optional

from ai.constants import CONST_BILLING_REPORT_INTERVAL, CONST_PROCESS_REPORT_INTERVAL
from .metrics import metrics

# ============================================================================
# PLATFORM-SPECIFIC IMPORTS
# ============================================================================

# getrusage: exact kernel-tracked CPU accounting (Linux/macOS only)
_HAS_RESOURCE = False
if sys.platform != 'win32':
    try:
        import resource

        _HAS_RESOURCE = True
    except ImportError:
        pass

# psutil: fallback for Windows (cheap for single-process self-measurement)
_HAS_PSUTIL = False
_psutil_process: Optional[object] = None
try:
    import psutil

    _HAS_PSUTIL = True
except ImportError:
    pass

# pynvml: GPU VRAM measurement (not blocked by gpu_guard)
_HAS_PYNVML = False
_nvml_initialized = False
_gpu_count = 0
try:
    import pynvml

    _HAS_PYNVML = True
except ImportError:
    pass

# Page size for /proc/self/statm RSS calculation
_PAGE_SIZE = os.sysconf('SC_PAGE_SIZE') if hasattr(os, 'sysconf') else 4096


# ============================================================================
# SAMPLING FUNCTIONS
# ============================================================================


def _read_rss_mb() -> float:
    """
    Read current RSS (Resident Set Size) in megabytes.

    Uses ``/proc/self/statm`` on Linux (microseconds, no library overhead).
    Falls back to ``psutil`` on Windows/macOS.

    Returns:
        Current process RSS in MB, or 0.0 if unavailable.
    """
    # Linux fast path: read /proc/self/statm directly
    if sys.platform != 'win32':
        try:
            with open('/proc/self/statm', 'r') as f:
                # Field 1 (index 1) is RSS in pages
                fields = f.read().split()
                rss_pages = int(fields[1])
                return (rss_pages * _PAGE_SIZE) / (1024 * 1024)
        except (IOError, IndexError, ValueError):
            pass

    # Fallback: psutil (Windows/macOS or Linux fallback)
    if _HAS_PSUTIL:
        global _psutil_process
        try:
            if _psutil_process is None:
                _psutil_process = psutil.Process(os.getpid())
            return _psutil_process.memory_info().rss / (1024 * 1024)
        except Exception:
            pass

    return 0.0


def _read_cpu_times() -> tuple:
    """
    Read cumulative CPU times (user + system) in seconds.

    Uses ``getrusage`` on Linux/macOS (nanosecond-level kernel call).
    Falls back to ``psutil`` on Windows.

    Returns:
        (user_seconds, system_seconds) tuple, or (0.0, 0.0) if unavailable.
    """
    if _HAS_RESOURCE:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return (usage.ru_utime, usage.ru_stime)

    if _HAS_PSUTIL:
        global _psutil_process
        try:
            if _psutil_process is None:
                _psutil_process = psutil.Process(os.getpid())
            times = _psutil_process.cpu_times()
            return (times.user, times.system)
        except Exception:
            pass

    return (0.0, 0.0)


def _read_gpu_vram_mb() -> float:
    """
    Read current GPU VRAM usage for this process in megabytes.

    Uses ``pynvml`` to query per-process GPU memory across all GPUs.
    Returns 0.0 in model-server mode (subprocess doesn't own GPU),
    when no NVIDIA GPU is present, or when ``pynvml`` is not available.

    Returns:
        Current GPU VRAM in MB for this process, or 0.0.
    """
    global _nvml_initialized, _gpu_count

    if not _HAS_PYNVML:
        return 0.0

    # Lazy init: first call initializes pynvml
    if not _nvml_initialized:
        try:
            pynvml.nvmlInit()
            _gpu_count = pynvml.nvmlDeviceGetCount()
            _nvml_initialized = True
        except Exception:
            return 0.0

    if _gpu_count == 0:
        return 0.0

    my_pid = os.getpid()
    total_mb = 0.0

    for gpu_idx in range(_gpu_count):
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(gpu_idx)
            procs = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)
            for proc in procs:
                if proc.pid == my_pid and proc.usedGpuMemory is not None:
                    total_mb += proc.usedGpuMemory / (1024 * 1024)
        except Exception:
            continue

    return total_mb


# ============================================================================
# PROCESS REPORTER
# ============================================================================


class ProcessReporter:
    """
    Periodic self-reporter for process resource metrics.

    Runs on a dedicated daemon thread.  Emits ``>MET*`` for the live
    dashboard (point-in-time values) and accumulates ``cpu_compute``
    and ``cpu_memory`` into ``MetricsManager`` for billing via ``>USG*``.

    Thread-safe: start/stop can be called from any thread.
    Idempotent: multiple start() calls are no-ops while running.
    """

    def __init__(self, interval: float = CONST_PROCESS_REPORT_INTERVAL):
        """
        Initialize the reporter.

        Args:
            interval: Seconds between samples (default 1.0).
        """
        self._interval = interval
        self._stopped = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # CPU tracking for delta-based percentage calculation
        self._last_utime = 0.0
        self._last_stime = 0.0
        self._last_wall = 0.0

        # Billing accumulators (cumulative, only grow)
        self._cumulative_cpu_ms = 0.0
        self._cumulative_mem_gb_sec = 0.0

        # CPU core count for normalization (0-100% range)
        self._cpu_count = os.cpu_count() or 1

        # Periodic >USG* billing emit (see _sample). Emitted on the billing
        # cadence, not just at object boundaries, so idle pipelines that reserve
        # GPU/RAM without processing objects are still billed.
        self._usg_interval = CONST_BILLING_REPORT_INTERVAL
        self._last_usg_wall = 0.0

    def start(self):
        """
        Start the reporter thread.  Idempotent — no-op if already running.

        Primes the initial CPU sample (getrusage requires two calls for
        delta-based percentage) and resets billing accumulators.
        """
        if self._thread is not None and self._thread.is_alive():
            return

        # Prime CPU baseline
        utime, stime = _read_cpu_times()
        self._last_utime = utime
        self._last_stime = stime
        self._last_wall = time.monotonic()
        # Emit the first >USG* on the very first sample (not one billing interval
        # later) so the parent receives a real cumulative startup snapshot well
        # before serviceUp. That lets the parent capture its billing baseline AT
        # serviceUp from actual usage instead of deferring it to the first object
        # boundary — which would otherwise fold the first object's work into the
        # baseline and drop it from billing.
        self._last_usg_wall = 0.0

        # Reset billing accumulators
        self._cumulative_cpu_ms = 0.0
        self._cumulative_mem_gb_sec = 0.0

        # Start daemon thread
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name='ProcessReporter',
        )
        self._thread.start()

    def stop(self):
        """
        Stop the reporter thread and do a final sample.

        Ensures the last billing values are written to MetricsManager
        before the final ``>USG*`` snapshot is emitted by taskhook.
        """
        if self._thread is None or not self._thread.is_alive():
            return

        # Signal stop and wait for thread to finish
        self._stopped.set()
        self._thread.join(timeout=3.0)
        if self._thread.is_alive():
            # Join timed out. Leave _thread set (so a later start() won't spawn a
            # second reporter) and skip the final _sample() so we don't race the
            # daemon's still-in-flight sample.
            return
        self._thread = None

        # Final sample to ensure billing accumulators are up to date
        self._sample()

    def _run(self):
        """
        Main thread loop: sample and emit every interval.

        Uses ``threading.Event.wait()`` for clean interruptible sleep.
        """
        while not self._stopped.is_set():
            self._sample()
            # Sleep for interval, or wake immediately on stop()
            self._stopped.wait(self._interval)

    def _sample(self):
        """
        Perform one sample cycle: measure, emit >MET*, update billing.

        Exceptions are silently caught to prevent the reporter thread
        from crashing the subprocess.
        """
        try:
            now = time.monotonic()
            dt = now - self._last_wall
            if dt <= 0:
                dt = self._interval  # Guard against clock weirdness

            # ── CPU utilization ──────────────────────────────────────
            utime, stime = _read_cpu_times()
            delta_cpu = (utime - self._last_utime) + (stime - self._last_stime)
            # Normalize to 0-100% across all cores
            cpu_percent = (delta_cpu / dt) * 100.0 / self._cpu_count if dt > 0 else 0.0
            cpu_percent = min(cpu_percent, 100.0)

            # Update cumulative CPU-ms for billing (un-normalized, raw CPU time)
            self._cumulative_cpu_ms = (utime + stime) * 1000.0

            self._last_utime = utime
            self._last_stime = stime
            self._last_wall = now

            # ── Memory ───────────────────────────────────────────────
            rss_mb = _read_rss_mb()
            rss_gb = rss_mb / 1024.0

            # Accumulate memory GB-seconds for billing
            self._cumulative_mem_gb_sec += rss_gb * dt

            # ── GPU VRAM ─────────────────────────────────────────────
            gpu_mb = _read_gpu_vram_mb()

            # ── Emit >MET* (live dashboard) ──────────────────────────
            payload = {
                'cpu_percent': round(cpu_percent, 1),
                'cpu_memory_mb': round(rss_mb, 1),
                'gpu_memory_mb': round(gpu_mb, 1),
            }
            try:
                from rocketlib import monitorMetrics

                monitorMetrics(payload)
            except Exception:
                pass  # Subprocess may not have rocketlib ready yet

            # ── Update MetricsManager for billing (>USG*) ───────────
            metrics.set_value('cpu_compute', self._cumulative_cpu_ms)
            metrics.set_value('cpu_memory', self._cumulative_mem_gb_sec)

            # ── Emit periodic >USG* (billing cadence) ────────────────
            # >USG* is otherwise only emitted at object boundaries (taskhook).
            # An idle pipeline (e.g. a chat holding models with no traffic)
            # processes no objects, so without a periodic emit it would never be
            # billed for the GPU/RAM it reserves. Push a cumulative snapshot on
            # the billing cadence so idle reservation is charged and the parent's
            # startup baseline lands at ~service-up, not at the first object.
            if now - self._last_usg_wall >= self._usg_interval:
                self._last_usg_wall = now
                try:
                    from rocketlib import monitorOther

                    report = metrics.report()
                    if report:
                        monitorOther('USG', json.dumps(report, separators=(',', ':')))
                except Exception:
                    pass  # Subprocess may not have rocketlib ready yet

        except Exception:
            pass  # Never crash the subprocess


# ============================================================================
# GLOBAL SINGLETON
# ============================================================================

process_reporter = ProcessReporter()
