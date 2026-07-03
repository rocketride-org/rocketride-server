# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for #1405: Chroma version incompatibility fails silently.

Covers two independent defects in `Store._doesCollectionExist` / `flush()`:

1. `list_collections()` return shape differs across chromadb client versions
   (list of name strings on newer clients vs. list of Collection-like objects
   exposing `.name` on older ones). Comparing `self.collection` directly
   against the raw list only worked for the string shape, so against an
   older-shaped response `_doesCollectionExist` silently reported "does not
   exist" even when it did.
2. `flush()` called `self.collectionObj.delete(...)` / `.upsert(...)` without
   checking whether `collectionObj` had actually been resolved, so a prior
   silent failure surfaced later as an opaque `AttributeError` instead of an
   actionable message.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

_STUB_MODULE_NAMES = (
    'depends',
    'rocketlib',
    'chromadb',
    'chromadb.config',
    'numpy',
    'chroma_store_under_test',
)


class _FakeCollectionRef:
    """Stand-in for an older chromadb client's `Collection` object.

    Only exposes `.name`, matching what `_doesCollectionExist` is allowed to
    rely on for older-client compatibility.
    """

    def __init__(self, name: str) -> None:
        self.name = name


class _FakeCollectionObj:
    """Stand-in for `Collection` returned by `get_collection`, supporting
    just enough surface (`delete`) for the `flush()` regression test.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.deleted_where: list = []

    def delete(self, where=None):
        self.deleted_where.append(where)


class _FakeHttpClient:
    """Configurable stand-in for `chromadb.HttpClient`."""

    def __init__(self, existing_names=(), shape: str = 'strings', list_collections_error: Exception | None = None):
        self._existing_names = list(existing_names)
        self._shape = shape
        self._list_collections_error = list_collections_error

    def list_collections(self):
        if self._list_collections_error is not None:
            raise self._list_collections_error
        if self._shape == 'strings':
            return list(self._existing_names)
        if self._shape == 'objects':
            return [_FakeCollectionRef(n) for n in self._existing_names]
        raise AssertionError(f'unknown shape {self._shape!r}')

    def get_collection(self, name: str) -> _FakeCollectionObj:
        return _FakeCollectionObj(name)


def _install_min_stubs() -> None:
    """Minimal stubs so `chroma.py` can execute without a real chromadb install."""
    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *_a, **_k: None
    sys.modules['depends'] = depends_mod

    # `rocketlib` is the native (C++-built) engine binding — not pip-installable
    # outside RocketRide's own build pipeline. Stubbed here with the minimal
    # surface `ai.common.store` / `ai.common.config` / `chroma.py` import at
    # module load time; none of it is exercised by the tests below since
    # `Store` instances are constructed via `__new__` (bypassing `__init__`,
    # which is the only place these symbols would actually be called).
    rocketlib_mod = types.ModuleType('rocketlib')

    class _IInstanceBase:
        pass

    class _IJson(dict):
        @staticmethod
        def toDict(obj):
            return dict(obj)

    rocketlib_mod.IInstanceBase = _IInstanceBase
    rocketlib_mod.IJson = _IJson
    rocketlib_mod.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib_mod.getServiceDefinition = lambda *_a, **_k: {}
    rocketlib_mod.warning = lambda *_a, **_k: None
    rocketlib_mod.debug = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib_mod

    chromadb = types.ModuleType('chromadb')
    chromadb.HttpClient = _FakeHttpClient
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


def _load_store_class() -> type:
    nodes_root = Path(__file__).resolve().parent.parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'chroma' / 'chroma.py'
    ai_src = nodes_root.parent / 'packages' / 'ai' / 'src'
    if str(ai_src) not in sys.path:
        sys.path.insert(0, str(ai_src))
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_store_under_test', chroma_py)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Store


def _bare_store(Store: type, *, client, collection: str = 'my_collection'):
    """Construct a Store instance without running `__init__` (avoids needing
    the full Config/connConfig machinery) and wire up just the attributes
    `_doesCollectionExist`/`flush` touch.
    """
    store = Store.__new__(Store)
    store.client = client
    store.collection = collection
    store.collectionObj = None
    return store


# ---------------------------------------------------------------------------
# _doesCollectionExist: version-shape compatibility
# ---------------------------------------------------------------------------


class TestDoesCollectionExistVersionCompat:
    def test_true_when_list_collections_returns_name_strings(self):
        """Newer chromadb client shape: list_collections() -> List[str]."""
        Store = _load_store_class()
        client = _FakeHttpClient(existing_names=['my_collection'], shape='strings')
        store = _bare_store(Store, client=client)

        assert store._doesCollectionExist() is True
        assert store.collectionObj is not None
        assert store.collectionObj.name == 'my_collection'

    def test_true_when_list_collections_returns_objects_with_name(self):
        """Older chromadb client shape: list_collections() -> List[Collection].

        This is the core #1405 regression: previously `self.collection in
        collections` compared a str against Collection objects and always
        evaluated to False here, even though the collection existed.
        """
        Store = _load_store_class()
        client = _FakeHttpClient(existing_names=['my_collection'], shape='objects')
        store = _bare_store(Store, client=client)

        assert store._doesCollectionExist() is True
        assert store.collectionObj is not None
        assert store.collectionObj.name == 'my_collection'

    def test_false_when_collection_absent_strings_shape(self):
        Store = _load_store_class()
        client = _FakeHttpClient(existing_names=['other_collection'], shape='strings')
        store = _bare_store(Store, client=client)

        assert store._doesCollectionExist() is False
        assert store.collectionObj is None

    def test_false_when_collection_absent_objects_shape(self):
        Store = _load_store_class()
        client = _FakeHttpClient(existing_names=['other_collection'], shape='objects')
        store = _bare_store(Store, client=client)

        assert store._doesCollectionExist() is False
        assert store.collectionObj is None

    def test_false_when_client_is_none(self):
        Store = _load_store_class()
        store = _bare_store(Store, client=_FakeHttpClient())
        store.client = None

        assert store._doesCollectionExist() is False

    def test_list_collections_error_is_wrapped_with_actionable_message(self):
        """A raw client/server incompatibility (e.g. KeyError('_type')) must not
        propagate as an opaque error — it should be wrapped with a message that
        names the host/port and hints at a version mismatch.
        """
        Store = _load_store_class()
        client = _FakeHttpClient(list_collections_error=KeyError('_type'))
        store = _bare_store(Store, client=client)
        store.host = 'chroma-host'
        store.port = 8000

        with pytest.raises(Exception, match='version mismatch'):
            store._doesCollectionExist()


# ---------------------------------------------------------------------------
# addChunks -> flush(): clear failure when collectionObj was never resolved
# ---------------------------------------------------------------------------


class TestFlushGuardsAgainstUnresolvedCollection:
    def test_add_chunks_raises_actionable_error_when_collection_object_is_none(self):
        """Previously this raised `AttributeError: 'NoneType' object has no
        attribute 'delete'` from deep inside `flush()`. It must now raise a
        message that names the collection and points at the real cause.
        """
        Store = _load_store_class()
        store = _bare_store(Store, client=_FakeHttpClient())
        store.payload_limit = 32 * 1024 * 1024
        assert store.collectionObj is None

        chunk = SimpleNamespace(
            metadata=SimpleNamespace(
                chunkId=0,
                objectId='obj-1',
                toDict=lambda: {'objectId': 'obj-1', 'chunkId': 0},
            ),
            embedding=[0.1, 0.2, 0.3],
            page_content='hello world',
        )

        with pytest.raises(Exception, match='not initialized'):
            store.addChunks([chunk], checkCollection=False)
