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


def test_concurrent_acquires_of_one_id_load_once():
    cache = LoaderCache()
    started = threading.Event()
    loads = []

    def slow():
        loads.append(1)
        started.wait(1)
        return _Model()

    results = []
    threads = [threading.Thread(target=lambda: results.append(cache.acquire('m', slow))) for _ in range(4)]
    for t in threads:
        t.start()
    started.set()
    for t in threads:
        t.join()
    assert loads == [1]
    assert len({id(r) for r in results}) == 1
