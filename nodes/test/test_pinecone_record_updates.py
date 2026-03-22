# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Pinecone record update/delete coverage."""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_STUB_MODULE_NAMES = (
    'depends',
    'pinecone',
    'pinecone.grpc',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
)


def _install_stubs() -> None:
    """Install lightweight stubs so pinecone.py can be imported in isolation."""
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_args, **_kwargs: None
    sys.modules['depends'] = mod_depends

    mod_pinecone = types.ModuleType('pinecone')

    class ServerlessSpec:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    class PodSpec:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    mod_pinecone.ServerlessSpec = ServerlessSpec
    mod_pinecone.PodSpec = PodSpec
    sys.modules['pinecone'] = mod_pinecone

    mod_pinecone_grpc = types.ModuleType('pinecone.grpc')

    class PineconeGRPC:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    mod_pinecone_grpc.PineconeGRPC = PineconeGRPC
    sys.modules['pinecone.grpc'] = mod_pinecone_grpc

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
        def __init__(self, *_args: object, **_kwargs: object) -> None:
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
    """Load Pinecone Store class from source with temporary stubs."""
    with _scoped_stubs():
        root = Path(__file__).resolve().parents[2]
        pinecone_file = root / 'nodes' / 'src' / 'nodes' / 'pinecone' / 'pinecone.py'
        spec = importlib.util.spec_from_file_location('test_pinecone_store_module', pinecone_file)
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Store


class _FakeIndex:
    """In-memory Pinecone-like index used for deterministic regression tests."""

    def __init__(self, records: dict[str, dict]) -> None:
        self.records = records
        self.query_calls = 0
        self.delete_calls = 0
        self.update_calls = 0

    def describe_index_stats(self) -> dict[str, int]:
        return {'dimension': 3}

    def query(
        self,
        vector: list[float],
        top_k: int = 10,
        filter_expr: dict | None = None,
        include_metadata: bool = False,
        include_values: bool = False,
        **kwargs: object,
    ) -> dict[str, list[dict[str, str]]]:
        self.query_calls += 1
        if filter_expr is None:
            filter_expr = kwargs.get('filter')

        matches = [{'id': record_id} for record_id, record in self.records.items() if self._matches_filter(record['metadata'], filter_expr)]
        return {'matches': matches[:top_k]}

    def delete(self, ids: list[str] | None = None, filter_expr: dict | None = None, **kwargs: object) -> None:
        self.delete_calls += 1

        if filter_expr is None:
            filter_expr = kwargs.get('filter')

        if filter_expr is not None:
            doomed_ids = [record_id for record_id, record in self.records.items() if self._matches_filter(record['metadata'], filter_expr)]
            for record_id in doomed_ids:
                self.records.pop(record_id, None)
            return

        if ids is not None:
            for record_id in ids:
                self.records.pop(record_id, None)

    def update(self, record_id: str | None = None, set_metadata: dict | None = None, **kwargs: object) -> None:
        self.update_calls += 1
        if record_id is None:
            record_id = kwargs.get('id')

        if record_id in self.records and set_metadata:
            self.records[record_id]['metadata'].update(set_metadata)

    def _matches_filter(self, metadata: dict, filter_expr: dict | None) -> bool:
        if not filter_expr:
            return True

        if '$and' in filter_expr:
            return all(self._matches_filter(metadata, entry) for entry in filter_expr['$and'])
        if '$or' in filter_expr:
            return any(self._matches_filter(metadata, entry) for entry in filter_expr['$or'])

        for field_name, condition in filter_expr.items():
            value = metadata.get(field_name)
            if isinstance(condition, dict):
                for operator, expected in condition.items():
                    if operator == '$in':
                        if value not in expected:
                            return False
                    elif operator == '$eq':
                        if value != expected:
                            return False
                    elif operator == '$ne':
                        if value == expected:
                            return False
                    elif operator == '$gt':
                        if value is None or value <= expected:
                            return False
                    elif operator == '$gte':
                        if value is None or value < expected:
                            return False
                    elif operator == '$lt':
                        if value is None or value >= expected:
                            return False
                    elif operator == '$lte':
                        if value is None or value > expected:
                            return False
                    else:
                        raise AssertionError(f'Unsupported operator in fake filter: {operator}')
            elif value != condition:
                return False

        return True


class _FakeClient:
    def __init__(self, index: _FakeIndex) -> None:
        self.index = index

    def Index(self, _collection: str) -> _FakeIndex:
        return self.index


