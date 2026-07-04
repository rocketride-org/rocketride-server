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
import uuid
import psutil
from typing import Optional, TYPE_CHECKING, Callable
from rocketlib import debug
from ai.constants import (
    CONST_METRICS_SAMPLE_INTERVAL,
    CONST_BILLING_REPORT_INTERVAL,
    CONST_METRICS_STOP_TIMEOUT,
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
        task_id: Optional[str] = None,
        client_id: Optional[str] = None,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        org_id: Optional[str] = None,
        pipeline_name: Optional[str] = None,
        source_name: Optional[str] = None,
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
            task_id: Task identifier for billing reports
            client_id: Account/client identifier for billing reports
            user_id: User who owns the task (for per-user billing)
            team_id: Team the task belongs to (for per-team billing)
            org_id: Organisation the task belongs to (for per-org billing)
            sample_interval: Seconds between metric samples (default: from constants.CONST_METRICS_SAMPLE_INTERVAL)
            on_update_callback: Optional callback to invoke when metrics are updated

        Raises:
            psutil.NoSuchProcess: If process does not exist
        """
        self.pid = pid
        self.task_id = task_id
        # Unique per-run identifier for billing idempotency. task_id is a
        # display ID (e.g. "44568e99.dropper_1") that can repeat across runs
        # with the same token. The billing_run_id ensures each run gets its
        # own ledger rows even if the display task_id is reused.
        self.billing_run_id = str(uuid.uuid4())
        self.client_id = client_id
        self.user_id = user_id or ''
        self.team_id = team_id or ''
        self.org_id = org_id or ''
        self.pipeline_name = pipeline_name or ''
        self.source_name = source_name or ''
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
        self._last_report_tokens_gpu_inference: float = 0.0
        self._last_report_tokens_custom: dict[str, float] = {}

        # Billing gate: when True, billing accumulators and token updates are
        # suppressed until set_service_up(True) is called. Resource metrics
        # (peaks, averages) are still tracked so the dashboard shows live usage.
        self._billing_gated: bool = True

        # Subprocess-reported metrics (absolute snapshots from >MET* protocol)
        self._subprocess_counters: dict[str, float] = {}
        self._subprocess_timers: dict[str, float] = {}

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

    def set_service_up(self, value: bool) -> None:
        """Signal that the pipeline is ready (or no longer ready) to accept data.

        When the pipeline signals serviceUp, billing accumulation begins.
        Resource metrics (peaks, averages) are tracked regardless of this flag.
        """
        if value and self._billing_gated:
            debug('[TaskMetrics] Pipeline ready — billing accumulation started')
        self._billing_gated = not value

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
                            baseline_mb = (
                                self._gpu_baseline_memory_mb[gpu_index]
                                if gpu_index < len(self._gpu_baseline_memory_mb)
                                else 0.0
                            )
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

        Peaks are always tracked for dashboard visibility. Averages and
        billing accumulators are suppressed until the pipeline signals
        serviceUp (via set_service_up), so users are not charged for
        startup time (model loading, dependency installation).

        Args:
            interval: Time elapsed since last sample (seconds)
        """
        # Track peaks (user-facing — always, regardless of billing gate)
        self._status.metrics.peak_cpu_percent = max(
            self._status.metrics.peak_cpu_percent, self._status.metrics.cpu_percent
        )
        self._status.metrics.peak_cpu_memory_mb = max(
            self._status.metrics.peak_cpu_memory_mb, self._status.metrics.cpu_memory_mb
        )
        self._status.metrics.peak_gpu_memory_mb = max(
            self._status.metrics.peak_gpu_memory_mb, self._status.metrics.gpu_memory_mb
        )

        # Billing accumulators and token updates — only after serviceUp
        if self._billing_gated:
            return

        # Update billing accumulators (internal)
        # Use raw CPU percent (unnormalized) for accurate vCPU-seconds billing
        self._sample_count += 1
        self._duration_seconds += interval
        self._cpu_seconds += self._cpu_percent_raw * interval / 100.0
        self._memory_mb_seconds += self._status.metrics.cpu_memory_mb * interval

        if self._gpu_available:
            self._gpu_memory_mb_seconds += self._status.metrics.gpu_memory_mb * interval

        # Calculate averages (user-facing — billing period only)
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

        Rates are loaded from the DB-backed billing rates cache
        (Account.get_billing_rates) so admins can adjust pricing at
        runtime. All time-based metrics use milliseconds; memory
        metrics use GB-seconds.

        Calculates tokens from:
        - OS-level resource usage (CPU ms, memory GB-sec, GPU memory GB-sec)
        - Subprocess-reported GPU inference timing (from >MET* protocol, ms)
        - Subprocess-reported timers/counters with matching DB rate keys
        """
        from ai.account import account

        rates = account.get_billing_rates()

        # OS-level: convert accumulators to rate-table units
        cpu_ms = self._cpu_seconds * 1000.0
        memory_gb_sec = self._memory_mb_seconds / 1024.0

        # OS-level token charges (rate is tokens-per-unit from DB)
        cpu_tokens = cpu_ms * rates.get('cpu_compute', 0.0)
        memory_tokens = memory_gb_sec * rates.get('cpu_memory', 0.0)

        # GPU inference tokens (subprocess-reported timer in ms)
        gpu_inference_ms = self._subprocess_timers.get('gpu_compute', 0.0)
        gpu_inference_tokens = gpu_inference_ms * rates.get('gpu_compute', 0.0)

        # GPU memory tokens — pro-rated by model size during actual inference
        # only (reported by model server or local-mode wrappers as GB-sec
        # in the 'gpu_memory' timer). Value is already in GB-sec (not ms).
        gpu_memory_gb_sec = self._subprocess_timers.get('gpu_memory', 0.0)
        gpu_memory_tokens = gpu_memory_gb_sec * rates.get('gpu_memory', 0.0)

        # Subprocess-reported timers and counters: apply any matching DB rate
        # Skip 'gpu_compute' (already handled above) and 'gpu_memory'
        # (already handled above).
        _handled_timers = {'gpu_compute', 'gpu_memory'}
        custom_tokens: dict[str, float] = {}
        for timer_name, timer_ms in self._subprocess_timers.items():
            if timer_name in _handled_timers:
                continue
            rate = rates.get(timer_name, 0.0)
            if rate > 0:
                custom_tokens[timer_name] = round(timer_ms * rate, 1)
        for counter_name, counter_value in self._subprocess_counters.items():
            rate = rates.get(counter_name, 0.0)
            if rate > 0:
                custom_tokens[counter_name] = round(counter_value * rate, 1)

        # Update status tokens in-place
        self._status.tokens.cpu_utilization = round(cpu_tokens, 1)
        self._status.tokens.cpu_memory = round(memory_tokens, 1)
        self._status.tokens.gpu_memory = round(gpu_memory_tokens, 1)
        self._status.tokens.gpu_inference = round(gpu_inference_tokens, 1)
        self._status.tokens.custom = custom_tokens
        self._status.tokens.total = round(
            self._status.tokens.cpu_utilization
            + self._status.tokens.cpu_memory
            + self._status.tokens.gpu_memory
            + self._status.tokens.gpu_inference
            + sum(custom_tokens.values()),
            1,
        )

    def merge_subprocess_metrics(self, metrics_dict: dict) -> None:
        """
        Ingest a subprocess billing snapshot received via the >MET* protocol.

        The payload is an **absolute snapshot** of the subprocess task metrics
        (accumulated across all pipes).  Each call replaces the previous
        snapshot rather than adding to it — the subprocess owns the running
        totals and the parent consumes them.

        Args:
            metrics_dict: ``{"timers": {name: ms, ...}, "counters": {name: value, ...}, ...}``
        """
        self._subprocess_timers = {str(k): float(v) for k, v in metrics_dict.get('timers', {}).items()}
        self._subprocess_counters = {str(k): float(v) for k, v in metrics_dict.get('counters', {}).items()}
        self._update_tokens()

        # Notify that metrics were updated
        if self._on_update_callback:
            self._on_update_callback()

    async def _report_to_billing_system(self) -> None:
        """
        Write cumulative token usage to the credit ledger via ``account.apply_debit()``.

        Called every ``CONST_BILLING_REPORT_INTERVAL`` seconds and once on
        task completion.  Each resource gets its own UPSERT row keyed on
        ``task:{task_id}:{resource}`` — the amount is the cumulative total
        (not an incremental delta), so repeated calls update the row in-place.

        In OSS mode (no SaaS extension), ``account.apply_debit()`` is a no-op.
        """
        # ── Build cumulative token totals ────────────────────────────────
        # All values are already converted to tokens by _update_tokens().
        # Each entry is (resource_bucket, description, amount).
        # Infrastructure metrics (cpu, memory, gpu) bill against 'tokens';
        # custom counters may bill against their own resource bucket.
        token_totals: list[tuple[str, str, float]] = [
            ('tokens', 'cpu_utilization', self._status.tokens.cpu_utilization),
            ('tokens', 'cpu_memory', self._status.tokens.cpu_memory),
            ('tokens', 'gpu_memory', self._status.tokens.gpu_memory),
            ('tokens', 'gpu_inference', self._status.tokens.gpu_inference),
        ]
        # Custom counters use the counter name as both resource and description
        for counter_name, counter_tokens in self._status.tokens.custom.items():
            token_totals.append((counter_name, counter_name, counter_tokens))
        # ── Debug logging ────────────────────────────────────────────────
        try:
            debug(
                f'[TaskMetrics] Billing report: task={self.task_id} total={self._status.tokens.total:.2f} resources={token_totals}'
            )
        except Exception:
            pass

        # ── Advance last-report tracking state ──────────────────────────
        # Record current accumulator values so the next report (or any
        # external consumer) can compute the delta accrued since this report.
        # This runs unconditionally — even in OSS mode (no org_id) — so that
        # internal tracking state stays consistent for tests and consumers.
        self._last_report_cpu_seconds = self._cpu_seconds
        self._last_report_memory_mb_seconds = self._memory_mb_seconds
        self._last_report_gpu_memory_mb_seconds = self._gpu_memory_mb_seconds
        self._last_report_tokens_cpu = self._status.tokens.cpu_utilization
        self._last_report_tokens_memory = self._status.tokens.cpu_memory
        self._last_report_tokens_gpu = self._status.tokens.gpu_memory

        # ── Write to ledger via account.apply_debit() ────────────────────
        # The account singleton dispatches to the SaaS implementation (UPSERT
        # into credit_ledger) or the OSS no-op depending on the active edition.
        if not self.org_id or not token_totals:
            return

        try:
            from ai.account import account

            context = {
                'task_id': self.task_id,
                'pipeline': self.pipeline_name,
                'source': self.source_name,
                'client_id': self.client_id,
                'duration_seconds': round(self._duration_seconds, 1),
                'tokens_total': round(self._status.tokens.total, 2),
            }
            for resource, description, amount in token_totals:
                if amount <= 0:
                    continue
                idem_key = f'task:{self.billing_run_id}:{description}'
                await account.apply_debit(
                    org_id=self.org_id,
                    user_id=self.user_id,
                    team_id=self.team_id,
                    resource=resource,
                    amount=amount,
                    idempotency_key=idem_key,
                    context=context,
                    description=description,
                )
        except Exception as e:
            debug(f'[TaskMetrics] Error writing to billing ledger: {e}')

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
                            await self._report_to_billing_system()
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
            self._last_report_tokens_gpu_inference = 0.0
            self._last_report_tokens_custom = {}

            # Reset subprocess metrics
            self._subprocess_counters = {}
            self._subprocess_timers = {}

            # Reset cumulative tokens in status
            self._status.tokens.cpu_utilization = 0.0
            self._status.tokens.cpu_memory = 0.0
            self._status.tokens.gpu_memory = 0.0
            self._status.tokens.gpu_inference = 0.0
            self._status.tokens.custom = {}
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
            await self._report_to_billing_system()

        # Audit the final frozen usage totals for this task
        await self._audit_task_usage()

    async def _audit_task_usage(self) -> None:
        """
        Write a single audit log entry with the final frozen token totals
        for this task.  Called once at task completion after the last
        billing UPSERT has been written.

        No-op in OSS (account.audit is a no-op) or when there is no org.
        """
        if not self.org_id:
            return

        tokens = self._status.tokens
        total = tokens.total
        if total <= 0:
            return

        try:
            from ai.account import account

            # Build per-resource breakdown from the frozen token counters
            usage = {}
            if tokens.cpu_utilization > 0:
                usage['cpu_utilization'] = round(tokens.cpu_utilization, 2)
            if tokens.cpu_memory > 0:
                usage['cpu_memory'] = round(tokens.cpu_memory, 2)
            if tokens.gpu_memory > 0:
                usage['gpu_memory'] = round(tokens.gpu_memory, 2)
            if tokens.gpu_inference > 0:
                usage['gpu_inference'] = round(tokens.gpu_inference, 2)
            for key, val in (tokens.custom or {}).items():
                if val > 0:
                    usage[key] = round(val, 2)

            await account.audit(
                user_id=self.user_id,
                source='billing',
                reason='task_usage',
                request_data={
                    'task_id': self.task_id,
                    'pipeline': self.pipeline_name,
                    'source': self.source_name,
                    'duration_seconds': round(self._duration_seconds, 1),
                },
                response_data={
                    'tokens_total': round(total, 2),
                    'usage': usage,
                },
                org_id=self.org_id,
            )
        except Exception as e:
            debug(f'[TaskMetrics] Error writing usage audit: {e}')
