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
from unittest.mock import AsyncMock, MagicMock

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
    'hold_time': 0.001,  # tokens per ms (the pipe hold, plan 8.1)
    'bytes_in': 0.0,
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


def test_accumulate_sample_keeps_totals_and_computes_no_averages(fake_psutil, no_gpu):
    """The status is summable: totals accumulate, avg_* stay at 0 (plan 7.5, ALB seam 3)."""
    tm, status = _make_metrics(fake_psutil)
    tm.set_service_up(True)  # ungate billing accumulators
    tm._cpu_percent_raw = 200.0
    status.metrics.cpu_memory_mb = 100.0
    tm._accumulate_sample(2.0)
    assert tm._cpu_seconds == pytest.approx(4.0)
    assert tm._memory_mb_seconds == pytest.approx(200.0)
    assert status.metrics.avg_cpu_percent == 0
    assert status.metrics.avg_cpu_memory_mb == 0


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


# ---------------------------------------------------------------------------
# Request trees -> usage increments (plan 8.2, 8.3)
# ---------------------------------------------------------------------------


def _attribution(org='org-1', user='user-a', team='team-home'):
    from ai.modules.task.task_control import BillingAttribution

    return BillingAttribution(org_id=org, team_id=team, user_id=user)


def _key(
    org='org-1', user='user-a', team='team-home', rung='team', publication='team-1', version=5, resource='hold_time'
):
    """The ledger key of the default test usage, with any fact replaced."""
    return task_metrics.usage_key(org, user, team, 'acme.docBrain', rung, publication, version, resource)


def _usage(trace_id, control_key='team.team-1.acme.docBrain.chat', billing=None, team='team-1', version=5):
    return task_metrics.TraceUsage(
        control_key=control_key,
        billing=billing or _attribution(),
        address='acme.docBrain.chat',
        rung='team',
        team=team,
        version=version,
    )


def test_a_closed_tree_becomes_one_request_of_its_paying_unit(fake_psutil, no_gpu, mock_billing_rates):
    """The engine's final bucket for a tree is converted at the rates and queued under the caller's row."""
    sink = task_metrics.UsageSink(post=None)
    tm, _ = _make_metrics(fake_psutil)
    tm._attribute = lambda trace_id: _usage(trace_id)
    tm.usage_sink = sink
    tm.merge_subprocess_metrics(
        {
            'timers': {'hold_time': 500.0},
            'counters': {'bytes_in': 10},
            'traces': {'7': {'timers': {'hold_time': 500.0}, 'counters': {'bytes_in': 10}, 'closed': True}},
        }
    )
    key = _key()
    assert list(sink.pending) == [key]
    pending = sink.pending[key]
    assert pending['amount'] == 0.5 and pending['request_count'] == 1  # 500 ms x 0.001; bytes_in bills nothing
    assert pending['row']['org_id'] == 'org-1' and pending['row']['team_id'] == 'team-home'
    context = pending['row']['context']
    assert (context['rung'], context['team'], context['version']) == ('team', 'team-1', 5) and 7 not in tm.traces


def test_two_publications_used_by_one_caller_are_two_rows(fake_psutil, no_gpu, mock_billing_rates):
    """The publication that answered is in the key: Staging and Production never share a row (plan 8.2)."""
    sink = task_metrics.UsageSink(post=None)
    sink.post(_usage(1, team='staging', version=5), {'hold_time': 0.5})
    sink.post(_usage(2, team='production', version=4), {'hold_time': 0.25})
    sink.post(_usage(3, team='production', version=4), {'hold_time': 0.25})
    assert set(sink.pending) == {_key(publication='production', version=4), _key(publication='staging')}
    production = sink.pending[_key(publication='production', version=4)]
    assert production['request_count'] == 2 and production['row']['context']['team'] == 'production'


