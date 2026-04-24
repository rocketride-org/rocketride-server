# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the VectorStoreToolMixin (packages/ai/src/ai/common/store.py).

These tests load ``store.py`` in isolation by stubbing its heavy imports
(``rocketlib``, ``ai.common.schema``) so the module can be exercised without
the server runtime. They cover:

* ``_normalize_vectordb_tool_input`` — dict / JSON / pydantic / nested /
  malformed / security-context stripping.
* Tool name namespacing — descriptor names must be ``<serverName>.<tool>``.
* Dispatch — ``search``, ``upsert``, ``delete`` call through to a fake store
  and propagate errors when the store is missing.
* Semantic-vs-keyword fallback — when ``IGlobal.embed_query`` is present the
  mixin populates ``question.embedding``; when absent it routes to keyword
  search (exactly once per warning).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

_ROOT = Path(__file__).resolve().parents[2]
_STORE_PY = _ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'store.py'

_STUB_MODULE_NAMES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.store',
)


# ---------------------------------------------------------------------------
# Stub harness
# ---------------------------------------------------------------------------


class _StubDoc:
    def __init__(
        self,
        page_content: str = '',
        metadata: Optional['_StubDocMetadata'] = None,
        score: float = 0.0,
        embedding: Optional[list] = None,
        embedding_model: Optional[str] = None,
    ) -> None:
        self.page_content = page_content
        self.metadata = metadata
        self.score = score
        self.embedding = embedding
        self.embedding_model = embedding_model

    def toDict(self) -> Dict[str, Any]:
        return {'content': self.page_content, 'score': self.score}


class _StubDocMetadata:
    def __init__(self, **kwargs: Any) -> None:
        self.objectId = kwargs.get('objectId', '')
        self.nodeId = kwargs.get('nodeId', '')
        self.parent = kwargs.get('parent', '/')
        self.chunkId = kwargs.get('chunkId', 0)
        self.tableId = kwargs.get('tableId', 0)
        self.isTable = kwargs.get('isTable', False)
        self.isDeleted = kwargs.get('isDeleted', False)
        self.vectorSize = kwargs.get('vectorSize', 0)
        self.modelName = kwargs.get('modelName', '')

    def __iter__(self):
        return iter(self.__dict__.items())


class _StubDocFilter:
    def __init__(self, **kwargs: Any) -> None:
        self.objectIds = kwargs.get('objectIds')
        self.nodeId = kwargs.get('nodeId')
        self.parent = kwargs.get('parent')
        self.isTable = kwargs.get('isTable')
        self.permissions = kwargs.get('permissions')
        self.tableIds = kwargs.get('tableIds')
        self.chunkIds = kwargs.get('chunkIds')
        self.minChunkId = kwargs.get('minChunkId')
        self.maxChunkId = kwargs.get('maxChunkId')
        self.isDeleted = kwargs.get('isDeleted')
        self.offset = kwargs.get('offset', 0)
        self.limit = kwargs.get('limit')
        self.fullTables = kwargs.get('fullTables', False)
        self.fullDocuments = kwargs.get('fullDocuments', False)


class _StubQuestion:
    def __init__(self, *a: Any, **kw: Any) -> None:
        self.type = None
        self.documents: list = []
        self.questions: list = []
        self.filter = _StubDocFilter()


class _StubQuestionText:
    def __init__(self, text: str = '') -> None:
        self.text = text
        self.embedding: Optional[list] = None
        self.embedding_model: Optional[str] = None


class _StubQuestionType:
    PROMPT = 'prompt'
    SEMANTIC = 'semantic'
    QUESTION = 'question'
    KEYWORD = 'keyword'
    GET = 'get'


class _StubAnswer:
    def setAnswer(self, *_a: Any, **_kw: Any) -> None:
        pass


# rocketlib stubs
class _StubIInstanceBase:
    """Minimal stand-in for rocketlib.IInstanceBase used by the mixin tests."""

    IGlobal: Any = None

    def _collect_tool_methods(self) -> Dict[str, Callable]:
        methods: Dict[str, Callable] = {}
        for name in dir(type(self)):
            attr = getattr(type(self), name, None)
            if attr is not None and hasattr(attr, '__tool_meta__'):
                methods[name] = getattr(self, name)
        return methods


def _stub_tool_function(
    *,
    input_schema: Any = None,
    description: Any = None,
    output_schema: Any = None,
) -> Callable:
    def decorator(fn: Callable) -> Callable:
        fn.__tool_meta__ = {
            'input_schema': input_schema,
            'description': description,
            'output_schema': output_schema,
        }
        return fn

    return decorator


_WARNINGS: List[str] = []


def _stub_warning(msg: str) -> None:
    _WARNINGS.append(str(msg))


