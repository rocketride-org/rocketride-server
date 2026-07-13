"""
Unit tests for ai.modules.task.task_metrics.TaskMetrics.

TaskMetrics is now billing-focused. It no longer samples CPU / memory / GPU
via psutil / pynvml — that responsibility moved to the task engine, which
pushes live metrics into ``_status.metrics`` from ``>MET*`` messages. This
class instead:

- ingests subprocess-reported cumulative usage snapshots via ``>USG*``
  (``merge_subprocess_usage``),
- converts those accumulators to tokens using conversion rates from the
  ``metrics_conversions`` DB table (``account.get_billing_rates``), writing a
  fresh ``TASK_TOKENS`` model onto ``_status.tokens`` (``_update_tokens``),
- gates billing until ``set_service_up(True)`` and snapshots baselines so
  startup costs are excluded,
- reports cumulative tokens to the credit ledger via
  ``account.apply_debit`` (``_report_to_billing_system`` /
  ``check_billing_report``), advancing ``_last_report_time``,
- audits the final frozen totals via ``account.audit`` on ``stop_monitoring``.

Test strategy:

- ``ai.account`` is faked in ``sys.modules`` so the source's in-method
  ``from ai.account import account`` resolves to a controllable mock. Its
  ``get_billing_rates`` returns fixed test rates; ``apply_debit`` and
  ``audit`` are AsyncMocks so the ledger / audit sinks are observable without
  a real backend.
- ``TASK_STATUS`` is faked with a ``SimpleNamespace`` carrying a real
  ``TASK_TOKENS`` (dynamic, ``extra='allow'``) ``tokens`` sub-object — the
  only attribute TaskMetrics reads or writes for token accounting.
- Async methods are exercised under ``@pytest.mark.asyncio``.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride.types.task import TASK_TOKENS

from ai.modules.task import task_metrics


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def make_status():
    """Build a TASK_STATUS-shaped namespace with a real (dynamic) TASK_TOKENS.

    TaskMetrics only ever reads/writes ``_status.tokens``, replacing it
    wholesale with a fresh ``TASK_TOKENS`` in ``_update_tokens`` /
    ``start_monitoring`` and calling ``.model_dump()`` on it when reporting.
    """
    return SimpleNamespace(tokens=TASK_TOKENS())


# Default billing rates keyed like the ``metrics_conversions`` DB table.
# Each value is tokens-per-unit for the matching subprocess usage key.
_TEST_BILLING_RATES = {
    'cpu_compute': 0.001,
    'cpu_memory': 0.05,
    'gpu_compute': 0.005,
    'gpu_memory': 2.0,
    'requests': 1.0,
    'pages': 0.0,  # zero rate — must never produce a token line
}


@pytest.fixture
def mock_account(monkeypatch):
    """Fake ``ai.account.account`` in ``sys.modules``.

    The source imports ``from ai.account import account`` *inside* its
    methods, so patching ``sys.modules['ai.account']`` with a module-like
    MagicMock exposing an ``account`` attribute is sufficient to intercept
    every billing call.

    Returns:
        MagicMock: the fake ``account`` object. ``get_billing_rates`` is a
        plain mock returning ``_TEST_BILLING_RATES``; ``apply_debit`` and
        ``audit`` are AsyncMocks recording every ledger / audit call.
    """
    account = MagicMock()
    account.get_billing_rates.return_value = dict(_TEST_BILLING_RATES)
    account.apply_debit = AsyncMock(return_value=True)
    account.audit = AsyncMock(return_value=None)
    monkeypatch.setitem(sys.modules, 'ai.account', MagicMock(account=account))
    return account


def _make_metrics(status=None, **overrides):
    """Construct a TaskMetrics with sensible billing identifiers.

    Args:
        status: optional pre-built status namespace; a fresh one is created
            when omitted.
        **overrides: constructor keyword overrides (e.g. ``org_id=''``).

    Returns:
        tuple[TaskMetrics, SimpleNamespace]: the instance and its status.
    """
    status = status or make_status()
    kwargs = dict(
        task_status=status,
        task_id='task-abc',
        client_id='client-1',
        user_id='user-1',
        team_id='team-1',
        org_id='org-1',
        pipeline_name='my-pipeline',
        source_name='my-source',
    )
    kwargs.update(overrides)
    tm = task_metrics.TaskMetrics(**kwargs)
    return tm, status


# ---------------------------------------------------------------------------
# __init__ — construction and defaults
# ---------------------------------------------------------------------------


def test_init_sets_billing_identifiers_and_defaults(mock_account):
    """Constructor stores identifiers and starts billing-gated with empty usage."""
    tm, status = _make_metrics()

    assert tm.task_id == 'task-abc'
    assert tm.client_id == 'client-1'
    assert tm.user_id == 'user-1'
    assert tm.team_id == 'team-1'
    assert tm.org_id == 'org-1'
    assert tm.pipeline_name == 'my-pipeline'
    assert tm.source_name == 'my-source'

    # Billing starts gated; usage / baselines empty until >USG* arrives.
    assert tm._billing_gated is True
    assert tm._subprocess_usage == {}
    assert tm._baselines == {}

    # Report interval seeded from the module constant.
    assert tm._report_interval_seconds == task_metrics.CONST_BILLING_REPORT_INTERVAL
    assert isinstance(tm._last_report_time, float)


def test_init_generates_unique_billing_run_id(mock_account):
    """Each instance gets its own billing_run_id for ledger idempotency."""
    tm1, _ = _make_metrics()
    tm2, _ = _make_metrics()
    assert tm1.billing_run_id != tm2.billing_run_id
    assert isinstance(tm1.billing_run_id, str) and tm1.billing_run_id


def test_init_optional_identifiers_default_to_empty(mock_account):
    """Missing user/team/org/pipeline/source default to empty strings, not None."""
    status = make_status()
    tm = task_metrics.TaskMetrics(task_status=status)
    assert tm.user_id == ''
    assert tm.team_id == ''
    assert tm.org_id == ''
    assert tm.pipeline_name == ''
    assert tm.source_name == ''


# ---------------------------------------------------------------------------
# set_service_up — billing gate + baseline snapshot
# ---------------------------------------------------------------------------


def test_set_service_up_true_snapshots_baselines_and_ungates(mock_account):
    """Snapshots current usage as baselines and opens the billing gate on set_service_up(True)."""
    tm, _ = _make_metrics()
    tm._subprocess_usage = {'cpu_compute': 5000.0, 'gpu_memory': 3.0}

    tm.set_service_up(True)

    assert tm._billing_gated is False
    # Baselines are a copy of usage at the moment of serviceUp.
    assert tm._baselines == {'cpu_compute': 5000.0, 'gpu_memory': 3.0}
    assert tm._baselines is not tm._subprocess_usage


def test_set_service_up_false_regates_billing(mock_account):
    """serviceUp(False) closes the billing gate again."""
    tm, _ = _make_metrics()
    tm.set_service_up(True)
    assert tm._billing_gated is False
    tm.set_service_up(False)
    assert tm._billing_gated is True


def test_set_service_up_true_twice_does_not_reset_baselines(mock_account):
    """Baselines are only captured on the gated->ungated transition."""
    tm, _ = _make_metrics()
    tm._subprocess_usage = {'cpu_compute': 100.0}
    tm.set_service_up(True)
    first_baselines = tm._baselines

    # Usage grows, then serviceUp(True) is signalled again while already up.
    tm._subprocess_usage = {'cpu_compute': 999.0}
    tm.set_service_up(True)

    # Baseline unchanged — the initial startup snapshot is preserved.
    assert tm._baselines == first_baselines == {'cpu_compute': 100.0}


# ---------------------------------------------------------------------------
# merge_subprocess_usage / _update_tokens — >USG* ingest + rate conversion
# ---------------------------------------------------------------------------


def test_merge_subprocess_usage_replaces_snapshot_wholesale(mock_account):
    """Each >USG* payload replaces the previous absolute snapshot."""
    tm, _ = _make_metrics()
    tm.set_service_up(True)

    tm.merge_subprocess_usage({'values': {'cpu_compute': 10.0, 'requests': 2.0}})
    assert tm._subprocess_usage == {'cpu_compute': 10.0, 'requests': 2.0}

    # A later snapshot omitting requests fully replaces the prior dict.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 25.0}})
    assert tm._subprocess_usage == {'cpu_compute': 25.0}


def test_merge_subprocess_usage_coerces_keys_and_values(mock_account):
    """Keys become str and values become float on ingest."""
    tm, _ = _make_metrics()
    tm.merge_subprocess_usage({'values': {'cpu_compute': 7}})
    assert tm._subprocess_usage == {'cpu_compute': 7.0}
    assert isinstance(next(iter(tm._subprocess_usage.values())), float)


def test_merge_subprocess_usage_invokes_update_callback(mock_account):
    """The on_update_callback fires after each merge."""
    callback = MagicMock()
    tm, _ = _make_metrics(on_update_callback=callback)
    tm.set_service_up(True)
    tm.merge_subprocess_usage({'values': {'cpu_compute': 1.0}})
    callback.assert_called_once()


def test_update_tokens_converts_usage_via_db_rates(mock_account):
    """Tokens = billable_usage * DB rate, per key, on _status.tokens."""
    tm, status = _make_metrics()
    tm.set_service_up(True)
    # First >USG* after service-up establishes a zero baseline (no startup
    # usage accrued), so the real usage below bills in full.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 0.0, 'gpu_memory': 0.0, 'requests': 0.0, 'pages': 0.0}})

    tm.merge_subprocess_usage(
        {
            'values': {
                'cpu_compute': 5000.0,  # 5000 * 0.001 = 5.0
                'gpu_memory': 3.0,  # 3 * 2.0 = 6.0
                'requests': 4.0,  # 4 * 1.0 = 4.0
                'pages': 100.0,  # rate 0.0 -> no token line
            }
        }
    )

    dump = status.tokens.model_dump()
    assert dump.get('cpu_compute') == pytest.approx(5.0)
    assert dump.get('gpu_memory') == pytest.approx(6.0)
    assert dump.get('requests') == pytest.approx(4.0)
    # Zero-rate keys never produce a token line.
    assert 'pages' not in dump


def test_baseline_deferred_to_first_usg_after_service_up(mock_account):
    """When service-up fires before any >USG*, the first post-service-up
    snapshot becomes the baseline (excluded); only later growth is billed.
    """
    tm, status = _make_metrics()

    # serviceUp with no usage yet -> baseline capture is deferred.
    tm.set_service_up(True)
    assert tm._baseline_pending is True
    assert tm._baselines == {}

    # First >USG* after service-up carries all of startup -> it becomes the
    # baseline and nothing is billed for it.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 5000.0}})
    assert tm._baseline_pending is False
    assert tm._baselines == {'cpu_compute': 5000.0}
    assert status.tokens.model_dump() == {}

    # Subsequent growth bills against the baseline: (8000 - 5000) * 0.001 = 3.0.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 8000.0}})
    assert status.tokens.model_dump().get('cpu_compute') == pytest.approx(3.0)


def test_update_tokens_subtracts_baselines(mock_account):
    """Startup usage captured as a baseline is excluded from billed tokens."""
    tm, status = _make_metrics()
    # Startup: 2000 units of cpu_compute accrued before serviceUp.
    tm._subprocess_usage = {'cpu_compute': 2000.0}
    tm.set_service_up(True)  # baseline = 2000

    # After serviceUp, usage climbs to 5000. Billable = 5000 - 2000 = 3000.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 5000.0}})

    dump = status.tokens.model_dump()
    assert dump.get('cpu_compute') == pytest.approx(3.0)  # 3000 * 0.001


def test_update_tokens_gated_produces_no_tokens(mock_account):
    """While billing-gated (before serviceUp), no tokens are calculated."""
    tm, status = _make_metrics()
    # No set_service_up -> still gated.
    tm.merge_subprocess_usage({'values': {'cpu_compute': 5000.0}})
    assert status.tokens.model_dump() == {}


def test_update_tokens_ignores_unpriced_keys(mock_account):
    """Usage keys with no matching DB rate produce no token line."""
    tm, status = _make_metrics()
    tm.set_service_up(True)
    tm.merge_subprocess_usage({'values': {'unknown_metric': 500.0}})
    assert 'unknown_metric' not in status.tokens.model_dump()


# ---------------------------------------------------------------------------
# _report_to_billing_system — ledger writes + state advancement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_report_to_billing_system_writes_ledger_rows(mock_account):
    """Each positive token key produces one apply_debit UPSERT with a stable idem key."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0, gpu_memory=6.0)

    await tm._report_to_billing_system()

    assert mock_account.apply_debit.await_count == 2
    idem_keys = {c.kwargs['idempotency_key'] for c in mock_account.apply_debit.await_args_list}
    assert idem_keys == {
        f'task:{tm.billing_run_id}:cpu_compute',
        f'task:{tm.billing_run_id}:gpu_memory',
    }
    # Amounts are the cumulative per-key totals.
    amounts = {c.kwargs['description']: c.kwargs['amount'] for c in mock_account.apply_debit.await_args_list}
    assert amounts == {'cpu_compute': 5.0, 'gpu_memory': 6.0}


