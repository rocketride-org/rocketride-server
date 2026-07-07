"""
Unit tests for ai.modules.task.task_metrics.TaskMetrics.

TaskMetrics samples CPU / memory / GPU usage of a process tree at a regular
interval and aggregates the data into a Pydantic TASK_STATUS object plus
internal billing accumulators. The class is mostly pure arithmetic on top
of psutil and (optional) pynvml; tests mock those two external surfaces.

Test strategy:

- ``psutil`` is replaced with a ``MagicMock`` for the whole module via
  monkeypatch. Construction is then safe and ``Process(pid)`` returns a
  controllable mock with ``.cpu_percent`` / ``.memory_info`` / ``.children``
  attributes set per test.
- ``pynvml`` is registered in ``sys.modules`` so the ``import pynvml`` inside
  ``_detect_gpu`` and ``_sample_gpu`` resolves to a fake.
- ``TASK_STATUS`` is faked with a ``SimpleNamespace`` carrying nested
  ``metrics`` and ``tokens`` namespaces — the only attributes TaskMetrics
  actually reads or writes.
- The background ``asyncio`` monitor loop is exercised via
  ``start_monitoring`` / ``stop_monitoring`` in a single asyncio test so
  background-task teardown is deterministic.
"""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.task import task_metrics


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_status():
    """Build a TASK_STATUS-shaped namespace with metrics + tokens sub-objects."""
    return SimpleNamespace(
        metrics=SimpleNamespace(
            cpu_percent=0.0,
            cpu_memory_mb=0.0,
            gpu_memory_mb=0.0,
            peak_cpu_percent=0.0,
            peak_cpu_memory_mb=0.0,
            peak_gpu_memory_mb=0.0,
            avg_cpu_percent=0.0,
            avg_cpu_memory_mb=0.0,
            avg_gpu_memory_mb=0.0,
        ),
        tokens=SimpleNamespace(
            cpu_utilization=0.0,
            cpu_memory=0.0,
            gpu_memory=0.0,
            gpu_inference=0.0,
            custom={},
            total=0.0,
        ),
    )


class _NoSuchProcess(Exception):
    """Stand-in for psutil.NoSuchProcess used in exception-path tests."""


class _AccessDenied(Exception):
    """Stand-in for psutil.AccessDenied used in exception-path tests."""


@pytest.fixture
def fake_psutil(monkeypatch):
    """
    Replace ai.modules.task.task_metrics.psutil with a controllable MagicMock.

    Tests configure the returned ``fake.Process`` to yield a per-test process
    object via ``fake.Process.return_value = <mock>``. ``NoSuchProcess`` and
    ``AccessDenied`` exception classes are wired so the source code's
    ``except (psutil.NoSuchProcess, psutil.AccessDenied)`` blocks behave
    correctly under tests that raise them.

    Args:
        monkeypatch: pytest's monkeypatch fixture.

    Returns:
        MagicMock: the patched psutil module replacement.
    """
    fake = MagicMock()
    fake.NoSuchProcess = _NoSuchProcess
    fake.AccessDenied = _AccessDenied
    fake.cpu_count = MagicMock(return_value=4)
    monkeypatch.setattr(task_metrics, 'psutil', fake)
    return fake


@pytest.fixture
def no_gpu(monkeypatch):
    """
    Make ``import pynvml`` raise ImportError so GPU detection falls into the
    no-GPU branch — the simplest setup for tests that do not care about GPU.

    Args:
        monkeypatch: pytest's monkeypatch fixture.
    """
    monkeypatch.setitem(sys.modules, 'pynvml', None)  # importing None raises


# Default billing rates matching the DB seed defaults (all time units in ms).
_TEST_BILLING_RATES = {
    'cpu_compute': 0.001,  # tokens per ms
    'cpu_memory': 0.05,  # tokens per GB-sec
    'gpu_compute': 0.005,  # tokens per ms
    'gpu_memory': 2.0,  # tokens per GB-sec
    'gpu_preprocess': 0.0,
    'gpu_postprocess': 0.0,
    'gpu_queue_wait': 0.0,
    'gpu_inference_count': 0.0,
}


@pytest.fixture(autouse=True)
def mock_billing_rates(monkeypatch):
    """Mock account.get_billing_rates() so _update_tokens() uses test rates."""
    mock_account = MagicMock()
    mock_account.get_billing_rates.return_value = _TEST_BILLING_RATES
    monkeypatch.setitem(sys.modules, 'ai.account', MagicMock(account=mock_account))