def _install_stubs() -> None:
    """Install lightweight stubs so store.py can be imported in isolation."""
    rocketlib_mod = types.ModuleType('rocketlib')
    rocketlib_mod.IInstanceBase = _StubIInstanceBase
    rocketlib_mod.tool_function = _stub_tool_function
    rocketlib_mod.warning = _stub_warning
    sys.modules['rocketlib'] = rocketlib_mod

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []  # mark as package
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []
    schema_mod = types.ModuleType('ai.common.schema')
    schema_mod.Doc = _StubDoc
    schema_mod.DocFilter = _StubDocFilter
    schema_mod.DocMetadata = _StubDocMetadata
    schema_mod.Question = _StubQuestion
    schema_mod.QuestionText = _StubQuestionText
    schema_mod.QuestionType = _StubQuestionType
    schema_mod.Answer = _StubAnswer

    sys.modules['ai'] = ai_pkg
    sys.modules['ai.common'] = common_pkg
    sys.modules['ai.common.schema'] = schema_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    saved = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _load_store_module() -> types.ModuleType:
    with _scoped_stubs():
        # Load store.py as a submodule of the stubbed ``ai.common`` package so
        # its ``from .schema import ...`` relative import resolves against the
        # stub already installed in sys.modules.
        spec = importlib.util.spec_from_file_location('ai.common.store', _STORE_PY)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules['ai.common.store'] = module
        spec.loader.exec_module(module)
        return module


# Load once at module level. After load, the mixin's closures still reference
# the stub types from the scoped-stubs window because the module caches them
# via its own globals (e.g. ``Doc`` / ``QuestionText``).
_store_module = _load_store_module()

VectorStoreToolMixin = _store_module.VectorStoreToolMixin
_normalize_vectordb_tool_input = _store_module._normalize_vectordb_tool_input


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeStore:
    """Captures calls to searchSemantic/searchKeyword/addChunks/remove."""

    def __init__(self, semantic_docs: Optional[List[_StubDoc]] = None, keyword_docs: Optional[List[_StubDoc]] = None) -> None:
        """Seed the fake store with optional pre-canned result lists."""
        self.semantic_docs = semantic_docs if semantic_docs is not None else []
        self.keyword_docs = keyword_docs if keyword_docs is not None else []
        self.semantic_calls: List[tuple] = []
        self.keyword_calls: List[tuple] = []
        self.added_chunks: List[list] = []
        self.removed_ids: List[list] = []
        self.raise_semantic: Optional[Exception] = None

    def searchSemantic(self, question: Any, doc_filter: Any) -> List[_StubDoc]:
        self.semantic_calls.append((question, doc_filter))
        if self.raise_semantic is not None:
            raise self.raise_semantic
        return self.semantic_docs

    def searchKeyword(self, question: Any, doc_filter: Any) -> List[_StubDoc]:
        self.keyword_calls.append((question, doc_filter))
        return self.keyword_docs

    def addChunks(self, chunks: list) -> None:
        self.added_chunks.append(chunks)

    def remove(self, object_ids: list) -> None:
        self.removed_ids.append(object_ids)


class FakeGlb:
    def __init__(self, logical_type: str = 'pinecone') -> None:
        """Store the logical type used for fallback namespacing."""
        self.logicalType = logical_type


class FakeIGlobal:
    def __init__(
        self,
        store: Optional[FakeStore] = None,
        server_name: Optional[str] = None,
        embed_query: Optional[Callable] = None,
        logical_type: str = 'pinecone',
        embed_model_name: Optional[str] = None,
    ) -> None:
        """Assemble a fake IGlobal with optional embedder and server name."""
        self.store = store
        if server_name is not None:
            self.serverName = server_name
        self.glb = FakeGlb(logical_type)
        if embed_query is not None:
            self.embed_query = embed_query
        if embed_model_name is not None:
            self.embed_model_name = embed_model_name


class FakeIInstance(VectorStoreToolMixin, _StubIInstanceBase):
    def __init__(self, iglobal: FakeIGlobal) -> None:
        """Attach the fake IGlobal so the mixin sees the configured store."""
        self.IGlobal = iglobal


def _fresh_warnings() -> None:
    _WARNINGS.clear()


# ---------------------------------------------------------------------------
# _normalize_vectordb_tool_input
# ---------------------------------------------------------------------------


def test_normalize_none_returns_empty_dict() -> None:
    assert _normalize_vectordb_tool_input(None) == {}


def test_normalize_plain_dict_passes_through() -> None:
    result = _normalize_vectordb_tool_input({'query': 'hello', 'top_k': 5})
    assert result == {'query': 'hello', 'top_k': 5}


def test_normalize_json_string() -> None:
    result = _normalize_vectordb_tool_input('{"query": "hello"}')
    assert result == {'query': 'hello'}