def test_a_dev_run_serves_through_no_publication(fake_psutil, no_gpu, mock_billing_rates):
    """A dev run names no publication: its key hashes none and its context carries None for slot and version."""
    sink = task_metrics.UsageSink(post=None)
    usage = task_metrics.TraceUsage(
        control_key='dev.user-a.acme.docBrain.chat', billing=_attribution(), address='acme.docBrain.chat', rung='dev'
    )
    sink.post(usage, {'hold_time': 0.5})
    key = _key(rung='dev', publication=None, version=None)
    assert list(sink.pending) == [key]
    assert (sink.pending[key]['row']['context']['team'], sink.pending[key]['row']['context']['version']) == (None, None)


def test_the_usage_key_is_fixed_length_and_changes_with_every_fact():
    """Every fact that makes two usages different rows changes the key; an absent fact is not the text 'None'."""
    base = dict(org='org-1', user='user-a', team='team-home', rung='team', publication='team-1', version=5)
    keys = {_key(**base)}
    for fact, other in (
        ('org', 'org-2'),
        ('user', None),
        ('team', None),
        ('rung', 'public'),
        ('publication', None),
        ('version', 6),
        ('resource', 'tokens'),
    ):
        keys.add(_key(**{**base, fact: other}))
    assert len(keys) == 8 and all(len(key) == 70 and key.startswith('usage:') for key in keys)
    assert _key(user=None) != _key(user='None')
    # Adjacent facts never run together
    assert task_metrics.usage_key('a', 'bc', None, 'p.q', 'team', None, None, 'r') != task_metrics.usage_key(
        'ab', 'c', None, 'p.q', 'team', None, None, 'r'
    )


def test_usage_on_two_days_adds_into_one_row(monkeypatch):
    """There is no day in the key: a control's usage tomorrow adds to the row it charged today."""
    sink = task_metrics.UsageSink(post=None)
    monkeypatch.setattr(task_metrics.time, 'time', lambda: 20772 * 86400 + 10)
    sink.post(_usage(1), {'hold_time': 0.5})
    monkeypatch.setattr(task_metrics.time, 'time', lambda: 20773 * 86400 + 10)
    sink.post(_usage(2), {'hold_time': 0.25})
    assert list(sink.pending) == [_key()] and sink.pending[_key()]['request_count'] == 2
    assert 'day' not in sink.pending[_key()]['row']['context']


def test_an_open_tree_is_tracked_and_an_unclaimed_tree_stays_engine_level(fake_psutil, no_gpu, mock_billing_rates):
    tm, _ = _make_metrics(fake_psutil)
    tm._attribute = lambda trace_id: _usage(trace_id) if trace_id == 1 else None
    tm.usage_sink = task_metrics.UsageSink(post=None)
    tm.merge_subprocess_metrics(
        {
            'timers': {},
            'counters': {},
            'traces': {
                '1': {'timers': {'gpu_compute': 100.0}, 'counters': {}, 'closed': False},
                '2': {'timers': {'gpu_compute': 100.0}, 'counters': {}, 'closed': True},
            },
        }
    )
    assert tm.traces[1].timers == {'gpu_compute': 100.0} and 2 not in tm.traces
    assert tm.usage_sink.pending == {}


def test_tokens_for_bills_gpu_under_tokens_and_metered_keys_under_their_own_name(
    fake_psutil, no_gpu, mock_billing_rates
):
    tm, _ = _make_metrics(fake_psutil)
    usage = _usage(1)
    usage.timers = {'gpu_compute': 200.0, 'gpu_memory': 1.0, 'hold_time': 1000.0, 'gpu_queue_wait': 999.0}
    usage.counters = {'bytes_in': 4096}
    assert tm.tokens_for(usage) == {'tokens': 3.0, 'hold_time': 1.0}


