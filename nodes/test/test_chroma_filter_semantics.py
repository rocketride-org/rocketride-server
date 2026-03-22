# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma filter conversion semantics."""

from __future__ import annotations

import importlib
import importlib.util
import sys
from types import ModuleType, SimpleNamespace
import pytest
from contextlib import contextmanager
from pathlib import Path
from collections.abc import Iterator

_MODULE_PREFIXES = ('chroma', 'chromadb')
_STUB_MODULE_NAMES = (
    'depends',
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'ai.common.transform',
    'numpy',
)


def _is_scoped_module(module_name: str) -> bool:
    """Return whether a module should be isolated within scoped imports."""
    return any(module_name == prefix or module_name.startswith(f'{prefix}.') for prefix in _MODULE_PREFIXES)


def _capture_scoped_modules() -> dict[str, ModuleType]:
    """Capture currently loaded modules matching the scoped import prefixes."""
    captured_modules: dict[str, ModuleType] = {}
    for module_name, module in sys.modules.items():
        if _is_scoped_module(module_name) and isinstance(module, ModuleType):
            captured_modules[module_name] = module
    return captured_modules


@contextmanager
def _scoped_imports() -> Iterator[None]:
    """Temporarily prepend canonical Chroma mock paths and restore import state."""
    original_sys_path = list(sys.path)
    original_modules = _capture_scoped_modules()
    original_stub_modules = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}

    test_dir = Path(__file__).resolve().parent
    mock_path = test_dir / 'mocks'
    nodes_path = test_dir.parent / 'src' / 'nodes'

    sys.path.insert(0, str(nodes_path))
    sys.path.insert(0, str(mock_path))
    # `nodes/src/nodes/chroma/chroma.py` imports runtime dependencies at module
    # import time; install lightweight stubs so tests stay hermetic.
    depends_module = ModuleType('depends')
    depends_module.depends = lambda *_a, **_kw: None  # type: ignore[attr-defined]
    sys.modules['depends'] = depends_module

    rocketlib_module = ModuleType('rocketlib')
    rocketlib_module.debug = lambda *_a, **_kw: None  # type: ignore[attr-defined]
    sys.modules['rocketlib'] = rocketlib_module

    ai_module = ModuleType('ai')
    ai_common_module = ModuleType('ai.common')
    ai_common_module.__path__ = []  # type: ignore[attr-defined]
    ai_schema_module = ModuleType('ai.common.schema')
    ai_store_module = ModuleType('ai.common.store')
    ai_config_module = ModuleType('ai.common.config')
    ai_transform_module = ModuleType('ai.common.transform')
    numpy_module = ModuleType('numpy')

    class _Doc:
        pass

    class _DocFilter:
        pass

    class _DocMetadata:
        pass

    class _QuestionText:
        pass

    class _DocumentStoreBase:
        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

    class _Config:
        @staticmethod
        def getNodeConfig(_provider: object, _connConfig: object) -> dict[str, object]:
            return {}

    class _IEndpointTransform:
        pass

    ai_schema_module.Doc = _Doc
    ai_schema_module.DocFilter = _DocFilter
    ai_schema_module.DocMetadata = _DocMetadata
    ai_schema_module.QuestionText = _QuestionText
    ai_store_module.DocumentStoreBase = _DocumentStoreBase
    ai_config_module.Config = _Config
    ai_transform_module.IEndpointTransform = _IEndpointTransform

    sys.modules['ai'] = ai_module
    sys.modules['ai.common'] = ai_common_module
    sys.modules['ai.common.schema'] = ai_schema_module
    sys.modules['ai.common.store'] = ai_store_module
    sys.modules['ai.common.config'] = ai_config_module
    sys.modules['ai.common.transform'] = ai_transform_module
    sys.modules['numpy'] = numpy_module
    importlib.invalidate_caches()
    try:
        yield
    finally:
        sys.path[:] = original_sys_path
        for module_name in list(sys.modules):
            if _is_scoped_module(module_name) and module_name not in original_modules:
                sys.modules.pop(module_name, None)
        for module_name, module in original_modules.items():
            sys.modules[module_name] = module
        for module_name, module in original_stub_modules.items():
            if module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = module


def _load_store_class() -> type:
    """Load `Store` from source using scoped canonical test mocks."""
    with _scoped_imports():
        chroma_file = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'chroma' / 'chroma.py'
        spec = importlib.util.spec_from_file_location('test_chroma_store_module', chroma_file)
        assert spec is not None and spec.loader is not None
        chroma_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(chroma_module)
        chromadb_module = importlib.import_module('chromadb')

        chromadb_file = getattr(chromadb_module, '__file__', None)
        assert chromadb_file is not None

        expected_mock_dir = (Path(__file__).resolve().parent / 'mocks' / 'chromadb').resolve()
        loaded_chromadb_path = Path(chromadb_file).resolve()
        assert expected_mock_dir in loaded_chromadb_path.parents

        return chroma_module.Store


def _doc_filter(**overrides: object) -> SimpleNamespace:
    """Build a DocFilter-like namespace with optional field overrides."""
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


@pytest.mark.parametrize(
    ('is_table', 'expected'),
    [
        pytest.param(False, {'isTable': {'$eq': False}}, id='is_table_false'),
        pytest.param(True, {'isTable': {'$eq': True}}, id='is_table_true'),
        pytest.param(None, None, id='is_table_none'),
    ],
)
def test_convert_filter_handles_is_table_values(
    is_table: bool | None,
    expected: dict[str, dict[str, bool]] | None,
) -> None:
    """`isTable` should map to expected filter output for all supported values."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    converted = store._convertFilter(_doc_filter(isTable=is_table))
    assert converted == expected


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


def test_load_store_class_scopes_chroma_and_chromadb_modules() -> None:
    """Loading store class should not leak scoped import modules across tests."""
    before = _capture_scoped_modules()

    _load_store_class()

    after = _capture_scoped_modules()
    assert set(after) == set(before)
    for module_name, module_before in before.items():
        assert after[module_name] is module_before
