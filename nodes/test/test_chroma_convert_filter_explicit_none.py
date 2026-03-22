# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma `_convertFilter` explicit-None vs empty-container semantics."""

from __future__ import annotations

import importlib.util
import math
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

_STUB_MODULE_NAMES = (
    'depends',
    'chromadb',
    'chromadb.config',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'rocketlib',
    'numpy',
    'chroma_store_under_test',
)


def _install_min_stubs() -> None:
    """Minimal stubs so `chroma.py` can execute for `_convertFilter` tests."""
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_a, **_k: None
    sys.modules['depends'] = mod_depends

    chromadb = types.ModuleType('chromadb')

    class _HttpClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb.HttpClient = _HttpClient
    chromadb.Collection = object
    sys.modules['chromadb'] = chromadb

    chromadb_config = types.ModuleType('chromadb.config')

    class Settings:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb_config.Settings = Settings
    sys.modules['chromadb.config'] = chromadb_config

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
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
        def __init__(self, *_a: object, **_k: object) -> None:
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

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.debug = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib

    numpy_mod = types.ModuleType('numpy')
    numpy_mod.exp = math.exp
    numpy_mod.int64 = int
    sys.modules['numpy'] = numpy_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_min_stubs()
    try:
        yield
    finally:
        for name in _STUB_MODULE_NAMES:
            if original.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_store_class() -> type:
    nodes_root = Path(__file__).resolve().parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'chroma' / 'chroma.py'
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_store_under_test', chroma_py)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Store


def _doc_filter(**overrides: object) -> SimpleNamespace:
    values = {
        'nodeId': None,
        'isTable': None,
        'tableIds': None,
        'parent': None,
        'permissions': None,
        'objectIds': None,
        'isDeleted': None,
        'chunkIds': None,
        'minChunkId': None,
        'maxChunkId': None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_convert_filter_empty_object_ids_list_is_not_omitted() -> None:
    """Explicit [] must constrain to zero object ids (parity with other vector stores)."""
    Store = _load_store_class()
    store = Store.__new__(Store)
    converted = store._convertFilter(_doc_filter(objectIds=[]))
    assert converted == {'objectId': {'$in': []}}


def test_convert_filter_empty_string_node_id_is_included() -> None:
    """Empty string nodeId is a valid explicit filter value and must not be dropped."""
    Store = _load_store_class()
    store = Store.__new__(Store)
    converted = store._convertFilter(_doc_filter(nodeId=''))
    assert converted == {'nodeId': {'$eq': ''}}


def test_convert_filter_empty_table_ids_list_is_not_omitted() -> None:
    """Explicit empty tableIds list must produce a tableId $in clause, not be omitted."""
    Store = _load_store_class()
    store = Store.__new__(Store)
    converted = store._convertFilter(_doc_filter(tableIds=[]))
    assert converted == {'tableId': {'$in': []}}


def test_convert_filter_omits_object_ids_when_unset() -> None:
    """When objectIds is unset (None), no objectId filter clause is added."""
    Store = _load_store_class()
    store = Store.__new__(Store)
    converted = store._convertFilter(_doc_filter())
    assert converted is None
