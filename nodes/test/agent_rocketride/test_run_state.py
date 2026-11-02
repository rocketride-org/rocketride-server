# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-run state: what one Wave run remembers, and its private view of memory.

One driver object serves every run of a node and runs can overlap, so per-run state
cannot live on the driver. One memory node can also serve several agents (a parent and
the child it calls as a tool both write ``wave-0.r0``), so each run gets its own key
space on the shared store.
"""

from __future__ import annotations

import threading
from concurrent.futures import Future
from contextlib import nullcontext

import pytest

WAIT = 10  # seconds; a bound for waits that should end at once


class Store:
    """The memory channel's three calls over a dict, as the memory node answers them.

    *stuck_keys* names keys whose clear raises. With *fail_writes*, every write stores
    its value and then raises.
    """

    def __init__(self, stuck_keys=(), fail_writes=False):
        self.data = {}
        self.stuck_keys = set(stuck_keys)
        self.fail_writes = fail_writes

    def put(self, key, value):
        self.data[key] = value
        if self.fail_writes:
            raise ConnectionError('lost the store after writing')
        return {'ok': True}

    def get(self, key):
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}

    def clear(self, key):
        if key.rsplit('/', 1)[-1] in self.stuck_keys:
            raise ConnectionError(f'cannot clear {key}')
        self.data.pop(key, None)
        return {'ok': True}


class HangingStore(Store):
    """A store whose writes wait for *release*. With *serial*, a clear waits behind a write."""

    def __init__(self, serial=False):
        super().__init__()
        self.writing, self.release = threading.Event(), threading.Event()
        self.lock = threading.Lock() if serial else None

    def put(self, key, value):
        with self.lock or nullcontext():
            self.writing.set()
            self.release.wait(timeout=30)
            return super().put(key, value)

    def clear(self, key):
        with self.lock or nullcontext():
            return super().clear(key)


class TrimmingStore(Store):
    """Trims the spaces around every key, as the memory node does."""

    def put(self, key, value):
        return super().put(key.strip(), value)

    def get(self, key):
        return super().get(key.strip())

    def clear(self, key):
        return super().clear(key.strip())


@pytest.fixture
def run_memory(wave):
    return wave.run_state.RunMemory


def test_two_runs_on_one_store_keep_their_own_values(run_memory):
    """A parent and a child writing the same key do not overwrite each other."""
    store = Store()
    parent, child = run_memory(store, 'run-parent'), run_memory(store, 'run-child')

    parent.put('wave-0.r0', 'parent data')
    child.put('wave-0.r0', 'child data')

    assert parent.get('wave-0.r0')['value'] == 'parent data'
    assert child.get('wave-0.r0')['value'] == 'child data'


def test_close_clears_only_this_runs_keys(run_memory):
    store = Store()
    store.put('someone-else', 1)
    run = run_memory(store, 'run-1')
    run.put('wave-0.r0', 'a')
    run.put('wave-0.r1', 'b')

    assert run.close() is True
    assert store.data == {'someone-else': 1}


def test_clear_all_means_this_run_only(run_memory):
    store = Store()
    store.put('someone-else', 1)
    run = run_memory(store, 'run-1')
    run.put('wave-0.r0', 'a')

    run.clear()

    assert store.data == {'someone-else': 1}
    assert run.list()['keys'] == []


def test_a_write_after_the_run_ends_is_refused(run_memory):
    """A tool that timed out and finishes later cannot leave its result behind."""
    store = Store()
    run = run_memory(store, 'run-1')
    run.close()

    assert run.put('wave-3.r0', 'late')['ok'] is False
    assert store.data == {}


def test_a_held_key_is_hidden_until_it_is_published(run_memory):
    """The wave has not decided to keep the result yet, so nothing can read it."""
    run = run_memory(Store(), 'run-1')
    run.hold('wave-0.r0')
    run.put('wave-0.r0', 'data')

    assert run.get('wave-0.r0')['ok'] is False
    assert run.list()['keys'] == []

    run.publish('wave-0.r0')

    assert run.get('wave-0.r0')['value'] == 'data'
    assert run.list()['keys'] == ['wave-0.r0']


def test_a_removed_key_is_hidden_at_once_and_deleted_at_close(run_memory):
    store = Store()
    run = run_memory(store, 'run-1')
    run.put('wave-0.r0', 'data')

    assert run.clear('wave-0.r0') == {'ok': True}
    assert run.get('wave-0.r0')['ok'] is False
    assert store.data == {'run-1/wave-0.r0': 'data'}, 'the store is not touched until the run ends'

    run.close()

    assert store.data == {}


def test_removing_a_key_does_not_wait_behind_a_hanging_write(run_memory):
    """The store takes one call at a time and a write hangs. A removal still returns at once."""
    store = HangingStore(serial=True)
    run = run_memory(store, 'run-1')
    writer = threading.Thread(target=run.put, args=('wave-1.r0', 'late'))
    writer.start()
    try:
        assert store.writing.wait(timeout=WAIT)
        remover = threading.Thread(target=run.clear, args=('wave-0.r0',))
        remover.start()
        remover.join(timeout=WAIT)
        assert not remover.is_alive(), 'the removal waited behind the hanging write'
    finally:
        store.release.set()
        writer.join(timeout=WAIT)


def test_close_keeps_going_when_a_key_will_not_clear(run_memory):
    """One key will not clear. close() still clears the rest, reports it, and does not raise."""
    store = Store(stuck_keys={'wave-0.r0'})
    run = run_memory(store, 'run-1')
    run.put('wave-0.r0', 'a')
    run.put('wave-0.r1', 'b')

    assert run.close() is False
    assert store.data == {'run-1/wave-0.r0': 'a'}


def test_a_write_that_fails_half_way_is_still_cleared(run_memory):
    """The store wrote the value and then failed. The key is still the run's to clear."""
    store = Store(fail_writes=True)
    run = run_memory(store, 'run-1')
    with pytest.raises(ConnectionError):
        run.put('wave-0.r0', 'a')

    run.close()

    assert store.data == {}


