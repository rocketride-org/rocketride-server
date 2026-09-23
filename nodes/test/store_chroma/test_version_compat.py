# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma issue #1405: server-version validation, list_collections
shape normalization, and non-silent index failure (no swallowed error / no NoneType crash).
"""

from __future__ import annotations

import importlib.util
import math
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

_STUB_MODULE_NAMES = (
    'chromadb',
    'chromadb.config',
    'numpy',
    'chroma_store_under_test',
)


def _install_min_stubs() -> None:
    """Minimal stubs so `chroma.py` can be imported without the real chromadb/numpy."""
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


def _load_module() -> ModuleType:
    nodes_root = Path(__file__).resolve().parent.parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_store_under_test', chroma_py)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


# --- _check_server_version ---------------------------------------------------


@pytest.mark.parametrize('version', ['0.5.18', '0.5.99', '0.4.24'])
def test_check_server_version_rejects_old_servers(version: str) -> None:
    """Servers below the supported floor (< 0.6) must raise a clear, actionable error."""
    module = _load_module()
    with pytest.raises(Exception) as exc:
        module._check_server_version(version)
    assert 'too old' in str(exc.value)
    assert version in str(exc.value)


@pytest.mark.parametrize('version', ['0.6.0', '0.6.3', '1.0.0', '1.5.9', 'v2.0.1', '3.2.2'])
def test_check_server_version_accepts_supported_servers(version: str) -> None:
    """Servers at or above the floor pass — including 0.6.x (the project's own test infra)."""
    module = _load_module()
    module._check_server_version(version)  # must not raise


@pytest.mark.parametrize('version', ['', 'garbage', '1', None])
def test_check_server_version_is_lenient_on_unparseable(version: object) -> None:
    """Unparseable/partial version strings must not block the connection (wrapper covers it)."""
    module = _load_module()
    module._check_server_version(version)  # must not raise


# --- _getServerVersion is defensive (thin clients may lack get_version) -------


def test_get_server_version_returns_none_when_method_absent() -> None:
    """A client without get_version must yield None, not raise (the bug that broke CI)."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.client = SimpleNamespace()  # no get_version attribute
    assert store._getServerVersion() is None


def test_get_server_version_returns_value_when_available() -> None:
    """When get_version exists, its return value is used."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.client = SimpleNamespace(get_version=lambda: '0.6.3')
    assert store._getServerVersion() == '0.6.3'


def test_get_server_version_returns_none_when_probe_raises() -> None:
    """A failing get_version must be swallowed to None, not surface as a connection error."""
    module = _load_module()
    store = module.Store.__new__(module.Store)

    def _boom() -> str:
        raise RuntimeError("KeyError('_type')")

    store.client = SimpleNamespace(get_version=_boom)
    assert store._getServerVersion() is None


@pytest.mark.parametrize('result', [6, object(), None], ids=['integer', 'object', 'none'])
def test_get_server_version_treats_non_string_probe_results_as_unknown(result: object) -> None:
    """Unexpected probe result types must not fail the open()-style version check."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.client = SimpleNamespace(get_version=lambda: result)

    server_version = store._getServerVersion()
    assert server_version is None
    module._check_server_version(server_version)


# --- _enforceServerVersion drops the handle it rejects -----------------------


def test_enforce_server_version_clears_client_when_server_too_old() -> None:
    """A rejected server must not leave a usable client handle behind."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.client = SimpleNamespace(get_version=lambda: '0.5.18')

    with pytest.raises(Exception) as exc:
        store._enforceServerVersion()

    assert 'too old' in str(exc.value)
    assert store.client is None


def test_enforce_server_version_keeps_client_on_supported_server() -> None:
    """A supported server passes the floor and keeps its handle."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    client = SimpleNamespace(get_version=lambda: '0.6.3')
    store.client = client

    store._enforceServerVersion()

    assert store.client is client


def test_enforce_server_version_keeps_client_when_version_unknown() -> None:
    """An undeterminable version is not a rejection, so the handle survives."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    client = SimpleNamespace()  # no get_version
    store.client = client

    store._enforceServerVersion()

    assert store.client is client


# --- _doesCollectionExist normalization --------------------------------------


def _store_with_client(collections: list) -> object:
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.collection = 'mycoll'
    store.collectionObj = None
    store.client = SimpleNamespace(
        list_collections=lambda: collections,
        get_collection=lambda name: SimpleNamespace(name=name, _sentinel=True),
    )
    return store


def test_does_collection_exist_with_name_strings() -> None:
    """Older clients return collection *names* (strings)."""
    store = _store_with_client(['other', 'mycoll'])
    assert store._doesCollectionExist() is True
    assert getattr(store.collectionObj, '_sentinel', False) is True


def test_does_collection_exist_with_collection_objects() -> None:
    """Newer clients return Collection *objects* with a .name attribute."""
    objects = [SimpleNamespace(name='other'), SimpleNamespace(name='mycoll')]
    store = _store_with_client(objects)
    assert store._doesCollectionExist() is True
    assert getattr(store.collectionObj, '_sentinel', False) is True


def test_does_collection_exist_false_when_absent() -> None:
    """Absent collection returns False for both shapes."""
    assert _store_with_client(['a', 'b'])._doesCollectionExist() is False
    assert _store_with_client([SimpleNamespace(name='a')])._doesCollectionExist() is False


# --- _createCollection no longer swallows the real error ---------------------


def test_create_collection_reraises_and_leaves_collection_none() -> None:
    """A failed create must raise (not return False and leave collectionObj None silently)."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.collection = 'mycoll'
    store.similarity = 'cosine'
    store.collectionObj = None

    def _boom(*_a: object, **_k: object) -> object:
        raise RuntimeError("KeyError('_type')")

    store.client = SimpleNamespace(get_or_create_collection=_boom)

    with pytest.raises(Exception) as exc:
        store._createCollection(5)
    assert 'Error creating Chroma collection' in str(exc.value)
    assert store.collectionObj is None


# --- flush guard: no cryptic NoneType crash ----------------------------------


def _fake_chunk() -> SimpleNamespace:
    metadata = SimpleNamespace(chunkId=0, objectId='o1', toDict=lambda: {'objectId': 'o1', 'chunkId': 0})
    return SimpleNamespace(metadata=metadata, embedding=[0.1, 0.2, 0.3], page_content='hello')


def test_add_chunks_raises_clear_error_when_collection_missing() -> None:
    """With collectionObj None, indexing must raise a clear message, not AttributeError."""
    module = _load_module()
    store = module.Store.__new__(module.Store)
    store.collectionObj = None  # collection was never created
    store.payload_limit = 32 * 1024 * 1024

    with pytest.raises(Exception) as exc:
        store.addChunks([_fake_chunk()], checkCollection=False)
    message = str(exc.value)
    assert 'collection' in message.lower()
    assert 'NoneType' not in message  # not the cryptic attribute-error text