@pytest.mark.asyncio
async def test_the_sink_coalesces_increments_and_retries_a_failed_write_under_its_own_id():
    """Increments of one row add up in an OPEN entry; a flush detaches it and sends it under its increment id; a
    failed write is retried on the next flush with the SAME id (the ledger refuses a repeat), while increments
    posted meanwhile form a new entry with a new id.
    """
    writes = []
    fail = {'on': True}

    async def post(**row):
        if fail['on']:
            raise RuntimeError('ledger down')
        writes.append(row)
        return True

    sink = task_metrics.UsageSink(post=post)
    sink.post(_usage(1), {'hold_time': 0.5})
    sink.post(_usage(2), {'hold_time': 0.25, 'tokens': 2.0})
    key = _key()
    assert sink.pending[key]['amount'] == 0.75 and sink.pending[key]['request_count'] == 2
    assert sink.pending[_key(resource='tokens')]['request_count'] == 1
    first_id = sink.pending[key]['increment_id']

    await sink.flush()
    assert writes == [] and sink.pending == {} and len(sink.unconfirmed) == 2, 'detached, unconfirmed, nothing lost'
    # Posted while the first write is out: a NEW entry under a new id
    sink.post(_usage(3), {'hold_time': 0.75})
    assert sink.pending[key]['increment_id'] != first_id
    fail['on'] = False
    await sink.flush()
    holds = [w for w in writes if w['resource'] == 'hold_time']
    assert [w['increment_id'] for w in holds] == [first_id, sink_second_id(holds)]
    assert [(w['amount'], w['request_count']) for w in holds] == [(0.75, 2), (0.75, 1)]
    assert holds[0]['user_id'] == 'user-a' and holds[0]['team_id'] == 'team-home'
    assert sink.pending == {} and sink.unconfirmed == {}


def sink_second_id(holds):
    """The second hold write's increment id (distinct from the first by construction)."""
    assert holds[1]['increment_id'] != holds[0]['increment_id']
    return holds[1]['increment_id']


def test_a_tree_without_a_paying_org_is_not_posted():
    """The org pays (plan 8.3): no attribution, or one naming no org, has nobody to charge."""
    sink = task_metrics.UsageSink(post=None)
    usage = _usage(1)
    usage.billing = None
    sink.post(usage, {'hold_time': 1.0})
    sink.post(_usage(2, billing=_attribution(org='')), {'hold_time': 1.0})
    assert sink.pending == {}


def test_a_run_with_no_caller_is_posted_with_its_team_and_no_user():
    """A scheduled or run-now team run has no caller: its row carries the team and no user."""
    sink = task_metrics.UsageSink(post=None)
    sink.post(_usage(1, billing=_attribution(user='', team='team-1')), {'hold_time': 0.5})
    key = _key(user=None, team='team-1')
    assert list(sink.pending) == [key]
    row = sink.pending[key]['row']
    assert (row['org_id'], row['user_id'], row['team_id']) == ('org-1', None, 'team-1')


def test_a_run_with_no_caller_and_no_team_is_posted_for_its_org_alone():
    """An org-owned run (plan 8.3) names neither a user nor a team."""
    sink = task_metrics.UsageSink(post=None)
    sink.post(_usage(1, billing=_attribution(user='', team=''), team=''), {'hold_time': 0.5})
    [pending] = sink.pending.values()
    assert (pending['row']['org_id'], pending['row']['user_id'], pending['row']['team_id']) == ('org-1', None, None)


def test_two_paying_units_never_share_a_key():
    """One user calling from two orgs: the org is in the key, so each org's usage is its own row."""
    writes = []

    async def post(**row):
        writes.append(row)
        return True

    sink = task_metrics.UsageSink(post=post)
    sink.post(_usage(1, billing=_attribution(org='org-1')), {'hold_time': 0.5})
    sink.post(_usage(2, billing=_attribution(org='org-1')), {'hold_time': 0.25})
    sink.post(_usage(3, billing=_attribution(org='org-2', team='team-b')), {'hold_time': 1.0})
    asyncio.run(sink.flush())

    assert sorted((w['org_id'], w['team_id'], w['amount'], w['request_count']) for w in writes) == [
        ('org-1', 'team-home', 0.75, 2),
        ('org-2', 'team-b', 1.0, 1),
    ]
    assert len({w['increment_id'] for w in writes}) == 2 and len({w['idempotency_key'] for w in writes}) == 2


