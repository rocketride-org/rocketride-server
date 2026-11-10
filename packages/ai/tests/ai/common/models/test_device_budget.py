"""Unit tests for the per-device admission guard (fake memory probe and NVML, no torch needed)."""

import os
import sys
import threading
import time
import types

import pytest

import ai.common.models.device_budget as budgetmod
from ai.common.models.device_budget import DeviceBudget, _has_neighbour, device_budget

# generous for a starved CI runner: each wait ends as soon as what it waits for happens
_ENTERS = 30.0  # how long a call is given to enter, to reach the queue, or to leave once let go
_STAYS_OUT = 0.3  # how long a call waiting in the queue is watched
_HOLD = 120.0  # a held call leaves on its own only after this, so a slow test never sees it leave
MARGIN_MB = 512  # the margin the guard keeps; spelled here so a changed margin fails


class _Probe:
    """Device memory as the guard reads it: driver free, own cache not in use, own allocated (MB)."""

    def __init__(self, free, cache_free=0.0, allocated=0.0):
        """Start the device at the given memory (MB).

        Args:
            free: Driver free memory.
            cache_free: This process's unused torch cache.
            allocated: This process's torch allocated memory.
        """
        self.free, self.cache_free, self.allocated = free, cache_free, allocated

    def __call__(self):
        """Return (free, cache_free, allocated) as they stand now."""
        return self.free, self.cache_free, self.allocated


class _Neighbours:
    """Whether NVML lists another engine process on the GPU."""

    def __init__(self, present=False):
        """Start with or without a neighbour.

        Args:
            present: Whether NVML lists another engine process.
        """
        self.present = present

    def __call__(self):
        """Return whether a neighbour is listed now."""
        return self.present


class _Release:
    """Counts cache releases and how many calls were inside at each."""

    def __init__(self, budget_of=lambda: None):
        """Count nothing yet.

        Args:
            budget_of: Returns the guard under test, to record how many calls were inside at each release.
        """
        self.inside_at = []
        self._budget_of = budget_of

    def __call__(self):
        """Record one release."""
        budget = self._budget_of()
        self.inside_at.append(len(budget._inside) if budget else -1)

    @property
    def count(self):
        """Return how many releases happened."""
        return len(self.inside_at)


class _Call:
    """One call held inside the guard until ``leave``."""

    def __init__(self, budget, cost):
        """Start the call in its own thread.

        Args:
            budget: The guard to enter.
            cost: The call's cost in MB, or ``None``.
        """
        self._budget = budget
        self.entered = threading.Event()
        self.out = threading.Event()
        self._leave = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(budget, cost), daemon=True)
        self._thread.start()

    def _run(self, budget, cost):
        """Enter the guard, signal it, and hold the place until ``leave``.

        Args:
            budget: The guard to enter.
            cost: The call's cost in MB, or ``None``.
        """
        with budget.reserve(cost):
            self.entered.set()
            self._leave.wait(_HOLD)
        self.out.set()

    def enters(self):
        """Return whether the call enters within ``_ENTERS`` seconds."""
        return self.entered.wait(_ENTERS)

    def stays_out(self):
        """Return whether the call waits in the queue and is still out ``_STAYS_OUT`` seconds later."""
        # a thread that has not started yet is out too, but not queued: order and drains differ
        return _wait_for(lambda: self.entered.is_set() or self.waiting) and not self.entered.wait(_STAYS_OUT)

    @property
    def inside(self):
        """Return whether the call is inside the guard now."""
        return self.entered.is_set() and not self.out.is_set()

    @property
    def waiting(self):
        """Return whether the call is in the guard's queue: it has waited there and not entered."""
        return not self.entered.is_set() and self._thread in self._budget._cond.waited

    def let_go(self):
        """Let the call leave once it is inside, without waiting for it."""
        self._leave.set()

    def leave(self):
        """Let the call leave and wait for its thread."""
        self.let_go()
        self._thread.join(_ENTERS)


def _leave_all(calls):
    """Let every call go before waiting for any: one still queued leaves once those inside are out.

    Args:
        calls: The calls to end, in any order.
    """
    for c in calls:
        c.let_go()
    for c in calls:
        c.leave()


def _inside(calls, expected):
    """How many of ``calls`` are inside at once, after ``expected`` had the time to enter and the rest to queue.

    Args:
        calls: The calls started.
        expected: How many of them should get in.

    Returns:
        How many are inside now; a call that entered and left is not counted.
    """
    _wait_for(lambda: sum(c.inside for c in calls) >= expected and all(c.inside or c.waiting for c in calls))
    time.sleep(_STAYS_OUT)
    return sum(c.inside for c in calls)