def test_normalize_malformed_json_returns_empty() -> None:
    _fresh_warnings()
    result = _normalize_vectordb_tool_input('{not json')
    assert result == {}
    assert any('malformed JSON' in w for w in _WARNINGS)


def test_normalize_pydantic_v2_model() -> None:
    class FakeModel:
        def model_dump(self) -> Dict[str, Any]:
            return {'query': 'hello', 'top_k': 3}

    result = _normalize_vectordb_tool_input(FakeModel())
    assert result == {'query': 'hello', 'top_k': 3}


def test_normalize_pydantic_v1_model() -> None:
    class FakeV1:
        def dict(self) -> Dict[str, Any]:
            return {'query': 'legacy'}

    result = _normalize_vectordb_tool_input(FakeV1())
    assert result == {'query': 'legacy'}


def test_normalize_nested_input_wrapper_dict() -> None:
    result = _normalize_vectordb_tool_input({'input': {'query': 'hi'}, 'top_k': 7})
    assert result == {'query': 'hi', 'top_k': 7}


def test_normalize_nested_input_wrapper_json_string() -> None:
    result = _normalize_vectordb_tool_input({'input': '{"query": "hi"}'})
    assert result == {'query': 'hi'}


def test_normalize_strips_security_context() -> None:
    result = _normalize_vectordb_tool_input({'query': 'x', 'security_context': {'user': 'root'}})
    assert 'security_context' not in result
    assert result == {'query': 'x'}


def test_normalize_non_dict_json_returns_empty() -> None:
    _fresh_warnings()
    result = _normalize_vectordb_tool_input('"just a string"')
    assert result == {}


# ---------------------------------------------------------------------------
# Tool namespacing
# ---------------------------------------------------------------------------


def test_collect_tool_methods_namespaces_with_server_name() -> None:
    instance = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='myvdb'))
    methods = instance._collect_tool_methods()

    assert set(methods.keys()) == {'myvdb.search', 'myvdb.upsert', 'myvdb.delete'}
    # Each value is a callable bound to the fake instance
    for bound in methods.values():
        assert callable(bound)


def test_collect_tool_methods_uses_provider_fallback() -> None:
    # No explicit serverName — should fall back to logicalType 'chroma'
    instance = FakeIInstance(FakeIGlobal(store=FakeStore(), logical_type='chroma'))
    methods = instance._collect_tool_methods()
    assert 'chroma.search' in methods
    assert 'chroma.upsert' in methods
    assert 'chroma.delete' in methods


def test_collect_tool_methods_default_when_no_globals() -> None:
    class Orphan(VectorStoreToolMixin, _StubIInstanceBase):
        pass

    orphan = Orphan()
    orphan.IGlobal = None
    methods = orphan._collect_tool_methods()
    # Falls all the way back to 'vectordb'
    assert set(methods.keys()) == {'vectordb.search', 'vectordb.upsert', 'vectordb.delete'}


def test_two_instances_different_server_names_do_not_collide() -> None:
    """Core bug: two pinecone instances in one pipeline must not collide."""
    a = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='primary', logical_type='pinecone'))
    b = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='secondary', logical_type='pinecone'))

    names_a = set(a._collect_tool_methods().keys())
    names_b = set(b._collect_tool_methods().keys())
    assert names_a.isdisjoint(names_b)
    assert 'primary.search' in names_a
    assert 'secondary.search' in names_b


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------


def test_search_uses_keyword_when_no_embedding_provider() -> None:
    _fresh_warnings()
    store = FakeStore(keyword_docs=[_StubDoc(page_content='cat', score=0.9, metadata=_StubDocMetadata(objectId='d1'))])
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    result = instance.search({'query': 'cat'})

    assert store.semantic_calls == []
    assert len(store.keyword_calls) == 1
    assert result['total'] == 1
    assert result['results'][0]['content'] == 'cat'
    # Warns exactly once about keyword-only mode
    assert sum(1 for w in _WARNINGS if 'keyword-only mode' in w) == 1


def test_search_warns_only_once_across_calls() -> None:
    _fresh_warnings()
    store = FakeStore()
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    instance.search({'query': 'a'})
    instance.search({'query': 'b'})
    instance.search({'query': 'c'})

    assert sum(1 for w in _WARNINGS if 'keyword-only mode' in w) == 1


def test_search_uses_semantic_when_embed_query_present() -> None:
    embed_calls: List[str] = []

    def embed_query(text: str) -> list:
        embed_calls.append(text)
        return [0.1, 0.2, 0.3]

    store = FakeStore(semantic_docs=[_StubDoc(page_content='dog', score=0.8, metadata=_StubDocMetadata(objectId='d2'))])
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb', embed_query=embed_query, embed_model_name='test-model'))

    result = instance.search({'query': 'dog'})

    assert embed_calls == ['dog']
    assert len(store.semantic_calls) == 1
    assert store.keyword_calls == []
    # The question passed to searchSemantic must have embedding populated
    question, _ = store.semantic_calls[0]
    assert question.embedding == [0.1, 0.2, 0.3]
    assert question.embedding_model == 'test-model'
    assert result['total'] == 1


