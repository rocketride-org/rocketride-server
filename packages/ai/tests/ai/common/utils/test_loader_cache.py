# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.loader_cache.LoaderCache``: one load per model id
while any control holds it, freed when the last control releases it.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_loader_cache.py -v
"""

from __future__ import annotations

import threading
import time
import weakref

import pytest

from ai.common.utils import LoaderCache


class _Model:
    """A stand-in handle that can be weak-referenced."""


def test_two_controls_naming_one_model_share_one_load():
    cache = LoaderCache()
    loads = []
    first = cache.acquire('m', lambda: loads.append(1) or _Model())
    second = cache.acquire('m', lambda: loads.append(2) or _Model())
    assert first is second
    assert loads == [1]


def test_the_handle_is_dropped_when_the_last_control_releases_it():
    cache = LoaderCache()
    handle = cache.acquire('a', _Model)
    cache.acquire('a', _Model)
    ref = weakref.ref(handle)
    del handle

    cache.release('a')
    assert ref() is not None, 'one control still holds the model'

    cache.release('a')
    assert ref() is None, 'an idle model must not stay resident'


def test_a_released_model_frees_its_place_for_the_next_one():
    # Model A ends with its control; model B then loads with A no longer resident.
    cache = LoaderCache()
    a = weakref.ref(cache.acquire('a', _Model))
    cache.release('a')
    cache.acquire('b', _Model)
    assert a() is None


def test_a_model_loads_again_after_it_was_released():
    cache = LoaderCache()
    first = cache.acquire('m', _Model)
    cache.release('m')
    second = cache.acquire('m', _Model)
    assert first is not second


def test_releasing_an_unheld_id_does_nothing():
    cache = LoaderCache()
    cache.release('never')
    assert cache.acquire('never', _Model) is not None


def test_a_failed_load_caches_and_counts_nothing():
    cache = LoaderCache()

    def boom():
        raise RuntimeError('no weights')

    with pytest.raises(RuntimeError):
        cache.acquire('m', boom)
    handle = cache.acquire('m', _Model)
    cache.release('m')
    assert cache.acquire('m', _Model) is not handle


def _run_all(targets):
    """Run each callable on its own thread; return their results in order, re-raising any failure here."""
    results = [None] * len(targets)
    errors = []

    def run(index, target):
        try:
            results[index] = target()
        except BaseException as e:  # noqa: BLE001 - forwarded to the test thread, pytest outcomes included
            errors.append(e)

    threads = [threading.Thread(target=run, args=(i, target)) for i, target in enumerate(targets)]
    for thread in threads:
        thread.start()
    return threads, results, errors


def _join(threads, errors):
    """Join every worker, then re-raise the first failure on the test thread."""
    for thread in threads:
        thread.join(5)
        assert not thread.is_alive(), 'a worker did not finish'
    if errors:
        raise errors[0]


def _wait_for(predicate):
    """Wait (bounded) until ``predicate()`` holds."""
    deadline = time.monotonic() + 5
    while not predicate():
        assert time.monotonic() < deadline, 'condition never held'
        time.sleep(0.001)


def test_concurrent_acquires_of_one_id_load_once():
    cache = LoaderCache()
    started = threading.Event()
    loads = []

    def slow():
        loads.append(1)
        started.wait(1)
        return _Model()

    threads, results, errors = _run_all([lambda: cache.acquire('m', slow) for _ in range(4)])
    started.set()
    _join(threads, errors)
    assert len(results) == 4 and all(r is not None for r in results)
    assert len({id(r) for r in results}) == 1
    assert loads == [1]


def test_a_waiting_acquire_survives_the_last_release_and_a_third_acquire_shares_its_load():
    cache = LoaderCache()
    loads = []

    def load():
        loads.append(1)
        return _Model()

    # A holds the model; a load in progress is simulated by holding the slot's lock.
    first = cache.acquire('m', load)
    slot = cache._slots['m']
    slot.lock.acquire()
    try:
        # W captures the slot and waits on its lock.
        threads, results, errors = _run_all([lambda: cache.acquire('m', load)])
        _wait_for(lambda: slot.pending == 1)

        # A's control ends: the last release drops the handle, but W keeps the slot.
        cache.release('m')
        assert cache._slots.get('m') is slot

        # A third acquire finds the same slot and waits on the same lock.
        more, more_results, more_errors = _run_all([lambda: cache.acquire('m', load)])
        _wait_for(lambda: slot.pending == 2)
    finally:
        slot.lock.release()
    _join(threads + more, errors + more_errors)

    # One reload, shared by both waiters, with both counted as holders.
    assert loads == [1, 1]
    assert results[0] is more_results[0] is not first
    assert slot.users == 2
    cache.release('m')
    assert cache._slots.get('m') is slot
    cache.release('m')
    assert 'm' not in cache._slots