def _wait_for(condition):
    """Wait up to ``_ENTERS`` seconds for a condition.

    Args:
        condition: Returns True once it holds.

    Returns:
        Whether it holds at the end.
    """
    deadline = time.monotonic() + _ENTERS
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.01)
    return condition()


@pytest.fixture(autouse=True)
def _fast_recheck(monkeypatch):
    """Re-check fast, read the process list on every admission, and keep idle releases out of the way."""
    monkeypatch.setattr(budgetmod, 'RECHECK_S', 0.02)
    monkeypatch.setattr(budgetmod, 'NEIGHBOURS_TTL_S', 0.0)
    monkeypatch.setattr(budgetmod, 'IDLE_RELEASE_S', 60.0)  # tests of the idle release set their own


class _Clock:
    """Stands in for the guard's monotonic clock: an idle spell ends only when the test moves the clock past it."""

    def __init__(self, monkeypatch):
        """Stop the guard's clock.

        Args:
            monkeypatch: The test's monkeypatch fixture.
        """
        self._now = 1000.0
        monkeypatch.setattr(budgetmod, 'time', types.SimpleNamespace(**{**vars(time), 'monotonic': lambda: self._now}))

    def advance(self, budget, seconds):
        """Move the clock on, wake the guard's releasing thread, and wait until it has acted.

        Args:
            budget: The guard under test.
            seconds: How far to move the clock.
        """
        self._now += seconds
        with budget._cond:
            budget._cond.notify_all()
        assert _settled(budget)


class _Cond(threading.Condition):
    """The guard's condition, noting each thread that waited on it and whether a waiter has seen every notify."""

    def __init__(self):
        """Start with no thread noted."""
        super().__init__()
        self.waited = set()
        self._notifies = 0
        self._waits_since = {}

    def wait(self, timeout=None):
        """Note the calling thread, then wait as ``threading.Condition`` does.

        Args:
            timeout: How long to wait at most, in seconds; ``None`` waits for a notify.

        Returns:
            False if the wait timed out, True otherwise.
        """
        # the thread object, not its id: the OS hands a finished thread's id to a new one
        me = threading.current_thread()
        self.waited.add(me)
        self._waits_since[me] = self._notifies
        try:
            return super().wait(timeout)
        finally:
            del self._waits_since[me]

    def notify_all(self):
        """Count the notify, then wake every waiter."""
        self._notifies += 1
        super().notify_all()

    def settled(self, thread):
        """Tell whether a thread waits now and began after the last notify; the caller holds the lock.

        Args:
            thread: The thread to look at.

        Returns:
            True if it has acted on every notify and waits again.
        """
        return self._waits_since.get(thread) == self._notifies


def _watched(budget):
    """Let tests see which calls wait in a new guard's queue.

    Args:
        budget: A guard no call has used yet.

    Returns:
        The same guard, on a condition that notes the threads that wait.
    """
    budget._cond = _Cond()
    return budget


def _settled(budget):
    """Wait until the guard's releasing thread, once started, waits again after the last notify.

    Args:
        budget: A guard built by ``_watched``.

    Returns:
        Whether it does within ``_ENTERS`` seconds.
    """

    def settled():
        """Return whether the releasing thread has nothing left to act on."""
        with budget._cond:
            return budget._releaser is None or budget._cond.settled(budget._releaser)

    return _wait_for(settled)


def _gpu(probe, neighbours=None, release=None, warm=None):
    """Build a GPU guard on fakes.

    Args:
        probe: The memory probe.
        neighbours: The neighbour probe; none listed by default.
        release: The cache release; a counting fake by default.
        warm: The workspace set-up; one that does nothing by default.

    Returns:
        The guard of ``cuda:0``.
    """
    return _watched(
        DeviceBudget('cuda:0', probe, neighbours or _Neighbours(), release or _Release(), warm or (lambda: None))
    )


def test_first_call_enters_whatever_it_costs():
    """A call larger than the card still enters when nothing else is inside."""
    first = _Call(_gpu(_Probe(free=100)), cost=5000)
    assert first.enters()
    first.leave()


@pytest.mark.parametrize('extra, fits', [(0, True), (1, False)])
def test_second_call_enters_only_if_it_fits(extra, fits):
    """A second call enters only if it fits beside the first, margin included.

    Args:
        extra: MB the second call needs beyond what is left.
        fits: Whether it should enter beside the first.
    """
    budget = _gpu(_Probe(free=4000))
    first = _Call(budget, 1000)
    assert first.enters()

    second = _Call(budget, 4000 - 1000 - MARGIN_MB + extra)
    assert second.enters() if fits else second.stays_out()
    first.leave()
    assert second.enters()
    second.leave()