def test_a_failed_usage_write_is_logged_as_an_error(monkeypatch):
    """A lost billing write is an error, not debug output; the increment stays for the next flush."""
    errors = []
    monkeypatch.setattr(task_metrics, 'error', errors.append)

    async def post(**row):
        raise RuntimeError('ledger down')

    sink = task_metrics.UsageSink(post=post)
    sink.post(_usage(1), {'hold_time': 0.5})
    asyncio.run(sink.flush())

    assert len(errors) == 1 and 'ledger down' in errors[0] and _key() in errors[0]
    assert len(sink.unconfirmed) == 1


def test_the_engine_debit_of_a_run_with_no_user_names_its_team(fake_psutil, no_gpu, monkeypatch):
    """A team-owned run's engine line is written with the team and no user (plan 8.3)."""
    import sys

    tm, status = _make_metrics(fake_psutil)
    tm.org_id, tm.user_id, tm.team_id, tm.billing_run_id = 'org-1', '', 'team-1', 'run-1'
    status.tokens.cpu_utilization = 2.0
    rows = []

    async def apply_debit(**row):
        rows.append(row)
        return True

    monkeypatch.setattr(sys.modules['ai.account'].account, 'apply_debit', apply_debit)
    asyncio.run(tm._report_to_billing_system())

    assert [(row['org_id'], row['user_id'], row['team_id']) for row in rows] == [('org-1', None, 'team-1')]


def test_a_shared_engine_writes_no_remainder_debit(fake_psutil, no_gpu, monkeypatch):
    """A shared engine has no owner: its callers' cost rides their usage rows; the remainder is plan 15 item 21."""
    import sys

    tm, status = _make_metrics(fake_psutil)
    tm.org_id, tm.user_id, tm.team_id, tm.billing_run_id = 'org-1', 'user-1', 'team-1', 'run-1'
    tm.debit_remainder = False
    status.tokens.cpu_utilization = 2.0
    apply_debit = AsyncMock(return_value=True)

    monkeypatch.setattr(sys.modules['ai.account'].account, 'apply_debit', apply_debit)
    asyncio.run(tm._report_to_billing_system())

    apply_debit.assert_not_awaited()


def test_a_failed_engine_debit_is_logged_as_an_error(fake_psutil, no_gpu, monkeypatch):
    import sys

    tm, status = _make_metrics(fake_psutil)
    tm.org_id, tm.user_id, tm.team_id, tm.billing_run_id = 'org-1', 'user-1', 'team-1', 'run-1'
    status.tokens.cpu_utilization = 2.0
    errors = []
    monkeypatch.setattr(task_metrics, 'error', errors.append)

    async def apply_debit(**row):
        raise RuntimeError('ledger down')

    monkeypatch.setattr(sys.modules['ai.account'].account, 'apply_debit', apply_debit)
    asyncio.run(tm._report_to_billing_system())

    assert len(errors) == 1 and 'ledger down' in errors[0]