@pytest.mark.asyncio
async def test_report_to_billing_system_skips_when_no_org(mock_account):
    """With no org, nothing is written to the ledger."""
    tm, status = _make_metrics(org_id='')
    status.tokens = TASK_TOKENS(cpu_compute=5.0)
    await tm._report_to_billing_system()
    mock_account.apply_debit.assert_not_awaited()


@pytest.mark.asyncio
async def test_report_to_billing_system_skips_zero_total(mock_account):
    """Zero cumulative tokens produce no ledger write."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS()  # empty -> total 0
    await tm._report_to_billing_system()
    mock_account.apply_debit.assert_not_awaited()


@pytest.mark.asyncio
async def test_report_to_billing_system_skips_zero_valued_keys(mock_account):
    """Individual zero/negative token keys are not written even if total > 0."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0, gpu_memory=0.0)
    await tm._report_to_billing_system()
    descriptions = {c.kwargs['description'] for c in mock_account.apply_debit.await_args_list}
    assert descriptions == {'cpu_compute'}


@pytest.mark.asyncio
async def test_check_billing_report_advances_last_report_time(mock_account):
    """When the interval has elapsed, a report is sent and _last_report_time advances."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0)
    # Force the interval to appear elapsed.
    tm._last_report_time = 0.0

    await tm.check_billing_report()

    mock_account.apply_debit.assert_awaited()
    # _last_report_time moved forward to (roughly) now.
    assert tm._last_report_time > 0.0


@pytest.mark.asyncio
async def test_check_billing_report_noop_before_interval(mock_account):
    """No report is sent before the billing interval elapses."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0)
    import time as _time

    tm._last_report_time = _time.time()  # just reported "now"
    await tm.check_billing_report()
    mock_account.apply_debit.assert_not_awaited()