def test_own_torch_cache_counts_as_free():
    """This process's unused torch cache counts as free memory."""
    budget = _gpu(_Probe(free=600, cache_free=3000))
    first = _Call(budget, 1000)
    assert first.enters()
    second = _Call(budget, 600 + 3000 - 1000 - MARGIN_MB)
    assert second.enters()
    first.leave()
    second.leave()


def test_memory_a_call_already_holds_is_not_counted_twice():
    """Memory a call inside already allocated is not claimed again."""
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
    """A waiter sees memory another process frees, without a call leaving."""
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
    """No more than ``MAX_CONCURRENT`` calls are inside a GPU, whatever memory is left."""
    budget = _gpu(_Probe(free=1e6))
    calls = [_Call(budget, 1) for _ in range(budgetmod.MAX_CONCURRENT + 1)]
    assert _inside(calls, budgetmod.MAX_CONCURRENT) == budgetmod.MAX_CONCURRENT
    _leave_all(calls)


def test_calls_enter_in_arrival_order():
    """A large waiting call is not overtaken by smaller ones that would fit."""
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
    """A call of unknown cost waits for the device to empty and keeps others out."""
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
    """A CPU guard admits ``CPU_SLOTS`` calls."""
    budget = _watched(DeviceBudget('cpu'))
    calls = [_Call(budget, 1) for _ in range(budgetmod.CPU_SLOTS + 1)]
    assert _inside(calls, budgetmod.CPU_SLOTS) == budgetmod.CPU_SLOTS
    _leave_all(calls)


def test_a_failed_call_leaves_the_guard():
    """A call that raises frees its place."""
    budget = _gpu(_Probe(free=100))
    with pytest.raises(RuntimeError):
        with budget.reserve(5000):
            raise RuntimeError('CUDA out of memory')
    second = _Call(budget, 5000)
    assert second.enters()
    second.leave()


def test_a_failed_memory_read_leaves_the_queue():
    """A probe that raises takes the waiting call out of the queue."""
    reads = []

    def probe():
        """Raise on the first read, then report plenty of memory."""
        reads.append(1)
        if len(reads) == 1:
            raise RuntimeError('CUDA error: unspecified launch failure')
        return 1e6, 0.0, 0.0

    budget = _gpu(probe)
    with pytest.raises(RuntimeError):
        with budget.reserve(100):
            pass
    second = _Call(budget, 100)
    assert second.enters()
    second.leave()


def test_the_cache_is_released_once_the_device_stays_idle(monkeypatch):
    """The cache goes back only after the last call left and the device stayed idle."""
    monkeypatch.setattr(budgetmod, 'IDLE_RELEASE_S', 0.05)
    release = _Release()
    budget = _gpu(_Probe(free=4000), release=release)
    first, second = _Call(budget, 1000), _Call(budget, 1000)
    assert first.enters() and second.enters()

    first.leave()
    time.sleep(_STAYS_OUT)
    assert release.count == 0  # a call is still inside
    second.leave()
    assert _wait_for(lambda: release.count == 1)


def test_the_cache_is_kept_for_a_waiting_call(monkeypatch):
    """A call that leaves while another waits keeps the cache for it."""
    monkeypatch.setattr(budgetmod, 'IDLE_RELEASE_S', 0.05)
    release = _Release()
    budget = _gpu(_Probe(free=1000), release=release)
    first = _Call(budget, 1000)
    assert first.enters()
    second = _Call(budget, 1000)
    assert second.stays_out()

    first.leave()
    assert second.enters()
    time.sleep(_STAYS_OUT)
    assert release.count == 0
    second.leave()
    assert _wait_for(lambda: release.count == 1)


def test_back_to_back_calls_keep_the_cache(monkeypatch):
    """Calls in quick succession keep the cache; one release follows the last, a whole idle spell after it."""
    clock = _Clock(monkeypatch)
    release = _Release()
    budget = _gpu(_Probe(free=1e6), release=release)
    for _ in range(3):
        with budget.reserve(100):
            pass
        clock.advance(budget, budgetmod.IDLE_RELEASE_S / 2)  # the next call comes within the spell
    assert release.count == 0  # each drain starts the spell again
    clock.advance(budget, budgetmod.IDLE_RELEASE_S / 2)
    assert release.count == 1


