# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Weaviate record update/delete scope behavior."""

from __future__ import annotations

import importlib.util
import sys
import time
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_STUB_MODULE_NAMES = ('numpy',)


def _install_stubs() -> None:
    """Install lightweight stubs so weaviate.py can be imported in isolation."""
    mod_numpy = types.ModuleType('numpy')
    sys.modules['numpy'] = mod_numpy


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Temporarily install stubs, restoring original modules on exit."""
    original_modules = {module_name: sys.modules.get(module_name) for module_name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for module_name, module in original_modules.items():
            if module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = module


def _load_store_class() -> type:
    """Load Weaviate Store class from source with temporary stubs."""
    with _scoped_stubs():
        root = Path(__file__).resolve().parents[3]
        mocks_path = root / 'nodes' / 'test' / 'mocks'
        weaviate_file = root / 'nodes' / 'src' / 'nodes' / 'store_weaviate' / 'weaviate.py'
        inserted = False
        if str(mocks_path) not in sys.path:
            sys.path.insert(0, str(mocks_path))
            inserted = True

        try:
            spec = importlib.util.spec_from_file_location('test_weaviate_store_module', weaviate_file)
            assert spec is not None
            assert spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.Store
        finally:
            if inserted and sys.path and sys.path[0] == str(mocks_path):
                sys.path.pop(0)


def _make_store(records: dict[str, dict]) -> tuple[object, object]:
    """Create a store instance with fake in-memory weaviate collection."""
    store_class = _load_store_class()

    root = Path(__file__).resolve().parents[3]
    mocks_path = root / 'nodes' / 'test' / 'mocks'
    inserted = False
    if str(mocks_path) not in sys.path:
        sys.path.insert(0, str(mocks_path))
        inserted = True

    try:
        import weaviate  # type: ignore

        collection = weaviate.MockCollection('test-weaviate-record-updates')
        collection._storage.clear()
        collection._storage.update(records)

        store = store_class.__new__(store_class)
        store.collectionObj = collection
        store.doesCollectionExist = lambda *_args, **_kwargs: True
        return store, collection
    finally:
        if inserted and sys.path and sys.path[0] == str(mocks_path):
            sys.path.pop(0)


def _make_obj_records(object_id: str, count: int, *, is_deleted: bool) -> dict[str, dict]:
    """
    Create mock Weaviate records keyed by ``f'{object_id}-{index}'``.

    Args:
        object_id: Object ID used for each generated record and key prefix.
        count: Number of records to generate.
        is_deleted: Deletion state assigned to each record.

    Returns:
        A ``dict[str, dict]`` where each value contains ``properties`` and ``vector`` keys.
    """
    return {
        f'{object_id}-{index}': {
            'properties': {
                'objectId': object_id,
                'isDeleted': is_deleted,
                'chunkId': index,
                'parent': f'/{object_id}',
                'content': f'chunk {index}',
            },
            'vector': [0.1, 0.2],
        }
        for index in range(count)
    }


@pytest.mark.parametrize(
    ('method_name', 'initial_is_deleted'),
    [
        ('remove', False),
        ('markDeleted', False),
        ('markActive', True),
    ],
)
def test_mutation_noop_for_empty_objectids(method_name: str, initial_is_deleted: bool) -> None:
    """Mutation methods should be a no-op for empty objectIds."""
    records = _make_obj_records('obj-1', 2, is_deleted=initial_is_deleted)
    records.update(_make_obj_records('obj-2', 1, is_deleted=initial_is_deleted))
    store, collection = _make_store(records)
    before_keys = sorted(collection._storage.keys())
    before_is_deleted = [record['properties']['isDeleted'] for record in collection._storage.values()]

    getattr(store, method_name)([])

    assert sorted(collection._storage.keys()) == before_keys
    after_is_deleted = [record['properties']['isDeleted'] for record in collection._storage.values()]
    assert after_is_deleted == before_is_deleted


@pytest.mark.parametrize(
    (
        'method_name',
        'initial_is_deleted',
        'expected_obj1_is_deleted',
        'expected_obj2_is_deleted',
        'expected_remaining_object_ids',
    ),
    [
        ('remove', False, [], [False], ['obj-2']),
        ('markDeleted', False, [True, True], [False], ['obj-1', 'obj-1', 'obj-2']),
        ('markActive', True, [False, False], [True], ['obj-1', 'obj-1', 'obj-2']),
    ],
)
def test_mutation_updates_only_matching_object_ids(
    method_name: str,
    initial_is_deleted: bool,
    expected_obj1_is_deleted: list[bool],
    expected_obj2_is_deleted: list[bool],
    expected_remaining_object_ids: list[str],
) -> None:
    """Mutation methods should only affect records matching target objectIds."""
    records = _make_obj_records('obj-1', 2, is_deleted=initial_is_deleted)
    records.update(_make_obj_records('obj-2', 1, is_deleted=initial_is_deleted))
    store, collection = _make_store(records)

    getattr(store, method_name)(['obj-1'])

    remaining_object_ids = [record['properties']['objectId'] for record in collection._storage.values()]
    assert remaining_object_ids == expected_remaining_object_ids

    obj1 = [
        record['properties']['isDeleted']
        for record in collection._storage.values()
        if record['properties']['objectId'] == 'obj-1'
    ]
    obj2 = [
        record['properties']['isDeleted']
        for record in collection._storage.values()
        if record['properties']['objectId'] == 'obj-2'
    ]
    assert obj1 == expected_obj1_is_deleted
    assert obj2 == expected_obj2_is_deleted


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_drains_capped_pages_for_multiple_documents(monkeypatch, method, initial):
    """A short response is not the last page; already updated chunks must not repeat."""
    records = _make_obj_records('a', 62, is_deleted=initial)
    records.update(_make_obj_records('b', 42, is_deleted=initial))
    records.update(_make_obj_records('already-done', 2, is_deleted=not initial))
    records.update(_make_obj_records('untouched', 3, is_deleted=initial))
    store, collection = _make_store(records)
    fetch = collection.query.fetch_objects
    calls = []

    def capped_fetch(**kwargs):
        calls.append(kwargs)
        assert len(calls) <= 10, 'mutation is not making progress'
        kwargs['limit'] = min(kwargs.get('limit', 100), 25)
        return fetch(**kwargs)

    monkeypatch.setattr(collection.query, 'fetch_objects', capped_fetch)
    getattr(store, method)(['a', 'b', 'already-done', 'missing'])

    assert len(calls) == 6  # five data pages, then an empty page
    for record in collection._storage.values():
        meta = record['properties']
        assert meta['isDeleted'] is (initial if meta['objectId'] == 'untouched' else not initial)


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_stops_when_an_update_does_not_persist(monkeypatch, method, initial):
    """A page that leaves the pending count where it was is a stall; the third stall in a row ends the drain."""
    store, collection = _make_store(_make_obj_records('a', 3, is_deleted=initial))
    fetch = collection.query.fetch_objects
    fetches = []

    def counted_fetch(**kwargs):
        fetches.append(kwargs)
        assert len(fetches) <= 4, 'the drain is looping on chunks whose update did not persist'
        return fetch(**kwargs)

    monkeypatch.setattr(collection.query, 'fetch_objects', counted_fetch)
    attempts = []
    monkeypatch.setattr(collection.data, 'update', lambda uuid, properties: attempts.append(uuid))
    pauses = []
    monkeypatch.setattr(time, 'sleep', pauses.append)

    with pytest.raises(Exception, match='did not persist on 3 chunk.*retry'):
        getattr(store, method)(['a'])

    assert len(fetches) == 3  # the page and two tolerated stalls; the third stall stops the drain
    assert len(attempts) == 9  # each chunk sent on each of the three pages
    assert pauses == [1.0, 1.0]  # after each tolerated stall


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_resends_once_when_an_update_does_not_show(monkeypatch, method, initial):
    """A lost write still leaves the count lower than before, so the next page re-sends it without a pause."""
    store, collection = _make_store(_make_obj_records('a', 3, is_deleted=initial))
    real_update = collection.data.update
    attempts = {}
    pauses = []
    monkeypatch.setattr(time, 'sleep', pauses.append)

    def update_losing_the_first_write_to_a1(uuid, properties):
        attempts[uuid] = attempts.get(uuid, 0) + 1
        if uuid != 'a-1' or attempts[uuid] > 1:
            real_update(uuid=uuid, properties=properties)

    monkeypatch.setattr(collection.data, 'update', update_losing_the_first_write_to_a1)

    getattr(store, method)(['a'])

    assert attempts == {'a-0': 1, 'a-1': 2, 'a-2': 1}
    assert pauses == []
    assert all(record['properties']['isDeleted'] is (not initial) for record in collection._storage.values())


class _Replica:
    """Reads through a lagging replica: pages capped at ``page``, writes visible ``lag`` seconds late.

    Time is a fake clock that each read moves on by 10 ms and ``time.sleep`` by
    its argument. Updates to a chunk in ``never`` are dropped, and ``rotate``
    turns each page so consecutive pages lead with different chunks. The fetch
    bound makes a drain that loops fail instead of hang.
    """

    def __init__(self, monkeypatch, collection, *, page, max_fetches, lag=0.0, never=(), rotate=False):
        self.now = 0.0
        self.fetches = 0
        self.attempts = []
        self.pauses = []
        self._queue = []  # (visible at, uuid, properties)
        fetch = collection.query.fetch_objects
        count = collection.aggregate.over_all
        apply = collection.data.update

        def settle():
            self.now += 0.01
            due = [item for item in self._queue if item[0] <= self.now]
            self._queue = [item for item in self._queue if item[0] > self.now]
            for _, uuid, properties in due:
                apply(uuid=uuid, properties=properties)

        def capped_fetch(filters=None, limit=100, offset=0):
            self.fetches += 1
            assert self.fetches <= max_fetches, 'the drain is looping'
            settle()
            result = fetch(filters=filters, limit=len(collection._storage) + 1)
            objects = result.objects
            if rotate and objects:
                turn = self.fetches % len(objects)
                objects = objects[turn:] + objects[:turn]
            result.objects = objects[: min(limit, page)]
            return result

        def counted(filters=None, total_count=False):
            settle()
            return count(filters=filters, total_count=total_count)

        def lagging_update(uuid, properties):
            self.attempts.append(uuid)
            if uuid not in never:
                self._queue.append((self.now + lag, uuid, dict(properties)))

        def sleep(seconds):
            self.pauses.append(seconds)
            self.now += seconds

        monkeypatch.setattr(collection.query, 'fetch_objects', capped_fetch)
        monkeypatch.setattr(collection.aggregate, 'over_all', counted)
        monkeypatch.setattr(collection.data, 'update', lagging_update)
        monkeypatch.setattr(time, 'sleep', sleep)


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_fails_on_alternating_stuck_pages(monkeypatch, method, initial):
    """Two chunks that never persist come back on alternate pages; the count does not drop, so the drain stops."""
    store, collection = _make_store(_make_obj_records('a', 2, is_deleted=initial))
    replica = _Replica(monkeypatch, collection, page=1, max_fetches=6, never={'a-0', 'a-1'}, rotate=True)

    with pytest.raises(Exception, match='did not persist on 2 chunk.*retry'):
        getattr(store, method)(['a'])

    assert replica.attempts[0] != replica.attempts[1]  # consecutive pages show different chunks
    assert replica.fetches == 3
    assert replica.pauses == [1.0, 1.0]


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_flips_the_rest_when_one_chunk_is_stuck(monkeypatch, method, initial):
    """One chunk among many never persists: every other chunk is updated, then the drain fails on that one."""
    records = _make_obj_records('a', 3, is_deleted=initial)
    records.update(_make_obj_records('b', 3, is_deleted=initial))
    store, collection = _make_store(records)
    replica = _Replica(monkeypatch, collection, page=2, max_fetches=12, never={'a-1'})

    with pytest.raises(Exception, match='did not persist on 1 chunk.*retry'):
        getattr(store, method)(['a', 'b'])

    for uuid, record in collection._storage.items():
        assert record['properties']['isDeleted'] is (initial if uuid == 'a-1' else not initial)
    assert replica.fetches <= 8
    assert replica.pauses == [1.0, 1.0]


@pytest.mark.parametrize('method, initial', [('markDeleted', False), ('markActive', True)])
def test_trash_completes_on_a_replica_that_shows_writes_late(monkeypatch, method, initial):
    """A healthy replica that shows each write 1.5 s late stalls a page at a time but finishes the drain."""
    store, collection = _make_store(_make_obj_records('a', 250, is_deleted=initial))
    replica = _Replica(monkeypatch, collection, page=100, max_fetches=20, lag=1.5)

    getattr(store, method)(['a'])

    assert all(record['properties']['isDeleted'] is (not initial) for record in collection._storage.values())
    assert replica.pauses and set(replica.pauses) == {1.0}


def test_trash_round_trip_removes_paths_and_keeps_parent_filter():
    """Directory listings hide trash before paging and show it again after restore."""
    records = _make_obj_records('a', 2, is_deleted=False)
    records.update(_make_obj_records('b', 1, is_deleted=False))
    records.update(_make_obj_records('schema', 1, is_deleted=True))
    store, _ = _make_store(records)
    store.markDeleted(['a'])
    assert store.getPaths(limit=1) == {'/b': 'b'}
    assert store.getPaths(parent='/a') == {}
    store.markActive(['a'])
    assert store.getPaths(parent='/a') == {'/a': 'a'}
    assert store.getPaths(offset=1, limit=1) == {'/b': 'b'}
