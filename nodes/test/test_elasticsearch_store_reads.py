# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for reading and writing an Elasticsearch index that already holds its control row."""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

_STUB_MODULE_NAMES = (
    'elasticsearch',
    'elasticsearch.helpers',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'nodes.store_elasticsearch',
    'nodes.store_elasticsearch.constants',
    'es_store_under_test',
)

_BULK_CALLS: list[dict] = []


class _Model:
    def __init__(self, **fields: object) -> None:
        self.__dict__.update(fields)

    def __getattr__(self, name: str) -> None:
        return None


def _install_stubs() -> None:
    """Stand in for the client library and the engine-side `ai.common` modules `elasticsearch_store.py` imports."""

    def stub(name: str, **attrs: object) -> types.ModuleType:
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        sys.modules[name] = module
        return module

    def bulk(_client: object, actions: list, **kwargs: object) -> None:
        _BULK_CALLS.append({'size': len(actions), **kwargs})

    stub('elasticsearch', Elasticsearch=object)
    stub('elasticsearch.helpers', bulk=bulk, scan=None, BulkIndexError=Exception)
    stub('ai')
    stub('ai.common')
    stub('ai.common.schema', Doc=_Model, DocFilter=_Model, DocMetadata=_Model, QuestionText=_Model)
    stub('ai.common.store', DocumentStoreBase=object)
    stub('ai.common.config', Config=object, check_credential_resolved=None)

    constants_path = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'store_elasticsearch' / 'constants.py'
    package = stub('nodes.store_elasticsearch')
    package.__path__ = [str(constants_path.parent)]
    stub('nodes.store_elasticsearch.constants', **vars(_exec_module('constants', constants_path)))


def _exec_module(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name in _STUB_MODULE_NAMES:
            if original[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_store_class() -> type:
    nodes_root = Path(__file__).resolve().parent.parent
    store_py = nodes_root / 'src' / 'nodes' / 'store_elasticsearch' / 'elasticsearch_store.py'
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location(
            'nodes.store_elasticsearch.es_store_under_test', store_py, submodule_search_locations=None
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(spec.name, None)
        return module.Store


class _FakeIndices:
    def exists(self, index: str) -> bool:
        return True


class _FakeClient:
    """Answers a sorted search the way Elasticsearch does: no relevance score, so `_score` is null."""

    def __init__(self, hits: list[dict]) -> None:
        self.indices = _FakeIndices()
        self._hits = hits

    def search(self, index: str, body: dict) -> dict:
        score = None if 'sort' in body else 0.9
        return {'hits': {'hits': [{**hit, '_score': score} for hit in self._hits]}}

    def count(self, index: str) -> dict:
        return {'count': len(self._hits)}


def _control_row_hit() -> dict:
    meta = {'objectId': 'schema', 'chunkId': 0, 'isDeleted': True, 'vectorSize': 3, 'modelName': 'm'}
    return {'_source': {'content': '', 'meta': meta}}


def _make_store(Store: type, hits: list[dict]) -> object:
    store = Store.__new__(Store)
    store.client = _FakeClient(hits)
    store.index = 'idx'
    store.similarity = 'cosine'
    store.threshold_search = 0.0
    store.payload_limit = 32 * 1024 * 1024
    return store


def _chunk(object_id: str) -> SimpleNamespace:
    metadata = SimpleNamespace(
        objectId=object_id,
        chunkId=0,
        nodeId=None,
        parent=None,
        permissionId=None,
        isDeleted=False,
        isTable=None,
        tableId=None,
    )
    return SimpleNamespace(embedding=[1.0, 0.0, 0.0], page_content='x', metadata=metadata)


def test_sorted_get_with_null_score_returns_the_control_row() -> None:
    """`get()` sorts by chunkId, so Elasticsearch returns `_score: null`; reopening an index must not raise."""
    Store = _load_store_class()
    store = _make_store(Store, [_control_row_hit()])

    assert store._checkCollectionExists() is True
    assert store.vectorSize == 3
    assert store.modelName == 'm'


@pytest.mark.parametrize('check_collection, expected_refresh', [(False, 'wait_for'), (True, None)])
def test_only_the_control_row_write_waits_for_a_refresh(check_collection: bool, expected_refresh: str | None) -> None:
    """A second batch must find the control row searchable, or `createCollection` deletes the index."""
    Store = _load_store_class()
    store = _make_store(Store, [])
    store.objectIdsToReplace = lambda chunks: []
    store.createCollection = lambda chunks: True
    _BULK_CALLS.clear()

    store.addChunks([_chunk('schema' if not check_collection else 'o1')], checkCollection=check_collection)

    assert [call.get('refresh') for call in _BULK_CALLS] == [expected_refresh]