def _make_metrics(fake_psutil, pid=1234, sample_interval=1.0, callback=None):
    """
    Build a TaskMetrics with mocked psutil and a fresh TASK_STATUS namespace.

    Args:
        fake_psutil: the fake_psutil fixture's MagicMock (so the constructor
            does not touch the real psutil module).
        pid: the integer pid argument passed through to TaskMetrics.
        sample_interval: pass-through to TaskMetrics.
        callback: optional update callback.

    Returns:
        tuple[TaskMetrics, SimpleNamespace]: the constructed instance and the
        backing status namespace (so tests can read updated fields).
    """
    status = make_status()
    tm = task_metrics.TaskMetrics(
        pid=pid,
        task_status=status,
        sample_interval=sample_interval,
        on_update_callback=callback,
    )
    return tm, status


# ---------------------------------------------------------------------------
# __init__ — happy path and GPU detection branches
# ---------------------------------------------------------------------------


def test_init_defaults_use_sample_interval_constant(fake_psutil, no_gpu):
    """When ``sample_interval=None``, the constant default is used."""
    status = make_status()
    tm = task_metrics.TaskMetrics(pid=1, task_status=status, sample_interval=None)
    assert tm.sample_interval == task_metrics.CONST_METRICS_SAMPLE_INTERVAL


def test_init_no_pynvml_disables_gpu_billing(fake_psutil, no_gpu):
    """ImportError on pynvml is caught and GPU tracking is disabled cleanly."""
    tm, _ = _make_metrics(fake_psutil)
    assert tm._gpu_available is False
    assert tm._pynvml_available is False
    assert tm._gpu_count == 0


def test_init_gpu_available_records_count_and_baseline(monkeypatch, fake_psutil):
    """When pynvml reports GPUs, the count and per-GPU baseline are captured."""
    pynvml = MagicMock()
    pynvml.nvmlDeviceGetCount.return_value = 2
    pynvml.nvmlSystemGetDriverVersion.return_value = '535.171.04'

    handle_0, handle_1 = MagicMock(name='h0'), MagicMock(name='h1')
    pynvml.nvmlDeviceGetHandleByIndex.side_effect = [handle_0, handle_1]

    # Two GPUs with different baseline usage.
    pynvml.nvmlDeviceGetMemoryInfo.side_effect = [
        SimpleNamespace(used=1024 * 1024 * 200),  # 200 MB
        SimpleNamespace(used=1024 * 1024 * 400),  # 400 MB
    ]
    monkeypatch.setitem(sys.modules, 'pynvml', pynvml)

    tm, _ = _make_metrics(fake_psutil)
    assert tm._gpu_count == 2
    assert tm._gpu_available is True
    assert tm._pynvml_available is True
    assert tm._gpu_baseline_memory_mb == [200.0, 400.0]


def test_init_gpu_nvml_init_failure_disables_gpu(monkeypatch, fake_psutil):
    """If pynvml.nvmlInit() raises, GPU tracking is disabled (no crash)."""
    pynvml = MagicMock()
    pynvml.nvmlInit.side_effect = RuntimeError('NVML init failed')
    monkeypatch.setitem(sys.modules, 'pynvml', pynvml)

    tm, _ = _make_metrics(fake_psutil)
    assert tm._gpu_available is False
    assert tm._gpu_count == 0


# ---------------------------------------------------------------------------
# _sample_cpu_memory
# ---------------------------------------------------------------------------


def test_sample_cpu_memory_aggregates_parent_and_children(fake_psutil, no_gpu):
    """CPU% and memory are summed across the main process and all children."""
    proc = MagicMock(name='proc')
    proc.cpu_percent.return_value = 80.0
    proc.memory_info.return_value = SimpleNamespace(rss=100 * 1024 * 1024)  # 100 MB

    child_a = MagicMock(name='child_a')
    child_a.cpu_percent.return_value = 40.0
    child_a.memory_info.return_value = SimpleNamespace(rss=50 * 1024 * 1024)

    child_b = MagicMock(name='child_b')
    child_b.cpu_percent.return_value = 20.0
    child_b.memory_info.return_value = SimpleNamespace(rss=10 * 1024 * 1024)

    proc.children.return_value = [child_a, child_b]
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil)
    tm._sample_cpu_memory()

    # Raw (unnormalised) total CPU = 80 + 40 + 20 = 140 — used for billing.
    assert tm._cpu_percent_raw == pytest.approx(140.0)
    # Normalised against 4 logical cpus from cpu_count.
    assert status.metrics.cpu_percent == pytest.approx(35.0)
    # Memory = 100 + 50 + 10 = 160 MB
    assert status.metrics.cpu_memory_mb == pytest.approx(160.0)