def test_a_call_inside_when_the_idle_spell_ends_keeps_the_cache(monkeypatch):
    """A call that entered during the idle spell is not robbed of its cache when the spell ends."""
    clock = _Clock(monkeypatch)
    budget = None
    release = _Release(lambda: budget)
    budget = _gpu(_Probe(free=1e6), release=release)
    with budget.reserve(100):
        pass  # the device goes idle: a release is due
    call = _Call(budget, 100)
    assert call.enters()
    clock.advance(budget, budgetmod.IDLE_RELEASE_S)  # the spell ends with the call inside
    assert release.count == 0
    call.leave()
    assert _settled(budget)
    assert release.count == 0  # its drain starts a new idle spell
    clock.advance(budget, budgetmod.IDLE_RELEASE_S)
    assert release.inside_at == [0]


def test_each_idle_spell_releases_once(monkeypatch):
    """A release follows every idle spell, and only one per spell."""
    monkeypatch.setattr(budgetmod, 'IDLE_RELEASE_S', 0.05)
    release = _Release()
    budget = _gpu(_Probe(free=1e6), release=release)
    with budget.reserve(100):
        pass
    assert _wait_for(lambda: release.count == 1)
    time.sleep(_STAYS_OUT)
    assert release.count == 1  # still idle: nothing more to hand back
    with budget.reserve(100):
        pass
    assert _wait_for(lambda: release.count == 2)


def test_drains_do_not_start_a_thread_each(monkeypatch):
    """The guard keeps one releasing thread, however many times the device drains."""
    monkeypatch.setattr(budgetmod, 'IDLE_RELEASE_S', 0.05)
    budget = _gpu(_Probe(free=1e6))
    before = threading.active_count()
    for _ in range(20):
        with budget.reserve(100):
            pass
    assert threading.active_count() - before <= 1


def test_each_thread_sets_up_its_workspace_once():
    """A thread's first call on a GPU sets up its cuBLAS workspace before the call runs; its later calls do not."""
    warmed = []
    budget = _gpu(_Probe(free=1e6), warm=lambda: warmed.append(threading.get_ident()))
    for _ in range(2):
        with budget.reserve(100):
            assert warmed == [threading.get_ident()]
    other = _Call(budget, 100)
    assert other.enters()
    other.leave()
    assert len(warmed) == 2 and warmed[1] != warmed[0]


def test_a_thread_given_a_finished_threads_id_sets_up_again(monkeypatch):
    """A new thread sets up its workspace even when the OS gives it the id of a thread that has ended."""
    monkeypatch.setattr(budgetmod, 'threading', types.SimpleNamespace(**{**vars(threading), 'get_ident': lambda: 1}))
    warmed = []
    budget = _gpu(_Probe(free=1e6), warm=lambda: warmed.append(1))
    for _ in range(2):
        call = _Call(budget, 100)
        assert call.enters()
        call.leave()
    assert len(warmed) == 2


def test_a_failed_workspace_set_up_does_not_fail_the_call(monkeypatch):
    """A set-up that raises is logged once, not tried again, and leaves the calls and the guard as they were."""
    warnings = []
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))
    tries = []

    def warm():
        """Fail as a torch without memory pools would."""
        tries.append(1)
        raise AttributeError("module 'torch.cuda' has no attribute 'MemPool'")

    budget = _gpu(_Probe(free=1e6), warm=warm)
    with budget.reserve(100):
        pass
    other = _Call(budget, 100)
    assert other.enters()
    other.leave()
    assert len(tries) == 1 and len(warnings) == 1 and 'cuBLAS' in warnings[0][0]
    assert budget._inside == []


def test_no_workspace_set_up_on_cpu():
    """Calls on the CPU leave cuBLAS alone."""
    warmed = []
    budget = DeviceBudget('cpu', warm=lambda: warmed.append(1))
    with budget.reserve(100):
        pass
    assert warmed == []


def test_beside_a_neighbour_every_call_starts_without_cache():
    """Beside a neighbour the cache is released before each call, never with a call inside."""
    budget = None
    release = _Release(lambda: budget)
    budget = _gpu(_Probe(free=1e6), _Neighbours(present=True), release)
    pending = [_Call(budget, 1000) for _ in range(3)]
    while pending:
        deadline = time.monotonic() + _ENTERS
        while not any(c.entered.is_set() for c in pending) and time.monotonic() < deadline:
            time.sleep(0.01)
        call = next(c for c in pending if c.entered.is_set())
        call.leave()
        pending.remove(call)
    # one release before each of the 3 calls, never with a call inside
    assert release.inside_at == [0, 0, 0]


def test_a_failed_cache_release_does_not_fail_the_call(monkeypatch):
    """A release that raises is logged once and the calls still succeed."""
    warnings = []
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))

    def release():
        """Fail as a broken device would."""
        raise RuntimeError('CUDA error: an illegal memory access was encountered')

    budget = _gpu(_Probe(free=1e6), _Neighbours(present=True), release)
    for _ in range(2):
        with budget.reserve(1000):
            pass
    assert len(warnings) == 1  # failed before each call, logged once


