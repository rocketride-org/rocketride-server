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

    def query(self, vector: list[float], top_k: int = 10, filter: dict | None = None, include_metadata: bool = False, include_values: bool = False) -> dict[str, list[dict[str, str]]]:
        self.query_calls += 1
        matches = [{'id': record_id} for record_id, record in self.records.items() if self._matches_filter(record['metadata'], filter)]
        return {'matches': matches[:top_k]}

    def delete(self, ids: list[str] | None = None, filter: dict | None = None) -> None:
        self.delete_calls += 1

        if filter is not None:
            wanted = set(filter.get('objectId', {}).get('$in', []))
            doomed_ids = [record_id for record_id, record in self.records.items() if record['metadata'].get('objectId') in wanted]
            for record_id in doomed_ids:
                self.records.pop(record_id, None)
            return

        if ids is not None:
            for record_id in ids:
                self.records.pop(record_id, None)

    def update(self, id: str, set_metadata: dict | None = None) -> None:
        self.update_calls += 1
        if id in self.records and set_metadata:
            self.records[id]['metadata'].update(set_metadata)

    def _matches_filter(self, metadata: dict, filter_expr: dict | None) -> bool:
        if not filter_expr:
            return True

        if '$and' in filter_expr:
            return all(self._matches_filter(metadata, entry) for entry in filter_expr['$and'])

        for field_name, condition in filter_expr.items():
            value = metadata.get(field_name)
            if isinstance(condition, dict):
                for operator, expected in condition.items():
                    if operator == '$in' and value not in expected:
                        return False
                    if operator == '$eq' and value != expected:
                        return False
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


def test_remove_deletes_all_matching_chunks() -> None:
    """remove() should delete every vector that matches the objectIds filter."""
    store, _ = _make_store(
        {
            'a': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'b': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'c': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'd': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'e': {'metadata': {'objectId': 'obj-2', 'isDeleted': False}},
        }
    )

    store.remove(['obj-1'])

    remaining_obj1 = [record_id for record_id, record in store.client.index.records.items() if record['metadata'].get('objectId') == 'obj-1']
    assert remaining_obj1 == []


def test_mark_deleted_updates_all_matching_chunks() -> None:
    """markDeleted() should flip isDeleted for all vectors of the target object."""
    store, _ = _make_store(
        {
            'a': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'b': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'c': {'metadata': {'objectId': 'obj-1', 'isDeleted': False}},
            'x': {'metadata': {'objectId': 'obj-2', 'isDeleted': False}},
        }
    )

    store.markDeleted(['obj-1'])

    obj1_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-1']
    obj2_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-2']
    assert obj1_values == [True, True, True]
    assert obj2_values == [False]


def test_mark_active_updates_all_matching_chunks() -> None:
    """markActive() should clear isDeleted for all vectors of the target object."""
    store, _ = _make_store(
        {
            'a': {'metadata': {'objectId': 'obj-1', 'isDeleted': True}},
            'b': {'metadata': {'objectId': 'obj-1', 'isDeleted': True}},
            'c': {'metadata': {'objectId': 'obj-1', 'isDeleted': True}},
            'x': {'metadata': {'objectId': 'obj-2', 'isDeleted': True}},
        }
    )

    store.markActive(['obj-1'])

    obj1_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-1']
    obj2_values = [record['metadata']['isDeleted'] for record in store.client.index.records.values() if record['metadata'].get('objectId') == 'obj-2']
    assert obj1_values == [False, False, False]
    assert obj2_values == [True]


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