def test_sample_cpu_memory_skips_dead_children(fake_psutil, no_gpu):
    """A NoSuchProcess from a child is swallowed and the rest are still summed."""
    proc = MagicMock()
    proc.cpu_percent.return_value = 10.0
    proc.memory_info.return_value = SimpleNamespace(rss=20 * 1024 * 1024)

    alive = MagicMock()
    alive.cpu_percent.return_value = 5.0
    alive.memory_info.return_value = SimpleNamespace(rss=5 * 1024 * 1024)

    dead = MagicMock()
    dead.cpu_percent.side_effect = _NoSuchProcess('gone')

    proc.children.return_value = [alive, dead]
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil)
    tm._sample_cpu_memory()

    # Dead child contributed nothing; only parent + alive child.
    assert tm._cpu_percent_raw == pytest.approx(15.0)
    assert status.metrics.cpu_memory_mb == pytest.approx(25.0)


def test_sample_cpu_memory_silently_handles_dead_parent(fake_psutil, no_gpu):
    """A NoSuchProcess on the parent leaves status fields untouched."""
    proc = MagicMock()
    proc.cpu_percent.side_effect = _NoSuchProcess('gone')
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil)
    # Pre-condition: both fields are zero from construction.
    assert status.metrics.cpu_percent == 0.0
    tm._sample_cpu_memory()  # must not raise
    assert status.metrics.cpu_percent == 0.0
    assert status.metrics.cpu_memory_mb == 0.0


# ---------------------------------------------------------------------------
# _sample_gpu
# ---------------------------------------------------------------------------


def test_sample_gpu_no_pynvml_sets_zero(fake_psutil, no_gpu):
    """Without pynvml, gpu_memory_mb is forced to 0.0 (billing disabled)."""
    tm, status = _make_metrics(fake_psutil)
    status.metrics.gpu_memory_mb = 999.0  # poison: must be cleared
    tm._sample_gpu()
    assert status.metrics.gpu_memory_mb == 0.0


def test_sample_gpu_uses_per_process_memory_when_available(monkeypatch, fake_psutil):
    """Driver reports per-process usedGpuMemory; sum across our pid set."""
    pynvml = MagicMock()
    pynvml.nvmlDeviceGetCount.return_value = 1
    handle = MagicMock()
    pynvml.nvmlDeviceGetHandleByIndex.return_value = handle
    pynvml.nvmlDeviceGetMemoryInfo.return_value = SimpleNamespace(used=0)
    pynvml.nvmlSystemGetDriverVersion.return_value = '535.0'

    # Our pid is 1234. Some processes belong to us, others don't.
    our_proc = SimpleNamespace(pid=1234, usedGpuMemory=300 * 1024 * 1024)  # 300 MB
    other = SimpleNamespace(pid=9999, usedGpuMemory=500 * 1024 * 1024)
    pynvml.nvmlDeviceGetComputeRunningProcesses.return_value = [our_proc, other]

    monkeypatch.setitem(sys.modules, 'pynvml', pynvml)

    proc = MagicMock()
    proc.children.return_value = []
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil, pid=1234)
    tm._sample_gpu()
    assert status.metrics.gpu_memory_mb == pytest.approx(300.0)


def test_sample_gpu_falls_back_when_driver_reports_none(monkeypatch, fake_psutil):
    """
    WDDM driver reports usedGpuMemory=None for every process. Fallback:
    total GPU memory minus the baseline captured at init.
    """
    pynvml = MagicMock()
    pynvml.nvmlDeviceGetCount.return_value = 1
    handle = MagicMock()
    pynvml.nvmlDeviceGetHandleByIndex.return_value = handle
    # Baseline captured at __init__ time:
    baseline = SimpleNamespace(used=200 * 1024 * 1024)  # 200 MB
    # Current usage at sample time:
    sample_now = SimpleNamespace(used=800 * 1024 * 1024)  # 800 MB total
    pynvml.nvmlDeviceGetMemoryInfo.side_effect = [baseline, sample_now]
    pynvml.nvmlSystemGetDriverVersion.return_value = '535.0'

    our_proc = SimpleNamespace(pid=1234, usedGpuMemory=None)
    pynvml.nvmlDeviceGetComputeRunningProcesses.return_value = [our_proc]

    monkeypatch.setitem(sys.modules, 'pynvml', pynvml)

    proc = MagicMock()
    proc.children.return_value = []
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil, pid=1234)
    tm._sample_gpu()
    # 800 (current) - 200 (baseline) = 600 MB
    assert status.metrics.gpu_memory_mb == pytest.approx(600.0)