def test_a_zero_replacement_stays_eligible_until_its_write_succeeds(fake_psutil, no_gpu, monkeypatch):
    """A line an earlier report charged is written as ZERO once attribution empties it; a failed zero write is
    retried by the next report, so the owner's old debit never outlives the callers' charge.
    """
    import sys

    tm, status = _make_metrics(fake_psutil)
    tm.org_id, tm.user_id, tm.team_id, tm.billing_run_id = 'org-1', 'user-1', 'team-1', 'run-1'
    status.tokens.custom = {'hold_time': 5.0}
    debits = []
    fail = {'on': False}

    async def apply_debit(**row):
        if fail['on']:
            raise RuntimeError('ledger down')
        debits.append((row['description'], row['amount']))
        return True

    # The autouse fixture installs a mock ai.account module: the report imports through sys.modules
    monkeypatch.setattr(sys.modules['ai.account'].account, 'apply_debit', apply_debit)

    asyncio.run(tm._report_to_billing_system())
    assert ('hold_time', 5.0) in debits and 'hold_time' in tm._debited

    # Every ms of that hold was a caller's: the owner's line is now zero
    tm._attributed['hold_time'] = 5.0
    fail['on'] = True
    asyncio.run(tm._report_to_billing_system())
    assert 'hold_time' in tm._debited, 'the failed zero write keeps the line eligible'

    fail['on'] = False
    asyncio.run(tm._report_to_billing_system())
    assert debits[-1] == ('hold_time', 0.0) and 'hold_time' not in tm._debited
    # Nothing left to replace: the next report writes no zero
    asyncio.run(tm._report_to_billing_system())
    assert debits[-1] == ('hold_time', 0.0) and len([d for d in debits if d == ('hold_time', 0.0)]) == 1


# ---------------------------------------------------------------------------
# A runtime's sampler (a container has no local PID)
# ---------------------------------------------------------------------------


class _Sampler:
    """A MetricsSampler stand-in returning canned readings."""

    def __init__(self, readings, min_interval=0.0):
        """Hand out ``readings`` in turn, then None."""
        self.min_interval = min_interval
        self._readings = list(readings)
        self.calls = 0

    async def sample(self):
        """The next canned reading, or None once they run out."""
        self.calls += 1
        return self._readings.pop(0) if self._readings else None


def _make_sampled(fake_psutil, sampler, sample_interval=1.0):
    """Build a TaskMetrics fed by a sampler instead of a pid."""
    status = make_status()
    tm = task_metrics.TaskMetrics(task_status=status, sample_interval=sample_interval, sampler=sampler)
    return tm, status


@pytest.mark.parametrize('kwargs', [{}, {'pid': 1, 'sampler': _Sampler([])}])
def test_init_needs_exactly_one_of_pid_and_sampler(fake_psutil, no_gpu, kwargs):
    """Neither or both is a programming error, not a silent zero."""
    with pytest.raises(ValueError, match='exactly one'):
        task_metrics.TaskMetrics(task_status=make_status(), **kwargs)


def test_sampler_never_touches_psutil_process(fake_psutil, no_gpu):
    """With a sampler there is no local process to open."""
    tm, _ = _make_sampled(fake_psutil, _Sampler([]))
    fake_psutil.Process.assert_not_called()
    assert tm._process is None and tm.pid is None


def test_sampler_sets_its_own_minimum_interval(fake_psutil, no_gpu):
    """A docker stats call takes about a second, so the interval is not shorter."""
    tm, _ = _make_sampled(fake_psutil, _Sampler([], min_interval=1.0), sample_interval=0.25)
    assert tm.sample_interval == 1.0


def test_sampler_reading_is_recorded_like_psutil(fake_psutil, no_gpu):
    """CPU is normalized by core count (4 in the fixture), memory becomes MB, raw CPU is kept for billing."""
    tm, status = _make_sampled(fake_psutil, _Sampler([]))
    tm._apply_sampler_reading((150.0, 512 * 1024 * 1024))
    assert status.metrics.cpu_percent == pytest.approx(37.5)
    assert status.metrics.cpu_memory_mb == pytest.approx(512.0)
    assert tm._cpu_percent_raw == pytest.approx(150.0)


def test_sampler_reading_none_keeps_the_last_values(fake_psutil, no_gpu):
    """A failed reading does not zero the gauges."""
    tm, status = _make_sampled(fake_psutil, _Sampler([]))
    tm._apply_sampler_reading((40.0, 1024 * 1024))
    tm._apply_sampler_reading(None)
    assert status.metrics.cpu_percent == pytest.approx(10.0)
    assert status.metrics.cpu_memory_mb == pytest.approx(1.0)