def test_the_process_list_is_reused_for_a_while(monkeypatch):
    """NVML is asked at most once per ``NEIGHBOURS_TTL_S``."""
    monkeypatch.setattr(budgetmod, 'NEIGHBOURS_TTL_S', 60.0)
    reads = []
    budget = _gpu(_Probe(free=1e6), lambda: reads.append(1) or False)
    for _ in range(3):
        with budget.reserve(100):
            pass
    assert len(reads) == 1


def test_a_neighbour_means_one_call_at_a_time():
    """With a neighbour listed, a second call waits for the first."""
    budget = _gpu(_Probe(free=1e6), _Neighbours(present=True))
    first = _Call(budget, 100)
    assert first.enters()
    second = _Call(budget, 100)
    assert second.stays_out()
    first.leave()
    assert second.enters()
    second.leave()


def test_calls_inside_finish_when_a_neighbour_appears():
    """Calls inside keep running when a neighbour appears; new ones wait."""
    neighbours = _Neighbours()
    budget = _gpu(_Probe(free=1e6), neighbours)
    first, second = _Call(budget, 100), _Call(budget, 100)
    assert first.enters() and second.enters()

    neighbours.present = True
    third = _Call(budget, 100)
    assert third.stays_out()
    first.leave()
    assert third.stays_out()  # one call is still inside
    second.leave()
    assert third.enters()
    third.leave()


def test_a_lone_call_waits_for_memory_while_the_neighbour_drains():
    """Right after a neighbour appears, a lone call waits until its cost fits."""
    probe = _Probe(free=1000)
    budget = _gpu(probe, _Neighbours(present=True))
    lone = _Call(budget, 2000)
    assert lone.stays_out()

    probe.free = 2000 + MARGIN_MB  # the calls the neighbour admitted alone have finished
    assert lone.enters()
    lone.leave()


def test_a_lone_call_enters_after_the_wait_as_with_the_lock(monkeypatch):
    """After ``SHARED_WAIT_S`` a lone call enters even if it does not fit."""
    monkeypatch.setattr(budgetmod, 'SHARED_WAIT_S', 0.2)
    budget = _gpu(_Probe(free=100), _Neighbours(present=True))
    lone = _Call(budget, 5000)
    assert lone.enters()
    lone.leave()


def test_a_lone_call_of_unknown_cost_enters_beside_a_neighbour():
    """A lone call of unknown cost enters beside a neighbour, as with the lock."""
    budget = _gpu(_Probe(free=100), _Neighbours(present=True))
    lone = _Call(budget, None)
    assert lone.enters()
    lone.leave()


def test_the_budget_returns_when_the_neighbour_leaves():
    """Once the neighbour leaves, calls share the device again."""
    neighbours = _Neighbours(present=True)
    budget = _gpu(_Probe(free=1e6), neighbours)
    first = _Call(budget, 100)
    assert first.enters()
    second = _Call(budget, 100)
    assert second.stays_out()

    neighbours.present = False
    assert second.enters()
    first.leave()
    second.leave()


_NAMES = {10: 'engine.exe', 11: 'Engine.exe', 20: 'dwm.exe', 21: 'chrome.exe'}


def _name_of(pid):
    """Name a fake process.

    Args:
        pid: The process id.

    Returns:
        Its name, or ``'?'`` when it has none.
    """
    return _NAMES.get(pid, '?')


def test_desktop_processes_are_not_neighbours():
    """Desktop processes on the GPU are not neighbours."""
    assert not _has_neighbour({10, 20, 21}, 10, 'engine.exe', _name_of)


def test_another_engine_process_is_a_neighbour():
    """Another process named like this one is a neighbour."""
    assert _has_neighbour({10, 11, 20}, 10, 'engine.exe', _name_of)


def test_a_process_that_cannot_be_named_is_a_neighbour():
    """A process whose name cannot be read is a neighbour."""
    assert _has_neighbour({10, 30, 20}, 10, 'engine.exe', _name_of)


def test_in_another_pid_namespace_one_unnamed_process_is_this_one():
    """In another PID namespace one unnamed process is this one; a second is a neighbour."""
    # NVML lists host pids: this process is 5 inside its namespace and 30 on the host
    assert not _has_neighbour({30, 20}, 5, 'engine', _name_of)
    assert _has_neighbour({30, 31, 20}, 5, 'engine', _name_of)