def test_sample_gpu_swallows_sampling_errors(monkeypatch, fake_psutil):
    """If pynvml raises mid-sample, the error is logged once and value reset to 0."""
    pynvml = MagicMock()
    pynvml.nvmlDeviceGetCount.return_value = 1
    pynvml.nvmlDeviceGetHandleByIndex.side_effect = RuntimeError('nvml dead')
    pynvml.nvmlDeviceGetMemoryInfo.return_value = SimpleNamespace(used=0)
    pynvml.nvmlSystemGetDriverVersion.return_value = '535.0'

    monkeypatch.setitem(sys.modules, 'pynvml', pynvml)

    proc = MagicMock()
    proc.children.return_value = []
    fake_psutil.Process.return_value = proc

    tm, status = _make_metrics(fake_psutil, pid=1234)
    status.metrics.gpu_memory_mb = 123.0  # poison
    tm._sample_gpu()
    # The per-GPU loop swallows the exception (continue), so total stays 0.0.
    assert status.metrics.gpu_memory_mb == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# _accumulate_sample — arithmetic over time
# ---------------------------------------------------------------------------


def test_accumulate_sample_updates_internal_counters(fake_psutil, no_gpu):
    """Internal cpu_seconds, memory_mb_seconds, duration_seconds increase as expected."""
    tm, status = _make_metrics(fake_psutil)
    tm.set_service_up(True)  # ungate billing accumulators
    tm._cpu_percent_raw = 200.0  # raw across cores
    status.metrics.cpu_memory_mb = 150.0
    status.metrics.gpu_memory_mb = 0.0  # gpu not available anyway

    tm._accumulate_sample(interval=2.0)

    assert tm._sample_count == 1
    assert tm._duration_seconds == pytest.approx(2.0)
    # cpu_seconds = 200% * 2s / 100 = 4.0 vCPU-seconds
    assert tm._cpu_seconds == pytest.approx(4.0)
    # memory_mb_seconds = 150 * 2 = 300
    assert tm._memory_mb_seconds == pytest.approx(300.0)


def test_accumulate_sample_tracks_peaks(fake_psutil, no_gpu):
    """Peak fields move only upward across samples."""
    tm, status = _make_metrics(fake_psutil)

    # First sample
    tm._cpu_percent_raw = 100.0
    status.metrics.cpu_percent = 25.0
    status.metrics.cpu_memory_mb = 100.0
    status.metrics.gpu_memory_mb = 0.0
    tm._accumulate_sample(1.0)
    assert status.metrics.peak_cpu_percent == 25.0
    assert status.metrics.peak_cpu_memory_mb == 100.0

    # Lower second sample — peaks must not regress.
    tm._cpu_percent_raw = 50.0
    status.metrics.cpu_percent = 12.0
    status.metrics.cpu_memory_mb = 50.0
    tm._accumulate_sample(1.0)
    assert status.metrics.peak_cpu_percent == 25.0
    assert status.metrics.peak_cpu_memory_mb == 100.0

    # Higher third sample — peaks rise.
    tm._cpu_percent_raw = 400.0
    status.metrics.cpu_percent = 100.0
    status.metrics.cpu_memory_mb = 250.0
    tm._accumulate_sample(1.0)
    assert status.metrics.peak_cpu_percent == 100.0
    assert status.metrics.peak_cpu_memory_mb == 250.0


def test_accumulate_sample_computes_averages(fake_psutil, no_gpu):
    """avg_* fields equal accumulated total / duration."""
    tm, status = _make_metrics(fake_psutil)
    tm.set_service_up(True)  # ungate billing accumulators
    tm._cpu_percent_raw = 200.0
    status.metrics.cpu_memory_mb = 100.0
    tm._accumulate_sample(2.0)
    # avg_cpu_percent = cpu_seconds / duration * 100 = (4 / 2) * 100 = 200
    assert status.metrics.avg_cpu_percent == pytest.approx(200.0)
    # avg memory = 200 / 2 = 100
    assert status.metrics.avg_cpu_memory_mb == pytest.approx(100.0)


# ---------------------------------------------------------------------------
# _update_tokens — rate math
# ---------------------------------------------------------------------------


