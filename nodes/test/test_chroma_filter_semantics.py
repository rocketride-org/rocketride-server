# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma filter conversion semantics."""

from __future__ import annotations

import importlib.util
import sys
import types
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

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
)


def _install_stubs() -> None:
    """Install lightweight stubs so chroma.py can be imported in isolation."""
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *_args, **_kwargs: None
    sys.modules['depends'] = mod_depends

    chromadb = types.ModuleType('chromadb')

    class _HttpClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    chromadb.HttpClient = _HttpClient
    chromadb.Collection = object
    sys.modules['chromadb'] = chromadb

    chromadb_config = types.ModuleType('chromadb.config')

    class Settings:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    chromadb_config.Settings = Settings
    sys.modules['chromadb.config'] = chromadb_config

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

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.debug = lambda *_args, **_kwargs: None
    sys.modules['rocketlib'] = rocketlib


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
    with _scoped_stubs():
        root = Path(__file__).resolve().parents[2]
        chroma_file = root / 'nodes' / 'src' / 'nodes' / 'chroma' / 'chroma.py'
        spec = importlib.util.spec_from_file_location('test_chroma_store_module', chroma_file)
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Store


def _doc_filter(**overrides: object) -> types.SimpleNamespace:
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
    return types.SimpleNamespace(**values)


def test_convert_filter_includes_is_table_false() -> None:
    """`isTable=False` must produce an explicit false filter clause."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    converted = store._convertFilter(_doc_filter(isTable=False))
    assert converted == {'isTable': {'$eq': False}}


def test_convert_filter_includes_is_table_true() -> None:
    """`isTable=True` should keep the existing true-clause behavior."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    converted = store._convertFilter(_doc_filter(isTable=True))
    assert converted == {'isTable': {'$eq': True}}


def test_convert_filter_omits_is_table_when_none() -> None:
    """`isTable=None` should omit the isTable clause entirely."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    converted = store._convertFilter(_doc_filter(isTable=None))
    assert converted is None


def test_convert_filter_keeps_nodeid_and_is_table_false() -> None:
    """`nodeId` and `isTable=False` should both appear in a combined filter."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    converted = store._convertFilter(_doc_filter(nodeId='node-1', isTable=False))
    assert converted == {
        '$and': [
            {'nodeId': {'$eq': 'node-1'}},
            {'isTable': {'$eq': False}},
        ]
    }


def test_load_store_class_does_not_leak_stub_modules() -> None:
    """Loading the store class should not leak temporary stubs in sys.modules."""
    stub_modules = [
        'depends',
        'chromadb',
        'chromadb.config',
        'ai',
        'ai.common',
        'ai.common.schema',
        'ai.common.store',
        'ai.common.config',
        'rocketlib',
    ]
    before = {name: sys.modules.get(name) for name in stub_modules}

    _load_store_class()

    for name, module_before in before.items():
        if module_before is None:
            assert name not in sys.modules
        else:
            assert sys.modules.get(name) is module_before
