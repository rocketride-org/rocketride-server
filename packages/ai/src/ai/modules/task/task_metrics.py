"""
Task Metrics: Billing and resource tracking for pipeline tasks.

Metrics are self-reported by the subprocess via the >MET* protocol
(5-second intervals from MetricsManager). The parent process (eaas)
ingests these snapshots and converts them to billable tokens.

No OS-level sampling (psutil/pynvml) is needed — the subprocess reports:
- cpu_compute: actual CPU seconds (time.process_time())
- cpu_memory: average RSS in MB (sampled every 15s)
- gpu_preprocess, gpu_compute, gpu_postprocess, gpu_queue_wait: ms
- gpu_memory: GB·sec (model_gb × inference_sec × fair_share)
- gpu_inference_count, requests, pages, etc. (counters)

Classes:
    TaskMetrics: Main billing tracker — ingests >MET* snapshots, converts to tokens
"""

import asyncio
import time
from typing import Optional, TYPE_CHECKING, Callable
from rocketlib import debug
from ai.constants import (
    CONST_BILLING_REPORT_INTERVAL,
    CONST_METRICS_STOP_TIMEOUT,
)

if TYPE_CHECKING:
    from rocketride import TASK_STATUS


class TaskMetrics:
    """
    Billing tracker for a single pipeline task.

    Ingests subprocess metrics snapshots from the >MET* protocol and converts
    accumulated resource usage to billable tokens. No OS-level sampling —
    all metrics are self-reported by the subprocess (MetricsManager).

    Attributes:
        pid (int): Process ID being monitored
        task_id: Task identifier for billing reports
        user_id, team_id, org_id: Billing attribution
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
        on_update_callback: Optional[Callable[[], None]] = None,
        **kwargs,
    ):
        """
        Initialize billing tracker.

        Args:
            pid: Root process ID (for identification, not sampling)
            task_status: Reference to TASK_STATUS to update in-place
            task_id: Task identifier for billing reports
            client_id: Account/client identifier
            user_id: User who owns the task
            team_id: Team the task belongs to
            org_id: Organisation the task belongs to
            on_update_callback: Callback when metrics are updated
        """
        self.pid = pid
        self.task_id = task_id
        self.client_id = client_id
        self.user_id = user_id or ''
        self.team_id = team_id or ''
        self.org_id = org_id or ''
        self._on_update_callback = on_update_callback

        # Monitoring control
        self._monitoring_task: Optional[asyncio.Task] = None
        self._stop_monitoring = asyncio.Event()
        self._metrics_lock = asyncio.Lock()

        # Reference to the task status (Pydantic model, updated in-place)
        self._status = task_status

        # Subprocess-reported metrics (absolute snapshot from >MET* protocol)
        self._subprocess_metrics: dict[str, float] = {}

        # Task timing
        self._start_time: float = time.time()
        self._duration_seconds: float = 0.0

        # Periodic billing report tracking
        self._report_interval_seconds: float = CONST_BILLING_REPORT_INTERVAL
        self._last_report_time: float = time.time()

        # Track values at last report for delta calculation
        self._last_report_tokens: dict[str, float] = {}

    # ========================================================================
    # SUBPROCESS METRICS INGESTION
    # ========================================================================

    def merge_subprocess_metrics(self, metrics_dict: dict) -> None:
        """
        Ingest a subprocess billing snapshot received via the >MET* protocol.

        The payload is an absolute snapshot (cumulative totals). Each call
        replaces the previous snapshot — the subprocess owns the running
        totals and the parent consumes them.

        Args:
            metrics_dict: ``{"metrics": {name: value, ...}, "events": [...]}``
        """
        self._subprocess_metrics = {str(k): float(v) for k, v in metrics_dict.get('metrics', {}).items()}

        # Update duration
        self._duration_seconds = time.time() - self._start_time

        # Update user-facing status metrics from subprocess data
        self._status.metrics.cpu_percent = 0  # No longer OS-sampling — cpu_compute is in seconds
        self._status.metrics.cpu_memory_mb = self._subprocess_metrics.get('cpu_memory_avg_mb', 0.0)
        self._status.metrics.gpu_memory_mb = 0  # No longer OS-sampling — gpu_memory is in GB·sec

        # Convert to tokens
        self._update_tokens()

        # Notify that metrics were updated
        if self._on_update_callback:
            self._on_update_callback()

    # ========================================================================
    # TOKEN CONVERSION
    # ========================================================================

    def _load_rates(self) -> dict[str, float]:
        """
        Get billing rates from the SaaS account provider's in-memory cache.

        Rates are loaded from DB at eaas startup (init_account) and can be
        reloaded on demand via rrext_billing_rates reload command.
        No DB access here — just reads the cached dict.
        Falls back to empty dict in OSS mode (no SaaS provider).
        """
        try:
            from ai.account import account

            return account.get_billing_rates()
        except Exception:
            return {}

    def _update_tokens(self) -> None:
        """
        Convert subprocess-reported metrics to billable tokens.

        All metrics are cumulative values from the subprocess >MET* snapshot.
        Each is multiplied by its rate from the metrics_conversions DB table.
        tokens = metric_value × tokens_per_unit for each metric key.
        """
        m = self._subprocess_metrics
        rates = self._load_rates()

        # Simple: for each metric, look up rate, multiply
        total_tokens = 0.0
        per_metric_tokens: dict[str, float] = {}

        for key, value in m.items():
            rate = rates.get(key, 0.0)
            if rate > 0:
                tokens = value * rate
                per_metric_tokens[key] = round(tokens, 1)
                total_tokens += tokens

        # === Populate usage (new unified field) ===
        # Raw metrics + _tokens sub-dict with per-metric charges
        usage = dict(m)  # Copy all raw metrics
        usage['_tokens'] = {**per_metric_tokens, 'total': round(total_tokens, 1)}
        self._status.usage = usage

        # === Populate deprecated tokens field (backward compat) ===
        self._status.tokens.cpu_utilization = per_metric_tokens.get('cpu_compute', 0.0)
        self._status.tokens.cpu_memory = per_metric_tokens.get('cpu_memory', 0.0)
        self._status.tokens.gpu_inference = per_metric_tokens.get('gpu_compute', 0.0)
        self._status.tokens.gpu_memory = per_metric_tokens.get('gpu_memory', 0.0)

        custom_tokens: dict[str, float] = {}
        for key, tokens in per_metric_tokens.items():
            if key not in ('cpu_compute', 'cpu_memory', 'gpu_compute', 'gpu_memory'):
                custom_tokens[key] = tokens

        self._status.tokens.custom = custom_tokens
        self._status.tokens.total = round(total_tokens, 1)

    # ========================================================================
    # BILLING REPORT (STUB)
    # ========================================================================

    def _report_to_billing_system(self) -> None:
        """
        Send periodic billing report to the billing system.

        Called every CONST_BILLING_REPORT_INTERVAL seconds (15s for testing).
        Reports INCREMENTAL token usage since the last report.

        STUB: Logs the report. TODO: HTTP POST to billing API.
        """
        # Calculate incremental token deltas since last report
        current_tokens = {
            'cpu_utilization': self._status.tokens.cpu_utilization,
            'cpu_memory': self._status.tokens.cpu_memory,
            'gpu_inference': self._status.tokens.gpu_inference,
            'gpu_memory': self._status.tokens.gpu_memory,
            **self._status.tokens.custom,
        }

        delta_tokens = {}
        delta_total = 0.0
        for key, value in current_tokens.items():
            prev = self._last_report_tokens.get(key, 0.0)
            delta = value - prev
            if abs(delta) > 0.01:
                delta_tokens[key] = round(delta, 2)
                delta_total += delta

        # Prepare report
        report_data = {
            'report_timestamp': time.time(),
            'report_period_seconds': self._report_interval_seconds,
            'task_id': self.task_id,
            'client_id': self.client_id,
            'user_id': self.user_id,
            'team_id': self.team_id,
            'org_id': self.org_id,
            'incremental_tokens': {**delta_tokens, 'total': round(delta_total, 2)},
            'cumulative_total': {
                'duration_seconds': self._duration_seconds,
                'tokens_total': self._status.tokens.total,
            },
            'subprocess_metrics': dict(self._subprocess_metrics),
        }

        # Update last-report tracking
        self._last_report_tokens = dict(current_tokens)

        # STUB: Log the report
        try:
            if abs(delta_total) > 0.01:
                debug(
                    f'[TaskMetrics] Billing: {delta_tokens} Total={delta_total:.2f} '
                    f'(Cumulative: {self._status.tokens.total})'
                )
        except Exception:
            pass

        # TODO: POST to billing API
        _ = report_data

    # ========================================================================
    # MONITORING LOOP
    # ========================================================================

    async def _monitoring_loop(self) -> None:
        """
        Background loop for periodic billing reports.

        No OS-level sampling — just checks the billing report timer.
        Subprocess metrics arrive via merge_subprocess_metrics() which
        is called from task_engine.py when >MET* events are received.
        """
        while not self._stop_monitoring.is_set():
            try:
                # Check if billing report is due
                current_time = time.time()
                self._duration_seconds = current_time - self._start_time

                async with self._metrics_lock:
                    time_since_last_report = current_time - self._last_report_time
                    if time_since_last_report >= self._report_interval_seconds:
                        try:
                            self._report_to_billing_system()
                            self._last_report_time = current_time
                        except Exception as e:
                            debug(f'[TaskMetrics] Error sending billing report: {e}')
                            self._last_report_time = current_time

            except Exception as e:
                debug(f'[TaskMetrics] Error in monitoring loop: {e}')

            # Wait for next check (1 second intervals for responsive shutdown)
            try:
                await asyncio.wait_for(self._stop_monitoring.wait(), timeout=1.0)
                break
            except asyncio.TimeoutError:
                continue

    # ========================================================================
    # START / STOP
    # ========================================================================

    def start_monitoring(self) -> None:
        """
        Start background billing report timer.

        Resets all tracking for a fresh session. Safe to call multiple times.
        """
        if self._monitoring_task is None or self._monitoring_task.done():
            # Reset tracking
            self._start_time = time.time()
            self._last_report_time = time.time()
            self._last_report_tokens = {}
            self._subprocess_metrics = {}

            # Reset tokens
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
        Stop monitoring and send final billing report.
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

        # Final billing report
        async with self._metrics_lock:
            self._duration_seconds = time.time() - self._start_time
            self._update_tokens()
            self._report_to_billing_system()
