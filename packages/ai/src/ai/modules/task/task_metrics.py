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
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING, Tuple
from rocketlib import debug
from ai.constants import (
    CONST_METRICS_SAMPLE_INTERVAL,
    CONST_BILLING_REPORT_INTERVAL,
    CONST_METRICS_STOP_TIMEOUT,
)

if TYPE_CHECKING:
    from rocketride import TASK_STATUS


@dataclass
class TraceUsage:
    """
    The usage accumulated under one request tree, and the control it belongs to.

    One engine serves many controls; each request tree (one ``traceId``, shared
    by every pipe the request opens) belongs to exactly one of them, so
    per-trace usage is what attributes an engine's work to the paying controls
    (plan 8.2). Metering fills it (C.13).

    Attributes:
        control_key: The registry key of the control that owns the trace.
        timers: Accumulated milliseconds per resource key.
        counters: Accumulated counts per resource key.
        billing: Who pays (plan 8.3): the request's caller and their home team.
        address: The control's address (``developerId.pipeId.source``).
        rung: The rung the control resolved on.
        team: The answering publication's audience slot (``''`` on a dev run).
        version: The answering artifact version (None on a dev run).
    """

    control_key: str
    timers: Dict[str, float] = field(default_factory=dict)
    counters: Dict[str, int] = field(default_factory=dict)
    billing: Any = None
    address: str = ''
    rung: str = ''
    team: str = ''
    version: Optional[int] = None


#: How long a closed bucket with no owner yet waits for its claim before it is dropped
CONST_ORPHAN_BUCKET_SECONDS = 60.0