def test_close_does_not_wait_for_a_write_in_progress(run_memory):
    """A write that hangs cannot hold up the end of the run, and its value is cleared when it lands."""
    store = HangingStore()
    run = run_memory(store, 'run-1')
    late = {}
    writer = threading.Thread(target=lambda: late.update(result=run.put('wave-0.r0', 'late')))
    writer.start()
    try:
        assert store.writing.wait(timeout=WAIT)
        closer = threading.Thread(target=run.close)
        closer.start()
        closer.join(timeout=WAIT)
        assert not closer.is_alive(), 'close() waited for the hanging write'
    finally:
        store.release.set()
        writer.join(timeout=WAIT)

    assert late['result']['ok'] is False
    assert store.data == {}


def test_close_waits_for_a_store_that_is_busy(run_memory):
    """The store takes one call at a time and a write is slow. close() waits for it.

    Each clear is a call into the engine, and the run must not end while one is still
    running, so close() does not give up on a slow store.
    """
    store = HangingStore(serial=True)
    run = run_memory(store, 'run-1')
    writer = threading.Thread(target=run.put, args=('wave-0.r0', 'late'))
    writer.start()
    closed = []
    closer = threading.Thread(target=lambda: closed.append(run.close()))
    try:
        assert store.writing.wait(timeout=WAIT)
        closer.start()
        closer.join(timeout=0.3)
        assert closer.is_alive(), 'close() gave up on the busy store'
    finally:
        store.release.set()
        writer.join(timeout=WAIT)
        closer.join(timeout=WAIT)

    assert closed == [True]
    assert store.data == {}


def test_forget_drops_result_fingerprints_but_remembers_the_call(wave):
    """No duplicate note may name a removed key, but running a removed call again is worth pointing out."""
    state = wave.run_state.RunState(seen_results={'f1': 'wave-0.r0', 'f2': 'wave-0.r1'}, seen_calls={'c1': 'wave-0.r0'})

    state.forget(['wave-0.r0'])

    assert state.seen_results == {'f2': 'wave-0.r1'}
    assert state.seen_calls == {'c1': 'wave-0.r0'}
    assert state.removed == set(), 'a key counts as removed only once the removal is applied'


def test_background_calls_count_what_is_running_and_what_returned(wave):
    """The check guard reads both counts together, and the run waits on the same futures."""
    calls = wave.run_state.BackgroundCalls()
    stuck, finished = Future(), Future()
    finished.set_result('done')
    calls.add(stuck)
    calls.add(finished)

    assert calls.snapshot() == (1, 1)
    assert calls.wait(0) == 1

    stuck.set_result('late')

    assert calls.snapshot() == (0, 2)
    assert calls.running() == 0
    assert calls.wait(None) == 0


@pytest.mark.parametrize('alias', ['{} ', '{}\t', ' {}'])
def test_a_key_with_spaces_cannot_read_a_hidden_result(run_memory, alias):
    """The store trims keys, so to it 'wave-0.r0 ' is 'wave-0.r0'. Hiding treats them as one key too.

    Otherwise a removed result, or one the wave gave up on, could still reach a tool
    through a memory.ref tag with a trailing space.
    """
    run = run_memory(TrimmingStore(), 'run-1')
    run.put('wave-0.r0', 'removed data')
    run.clear('wave-0.r0')
    run.put('wave-0.r1', 'abandoned data')
    run.hold('wave-0.r1')

    assert run.get(alias.format('wave-0.r0'))['ok'] is False
    assert run.get(alias.format('wave-0.r1'))['ok'] is False
    run.publish(alias.format('wave-0.r1'))
    assert run.get('wave-0.r1')['value'] == 'abandoned data', 'publish matches the same key'