def test_sampler_gpu_half_reads_zero(monkeypatch, fake_psutil):
    """No local PID: nothing to match against NVML's processes, even with a GPU present."""
    fake_nvml = MagicMock()
    fake_nvml.nvmlDeviceGetCount.return_value = 1
    monkeypatch.setitem(sys.modules, 'pynvml', fake_nvml)
    tm, status = _make_sampled(fake_psutil, _Sampler([]))
    status.metrics.gpu_memory_mb = 99.0
    tm._sample_gpu()
    assert status.metrics.gpu_memory_mb == 0.0
    fake_nvml.nvmlDeviceGetComputeRunningProcesses.assert_not_called()


async def test_monitoring_loop_reads_the_sampler(fake_psutil, no_gpu):
    """The background loop takes its CPU and memory from the sampler."""
    sampler = _Sampler([(80.0, 256 * 1024 * 1024)] * 50)
    tm, status = _make_sampled(fake_psutil, sampler, sample_interval=0.01)
    tm._report_to_billing_system = MagicMock(side_effect=lambda: asyncio.sleep(0))
    tm._audit_task_usage = MagicMock(side_effect=lambda: asyncio.sleep(0))

    tm.start_monitoring()
    for _ in range(100):
        if sampler.calls:
            break
        await asyncio.sleep(0.01)
    await tm.stop_monitoring()

    assert sampler.calls >= 1
    assert status.metrics.cpu_percent == pytest.approx(20.0)
    assert status.metrics.cpu_memory_mb == pytest.approx(256.0)


async def test_monitoring_loop_bills_nothing_without_a_reading(fake_psutil, no_gpu):
    """A sampler with no reading keeps the last values on show; they are not billed again."""
    sampler = _Sampler([(80.0, 256 * 1024 * 1024)])
    tm, status = _make_sampled(fake_psutil, sampler, sample_interval=0.01)
    tm._report_to_billing_system = MagicMock(side_effect=lambda: asyncio.sleep(0))
    tm._audit_task_usage = MagicMock(side_effect=lambda: asyncio.sleep(0))
    tm.set_service_up(True)  # ungate billing accumulators

    tm.start_monitoring()
    for _ in range(200):
        if sampler.calls >= 4:
            break
        await asyncio.sleep(0.01)
    await tm.stop_monitoring()

    assert sampler.calls >= 4
    assert tm._sample_count == 1
    assert status.metrics.cpu_memory_mb == pytest.approx(256.0)


async def test_monitoring_loop_counts_the_time_a_reading_takes(fake_psutil, no_gpu, monkeypatch):
    """The interval ends when the reading arrives: a stop asked for during a slow read still bills it."""
    clock = [1000.0]
    monkeypatch.setattr(task_metrics, 'time', SimpleNamespace(time=lambda: clock[0]))

    class SlowSampler(_Sampler):
        """A docker stats call that takes 5 s, during which the task is stopped."""

        async def sample(self):
            """Advance the clock by 5 s and ask the loop to stop before answering."""
            clock[0] += 5.0
            tm._stop_monitoring.set()
            return await super().sample()

    sampler = SlowSampler([(80.0, 256 * 1024 * 1024)])
    tm, _ = _make_sampled(fake_psutil, sampler, sample_interval=0.01)
    tm._report_to_billing_system = MagicMock(side_effect=lambda: asyncio.sleep(0))
    tm._audit_task_usage = MagicMock(side_effect=lambda: asyncio.sleep(0))
    tm.set_service_up(True)  # ungate billing accumulators

    tm.start_monitoring()
    await asyncio.wait_for(tm._monitoring_task, timeout=5)

    assert sampler.calls == 1
    assert tm._duration_seconds == pytest.approx(5.0)