def test_no_nvml_means_a_neighbour(monkeypatch):
    """Without NVML the guard assumes a neighbour."""
    monkeypatch.setitem(sys.modules, 'pynvml', None)
    assert budgetmod._nvml_neighbours('cuda:0')() is True


def test_a_failed_process_name_read_falls_back_and_is_read_again(monkeypatch):
    """A failed name read means a neighbour, is logged once, and is retried on the next listing."""
    reads = []

    class _Process:
        """This process, whose name cannot be read the first two times."""

        def name(self):
            """Raise twice, then return the engine's name."""
            reads.append(1)
            if len(reads) <= 2:
                raise RuntimeError('access denied')
            return 'engine.exe'

    only_this_process = [types.SimpleNamespace(pid=os.getpid())]
    nvml = types.SimpleNamespace(
        nvmlInit=lambda: None,
        nvmlDeviceGetHandleByUUID=lambda uuid: 'handle',
        nvmlDeviceGetComputeRunningProcesses=lambda handle: only_this_process,
        nvmlDeviceGetGraphicsRunningProcesses=lambda handle: [],
        nvmlDeviceGetProcessUtilization=lambda handle, since: [],
    )
    cuda = types.SimpleNamespace(get_device_properties=lambda index: types.SimpleNamespace(uuid='0'))
    warnings = []
    monkeypatch.setitem(sys.modules, 'psutil', types.SimpleNamespace(Process=_Process))
    monkeypatch.setitem(sys.modules, 'pynvml', nvml)
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=types.SimpleNamespace(cuda=cuda)))
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))

    neighbours = budgetmod._nvml_neighbours('cuda:0')
    assert neighbours() is True  # name not read: one call at a time
    assert neighbours() is True
    assert neighbours() is False  # read now: only this process is on the GPU
    assert len(warnings) == 1


def test_an_idle_engine_process_is_not_a_neighbour():
    """A process named like this one that was not seen busy only holds a context."""
    assert not _has_neighbour({10, 11, 20}, 10, 'engine.exe', _name_of, busy=set())
    assert _has_neighbour({10, 11, 20}, 10, 'engine.exe', _name_of, busy={11})
    assert not _has_neighbour({10, 11, 20}, 10, 'engine.exe', _name_of, busy={20})  # a busy desktop does not count


def test_without_utilisation_every_listed_process_counts():
    """Without per-process utilisation (``busy`` is None) the old rule holds."""
    assert _has_neighbour({10, 11}, 10, 'engine.exe', _name_of, busy=None)
    assert _has_neighbour({10, 30}, 10, 'engine.exe', _name_of, busy=None)


def test_an_unnamed_process_counts_only_when_busy():
    """A process that cannot be named is told apart by utilisation when this process is listed."""
    assert not _has_neighbour({10, 30}, 10, 'engine.exe', _name_of, busy=set())
    assert _has_neighbour({10, 30}, 10, 'engine.exe', _name_of, busy={30})


def test_in_another_pid_namespace_unnamed_processes_count_whatever_their_utilisation():
    """Host pids cannot be matched to this process, so an idle unnamed one still counts beyond the first."""
    assert not _has_neighbour({30}, 5, 'engine', _name_of, busy=set())
    assert _has_neighbour({30, 31}, 5, 'engine', _name_of, busy=set())


def test_in_another_pid_namespace_a_named_idle_process_is_not_a_neighbour():
    """A host pid that can be named is told apart by utilisation as usual."""
    names = {11: 'engine'}
    assert not _has_neighbour({11}, 5, 'engine', lambda pid: names.get(pid, '?'), busy=set())
    assert _has_neighbour({11}, 5, 'engine', lambda pid: names.get(pid, '?'), busy={11})


class _NotFound(Exception):
    """NVML's "no sample" error."""

    value = 6


def _sample(pid, sm, mem=0):
    """Build a fake NVML utilisation sample.

    Args:
        pid: The process id.
        sm: Its SM utilisation.
        mem: Its memory utilisation.

    Returns:
        The sample.
    """
    return types.SimpleNamespace(pid=pid, smUtil=sm, memUtil=mem)


def test_busy_pids_are_those_with_a_sample_above_zero():
    """Only processes with SM or memory utilisation count as busy."""
    seen = []

    def util(handle, since):
        """Record the start of the window and return the samples."""
        seen.append(since)
        return [_sample(1, 80), _sample(2, 0), _sample(3, 0, 5)]

    nvml = types.SimpleNamespace(nvmlDeviceGetProcessUtilization=util, NVML_ERROR_NOT_FOUND=6)
    before = time.time()
    assert budgetmod._busy_pids(nvml, 'handle', 10.0) == {1, 3}
    assert (before - 10.0) * 1e6 - 1 <= seen[0] <= (time.time() - 10.0) * 1e6  # int() truncates


