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
from typing import Optional, TYPE_CHECKING, Callable
from rocketlib import debug
from ai.constants import CONST_BILLING_REPORT_INTERVAL

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
        task_status: 'TASK_STATUS',
        task_id: Optional[str] = None,
        client_id: Optional[str] = None,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        org_id: Optional[str] = None,
        pipeline_name: Optional[str] = None,
        source_name: Optional[str] = None,
        on_update_callback: Optional[Callable[[], None]] = None,
    ):
        """
        Initialize metrics collector for a task.

        Billing values arrive from the subprocess via ``>USG*`` and are
        converted to tokens using rates from the ``metrics_conversions``
        database table.  Live resource metrics (cpu_percent, cpu_memory_mb,
        gpu_memory_mb) are pushed directly to ``_status.metrics`` by the
        task engine from ``>MET*`` — not by this class.

        Args:
            task_status: Reference to TASK_STATUS to update in-place (tokens field)
            task_id: Task identifier for billing reports
            client_id: Account/client identifier for billing reports
            user_id: User who owns the task (for per-user billing)
            team_id: Team the task belongs to (for per-team billing)
            org_id: Organisation the task belongs to (for per-org billing)
            on_update_callback: Optional callback to invoke when tokens are updated
        """
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
        self._on_update_callback = on_update_callback

        # Monitoring control
        self._stop_monitoring = asyncio.Event()

        # Thread-safe metrics access
        self._metrics_lock = asyncio.Lock()

        # Reference to the task status (Pydantic model, updated in-place)
        self._status = task_status

        # Periodic billing report tracking
        self._report_interval_seconds: float = CONST_BILLING_REPORT_INTERVAL
        self._last_report_time: float = time.time()

        # Billing gate: when True, token updates are suppressed until
        # set_service_up(True) is called.  Live metrics (peaks) are still
        # tracked by the task engine from >MET* regardless of this flag.
        self._billing_gated: bool = True

        # Subprocess-reported billing values (absolute snapshots from >USG*)
        # Flat dict: keys match metrics_conversions DB table (e.g. cpu_compute,
        # gpu_memory, requests, pages).  Replaced wholesale on each >USG* message.
        self._subprocess_usage: dict[str, float] = {}

        # Baselines ("startup delta") — subtracted from subprocess_usage so
        # startup costs (model load, dependency install) are excluded from
        # billing.  Captured at/after service-up (see set_service_up).
        self._baselines: dict[str, float] = {}

        # Safety net for the (now rare) case where service-up fires before any
        # ``>USG*`` has arrived.  ProcessReporter emits its first ``>USG*`` on its
        # very first sample (~1s after task start), so by the time the pipeline is
        # ready _subprocess_usage is normally already populated and the baseline
        # is captured directly at service-up.  If service-up still beats the first
        # snapshot, this flag defers baseline capture to the first ``>USG*`` after
        # service-up (snapshotting an empty baseline would bill all of startup).
        self._baseline_pending: bool = False

    def set_service_up(self, value: bool) -> None:
        """Signal that the pipeline is ready (or no longer ready) to accept data.

        When the pipeline signals serviceUp, billing accumulation begins.
        Snapshots the current subprocess usage values as baselines so startup
        costs (model loading, dependency installation) are excluded from billing.
        Live resource metrics (peaks) are tracked regardless of this flag.
        """
        if value and self._billing_gated:
            # Baseline = cumulative usage at the moment the pipeline became
            # ready; everything before this point is startup and is excluded
            # from billing.  The first >USG* may not have arrived yet at this
            # instant (periodic billing-cadence emit or object boundary), so
            # _subprocess_usage may still be empty here — capture whatever we
            # have and, if empty, defer the baseline to the first >USG* that
            # arrives after service-up (merge_subprocess_usage).
            self._baselines = dict(self._subprocess_usage)
            self._baseline_pending = not self._subprocess_usage
            debug('[TaskMetrics] Pipeline ready — billing accumulation started')
        self._billing_gated = not value

    def _update_tokens(self) -> None:
        """
        Update cumulative token usage from subprocess-reported billing values.

        All billing data now comes from the subprocess via ``>USG*``.  Each
        key in ``_subprocess_usage`` is matched against the ``metrics_conversions``
        DB table.  Startup costs are excluded via baseline subtraction (baselines
        are snapshotted at ``set_service_up(True)``).

        When billing is gated (before serviceUp), tokens are not calculated.
        """
        if self._billing_gated:
            return

        from ai.account import account

        rates = account.get_billing_rates()

        # Single generic loop: each subprocess-reported value is matched
        # against its DB rate key. Baseline subtracted to exclude startup.
        tokens: dict[str, float] = {}
        for key, value in self._subprocess_usage.items():
            billable = value - self._baselines.get(key, 0.0)
            rate = rates.get(key, 0.0)
            if rate > 0 and billable > 0:
                tokens[key] = round(billable * rate, 1)

        # Reconstruct the TASK_TOKENS model with the new values
        from rocketride.types.task import TASK_TOKENS

        self._status.tokens = TASK_TOKENS(**tokens)

    def merge_subprocess_usage(self, payload: dict) -> None:
        """
        Ingest a subprocess billing snapshot received via the ``>USG*`` protocol.

        The payload is a flat dict of cumulative billing values (absolute
        snapshot).  Each call replaces the previous snapshot — the subprocess
        owns the running totals and the parent consumes them.

        Keys match the ``metrics_conversions`` DB table (e.g. ``cpu_compute``,
        ``gpu_memory``, ``requests``, ``pages``).

        Args:
            payload: ``{"values": {name: amount, ...}, "events": [...]}``
        """
        values = payload.get('values', {})
        self._subprocess_usage = {str(k): float(v) for k, v in values.items()}

        # Complete a deferred baseline (rare — see _baseline_pending): only when
        # service-up beat the reporter's first >USG* is this first post-service-up
        # cumulative snapshot treated as the startup delta and excluded from
        # billing (this first report nets to zero; subsequent reports bill
        # value − baseline).
        if self._baseline_pending and not self._billing_gated:
            self._baselines = dict(self._subprocess_usage)
            self._baseline_pending = False

        self._update_tokens()

        # Notify that metrics were updated
        if self._on_update_callback:
            self._on_update_callback()

    async def _report_to_billing_system(self) -> None:
        """
        Write cumulative token usage to the credit ledger via ``account.apply_debit()``.

        Called every ``CONST_BILLING_REPORT_INTERVAL`` seconds and once on
        task completion.  Each token key gets its own UPSERT row keyed on
        ``task:{billing_run_id}:{key}`` — the amount is the cumulative total
        (not an incremental delta), so repeated calls update the row in-place.

        In OSS mode (no SaaS extension), ``account.apply_debit()`` is a no-op.
        """
        # Dump all token values from the dynamic Pydantic model
        token_dict = self._status.tokens.model_dump()
        total = sum(token_dict.values())

        # Debug logging
        try:
            debug(f'[TaskMetrics] Billing report: task={self.task_id} total={total:.2f} tokens={token_dict}')
        except Exception:
            pass

        # Write to ledger
        if not self.org_id or total <= 0:
            return

        try:
            from ai.account import account

            context = {
                'task_id': self.task_id,
                'pipeline': self.pipeline_name,
                'source': self.source_name,
                'client_id': self.client_id,
                'tokens_total': round(total, 2),
            }
            for key, amount in token_dict.items():
                if amount <= 0:
                    continue
                idem_key = f'task:{self.billing_run_id}:{key}'
                await account.apply_debit(
                    org_id=self.org_id,
                    user_id=self.user_id,
                    team_id=self.team_id,
                    resource='tokens',
                    amount=amount,
                    idempotency_key=idem_key,
                    context=context,
                    description=key,
                )
        except Exception as e:
            debug(f'[TaskMetrics] Error writing to billing ledger: {e}')

    async def check_billing_report(self) -> None:
        """
        Check if a periodic billing report is due and send it.

        Called by the server's centralized billing loop.  CPU/memory/GPU
        sampling is now handled by the subprocess via ``>MET*`` and
        ``>USG*`` — this method only checks the billing report timer.
        """
        if self._stop_monitoring.is_set():
            return

        current_time = time.time()
        time_since_last_report = current_time - self._last_report_time

        if time_since_last_report >= self._report_interval_seconds:
            try:
                async with self._metrics_lock:
                    await self._report_to_billing_system()
                self._last_report_time = current_time
            except Exception as e:
                debug(f'[TaskMetrics] Error sending billing report: {e}')
                self._last_report_time = current_time

    def start_monitoring(self) -> None:
        """
        Prepare for metrics collection.

        Resets all tracking variables and marks this instance as active.
        CPU/memory/GPU sampling is handled by the subprocess ProcessReporter;
        the parent only manages billing reports via check_billing_report().
        """
        # Reset billing report tracking
        self._last_report_time = time.time()

        # Reset subprocess billing values
        self._subprocess_usage = {}
        self._baselines = {}

        # Reset cumulative tokens in status
        from rocketride.types.task import TASK_TOKENS

        self._status.tokens = TASK_TOKENS()

        # Mark as active
        self._stop_monitoring.clear()

    async def stop_monitoring(self) -> None:
        """
        Stop metrics collection.

        Marks this instance as inactive so the server's centralized loop
        skips it. Sends a final billing report for any remaining usage.
        All metrics and tokens are preserved.
        """
        self._stop_monitoring.set()

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

        # Dump token values from the extra-allow Pydantic model
        token_dict = self._status.tokens.model_dump()
        total = sum(token_dict.values())
        if total <= 0:
            return

        try:
            from ai.account import account

            # Build per-resource breakdown from the frozen token values
            usage = {k: round(v, 2) for k, v in token_dict.items() if v > 0}

            await account.audit(
                user_id=self.user_id,
                source='billing',
                reason='task_usage',
                request_data={
                    'task_id': self.task_id,
                    'pipeline': self.pipeline_name,
                    'source': self.source_name,
                },
                response_data={
                    'tokens_total': round(total, 2),
                    'usage': usage,
                },
                org_id=self.org_id,
            )
        except Exception as e:
            debug(f'[TaskMetrics] Error writing usage audit: {e}')
