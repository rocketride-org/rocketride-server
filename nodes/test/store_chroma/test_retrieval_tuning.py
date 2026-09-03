# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit + regression tests for Chroma top-k retrieval tuning (issue #1411).

Covers a configurable `top_k` that overrides the incoming DocFilter limit for
search retrieval while leaving behaviour unchanged when it is unset. Exact
fetches continue to use the DocFilter limit, and the existing hardcoded 0.20
score floor remains in place.

`chroma.py` is loaded with its heavy dependencies (rocketlib, ai.common, chromadb,
numpy) temporarily stubbed inside a scoped context, then the originals are
restored — so the test runs standalone (no built engine) without polluting other
tests' module imports.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import types
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


# --- Lightweight fakes for the leaf types chroma.py binds at import ----------


class _FakeDoc:
    """Minimal stand-in for ai.common.schema.Doc (records score/content/meta)."""

    def __init__(self, score=0.0, page_content='', metadata=None, embedding=None, embedding_model=None):
        self.score = score
        self.page_content = page_content
        self.metadata = metadata


class _FakeDocumentStoreBase:
    """Non-abstract stand-in for ai.common.store.DocumentStoreBase."""


_STUBBED_MODULE_NAMES = (
    'chromadb',
    'chromadb.config',
    'numpy',
    'depends',
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
    'ai.common.config',
    'chroma_store_under_test',
)


def _install_stubs() -> None:
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
    numpy_mod.bool_ = bool  # keep it a valid isinstance() target (pytest.approx probes np.bool_)
    sys.modules['numpy'] = numpy_mod

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *_a, **_k: None
    sys.modules['depends'] = depends_mod

    rocketlib_mod = types.ModuleType('rocketlib')
    rocketlib_mod.debug = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib_mod

    ai_mod = types.ModuleType('ai')
    ai_common_mod = types.ModuleType('ai.common')
    sys.modules['ai'] = ai_mod
    sys.modules['ai.common'] = ai_common_mod

    schema_mod = types.ModuleType('ai.common.schema')
    schema_mod.Doc = _FakeDoc
    schema_mod.DocFilter = SimpleNamespace  # only referenced in annotations
    schema_mod.DocMetadata = dict  # only used via typing.cast (no-op)
    schema_mod.QuestionText = SimpleNamespace
    sys.modules['ai.common.schema'] = schema_mod

    store_mod = types.ModuleType('ai.common.store')
    store_mod.DocumentStoreBase = _FakeDocumentStoreBase
    sys.modules['ai.common.store'] = store_mod

    config_mod = types.ModuleType('ai.common.config')
    config_mod.Config = MagicMock()
    sys.modules['ai.common.config'] = config_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUBBED_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name in _STUBBED_MODULE_NAMES:
            if original.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_chroma_module():
    nodes_root = Path(__file__).resolve().parent.parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_store_under_test', chroma_py)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


_CHROMA = _load_chroma_module()
Store = _CHROMA.Store


def _make_store(top_k=None, similarity='cosine') -> 'Store':
    store = Store.__new__(Store)
    store.top_k = top_k
    store.similarity = similarity
    return store


def _query_result(distances):
    """Build a Chroma query() result shape (distances present ⇒ list-of-lists)."""
    n = len(distances)
    return {
        'ids': [[str(uuid.uuid4()) for _ in range(n)]],
        'metadatas': [[{'objectId': f'obj-{i}', 'chunkId': i, 'nodeId': 'n', 'parent': '/p'} for i in range(n)]],
        'distances': [list(distances)],
        'documents': [[f'chunk {i}' for i in range(n)]],
    }


def _docfilter(limit: int = 25):
    """A DocFilter-shaped object covering every attribute `_convertFilter` reads."""
    return SimpleNamespace(
        limit=limit,
        offset=0,
        nodeId=None,
        isTable=None,
        tableIds=None,
        parent=None,
        permissions=None,
        objectIds=None,
        isDeleted=None,
        chunkIds=None,
        minChunkId=None,
        maxChunkId=None,
    )


def _empty_query_result():
    return {'ids': [[]], 'metadatas': [[]], 'distances': [[]], 'documents': [[]]}


# --- _convertToDocs: preserve the hardcoded 0.20 floor -----------------------


def test_convert_to_docs_applies_hardcoded_score_floor(monkeypatch):
    store = _make_store(similarity='l2')
    scores = iter([0.19, 0.20])
    monkeypatch.setattr(_CHROMA.np, 'exp', lambda _value: (1.0 / next(scores)) - 1.0)

    docs = store._convertToDocs(_query_result([0.0, 1.0]))

    assert len(docs) == 1
    assert docs[0].page_content == 'chunk 1'
    # Plain tolerance compare on purpose: pytest.approx probes numpy's bool_ type,
    # and other node test files in the shared CI worker leave a stubbed `numpy` in
    # sys.modules, which makes that probe raise TypeError.
    assert abs(docs[0].score - 0.20) < 1e-9


# --- _effectiveLimit / top_k override ----------------------------------------


def test_effective_limit_prefers_configured_top_k():
    store = _make_store(top_k=3)
    assert store._effectiveLimit(_docfilter(limit=25)) == 3


def test_effective_limit_falls_back_to_docfilter_limit():
    store = _make_store(top_k=None)
    assert store._effectiveLimit(_docfilter(limit=25)) == 25


def test_search_semantic_top_k_overrides_limit():
    store = _make_store(top_k=7)
    store.collectionObj = MagicMock()
    store.collectionObj.query.return_value = _empty_query_result()
    store.doesCollectionExist = lambda *a, **k: True
    query = SimpleNamespace(embedding=[0.1, 0.2], embedding_model='m')
    store.searchSemantic(query, _docfilter(limit=25))
    assert store.collectionObj.query.call_args.kwargs['n_results'] == 7


def test_search_semantic_without_top_k_uses_docfilter_limit():
    store = _make_store(top_k=None)
    store.collectionObj = MagicMock()
    store.collectionObj.query.return_value = _empty_query_result()
    store.doesCollectionExist = lambda *a, **k: True
    query = SimpleNamespace(embedding=[0.1, 0.2], embedding_model='m')
    store.searchSemantic(query, _docfilter(limit=25))
    assert store.collectionObj.query.call_args.kwargs['n_results'] == 25


def test_search_keyword_top_k_overrides_limit():
    store = _make_store(top_k=4)
    store.collectionObj = MagicMock()
    store.collectionObj.get.return_value = _empty_query_result()
    store.doesCollectionExist = lambda *a, **k: True
    query = SimpleNamespace(text='invoice')
    store.searchKeyword(query, _docfilter(limit=25))
    assert store.collectionObj.get.call_args.kwargs['limit'] == 4


def test_get_ignores_top_k_and_uses_docfilter_limit():
    store = _make_store(top_k=4)
    store.collectionObj = MagicMock()
    store.collectionObj.get.return_value = {'ids': [], 'metadatas': [], 'documents': []}

    store.get(_docfilter(limit=11), checkCollection=False)

    assert store.collectionObj.get.call_args.kwargs['limit'] == 11


# --- _coerceTopK validation ---------------------------------------------------


@pytest.mark.parametrize('value,expected', [(None, None), ('', None), (5, 5), (5.0, 5), (1, 1)])
def test_coerce_top_k_valid(value, expected):
    assert Store._coerceTopK(value) == expected


@pytest.mark.parametrize('value', [0, -1, 2.5, True, False, 'x'])
def test_coerce_top_k_invalid(value):
    with pytest.raises(ValueError):
        Store._coerceTopK(value)
