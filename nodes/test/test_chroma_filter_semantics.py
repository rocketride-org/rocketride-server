# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma filter conversion semantics."""

from __future__ import annotations

import importlib
import sys
from types import ModuleType, SimpleNamespace
import pytest
from contextlib import contextmanager
from pathlib import Path
from collections.abc import Iterator

_MODULE_PREFIXES = ('chroma', 'chromadb')


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

    test_dir = Path(__file__).resolve().parent
    mock_path = test_dir / 'mocks'
    nodes_path = test_dir.parent / 'src' / 'nodes'

    sys.path.insert(0, str(nodes_path))
    sys.path.insert(0, str(mock_path))
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


def _load_store_class() -> type:
    """Load `Store` from `chroma.chroma` using scoped canonical test mocks."""
    with _scoped_imports():
        chroma_module = importlib.import_module('chroma.chroma')
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