@pytest.mark.asyncio
async def test_check_billing_report_noop_when_stopped(mock_account):
    """A stopped instance is skipped by the centralized billing loop."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0)
    tm._last_report_time = 0.0
    tm._stop_monitoring.set()
    await tm.check_billing_report()
    mock_account.apply_debit.assert_not_awaited()


# ---------------------------------------------------------------------------
# start_monitoring / stop_monitoring lifecycle
# ---------------------------------------------------------------------------


def test_start_monitoring_resets_billing_state(mock_account):
    """start_monitoring clears usage / baselines / tokens for a fresh session."""
    tm, status = _make_metrics()
    # Poison: leftover state from a prior session.
    tm._subprocess_usage = {'cpu_compute': 99.0}
    tm._baselines = {'cpu_compute': 5.0}
    status.tokens = TASK_TOKENS(cpu_compute=99.0)
    tm._stop_monitoring.set()

    tm.start_monitoring()

    assert tm._subprocess_usage == {}
    assert tm._baselines == {}
    assert status.tokens.model_dump() == {}
    assert tm._stop_monitoring.is_set() is False


@pytest.mark.asyncio
async def test_stop_monitoring_reports_and_audits(mock_account):
    """stop_monitoring marks inactive, sends a final report, and audits totals."""
    tm, status = _make_metrics()
    status.tokens = TASK_TOKENS(cpu_compute=5.0, gpu_memory=6.0)

    await tm.stop_monitoring()

    assert tm._stop_monitoring.is_set() is True
    # Final billing report written.
    mock_account.apply_debit.assert_awaited()
    # Final usage audit written once with the frozen totals.
    mock_account.audit.assert_awaited_once()
    audit_kwargs = mock_account.audit.await_args.kwargs
    assert audit_kwargs['org_id'] == 'org-1'
    assert audit_kwargs['reason'] == 'task_usage'
    assert audit_kwargs['response_data']['usage'] == {'cpu_compute': 5.0, 'gpu_memory': 6.0}


@pytest.mark.asyncio
async def test_stop_monitoring_no_org_skips_audit(mock_account):
    """With no org, stop_monitoring neither bills nor audits."""
    tm, status = _make_metrics(org_id='')
    status.tokens = TASK_TOKENS(cpu_compute=5.0)
    await tm.stop_monitoring()
    mock_account.apply_debit.assert_not_awaited()
    mock_account.audit.assert_not_awaited()