def test_no_sample_in_the_window_means_nothing_was_busy():
    """NVML's not-found error is an empty answer, not a failure."""

    def util(handle, since):
        """Raise as NVML does when nothing ran."""
        raise _NotFound()

    nvml = types.SimpleNamespace(nvmlDeviceGetProcessUtilization=util, NVML_ERROR_NOT_FOUND=6)
    assert budgetmod._busy_pids(nvml, 'handle', 10.0) == set()


def test_another_utilisation_error_is_not_an_empty_answer():
    """Any other NVML error is raised, so the caller keeps the old rule."""

    def util(handle, since):
        """Raise as NVML does on a device without the call."""
        raise RuntimeError('not supported')

    nvml = types.SimpleNamespace(nvmlDeviceGetProcessUtilization=util, NVML_ERROR_NOT_FOUND=6)
    with pytest.raises(RuntimeError):
        budgetmod._busy_pids(nvml, 'handle', 10.0)


class _FakeNvml:
    """NVML with a settable process list and per-process busy times."""

    NVML_ERROR_NOT_FOUND = 6

    def __init__(self, listed):
        """List the given pids; ``busy_until`` maps a pid to the time it last ran.

        Args:
            listed: The pids on the device.
        """
        self.listed = listed
        self.busy_until = {}
        self.fail = None

    def nvmlInit(self):
        """Do nothing."""

    def nvmlDeviceGetHandleByUUID(self, uuid):
        """Return a placeholder handle."""
        return 'handle'

    def nvmlDeviceGetComputeRunningProcesses(self, handle):
        """List the pids."""
        return [types.SimpleNamespace(pid=pid) for pid in self.listed]

    def nvmlDeviceGetGraphicsRunningProcesses(self, handle):
        """List nothing."""
        return []

    def nvmlDeviceGetProcessUtilization(self, handle, since):
        """Return a sample for each process that ran after ``since``, as NVML does."""
        if self.fail:
            raise self.fail
        samples = [_sample(pid, 80) for pid, last in self.busy_until.items() if last * 1e6 > since]
        if not samples:
            raise _NotFound()
        return samples


@pytest.fixture
def _nvml(monkeypatch):
    """Install a fake NVML, psutil, torch and clock, this process just seen busy; return (probe, NVML, clock)."""
    own = os.getpid()
    clock = [1000.0]
    nvml = _FakeNvml([own, 7777])
    nvml.busy_until[own] = clock[0]
    names = {own: 'engine.exe', 7777: 'engine.exe'}
    cuda = types.SimpleNamespace(get_device_properties=lambda index: types.SimpleNamespace(uuid='0'))
    process = types.SimpleNamespace(Process=lambda pid=own: types.SimpleNamespace(name=lambda: names[pid]))
    monkeypatch.setitem(sys.modules, 'psutil', process)
    monkeypatch.setitem(sys.modules, 'pynvml', nvml)
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=types.SimpleNamespace(cuda=cuda)))
    monkeypatch.setattr(budgetmod, '_process_name', lambda pid: names.get(pid, '?'))
    monkeypatch.setattr(budgetmod, 'time', types.SimpleNamespace(time=lambda: clock[0], monotonic=time.monotonic))
    return budgetmod._nvml_neighbours('cuda:0'), nvml, clock


def test_an_idle_neighbour_does_not_count(_nvml):
    """The idle process of a finished task holds a context but has run nothing for a minute."""
    neighbours, nvml, clock = _nvml
    nvml.busy_until[7777] = clock[0] - 60
    assert neighbours() is False


def test_a_busy_neighbour_counts_until_the_window_has_passed(_nvml):
    """A neighbour counts while its last sample is inside the window, and not after."""
    neighbours, nvml, clock = _nvml
    nvml.busy_until[7777] = clock[0]
    assert neighbours() is True
    clock[0] += budgetmod.BUSY_WINDOW_S - 1
    assert neighbours() is True
    clock[0] += 2  # the neighbour paused for longer than the window
    assert neighbours() is False
    nvml.busy_until[7777] = clock[0]  # and it resumes
    assert neighbours() is True