def test_search_empty_query_raises() -> None:
    instance = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='vdb'))
    try:
        instance.search({'query': ''})
    except ValueError as e:
        assert 'non-empty' in str(e)
    else:
        raise AssertionError('Expected ValueError for empty query')


def test_search_falls_back_to_keyword_on_semantic_exception() -> None:
    _fresh_warnings()
    store = FakeStore(keyword_docs=[_StubDoc(page_content='kw', score=0.5, metadata=_StubDocMetadata(objectId='d1'))])
    store.raise_semantic = RuntimeError('index missing')
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb', embed_query=lambda _t: [0.0, 0.1]))

    result = instance.search({'query': 'hello'})

    assert len(store.semantic_calls) == 1
    assert len(store.keyword_calls) == 1
    assert result['total'] == 1
    assert any('semantic search failed' in w for w in _WARNINGS)


def test_search_raises_when_store_missing() -> None:
    instance = FakeIInstance(FakeIGlobal(store=None, server_name='vdb'))
    try:
        instance.search({'query': 'x'})
    except RuntimeError as e:
        assert 'store not initialized' in str(e)
    else:
        raise AssertionError('Expected RuntimeError when store is None')


def test_upsert_adds_chunks() -> None:
    store = FakeStore()
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    result = instance.upsert(
        {
            'documents': [
                {'content': 'doc one text', 'object_id': 'obj-1'},
                {'content': 'doc two', 'object_id': 'obj-2', 'metadata': {'nodeId': 'foo', 'parent': '/p'}},
            ]
        }
    )

    assert result == {'success': True, 'count': 2, 'skipped': 0}
    assert len(store.added_chunks) == 1
    chunks = store.added_chunks[0]
    assert len(chunks) == 2
    assert chunks[0].metadata.objectId == 'obj-1'
    assert chunks[1].metadata.nodeId == 'foo'
    assert chunks[1].metadata.parent == '/p'


def test_upsert_skips_invalid_entries() -> None:
    store = FakeStore()
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    result = instance.upsert(
        {
            'documents': [
                {'content': 'valid', 'object_id': 'obj-1'},
                {'content': '', 'object_id': 'obj-2'},  # missing content
                {'content': 'text', 'object_id': ''},  # missing id
                'not a dict',
            ]
        }
    )
    assert result['success'] is True
    assert result['count'] == 1
    assert result['skipped'] == 3


def test_upsert_requires_documents() -> None:
    instance = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='vdb'))
    try:
        instance.upsert({'documents': []})
    except ValueError as e:
        assert 'non-empty' in str(e) or 'documents' in str(e)
    else:
        raise AssertionError('Expected ValueError on empty documents')


def test_delete_calls_store_remove() -> None:
    store = FakeStore()
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    result = instance.delete({'object_ids': ['a', 'b', 'c']})

    assert result == {'success': True, 'deleted_count': 3}
    assert store.removed_ids == [['a', 'b', 'c']]


def test_delete_strips_whitespace_and_drops_empty() -> None:
    store = FakeStore()
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='vdb'))

    result = instance.delete({'object_ids': ['  id-1 ', '', '   ', 'id-2']})
    assert result == {'success': True, 'deleted_count': 2}
    assert store.removed_ids == [['id-1', 'id-2']]


def test_delete_requires_object_ids() -> None:
    instance = FakeIInstance(FakeIGlobal(store=FakeStore(), server_name='vdb'))
    try:
        instance.delete({'object_ids': []})
    except ValueError as e:
        assert 'object_ids' in str(e)
    else:
        raise AssertionError('Expected ValueError on empty object_ids')


def test_dispatch_via_namespaced_name() -> None:
    """End-to-end: _collect_tool_methods -> lookup -> invoke via namespaced key."""
    store = FakeStore(keyword_docs=[_StubDoc(page_content='hit', score=1.0, metadata=_StubDocMetadata(objectId='o1'))])
    instance = FakeIInstance(FakeIGlobal(store=store, server_name='pinecone'))

    methods = instance._collect_tool_methods()
    assert 'pinecone.search' in methods

    # Simulate engine dispatch: methods[tool_name](input_obj)
    result = methods['pinecone.search']({'query': 'hit'})
    assert result['total'] == 1
    assert result['results'][0]['content'] == 'hit'


def test_normalize_handles_nested_input_with_security_context() -> None:
    result = _normalize_vectordb_tool_input({'input': {'query': 'x', 'security_context': {'user': 'root'}}})
    assert result == {'query': 'x'}
