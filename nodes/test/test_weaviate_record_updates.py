# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Weaviate record update/delete scope behavior."""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_STUB_MODULE_NAMES = (
    'depends',
    'numpy',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
)


def _install_stubs() -> None:
    """Install lightweight stubs so weaviate.py can be imported in isolation."""
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_args, **_kwargs: None
    sys.modules['depends'] = mod_depends

    mod_numpy = types.ModuleType('numpy')
    sys.modules['numpy'] = mod_numpy

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
    """Load Weaviate Store class from source with temporary stubs."""
    with _scoped_stubs():
        root = Path(__file__).resolve().parents[2]
        mocks_path = root / 'nodes' / 'test' / 'mocks'
        weaviate_file = root / 'nodes' / 'src' / 'nodes' / 'weaviate' / 'weaviate.py'
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

    root = Path(__file__).resolve().parents[2]
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
            'properties': {'objectId': object_id, 'isDeleted': is_deleted},
            'vector': [0.1, 0.2],
        }
        for index in range(count)
    }


def test_remove_noop_for_empty_objectids() -> None:
    """remove([]) should be a no-op."""
    records = _make_obj_records('obj-1', 2, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))
    store, collection = _make_store(records)
    before = sorted(collection._storage.keys())

    store.remove([])

    assert sorted(collection._storage.keys()) == before


def test_mark_deleted_noop_for_empty_objectids() -> None:
    """markDeleted([]) should be a no-op."""
    records = _make_obj_records('obj-1', 2, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))
    store, collection = _make_store(records)

    store.markDeleted([])

    values = [record['properties']['isDeleted'] for record in collection._storage.values()]
    assert values == [False, False, False]


def test_mark_active_noop_for_empty_objectids() -> None:
    """markActive([]) should be a no-op."""
    records = _make_obj_records('obj-1', 2, is_deleted=True)
    records.update(_make_obj_records('obj-2', 1, is_deleted=True))
    store, collection = _make_store(records)

    store.markActive([])

    values = [record['properties']['isDeleted'] for record in collection._storage.values()]
    assert values == [True, True, True]


def test_remove_deletes_only_matching_object_ids() -> None:
    """remove([...]) should only delete matching objectId records."""
    records = _make_obj_records('obj-1', 2, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))
    store, collection = _make_store(records)

    store.remove(['obj-1'])

    remaining = [record['properties']['objectId'] for record in collection._storage.values()]
    assert remaining == ['obj-2']


def test_mark_deleted_updates_only_matching_object_ids() -> None:
    """markDeleted([...]) should only update matching objectId records."""
    records = _make_obj_records('obj-1', 2, is_deleted=False)
    records.update(_make_obj_records('obj-2', 1, is_deleted=False))
    store, collection = _make_store(records)

    store.markDeleted(['obj-1'])

    obj1 = [record['properties']['isDeleted'] for record in collection._storage.values() if record['properties']['objectId'] == 'obj-1']
    obj2 = [record['properties']['isDeleted'] for record in collection._storage.values() if record['properties']['objectId'] == 'obj-2']
    assert obj1 == [True, True]
    assert obj2 == [False]


def test_mark_active_updates_only_matching_object_ids() -> None:
    """markActive([...]) should only update matching objectId records."""
    records = _make_obj_records('obj-1', 2, is_deleted=True)
    records.update(_make_obj_records('obj-2', 1, is_deleted=True))
    store, collection = _make_store(records)

    store.markActive(['obj-1'])

    obj1 = [record['properties']['isDeleted'] for record in collection._storage.values() if record['properties']['objectId'] == 'obj-1']
    obj2 = [record['properties']['isDeleted'] for record in collection._storage.values() if record['properties']['objectId'] == 'obj-2']
    assert obj1 == [False, False]
    assert obj2 == [True]
