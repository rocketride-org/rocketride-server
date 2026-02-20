"""
Task Metrics: Real-time resource utilization tracking for pipeline tasks.

This module provides comprehensive metrics collection for CPU, memory, and GPU
resources during task execution. Metrics are sampled at configurable intervals
and accumulated for billing and monitoring purposes.

Features:
- Per-task CPU and memory tracking using psutil
- Monitors entire process tree (parent + all children recursively)
- Per-process GPU memory tracking using nvidia-ml-py (NVIDIA GPUs only)
- Thread-safe metrics accumulation via asyncio
- Automatic cleanup on task completion

Classes:
    TaskMetrics: Main metrics collector and accumulator
"""

import asyncio
import time
import psutil
from typing import Optional, TYPE_CHECKING, Callable
from rocketlib import debug
from ai.constants import (
    CONST_METRICS_SAMPLE_INTERVAL,
    CONST_BILLING_REPORT_INTERVAL,
    CONST_METRICS_STOP_TIMEOUT,
    CONST_RATE_VCPU_HOUR,
    CONST_RATE_MEMORY_GB_HOUR,
    CONST_RATE_GPU_GB_HOUR,
)

if TYPE_CHECKING:
    from rocketride import TASK_STATUS


class TaskMetrics:
    """
    Real-time metrics collector for task resource utilization.

    Tracks CPU, memory, and GPU usage with per-second sampling and provides
    accumulated totals for billing and monitoring. Monitors the main process
    and all its child processes (recursive). Metrics are collected in a
    background asyncio task and updated atomically.

    Attributes:
        pid (int): Process ID to monitor (includes all children)
        sample_interval (float): Seconds between samples (default: 1.0)
        _process (psutil.Process): Process handle
        _monitoring_task (Optional[asyncio.Task]): Background monitoring task
        _stop_monitoring (asyncio.Event): Signal to stop monitoring
        _metrics_lock (asyncio.Lock): Thread-safe metrics access
        _current (Dict): Current snapshot metrics
        _accumulated (Dict): Accumulated totals since start
    """

    def __init__(
        self,
        pid: int,
        task_status: 'TASK_STATUS',
        sample_interval: Optional[float] = None,
        on_update_callback: Optional[Callable[[], None]] = None,
    ):
        """
        Initialize metrics collector for a process tree.

        Monitors the specified process and all its child processes (recursive).
        Metrics are aggregated across the entire process tree and written
        directly into the provided task status (updates metrics and tokens in-place).

        Args:
            pid: Root process ID to monitor (includes all children)
            task_status: Reference to TASK_STATUS to update in-place (metrics and tokens fields)
            sample_interval: Seconds between metric samples (default: from constants.CONST_METRICS_SAMPLE_INTERVAL)
            on_update_callback: Optional callback to invoke when metrics are updated

        Raises:
            psutil.NoSuchProcess: If process does not exist
        """
        self.pid = pid
        self.sample_interval = sample_interval if sample_interval is not None else CONST_METRICS_SAMPLE_INTERVAL
        self._on_update_callback = on_update_callback

        # Process handle
        self._process = psutil.Process(pid)

        # CPU core count for normalization
        self._cpu_count = psutil.cpu_count(logical=True) or 1

        # Monitoring control
        self._monitoring_task: Optional[asyncio.Task] = None
        self._stop_monitoring = asyncio.Event()

        # Thread-safe metrics access
        self._metrics_lock = asyncio.Lock()

        # Reference to the task status (Pydantic model, updated in-place)
        self._status = task_status

        # Internal billing accumulators (not exposed to user)
        self._duration_seconds: float = 0.0
        self._sample_count: int = 0
        self._cpu_seconds: float = 0.0
        self._memory_mb_seconds: float = 0.0
        self._gpu_memory_mb_seconds: float = 0.0

        # Raw CPU percent (unnormalized) for billing calculations
        self._cpu_percent_raw: float = 0.0

        # GPU detection using pynvml (required for accurate per-process billing)
        self._gpu_available: bool = False
        self._gpu_count: int = 0
        self._pynvml_available: bool = False
        self._gpu_baseline_memory_mb: list[float] = []  # Baseline memory per GPU at start

        # Periodic billing report tracking (from constants)
        self._report_interval_seconds: float = CONST_BILLING_REPORT_INTERVAL
        self._last_report_time: float = time.time()

        # Track values at last report for delta calculation
        self._last_report_cpu_seconds: float = 0.0
        self._last_report_memory_mb_seconds: float = 0.0
        self._last_report_gpu_memory_mb_seconds: float = 0.0
        self._last_report_tokens_cpu: float = 0.0
        self._last_report_tokens_memory: float = 0.0
        self._last_report_tokens_gpu: float = 0.0

        # Detect GPU capabilities using pynvml
        self._detect_gpu()

    def _detect_gpu(self) -> None:
        """
        Detect available NVIDIA GPUs using pynvml.

        Uses NVIDIA Management Library (NVML) to detect GPU count. This is required
        for accurate per-process GPU memory billing. If pynvml is not available or
        no GPUs are found, GPU billing will be disabled for this task.
        """
        try:
            import pynvml

            # Initialize NVML
            pynvml.nvmlInit()

            # Get GPU count
            self._gpu_count = pynvml.nvmlDeviceGetCount()
            self._gpu_available = self._gpu_count > 0
            self._pynvml_available = True

            if self._gpu_available:
                # Get driver version
                driver_version = pynvml.nvmlSystemGetDriverVersion()

                # Capture baseline memory for each GPU (for fallback billing)
                for gpu_index in range(self._gpu_count):
                    try:
                        handle = pynvml.nvmlDeviceGetHandleByIndex(gpu_index)
                        mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                        baseline_mb = float(mem_info.used // (1024 * 1024))
                        self._gpu_baseline_memory_mb.append(baseline_mb)
                    except Exception:
                        self._gpu_baseline_memory_mb.append(0.0)

                # Log GPU detection for debugging
                debug(f'[TaskMetrics] Detected {self._gpu_count} NVIDIA GPU(s) for billing')
                debug(f'[TaskMetrics] NVIDIA Driver Version: {driver_version}')
                debug(f'[TaskMetrics] GPU baseline memory: {self._gpu_baseline_memory_mb} MB')

        except ImportError:
            # pynvml not available - GPU billing will be disabled
            debug('[TaskMetrics] NVidia management library not installed')
            self._gpu_available = False
            self._gpu_count = 0
            self._pynvml_available = False

        except Exception as e:
            # NVML initialization failed - GPU billing will be disabled
            debug(f'[TaskMetrics] GPU detection failed: {e}')
            self._gpu_available = False
            self._gpu_count = 0
            self._pynvml_available = False

    def _sample_cpu_memory(self) -> None:
        """
        Sample current CPU and memory usage for process tree.

        Uses psutil to get process CPU percentage and memory usage for the
        main process and all its children (recursive). Updates metrics dict
        directly with aggregated values.
        """
        try:
            # Start with main process
            cpu_percent = self._process.cpu_percent(interval=None)
            mem_info = self._process.memory_info()
            memory_mb = mem_info.rss / (1024 * 1024)  # Resident Set Size

            # Add all child processes (recursive)
            try:
                for child in self._process.children(recursive=True):
                    try:
                        cpu_percent += child.cpu_percent(interval=None)
                        child_mem = child.memory_info()
                        memory_mb += child_mem.rss / (1024 * 1024)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        # Child died or no access - skip it
                        continue
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # Main process died while getting children
                pass

            # Normalize CPU to 0-100% by dividing by number of cores
            # (raw value can exceed 100% on multi-core systems)
            cpu_percent_normalized = cpu_percent / self._cpu_count if self._cpu_count > 0 else cpu_percent

            self._status.metrics.cpu_percent = cpu_percent_normalized
            self._status.metrics.cpu_memory_mb = memory_mb

            # Store unnormalized CPU for billing (raw vCPU usage)
            self._cpu_percent_raw = cpu_percent

        except (psutil.NoSuchProcess, psutil.AccessDenied):
            # Process died or no access
            pass

    def _sample_gpu(self) -> None:
        """
        Sample current GPU memory usage (per-process tree, across all GPUs).

        Queries all available NVIDIA GPUs using pynvml and sums memory for the main process
        and all its children (recursive). A pipeline may spawn child processes that use GPUs,
        and may use multiple GPUs, so we aggregate memory usage from all GPUs where our
        process tree is found.

        If pynvml is not available or fails, GPU memory is set to 0 (no GPU billing).
        """
        if not self._pynvml_available:
            # No pynvml - GPU billing disabled (warning already logged at init)
            self._status.metrics.gpu_memory_mb = 0.0
            return

        try:
            import pynvml

            # Build set of PIDs to track (main process + all children)
            pids_to_track = {self.pid}
            try:
                for child in self._process.children(recursive=True):
                    try:
                        pids_to_track.add(child.pid)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # Main process died while getting children
                pass

            # Query all GPUs and sum memory for our process tree
            total_gpu_memory_mb = 0.0

            for gpu_index in range(self._gpu_count):
                try:
                    # Get handle for this GPU
                    handle = pynvml.nvmlDeviceGetHandleByIndex(gpu_index)
                    compute_procs = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)

                    # Sum per-process memory for our process tree
                    gpu_memory_this_gpu = 0.0
                    found_our_process = False

                    for proc in compute_procs:
                        if proc.pid in pids_to_track:
                            found_our_process = True
                            if proc.usedGpuMemory is not None:
                                # Per-process memory available (Linux, Windows TCC)
                                gpu_memory_this_gpu += float(proc.usedGpuMemory // (1024 * 1024))

                    # If we found our process but got no memory (all returned None)
                    # Check if this is a driver limitation or genuinely zero usage
                    if found_our_process and gpu_memory_this_gpu == 0.0:
                        # Check if ANY process has memory reporting
                        driver_supports_memory = any(p.usedGpuMemory is not None for p in compute_procs)

                        if not driver_supports_memory:
                            # Driver limitation (Windows WDDM) - use fallback
                            if not hasattr(self, '_logged_fallback_billing'):
                                debug('[TaskMetrics] WARNING: Driver does not support per-process GPU memory')
                                debug('[TaskMetrics] Using total GPU memory minus baseline (approximation)')
                                self._logged_fallback_billing = True

                            # Fallback: total GPU memory - baseline
                            mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                            current_total_mb = float(mem_info.used // (1024 * 1024))
                            baseline_mb = self._gpu_baseline_memory_mb[gpu_index] if gpu_index < len(self._gpu_baseline_memory_mb) else 0.0
                            gpu_memory_this_gpu = max(0.0, current_total_mb - baseline_mb)
                        # else: driver supports it, our process truly has 0 memory

                    total_gpu_memory_mb += gpu_memory_this_gpu

                except Exception:
                    # This GPU failed, continue to next one
                    continue

            self._status.metrics.gpu_memory_mb = total_gpu_memory_mb

        except Exception as e:
            # NVML sampling failed - log error once but don't crash
            if not hasattr(self, '_logged_sampling_error'):
                debug(f'[TaskMetrics] WARNING: GPU sampling failed: {e}')
                self._logged_sampling_error = True
            self._status.metrics.gpu_memory_mb = 0.0

    def _accumulate_sample(self, interval: float) -> None:
        """
        Accumulate current sample into totals.

        Args:
            interval: Time elapsed since last sample (seconds)
        """
        # Update billing accumulators (internal)
        # Use raw CPU percent (unnormalized) for accurate vCPU-seconds billing
        self._sample_count += 1
        self._duration_seconds += interval
        self._cpu_seconds += self._cpu_percent_raw * interval / 100.0
        self._memory_mb_seconds += self._status.metrics.cpu_memory_mb * interval

        if self._gpu_available:
            self._gpu_memory_mb_seconds += self._status.metrics.gpu_memory_mb * interval

        # Track peaks (user-facing)
        self._status.metrics.peak_cpu_percent = max(self._status.metrics.peak_cpu_percent, self._status.metrics.cpu_percent)
        self._status.metrics.peak_cpu_memory_mb = max(self._status.metrics.peak_cpu_memory_mb, self._status.metrics.cpu_memory_mb)
        self._status.metrics.peak_gpu_memory_mb = max(self._status.metrics.peak_gpu_memory_mb, self._status.metrics.gpu_memory_mb)

        # Calculate averages (user-facing)
        if self._duration_seconds > 0:
            self._status.metrics.avg_cpu_percent = (self._cpu_seconds / self._duration_seconds) * 100
            self._status.metrics.avg_cpu_memory_mb = self._memory_mb_seconds / self._duration_seconds
            if self._gpu_available:
                self._status.metrics.avg_gpu_memory_mb = self._gpu_memory_mb_seconds / self._duration_seconds

        # Update tokens (user-facing billing)
        self._update_tokens()

    def _update_tokens(self) -> None:
        """
        Update cumulative token usage from resource accumulators.

        Calculates tokens directly from raw resource usage (CPU-seconds,
        memory MB-seconds, GPU MB-seconds) and updates status.tokens in-place.
        """
        # Convert accumulators to billable resource-hours
        vcpu_hours = self._cpu_seconds / 3600
        memory_gb_hours = self._memory_mb_seconds / 1024 / 3600
        gpu_gb_hours = self._gpu_memory_mb_seconds / 1024 / 3600

        # Calculate token charges
        cpu_tokens = vcpu_hours * CONST_RATE_VCPU_HOUR
        memory_tokens = memory_gb_hours * CONST_RATE_MEMORY_GB_HOUR
        gpu_tokens = gpu_gb_hours * CONST_RATE_GPU_GB_HOUR

        # Update status tokens in-place
        self._status.tokens.cpu_utilization = round(cpu_tokens, 1)
        self._status.tokens.cpu_memory = round(memory_tokens, 1)
        self._status.tokens.gpu_memory = round(gpu_tokens, 1)
        self._status.tokens.total = round(self._status.tokens.cpu_utilization + self._status.tokens.cpu_memory + self._status.tokens.gpu_memory, 1)

    def _report_to_billing_system(self) -> None:
        """
        Send periodic billing report to the billing system.

        This method is called every 5 minutes to report INCREMENTAL usage
        since the last report. Only the delta (new usage in this period) is
        sent to the billing system.

        STUB: Implementation pending - will send HTTP POST to billing API.

        The report includes:
        - Task identification (task_id, customer_id, etc. from status)
        - INCREMENTAL resource usage since last report:
            * CPU usage delta (vCPU-seconds)
            * Memory usage delta (MB-seconds)
            * GPU memory usage delta (MB-seconds)
        - INCREMENTAL token charges since last report (cpu, memory, gpu, total)
        - Current metrics snapshot (cpu_percent, memory_mb, gpu_memory_mb)
        - Peak and average metrics (lifetime cumulative)
        """
        # Calculate incremental usage since last report
        delta_cpu_seconds = self._cpu_seconds - self._last_report_cpu_seconds
        delta_memory_mb_seconds = self._memory_mb_seconds - self._last_report_memory_mb_seconds
        delta_gpu_memory_mb_seconds = self._gpu_memory_mb_seconds - self._last_report_gpu_memory_mb_seconds

        # Calculate incremental token charges since last report
        delta_tokens_cpu = self._status.tokens.cpu_utilization - self._last_report_tokens_cpu
        delta_tokens_memory = self._status.tokens.cpu_memory - self._last_report_tokens_memory
        delta_tokens_gpu = self._status.tokens.gpu_memory - self._last_report_tokens_gpu
        delta_tokens_total = delta_tokens_cpu + delta_tokens_memory + delta_tokens_gpu

        # Prepare incremental report data structure (will be sent to billing API)
        report_data = {
            'report_timestamp': time.time(),
            'report_period_seconds': self._report_interval_seconds,
            # INCREMENTAL usage for this 5-minute period only
            'incremental_usage': {
                'cpu_seconds': round(delta_cpu_seconds, 2),
                'memory_mb_seconds': round(delta_memory_mb_seconds, 2),
                'gpu_memory_mb_seconds': round(delta_gpu_memory_mb_seconds, 2),
            },
            # INCREMENTAL token charges for this 5-minute period only
            'incremental_tokens': {
                'cpu_utilization': round(delta_tokens_cpu, 1),
                'cpu_memory': round(delta_tokens_memory, 1),
                'gpu_memory': round(delta_tokens_gpu, 1),
                'total': round(delta_tokens_total, 2),
            },
            # Cumulative values (for reference/validation)
            'cumulative_total': {
                'duration_seconds': self._duration_seconds,
                'tokens_total': self._status.tokens.total,
            },
            # Current state snapshot
            'current_metrics': {
                'cpu_percent': self._status.metrics.cpu_percent,
                'cpu_memory_mb': self._status.metrics.cpu_memory_mb,
                'gpu_memory_mb': self._status.metrics.gpu_memory_mb,
            },
            # Lifetime peaks and averages
            'peak_metrics': {
                'cpu_percent': self._status.metrics.peak_cpu_percent,
                'cpu_memory_mb': self._status.metrics.peak_cpu_memory_mb,
                'gpu_memory_mb': self._status.metrics.peak_gpu_memory_mb,
            },
            'average_metrics': {
                'cpu_percent': self._status.metrics.avg_cpu_percent,
                'cpu_memory_mb': self._status.metrics.avg_cpu_memory_mb,
                'gpu_memory_mb': self._status.metrics.avg_gpu_memory_mb,
            },
        }

        # Update "last report" tracking FIRST (before any potential failures)
        # This ensures we don't double-report the same period if logging fails
        self._last_report_cpu_seconds = self._cpu_seconds
        self._last_report_memory_mb_seconds = self._memory_mb_seconds
        self._last_report_gpu_memory_mb_seconds = self._gpu_memory_mb_seconds
        self._last_report_tokens_cpu = self._status.tokens.cpu_utilization
        self._last_report_tokens_memory = self._status.tokens.cpu_memory
        self._last_report_tokens_gpu = self._status.tokens.gpu_memory

        # STUB: Log the report (will be replaced with actual API call)
        try:
            print('[TaskMetrics] Billing report:')
            print(f'  Incremental Tokens (this period): CPU Utilization={delta_tokens_cpu:.2f}, CPU Memory={delta_tokens_memory:.2f}, GPU Memory={delta_tokens_gpu:.2f}, Total={delta_tokens_total:.2f}')
            print(f'  Cumulative Tokens (lifetime): CPU Utilization={self._status.tokens.cpu_utilization}, CPU Memory={self._status.tokens.cpu_memory}, GPU Memory={self._status.tokens.gpu_memory}, Total={self._status.tokens.total}')
            print(f'  Current Metrics: CPU={self._status.metrics.cpu_percent:.1f}%, CPU Memory={self._status.metrics.cpu_memory_mb:.1f}MB, GPU Memory={self._status.metrics.gpu_memory_mb:.1f}MB')
        except Exception:
            # Don't let print failures break billing tracking
            pass

        # TODO: Implement actual billing API call
        # When billing system is ready:
        # 1. Add CONST_BILLING_API_TIMEOUT to imports at top of file
        # 2. Send report_data via HTTP POST:
        #
        # import requests
        # response = requests.post(
        #     f'{billing_system_url}/api/v1/billing/report',
        #     json=report_data,
        #     timeout=CONST_BILLING_API_TIMEOUT
        # )
        # response.raise_for_status()
        #
        # For now, report_data is prepared but only logged above
        _ = report_data  # Suppress unused variable warning

    async def _monitoring_loop(self) -> None:
        """
        Background monitoring loop.

        Samples CPU, memory, and GPU metrics at configured interval until
        stop signal is received. Updates are written directly into the
        status metrics dict and protected by metrics lock.
        """
        last_sample_time = time.time()

        # Initial CPU sample (requires two samples for percentage)
        try:
            self._process.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return

        # Wait one interval before first real sample
        await asyncio.sleep(self.sample_interval)

        while not self._stop_monitoring.is_set():
            current_time = time.time()
            interval = current_time - last_sample_time

            try:
                async with self._metrics_lock:
                    # Sample current metrics
                    self._sample_cpu_memory()
                    self._sample_gpu()

                    # Accumulate into totals
                    self._accumulate_sample(interval)

                    # Check if 5 minutes have elapsed since last billing report
                    time_since_last_report = current_time - self._last_report_time
                    if time_since_last_report >= self._report_interval_seconds:
                        try:
                            self._report_to_billing_system()
                            self._last_report_time = current_time
                        except Exception as e:
                            # Log error but don't crash monitoring loop
                            debug(f'[TaskMetrics] Error sending billing report: {e}')
                            # Still update report time to avoid continuous retry
                            self._last_report_time = current_time

                last_sample_time = current_time

                # Notify that metrics were updated
                if self._on_update_callback:
                    self._on_update_callback()
            except Exception as e:
                # Catch any unexpected errors to keep monitoring loop alive
                debug(f'[TaskMetrics] Error in monitoring loop: {e}')
                last_sample_time = current_time  # Still update time to avoid tight loop

            # Wait for next sample
            try:
                await asyncio.wait_for(self._stop_monitoring.wait(), timeout=self.sample_interval)
                break  # Stop signal received
            except asyncio.TimeoutError:
                continue  # Continue monitoring

    def start_monitoring(self) -> None:
        """
        Start background metrics collection.

        Spawns an asyncio task that samples metrics at the configured interval.
        Resets all tracking variables and tokens for a fresh monitoring session.
        Safe to call multiple times (subsequent calls are no-ops).
        """
        if self._monitoring_task is None or self._monitoring_task.done():
            # Reset all tracking for new monitoring session
            self._last_report_time = time.time()
            self._last_report_cpu_seconds = 0.0
            self._last_report_memory_mb_seconds = 0.0
            self._last_report_gpu_memory_mb_seconds = 0.0
            self._last_report_tokens_cpu = 0.0
            self._last_report_tokens_memory = 0.0
            self._last_report_tokens_gpu = 0.0

            # Reset cumulative tokens in status
            self._status.tokens.cpu_utilization = 0.0
            self._status.tokens.cpu_memory = 0.0
            self._status.tokens.gpu_memory = 0.0
            self._status.tokens.total = 0.0

            # Start monitoring
            self._stop_monitoring.clear()
            self._monitoring_task = asyncio.create_task(self._monitoring_loop())

    async def stop_monitoring(self) -> None:
        """
        Stop background metrics collection.

        Signals the monitoring task to stop and waits for it to complete.
        Sends a final billing report for any remaining incremental usage.
        All metrics and tokens are preserved until start_monitoring() is called again.
        """
        if self._monitoring_task and not self._monitoring_task.done():
            self._stop_monitoring.set()
            try:
                await asyncio.wait_for(self._monitoring_task, timeout=CONST_METRICS_STOP_TIMEOUT)
            except asyncio.TimeoutError:
                self._monitoring_task.cancel()
                try:
                    await self._monitoring_task
                except asyncio.CancelledError:
                    pass

        # Send final billing report on shutdown (captures any remaining incremental usage)
        async with self._metrics_lock:
            self._report_to_billing_system()
