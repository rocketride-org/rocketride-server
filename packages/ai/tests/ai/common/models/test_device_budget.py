"""Unit tests for the per-device admission guard (fake memory probe, no torch needed)."""

import threading
import time

import pytest

import ai.common.models.device_budget as budgetmod
from ai.common.models.device_budget import MARGIN_MB, DeviceBudget, device_budget

_ENTERS = 5.0  # how long a call that may enter is given to enter
_STAYS_OUT = 0.3  # how long a call that must wait is watched


class _Probe:
    """Device memory as the guard reads it: driver free, own cache not in use, own allocated (MB)."""

    def __init__(self, free, cache_free=0.0, allocated=0.0):
        self.free, self.cache_free, self.allocated = free, cache_free, allocated

    def __call__(self):
        return self.free, self.cache_free, self.allocated


class _Call:
    """One call held inside the guard until ``leave``."""

    def __init__(self, budget, cost):
        self.entered = threading.Event()
        self._leave = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(budget, cost), daemon=True)
        self._thread.start()

    def _run(self, budget, cost):
        with budget.reserve(cost):
            self.entered.set()
            self._leave.wait(10)

    def enters(self):
        return self.entered.wait(_ENTERS)

    def stays_out(self):
        return not self.entered.wait(_STAYS_OUT)

    def leave(self):
        self._leave.set()
        self._thread.join(5)


def _inside(calls, expected):
    """How many of ``calls`` are inside once ``expected`` had the time to enter and the rest to wait."""
    deadline = time.monotonic() + _ENTERS
    while sum(c.entered.is_set() for c in calls) < expected and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(_STAYS_OUT)
    return sum(c.entered.is_set() for c in calls)


@pytest.fixture(autouse=True)
def _fast_recheck(monkeypatch):
    monkeypatch.setattr(budgetmod, 'RECHECK_S', 0.02)


def _gpu(probe):
    return DeviceBudget('cuda:0', probe)


def test_first_call_enters_whatever_it_costs():
    first = _Call(_gpu(_Probe(free=100)), cost=5000)
    assert first.enters()
    first.leave()


def test_second_call_enters_only_if_it_fits():
    budget = _gpu(_Probe(free=4000))
    first = _Call(budget, 1000)
    assert first.enters()

    fits = _Call(budget, 4000 - 1000 - MARGIN_MB)
    assert fits.enters()
    too_big = _Call(budget, 4000 - 1000 - MARGIN_MB + 1)
    assert too_big.stays_out()

    first.leave()
    fits.leave()
    assert too_big.enters()
    too_big.leave()


def test_own_torch_cache_counts_as_free():
    budget = _gpu(_Probe(free=600, cache_free=3000))
    first = _Call(budget, 1000)
    assert first.enters()
    second = _Call(budget, 600 + 3000 - 1000 - MARGIN_MB)
    assert second.enters()
    first.leave()
    second.leave()


def test_memory_a_call_already_holds_is_not_counted_twice():
    probe = _Probe(free=3000)
    budget = _gpu(probe)
    first = _Call(budget, 2000)
    assert first.enters()
    probe.free, probe.allocated = 1000, 2000  # the first call has taken its memory

    second = _Call(budget, 1000 - MARGIN_MB)
    assert second.enters()
    first.leave()
    second.leave()


def test_memory_freed_elsewhere_is_seen_without_a_release():
    probe = _Probe(free=1000)
    budget = _gpu(probe)
    first = _Call(budget, 500)
    assert first.enters()
    waiter = _Call(budget, 2000)
    assert waiter.stays_out()

    probe.free = 4000  # the desktop or another process gave memory back
    assert waiter.enters()
    first.leave()
    waiter.leave()


def test_at_most_four_calls_on_a_gpu():
    budget = _gpu(_Probe(free=1e6))
    calls = [_Call(budget, 1) for _ in range(budgetmod.MAX_CONCURRENT + 1)]
    assert _inside(calls, budgetmod.MAX_CONCURRENT) == budgetmod.MAX_CONCURRENT
    for c in calls:
        c.leave()


def test_calls_enter_in_arrival_order():
    budget = _gpu(_Probe(free=2000))
    first = _Call(budget, 1000)
    assert first.enters()
    big = _Call(budget, 3000)
    assert big.stays_out()

    small = _Call(budget, 100)  # would fit, but the big call came first
    assert small.stays_out()
    first.leave()
    assert big.enters()
    big.leave()
    small.leave()


def test_unknown_cost_runs_alone():
    budget = _gpu(_Probe(free=1e6))
    first = _Call(budget, 100)
    assert first.enters()
    exclusive = _Call(budget, None)
    assert exclusive.stays_out()
    first.leave()
    assert exclusive.enters()

    after = _Call(budget, 100)
    assert after.stays_out()
    exclusive.leave()
    assert after.enters()
    after.leave()


def test_cpu_slots():
    budget = DeviceBudget('cpu')
    calls = [_Call(budget, 1) for _ in range(budgetmod.CPU_SLOTS + 1)]
    assert _inside(calls, budgetmod.CPU_SLOTS) == budgetmod.CPU_SLOTS
    for c in calls:
        c.leave()


def test_a_failed_call_leaves_the_guard():
    budget = _gpu(_Probe(free=100))
    with pytest.raises(RuntimeError):
        with budget.reserve(5000):
            raise RuntimeError('CUDA out of memory')
    second = _Call(budget, 5000)
    assert second.enters()
    second.leave()


def test_one_guard_per_device(monkeypatch):
    monkeypatch.setattr(budgetmod, 'is_model_server_enabled', lambda: False)
    monkeypatch.setattr(budgetmod, '_cuda_probe', lambda device: _Probe(free=1e6))
    monkeypatch.setattr(budgetmod, '_budgets', {})

    assert device_budget('cuda') is device_budget('cuda:0')
    assert device_budget('cuda:1') is not device_budget('cuda:0')
    assert device_budget('cpu') is device_budget('cpu')


def test_model_server_mode_is_a_no_op(monkeypatch):
    monkeypatch.setattr(budgetmod, 'is_model_server_enabled', lambda: True)
    guard = device_budget('cuda:0')
    held = [guard.reserve(None) for _ in range(8)]
    for cm in held:
        cm.__enter__()  # an exclusive call would block the second one if this were a real guard
    for cm in held:
        cm.__exit__(None, None, None)