def test_samples_count_once_they_have_shown_this_process_busy(_nvml, monkeypatch):
    """Until NVML has sampled this process busy, an idle-looking neighbour counts; from then on it does not."""
    neighbours, nvml, clock = _nvml
    warnings = []
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))
    del nvml.busy_until[os.getpid()]
    nvml.busy_until[3908] = clock[0]  # a busy desktop says nothing about engine processes
    assert neighbours() is True
    nvml.busy_until[os.getpid()] = clock[0]
    assert neighbours() is False
    clock[0] += budgetmod.BUSY_WINDOW_S + 1  # this process idle since
    assert neighbours() is False
    assert not warnings  # the first answer came from the samples, not from a failed read


def test_a_driver_that_samples_no_process_keeps_the_old_rule(_nvml, monkeypatch):
    """With no sample of this process ever, every listed engine process counts, without a warning."""
    neighbours, nvml, clock = _nvml
    del nvml.busy_until[os.getpid()]
    warnings = []
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))
    assert neighbours() is True
    clock[0] += 60
    assert neighbours() is True
    assert not warnings


def test_without_a_utilisation_call_every_listed_engine_counts_and_it_is_logged_once(_nvml, monkeypatch):
    """A device that cannot report utilisation keeps the old rule, with one warning."""
    neighbours, nvml, clock = _nvml
    nvml.fail = RuntimeError('not supported')
    warnings = []
    monkeypatch.setattr(budgetmod, 'logger', types.SimpleNamespace(warning=lambda *args: warnings.append(args)))
    assert neighbours() is True
    assert neighbours() is True
    assert len(warnings) == 1
    assert 'utilisation' in warnings[0][0]


def test_a_failed_utilisation_read_is_tried_again(_nvml):
    """A utilisation error keeps the old rule for that listing only, even once the samples were trusted."""
    neighbours, nvml, clock = _nvml
    assert neighbours() is False
    nvml.fail = RuntimeError('busy driver')
    assert neighbours() is True
    nvml.fail = None
    assert neighbours() is False


def test_the_cuda_release_hands_the_cache_back():
    """The real release frees memory torch cached on a CUDA device."""
    torch = pytest.importorskip('torch')
    if not torch.cuda.is_available():
        pytest.skip('needs a CUDA device')
    block = torch.empty(64 << 20, dtype=torch.uint8, device='cuda:0')
    del block  # freed into this process's cache
    cached = torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0)
    assert cached >= 64 << 20

    budgetmod._cuda_release()()
    assert torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0) < 64 << 20


def test_the_cuda_workspace_set_up_keeps_large_blocks_releasable():
    """A workspace made by the first product sits in a freed large block and keeps it; one set up first does not."""
    torch = pytest.importorskip('torch')
    if not torch.cuda.is_available():
        pytest.skip('needs a CUDA device')
    big = 256 << 20

    def kept_mb(warm):
        """On a new stream, which gets a workspace of its own, free a large block, run a product, release.

        Args:
            warm: Sets up the workspace once the large block is free, as a thread entering late finds it, or None.

        Returns:
            The MB still reserved above the start.
        """
        torch.cuda.empty_cache()
        start = torch.cuda.memory_reserved(0)
        with torch.cuda.stream(torch.cuda.Stream(0)):
            block = torch.empty(big, dtype=torch.uint8, device='cuda:0')
            del block  # a large free block in this stream's cache
            if warm:
                warm()
            a = torch.ones(64, 64, device='cuda:0')
            (a @ a).sum().item()
            del a
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        return (torch.cuda.memory_reserved(0) - start) / (1 << 20)

    try:
        assert kept_mb(None) >= 256  # the workspace was carved from the large block
        assert kept_mb(budgetmod._cuda_warm('cuda:0')) < 64
    finally:
        torch._C._cuda_clearCublasWorkspaces()  # this test runs alone on the device
        torch.cuda.empty_cache()


def test_one_guard_per_device(monkeypatch):
    """``cuda`` and ``cuda:0`` share one guard; other devices get their own."""
    monkeypatch.setattr(budgetmod, 'is_model_server_enabled', lambda: False)
    monkeypatch.setattr(budgetmod, '_cuda_probe', lambda device: _Probe(free=1e6))
    monkeypatch.setattr(budgetmod, '_budgets', {})

    assert device_budget('cuda') is device_budget('cuda:0')
    assert device_budget('cuda:1') is not device_budget('cuda:0')
    assert device_budget('cpu') is device_budget('cpu')


def test_model_server_mode_is_a_no_op(monkeypatch):
    """With ``--modelserver`` the guard admits every call at once."""
    monkeypatch.setattr(budgetmod, 'is_model_server_enabled', lambda: True)
    guard = device_budget('cuda:0')
    held = [guard.reserve(None) for _ in range(8)]
    for cm in held:
        cm.__enter__()  # an exclusive call would block the second one if this were a real guard
    for cm in held:
        cm.__exit__(None, None, None)
