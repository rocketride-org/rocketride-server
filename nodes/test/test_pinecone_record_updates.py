# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Pinecone record update/delete coverage.

Uses the project's existing MockPinecone/MockIndex infrastructure from
nodes/test/mocks/pinecone/ rather than custom fakes.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# ---------------------------------------------------------------------------
# Module stubs required to import pinecone.py in isolation
# ---------------------------------------------------------------------------

_ROOT = Path(__file__).resolve().parents[2]
_MOCKS_DIR = _ROOT / 'nodes' / 'test' / 'mocks'

_STUB_MODULE_NAMES = (
    'depends',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'pinecone',
    'pinecone.grpc',
)


def _install_stubs() -> None:
    """Install lightweight stubs so pinecone.py can be imported in isolation.

    The pinecone/pinecone.grpc modules are resolved via sys.path from the
    existing mock infrastructure instead of being stubbed inline.
    """
    # depends -- no-op
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_a, **_kw: None
    sys.modules['depends'] = mod_depends

    # ai.common.* stubs
    ai_pkg = types.ModuleType('ai')
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []
    schema_mod = types.ModuleType('ai.common.schema')
    store_mod = types.ModuleType('ai.common.store')
    config_mod = types.ModuleType('ai.common.config')

    class Doc:
        pass

    class DocFilter:
        pass

    class DocMetadata:
        pass

    class QuestionText:
        pass

    class DocumentStoreBase:
        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

    class Config:
        @staticmethod
        def getNodeConfig(_provider: object, _connConfig: object) -> dict:
            return {}

    schema_mod.Doc = Doc
    schema_mod.DocFilter = DocFilter
    schema_mod.DocMetadata = DocMetadata
    schema_mod.QuestionText = QuestionText
    store_mod.DocumentStoreBase = DocumentStoreBase
    config_mod.Config = Config

    sys.modules['ai'] = ai_pkg
    sys.modules['ai.common'] = common_pkg
    sys.modules['ai.common.schema'] = schema_mod
    sys.modules['ai.common.store'] = store_mod
    sys.modules['ai.common.config'] = config_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Temporarily install stubs, restoring original modules on exit."""
    saved = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    saved_path = list(sys.path)
    # Let import pinecone resolve to the project mock
    sys.path.insert(0, str(_MOCKS_DIR))
    _install_stubs()
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod
        # Clean up mock pinecone modules that were loaded via sys.path
        for name in ('pinecone', 'pinecone.grpc'):
            if name not in saved:
                sys.modules.pop(name, None)


def _load_store_module() -> types.ModuleType:
    """Load the Pinecone Store module from source with temporary stubs."""
    with _scoped_stubs():
        pinecone_file = _ROOT / 'nodes' / 'src' / 'nodes' / 'pinecone' / 'pinecone.py'
        spec = importlib.util.spec_from_file_location('test_pinecone_store_module', pinecone_file)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


# Load once at module level -- stubs are scoped and cleaned up automatically.
_store_module = _load_store_module()
Store = _store_module.Store


def _load_mock_pinecone_types() -> tuple[type, type]:
    """Import the project Pinecone mock without leaking module state."""
    saved = {name: sys.modules.get(name) for name in ('pinecone', 'pinecone.grpc')}
    sys.path.insert(0, str(_MOCKS_DIR))
    try:
        from pinecone import MockPinecone, MockIndex  # noqa: E402

        return MockPinecone, MockIndex
    finally:
        sys.path.remove(str(_MOCKS_DIR))
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


MockPinecone, MockIndex = _load_mock_pinecone_types()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INDEX_NAME = 'test-index'
_DIMENSION = 3


def _make_obj_vectors(object_id: str, count: int, *, is_deleted: bool) -> list[dict]:
    """Build a list of upsert-ready vector dicts for a single objectId."""
    return [
        {
            'id': f'{object_id}-{i}',
            'values': [1.0] * _DIMENSION,
            'metadata': {'objectId': object_id, 'isDeleted': is_deleted},
        }
        for i in range(count)
    ]


def _make_store(vectors: list[dict]) -> tuple[object, MockIndex]:
    """Create a Store wired to MockPinecone with pre-seeded vectors."""
    MockPinecone.reset()

    client = MockPinecone(api_key='test-key')
    client.create_index(name=_INDEX_NAME, dimension=_DIMENSION, metric='cosine')

    index = client.Index(_INDEX_NAME)
    if vectors:
        index.upsert(vectors)

    store = Store.__new__(Store)
    store.collection = _INDEX_NAME
    store.client = client
    store.doesCollectionExist = lambda *_a, **_kw: True
    return store, index


def _get_records(index: MockIndex) -> dict[str, dict]:
    """Return the raw storage dict for the test index."""
    return MockIndex._all_storage.get(_INDEX_NAME, {})


# ---------------------------------------------------------------------------
# Tests -- record mutation coverage
# ---------------------------------------------------------------------------


def test_remove_deletes_all_matching_chunks() -> None:
    """remove() should delete every vector that matches the objectIds filter."""
    vectors = _make_obj_vectors('obj-1', 1001, is_deleted=False)
    vectors += _make_obj_vectors('obj-2', 1, is_deleted=False)

    store, index = _make_store(vectors)
    store.remove(['obj-1'])

    records = _get_records(index)
    remaining_obj1 = [rid for rid, r in records.items() if r['metadata'].get('objectId') == 'obj-1']
    remaining_obj2 = [rid for rid, r in records.items() if r['metadata'].get('objectId') == 'obj-2']
    assert remaining_obj1 == []
    assert remaining_obj2 != []


def test_mark_deleted_updates_all_matching_chunks() -> None:
    """markDeleted() should flip isDeleted for all vectors of the target object."""
    vectors = _make_obj_vectors('obj-1', 1001, is_deleted=False)
    vectors += _make_obj_vectors('obj-2', 1, is_deleted=False)

    store, index = _make_store(vectors)
    store.markDeleted(['obj-1'])

    records = _get_records(index)
    obj1_values = [r['metadata']['isDeleted'] for r in records.values() if r['metadata'].get('objectId') == 'obj-1']
    obj2_values = [r['metadata']['isDeleted'] for r in records.values() if r['metadata'].get('objectId') == 'obj-2']
    assert len(obj1_values) == 1001
    assert all(obj1_values)
    assert obj2_values == [False]


def test_mark_active_updates_all_matching_chunks() -> None:
    """markActive() should clear isDeleted for all vectors of the target object."""
    vectors = _make_obj_vectors('obj-1', 1001, is_deleted=True)
    vectors += _make_obj_vectors('obj-2', 1, is_deleted=True)

    store, index = _make_store(vectors)
    store.markActive(['obj-1'])

    records = _get_records(index)
    obj1_values = [r['metadata']['isDeleted'] for r in records.values() if r['metadata'].get('objectId') == 'obj-1']
    obj2_values = [r['metadata']['isDeleted'] for r in records.values() if r['metadata'].get('objectId') == 'obj-2']
    assert len(obj1_values) == 1001
    assert not any(obj1_values)
    assert obj2_values == [True]


def test_update_records_noop_for_empty_objectids() -> None:
    """updateRecords() should not touch the index when objectIds is empty."""
    vectors = _make_obj_vectors('obj-1', 1, is_deleted=False)
    store, index = _make_store(vectors)

    store.updateRecords([], {'isDeleted': True})
    store.updateRecords([], isDeleteOperation=True)

    records = _get_records(index)
    assert len(records) == 1
    assert records['obj-1-0']['metadata']['isDeleted'] is False


# ---------------------------------------------------------------------------
# Tests -- MockIndex filter operator coverage
# ---------------------------------------------------------------------------


def test_matches_filter_supports_numeric_comparison_operators() -> None:
    """MockIndex._matches_filter() should honor $gt/$gte/$lt/$lte for numeric metadata."""
    index = MockIndex('filter-test')
    metadata = {'chunkId': 5, 'objectId': 'obj-1'}

    assert index._matches_filter(metadata, {'chunkId': {'$gt': 4}})
    assert index._matches_filter(metadata, {'chunkId': {'$gte': 5}})
    assert index._matches_filter(metadata, {'chunkId': {'$lt': 6}})
    assert index._matches_filter(metadata, {'chunkId': {'$lte': 5}})

    assert not index._matches_filter(metadata, {'chunkId': {'$gt': 5}})
    assert not index._matches_filter(metadata, {'chunkId': {'$gte': 6}})
    assert not index._matches_filter(metadata, {'chunkId': {'$lt': 5}})
    assert not index._matches_filter(metadata, {'chunkId': {'$lte': 4}})

    assert not index._matches_filter({'objectId': 'obj-1'}, {'chunkId': {'$gte': 0}})


def test_matches_filter_supports_mixed_range_and_logical_conditions() -> None:
    """MockIndex._matches_filter() should compose numeric comparisons under $and/$or."""
    index = MockIndex('filter-test')
    filter_expr = {
        '$and': [
            {'objectId': {'$eq': 'obj-1'}},
            {
                '$or': [
                    {'chunkId': {'$lt': 3}},
                    {'chunkId': {'$gt': 8}},
                ]
            },
        ]
    }

    assert index._matches_filter({'objectId': 'obj-1', 'chunkId': 2}, filter_expr)
    assert index._matches_filter({'objectId': 'obj-1', 'chunkId': 9}, filter_expr)
    assert not index._matches_filter({'objectId': 'obj-1', 'chunkId': 5}, filter_expr)
    assert not index._matches_filter({'objectId': 'obj-2', 'chunkId': 2}, filter_expr)


def test_matches_filter_supports_ne_operator() -> None:
    """MockIndex._matches_filter() should honor $ne for metadata values."""
    index = MockIndex('filter-test')

    assert index._matches_filter({'isDeleted': False}, {'isDeleted': {'$ne': True}})
    assert not index._matches_filter({'isDeleted': True}, {'isDeleted': {'$ne': True}})