def test_update_tokens_converts_resource_accumulators_via_db_rates(fake_psutil, no_gpu):
    """Tokens = raw_value * DB rate; total = sum of components."""
    tm, status = _make_metrics(fake_psutil)
    tm.set_service_up(True)  # ungate billing accumulators
    # Inject accumulators directly to bypass arithmetic noise.
    # 100 CPU-seconds = 100_000 ms * 0.001 tokens/ms = 100 tokens
    tm._cpu_seconds = 100.0
    # 10240 MB-sec = 10 GB-sec * 0.05 tokens/GB-sec = 0.5 tokens
    tm._memory_mb_seconds = 10240.0
    # GPU memory comes from subprocess timer, not OS sampling
    # Simulate 5 GB-sec of inference VRAM (stored as GB-sec, not ms)
    tm._subprocess_timers['gpu_memory'] = 5.0

    tm._update_tokens()

    expected_cpu = round(100.0 * 1000.0 * _TEST_BILLING_RATES['cpu_compute'], 1)
    expected_mem = round(10.0 * _TEST_BILLING_RATES['cpu_memory'], 1)
    expected_gpu_mem = round(5.0 * _TEST_BILLING_RATES['gpu_memory'], 1)
    assert status.tokens.cpu_utilization == expected_cpu
    assert status.tokens.cpu_memory == expected_mem
    assert status.tokens.gpu_memory == expected_gpu_mem
    expected_total = round(expected_cpu + expected_mem + expected_gpu_mem, 1)
    assert status.tokens.total == expected_total


# ---------------------------------------------------------------------------
# _report_to_billing_system — delta computation + state advancement
# ---------------------------------------------------------------------------


def test_report_to_billing_system_advances_last_report_state(fake_psutil, no_gpu):
    """After a report, the _last_report_* tracking matches the current accumulators."""
    tm, status = _make_metrics(fake_psutil)
    tm._cpu_seconds = 100.0
    tm._memory_mb_seconds = 200.0
    tm._gpu_memory_mb_seconds = 50.0
    status.tokens.cpu_utilization = 10.0
    status.tokens.cpu_memory = 20.0
    status.tokens.gpu_memory = 5.0
    status.tokens.total = 35.0

    asyncio.run(tm._report_to_billing_system())

    # State advanced — the next report's delta starts from these.
    assert tm._last_report_cpu_seconds == 100.0
    assert tm._last_report_memory_mb_seconds == 200.0
    assert tm._last_report_gpu_memory_mb_seconds == 50.0
    assert tm._last_report_tokens_cpu == 10.0
    assert tm._last_report_tokens_memory == 20.0
    assert tm._last_report_tokens_gpu == 5.0


def test_report_to_billing_system_handles_consecutive_reports(fake_psutil, no_gpu):
    """Second report sees only the delta accrued since the first."""
    tm, _ = _make_metrics(fake_psutil)

    async def run():
        """Run two consecutive billing reports."""
        # First period
        tm._cpu_seconds = 100.0
        await tm._report_to_billing_system()
        assert tm._last_report_cpu_seconds == 100.0

        # Second period — accumulators grew by 50
        tm._cpu_seconds = 150.0
        await tm._report_to_billing_system()
        assert tm._last_report_cpu_seconds == 150.0

    asyncio.run(run())


# ---------------------------------------------------------------------------
# start_monitoring / stop_monitoring lifecycle
# ---------------------------------------------------------------------------


def test_start_monitoring_resets_state(fake_psutil, no_gpu):
    """start_monitoring zeroes the per-session tracking before the loop runs."""
    tm, status = _make_metrics(fake_psutil)
    # Poison: simulate state left over from a prior session.
    tm._last_report_cpu_seconds = 99.0
    status.tokens.cpu_utilization = 99.0
    status.tokens.total = 99.0

    # asyncio.create_task needs a running loop, so run inside an event loop.
    async def run():
        """Run start + immediate stop on a live event loop."""
        tm.start_monitoring()
        # The monitoring task is scheduled but not yet executed.
        await tm.stop_monitoring()

    asyncio.run(run())

    assert tm._last_report_cpu_seconds == 0.0
    assert status.tokens.cpu_utilization == 0.0
    assert status.tokens.total == 0.0


def test_start_monitoring_is_idempotent(fake_psutil, no_gpu):
    """Calling start_monitoring twice does not spawn a second task."""
    tm, _ = _make_metrics(fake_psutil)

    async def run():
        """Start twice, capture the task ref, then stop cleanly."""
        tm.start_monitoring()
        first = tm._monitoring_task
        tm.start_monitoring()
        second = tm._monitoring_task
        await tm.stop_monitoring()
        return first, second

    first, second = asyncio.run(run())
    assert first is second


def test_stop_monitoring_on_idle_is_a_noop(fake_psutil, no_gpu):
    """Stopping when no task was ever started does not raise."""
    tm, _ = _make_metrics(fake_psutil)

    async def run():
        """Stop without ever starting — must not raise."""
        await tm.stop_monitoring()

    asyncio.run(run())  # absence of exception is the assertion