class UsageSink:
    """
    Where a request tree's usage leaves the engine host (plan 8.2, ALB seam 5).

    The unit of accounting is ONE REQUEST: when a tree closes, its tokens per
    resource and ``request_count`` 1 are an INCREMENT to the day row
    ``usage:{dayNumber}:{developerId.pipeId}:{rung}:{team}:{version}:{userId}:{resource}``
    of its paying unit, written with the account's additive ``apply_usage``.
    The PUBLICATION that answered (rung, audience slot, version; ``-`` where a
    dev run has none) is part of the key, so one caller's calls through
    Staging and through Production on one day are two rows and a per-team
    count is a plain group-by (decided 2026-11-16). Posting
    coalesces the increments of one row until ``flush`` (the billing report
    interval, and engine end), an optimisation only: a buffered increment is
    dropped when the database confirms the write, and a failed write rides
    the next flush. Nothing here ever holds a row's total.
    """

    def __init__(self, post: Optional[Callable[..., Any]] = None) -> None:
        """
        Args:
            post: The write, ``account.apply_usage`` by default (injectable for tests).
        """
        self._post = post
        # Pending increments by ledger key: {key: {'amount', 'request_count', 'row'}}
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._unconfirmed: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def day_number(now: Optional[float] = None) -> int:
        """UTC days since 1970-01-01 of ``now`` (the day a request CLOSED on)."""
        return int((time.time() if now is None else now) // 86400)

    def post(self, usage: 'TraceUsage', tokens: Dict[str, float], now: Optional[float] = None) -> None:
        """
        Queue one closed request tree's usage as increments to its day rows.

        Args:
            usage: The tree's accumulator (its paying unit, address and rung).
            tokens: Tokens per resource, already converted at the rates.
            now: The close time (injectable).
        """
        billing = usage.billing
        if billing is None or not getattr(billing, 'org_id', '') or not getattr(billing, 'user_id', ''):
            return
        pipe = '.'.join(usage.address.split('.')[:2]) if usage.address else ''
        day = self.day_number(now)
        # The publication segments: a dev run serves through none, so its
        # rows carry '-' where a published rung carries the slot and version
        team = usage.team or '-'
        version = '-' if usage.version is None else str(usage.version)
        for resource, amount in tokens.items():
            if amount <= 0:
                continue
            key = f'usage:{day}:{pipe}:{usage.rung or "-"}:{team}:{version}:{billing.user_id}:{resource}'
            pending = self._pending.get(key)
            if pending is None:
                pending = self._pending[key] = {
                    # The increment's own identity: the ledger refuses a second
                    # write of it, so a retry after an unanswered write is safe
                    'increment_id': uuid.uuid4().hex,
                    'amount': 0.0,
                    'request_count': 0,
                    'row': {
                        'org_id': billing.org_id,
                        'user_id': billing.user_id,
                        'team_id': billing.team_id or None,
                        'resource': resource,
                        'idempotency_key': key,
                        'description': resource,
                        'context': {
                            'address': usage.address,
                            'pipe': pipe,
                            'rung': usage.rung,
                            'team': usage.team or None,
                            'version': usage.version,
                            'day': day,
                        },
                    },
                }
            pending['amount'] += float(amount)
            pending['request_count'] += 1

    async def flush(self) -> None:
        """
        Write every increment not yet confirmed.

        Each open entry is DETACHED before its write is awaited, so increments
        posted meanwhile start a new entry (a new increment id) and are never
        lost with the old one. A write that fails stays UNCONFIRMED and is
        retried first on the next flush, with the same increment id: the
        ledger records applied increment ids with the addition in one
        transaction and refuses a second write of one, so a write that
        committed but did not answer is never added twice (plan 8.2).
        """
        if not self._pending and not self._unconfirmed:
            return
        post = self._post
        if post is None:
            from ai.account import account

            post = account.apply_usage
        # Step 1: the earlier failures first, then the open entries detached
        for key in list(self._pending):
            pending = self._pending.pop(key, None)
            if pending is not None:
                self._unconfirmed[pending['increment_id']] = pending
        # Step 2: one write per increment; confirmed ones are forgotten
        for increment_id, pending in list(self._unconfirmed.items()):
            try:
                await post(
                    amount=pending['amount'],
                    request_count=pending['request_count'],
                    increment_id=increment_id,
                    **pending['row'],
                )
            except Exception as e:
                debug(
                    f'[TaskMetrics] Usage increment {pending["row"]["idempotency_key"]} ({increment_id}) not '
                    f'written, retried on the next flush: {e}'
                )
                continue
            self._unconfirmed.pop(increment_id, None)

    @property
    def pending(self) -> Dict[str, Dict[str, Any]]:
        """The OPEN increments, by ledger key: still taking posts, not yet sent."""
        return self._pending

    @property
    def unconfirmed(self) -> Dict[str, Dict[str, Any]]:
        """The increments sent but not confirmed written, by increment id: retried on the next flush."""
        return self._unconfirmed


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
        attribute: Optional[Callable[[int], Optional['TraceUsage']]] = None,
        usage_sink: Optional['UsageSink'] = None,
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

        # Per-trace accumulators: traceId -> the owning control and its
        # usage. Fresh with every engine start, like everything here.
        self.traces: Dict[int, TraceUsage] = {}
        # Who a tree belongs to, asked once per tree when its first bucket
        # arrives: the engine answers from the server's trace owners (a tree
        # nobody claimed is the engine's own work, metered engine-wide only)
        self._attribute = attribute
        # Where a closed tree's usage goes (plan 8.2)
        self.usage_sink = usage_sink if usage_sink is not None else UsageSink()
        # Closed buckets whose owner was not known when they arrived (a
        # borrowed tool pipe's tree is claimed only once its response reaches
        # the server): kept until the claim lands, dropped after the grace
        self._orphans: Dict[int, Tuple[Dict[str, Any], float]] = {}
        # What the sink has already posted per resource, so the engine owner's
        # cumulative debit never charges a caller's request a second time
        self._attributed: Dict[str, float] = {}
        # The debit lines an earlier report wrote with a positive amount: a
        # later report brings one to zero by writing a zero replacement
        self._debited: set = set()

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

        # No averages are computed here: the status body is summable (ALB
        # seam 3, plan 7.5), so avg_* stay on the frozen contract at 0 and
        # clients derive them from the totals.

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
        self._merge_traces(metrics_dict.get('traces') or {})

        # Notify that metrics were updated
        if self._on_update_callback:
            self._on_update_callback()

    def _less_attributed(self, totals: List[Tuple[str, str, float]]) -> List[Tuple[str, str, float]]:
        """
        The owner's debit lines with the sink-posted amounts removed per resource.

        Args:
            totals: ``(resource, description, amount)`` lines, cumulative.

        Returns:
            The same lines, each resource reduced by what callers were charged, never below zero.
        """
        remaining = dict(self._attributed)
        out: List[Tuple[str, str, float]] = []
        for resource, description, amount in totals:
            taken = min(amount, remaining.get(resource, 0.0))
            if taken > 0:
                remaining[resource] -= taken
            out.append((resource, description, round(amount - taken, 1)))
        return out

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
        # A caller's request is charged once: what the usage sink posted to the
        # callers' day rows (hold time, bytes, the trees' GPU time) comes off
        # the engine owner's cumulative debit, per resource (dashboard totals
        # above stay engine-wide)
        token_totals = self._less_attributed(token_totals)
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
                # A line attribution brought to zero still REPLACES the row an
                # earlier report wrote, else the owner keeps paying what the
                # caller was charged meanwhile
                if amount <= 0 and description not in self._debited:
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
                # Bookkept only once the write is through: a zero replacement
                # that failed stays eligible for the next report
                if amount > 0:
                    self._debited.add(description)
                else:
                    self._debited.discard(description)
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
                            await self.usage_sink.flush()
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

    def _merge_traces(self, traces: Dict[str, Dict[str, Any]]) -> None:
        """
        Take the snapshot's per-tree buckets: cumulative while a tree is open, final when it closed.

        A closed tree is converted to tokens at the rates and posted to the
        usage sink as one request of its paying unit (plan 8.2), then dropped.

        Args:
            traces: ``{traceId: {'timers', 'counters', 'closed'}}`` from the engine.
        """
        self._adopt_orphans()
        for raw_id, bucket in traces.items():
            try:
                trace_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if not self._take_bucket(trace_id, bucket):
                # Nobody has claimed the tree yet: a closed bucket waits for
                # the claim (a borrowed tool pipe's arrives with the tool
                # response); an open one comes again with the next snapshot
                if bucket.get('closed'):
                    self._orphans[trace_id] = (bucket, time.time())

    def _take_bucket(self, trace_id: int, bucket: Dict[str, Any]) -> bool:
        """
        Merge one tree's bucket into its accumulator; post and drop it when closed.

        Args:
            trace_id: The engine's bare traceId.
            bucket: ``{'timers', 'counters', 'closed'}``.

        Returns:
            False when the tree has no owner yet (nothing taken).
        """
        usage = self.traces.get(trace_id)
        if usage is None:
            usage = self._attribute(trace_id) if self._attribute is not None else None
            if usage is None:
                return False
            self.traces[trace_id] = usage
        usage.timers = {str(k): float(v) for k, v in (bucket.get('timers') or {}).items()}
        usage.counters = {str(k): int(v) for k, v in (bucket.get('counters') or {}).items()}
        if bucket.get('closed'):
            tokens = self.tokens_for(usage)
            self.usage_sink.post(usage, tokens)
            for resource, amount in tokens.items():
                self._attributed[resource] = self._attributed.get(resource, 0.0) + float(amount)
            self.traces.pop(trace_id, None)
        return True

    def _adopt_orphans(self) -> None:
        """Attribute the closed buckets that arrived before their claim; drop those past the grace."""
        if not self._orphans:
            return
        now = time.time()
        for trace_id, (bucket, arrived) in list(self._orphans.items()):
            if self._take_bucket(trace_id, bucket) or now - arrived > CONST_ORPHAN_BUCKET_SECONDS:
                self._orphans.pop(trace_id, None)

    def tokens_for(self, usage: TraceUsage) -> Dict[str, float]:
        """
        One tree's usage as tokens per resource, at the current rates.

        The same conversion ``_update_tokens`` applies engine-wide: a timer
        or counter bills only against a ``metrics_conversions`` row of its
        own name; GPU inference and memory bill under ``tokens`` like the
        engine totals, every other metered key under its own resource.

        Args:
            usage: The tree's accumulator.

        Returns:
            ``{resource: tokens}`` with only positive entries.
        """
        from ai.account import account

        rates = account.get_billing_rates()
        tokens: Dict[str, float] = {}

        def _add(resource: str, value: float) -> None:
            if value > 0:
                tokens[resource] = round(tokens.get(resource, 0.0) + value, 4)

        for name, ms in usage.timers.items():
            rate = rates.get(name, 0.0)
            if rate <= 0:
                continue
            _add('tokens' if name in ('gpu_compute', 'gpu_memory') else name, ms * rate)
        for name, count in usage.counters.items():
            rate = rates.get(name, 0.0)
            if rate > 0:
                _add(name, count * rate)
        return tokens

    def trace(self, trace_id: int, control_key: str) -> TraceUsage:
        """
        The accumulator of one request tree, created on first use for its control.

        A ``traceId`` is never reused within an engine, so the first control
        to name it owns it for the engine's life; a later call naming another
        control for the same id is a routing bug and is refused.

        Args:
            trace_id: The request tree's never-reused id (plan 7.4).
            control_key: The registry key of the control that owns it.

        Returns:
            TraceUsage: The trace's accumulator.

        Raises:
            ValueError: The trace already belongs to a different control.
        """
        usage = self.traces.get(trace_id)
        if usage is None:
            usage = self.traces[trace_id] = TraceUsage(control_key=control_key)
        elif usage.control_key != control_key:
            raise ValueError(f'trace {trace_id} belongs to another control')
        return usage

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

        # Send final billing report on shutdown (captures any remaining incremental
        # usage), and the last request increments with it
        async with self._metrics_lock:
            # A closed bucket still waiting for its claim is attributed now,
            # before the owner's final report subtracts it
            self._adopt_orphans()
            await self._report_to_billing_system()
            await self.usage_sink.flush()

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