def _make_store(records: dict[str, dict]) -> tuple[object, _FakeIndex]:
    """Create a store instance with fake Pinecone client/index."""
    store_class = _load_store_class()
    fake_index = _FakeIndex(records)
    store = store_class.__new__(store_class)
    store.collection = 'test-index'
    store.client = _FakeClient(fake_index)
    store.doesCollectionExist = lambda *_args, **_kwargs: True
    return store, fake_index


def _make_obj_records(object_id: str, count: int, is_deleted: bool) -> dict[str, dict]:
    return {f'{object_id}-{index}': {'metadata': {'objectId': object_id, 'isDeleted': is_deleted}} for index in range(count)}


def test_remove_deletes_all_matching_chunks() -> None:
    """remove() should delete every vector that matches the objectIds filter."""
    records = _make_obj_records('obj-1', 1001, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))

    store, _ = _make_store(records)

    store.remove(['obj-1'])

    remaining_obj1 = [record_id for record_id, record in store.client.index.records.items() if record['metadata'].get('objectId') == 'obj-1']
    remaining_obj2 = [record_id for record_id, record in store.client.index.records.items() if record['metadata'].get('objectId') == 'obj-2']
    assert remaining_obj1 == []
    assert remaining_obj2 != []


def test_mark_deleted_updates_all_matching_chunks() -> None:
    """markDeleted() should flip isDeleted for all vectors of the target object."""
    records = _make_obj_records('obj-1', 1001, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))

    store, fake_index = _make_store(records)

    store.markDeleted(['obj-1'])

    obj1_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-1']
    obj2_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-2']
    assert len(obj1_values) == 1001
    assert all(obj1_values)
    assert obj2_values == [False]
    assert fake_index.query_calls >= 2


def test_mark_active_updates_all_matching_chunks() -> None:
    """markActive() should clear isDeleted for all vectors of the target object."""
    records = _make_obj_records('obj-1', 1001, is_deleted=True)
    records.update(_make_obj_records('obj-2', 1, is_deleted=True))

    store, fake_index = _make_store(records)

    store.markActive(['obj-1'])

    obj1_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-1']
    obj2_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-2']
    assert len(obj1_values) == 1001
    assert not any(obj1_values)
    assert obj2_values == [True]
    assert fake_index.query_calls >= 2


def test_update_records_noop_for_empty_objectids() -> None:
    """updateRecords() should not query/update/delete when objectIds is empty."""
    store, fake_index = _make_store(
        {
            'a': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
        }
    )

    store.updateRecords([], {'isDeleted': True})
    store.updateRecords([], isDeleteOperation=True)

    assert fake_index.query_calls == 0
    assert fake_index.delete_calls == 0
    assert fake_index.update_calls == 0


def test_matches_filter_supports_numeric_comparison_operators() -> None:
    """_matches_filter() should honor $gt/$gte/$lt/$lte for numeric metadata."""
    fake_index = _FakeIndex({})
    metadata = {'chunkId': 5, 'objectId': 'obj-1'}

    assert fake_index._matches_filter(metadata, {'chunkId': {'$gt': 4}})
    assert fake_index._matches_filter(metadata, {'chunkId': {'$gte': 5}})
    assert fake_index._matches_filter(metadata, {'chunkId': {'$lt': 6}})
    assert fake_index._matches_filter(metadata, {'chunkId': {'$lte': 5}})

    assert not fake_index._matches_filter(metadata, {'chunkId': {'$gt': 5}})
    assert not fake_index._matches_filter(metadata, {'chunkId': {'$gte': 6}})
    assert not fake_index._matches_filter(metadata, {'chunkId': {'$lt': 5}})
    assert not fake_index._matches_filter(metadata, {'chunkId': {'$lte': 4}})

    assert not fake_index._matches_filter({'objectId': 'obj-1'}, {'chunkId': {'$gte': 0}})


def test_matches_filter_supports_mixed_range_and_logical_conditions() -> None:
    """_matches_filter() should compose numeric comparisons under $and/$or."""
    fake_index = _FakeIndex({})
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

    assert fake_index._matches_filter({'objectId': 'obj-1', 'chunkId': 2}, filter_expr)
    assert fake_index._matches_filter({'objectId': 'obj-1', 'chunkId': 9}, filter_expr)
    assert not fake_index._matches_filter({'objectId': 'obj-1', 'chunkId': 5}, filter_expr)
    assert not fake_index._matches_filter({'objectId': 'obj-2', 'chunkId': 2}, filter_expr)


def test_matches_filter_rejects_unknown_operator() -> None:
    """_matches_filter() should fail loudly on unsupported operators."""
    fake_index = _FakeIndex({})

    with pytest.raises(AssertionError, match='Unsupported operator'):
        fake_index._matches_filter({'chunkId': 5}, {'chunkId': {'$contains': 5}})
