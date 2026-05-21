# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for the search_hybrid node: the BM25/RRF engine and IInstance contract.

The build interpreter (``builder nodes:test``) provides ``rocketlib``,
``ai.common.schema`` and ``depends``. The node source is not on the
interpreter's import path by default, so -- like every other node suite
(chunker, local_text_output, milvus, pinecone, tool_git, ...) -- we prepend
``nodes/src/nodes`` and import the ``search_hybrid.*`` package by name. There is
no skip fallback: outside the build interpreter the ``rocketlib`` import fails
and collection errors out, by design.

``rank_bm25`` is a third-party PyPI compute library (resolved at runtime by
``depends()`` on the build interpreter), not a framework module. Like the
openai / elasticsearch mocks, we install the project's faithful mock from
``nodes/test/mocks/rank_bm25/`` when the real package is absent so the engine
can be unit-tested in isolation. It is the only stub installed here --
``rocketlib`` / ``ai.*`` / ``depends`` are provided and NOT stubbed.

Usage:
    python -m pytest nodes/test/search_hybrid/ -v
"""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Put nodes/src/nodes on sys.path so the search_hybrid package imports by name
# (file-path-based imports bypass interpreter path configuration). The node
# package's IInstance/IGlobal pull in the real rocketlib / ai.* modules from
# the build interpreter.
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve().parent
_NODES_SRC = _HERE.parent.parent / 'src' / 'nodes'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


# ---------------------------------------------------------------------------
# rank_bm25 is a PyPI dependency resolved at runtime by `depends()` on the
# build interpreter. For unit-testing the engine in isolation we load the
# project's third-party mock from nodes/test/mocks/rank_bm25/ (the same
# directory the integration runner puts on sys.path via ROCKETRIDE_MOCK) and
# install it as `rank_bm25`. This is the only stub the test installs --
# rocketlib / ai.* / depends are provided by the build interpreter and are
# NOT stubbed here.
# ---------------------------------------------------------------------------

_MOCKS_DIR = _HERE.parent / 'mocks'


def _load_rank_bm25_mock():
    """Load the rank_bm25 mock module from nodes/test/mocks/rank_bm25/."""
    spec = importlib.util.spec_from_file_location('rank_bm25', str(_MOCKS_DIR / 'rank_bm25' / '__init__.py'))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Track our stub so the module-scoped teardown below can distinguish a
# stub we installed from a real ``rank_bm25`` that was already present.
_RANK_BM25_STUB_TOKEN = object()


def _install_bm25_stub_for_session():
    """Install the rank_bm25 mock only when the real package is missing.

    Returns ``True`` if this call installed the mock (and therefore owns
    its removal), ``False`` if the real package was already importable.
    """
    if 'rank_bm25' in sys.modules:
        return False
    stub = _load_rank_bm25_mock()
    stub.__rank_bm25_test_stub__ = _RANK_BM25_STUB_TOKEN
    sys.modules['rank_bm25'] = stub
    return True


@pytest.fixture(scope='module', autouse=True)
def _rank_bm25_stub_module():
    """Ensure the mock we install gets removed when this module finishes.

    ``hybrid_search.py`` does ``from rank_bm25 import BM25Okapi`` lazily
    inside ``bm25_search``, so the mock must remain installed for the
    duration of the engine tests in this file. Using module scope (rather
    than session scope) means the mock is removed as soon as this test
    file is done, so unrelated test modules later in the same pytest run
    do not see our stand-in.
    """
    owns_stub = _install_bm25_stub_for_session()
    try:
        yield
    finally:
        if owns_stub:
            mod = sys.modules.get('rank_bm25')
            if getattr(mod, '__rank_bm25_test_stub__', None) is _RANK_BM25_STUB_TOKEN:
                sys.modules.pop('rank_bm25', None)


# The engine module needs to be importable at module-load time so individual
# test classes can reference ``HybridSearchEngine`` directly. Install the
# mock eagerly (the module-scoped fixture above guarantees teardown).
_install_bm25_stub_for_session()

from search_hybrid.hybrid_search import HybridSearchEngine  # noqa: E402


# ===========================================================================
# Sample test data
# ===========================================================================

SAMPLE_DOCS = [
    {'id': 'doc1', 'text': 'Machine learning is a subset of artificial intelligence.'},
    {'id': 'doc2', 'text': 'Deep learning uses neural networks with many layers.'},
    {'id': 'doc3', 'text': 'Natural language processing handles text and speech.'},
    {'id': 'doc4', 'text': 'Computer vision analyzes images and video content.'},
    {'id': 'doc5', 'text': 'Reinforcement learning trains agents through rewards.'},
]


# ===========================================================================
# BM25 search
# ===========================================================================


class TestBM25Search:
    def test_keyword_matching(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('machine learning', SAMPLE_DOCS, top_k=5)
        assert len(results) > 0
        assert results[0]['id'] == 'doc1'

    def test_ranking_order(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('neural networks deep learning', SAMPLE_DOCS, top_k=5)
        assert len(results) > 0
        scores = [r['bm25_score'] for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_empty_query(self):
        engine = HybridSearchEngine(alpha=0.5)
        assert engine.bm25_search('', SAMPLE_DOCS) == []

    def test_empty_documents(self):
        engine = HybridSearchEngine(alpha=0.5)
        assert engine.bm25_search('machine learning', []) == []

    def test_top_k_limit(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('learning', SAMPLE_DOCS, top_k=2)
        assert len(results) <= 2

    def test_bm25_score_present(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('learning', SAMPLE_DOCS, top_k=5)
        for r in results:
            assert 'bm25_score' in r
            assert isinstance(r['bm25_score'], float)

    def test_no_matching_terms(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('xyz123abc', SAMPLE_DOCS, top_k=5)
        assert isinstance(results, list)


# ===========================================================================
# Reciprocal Rank Fusion
# ===========================================================================


class TestReciprocalRankFusion:
    def test_merge_two_ranked_lists(self):
        list1 = [
            {'id': 'a', 'text': 'doc a'},
            {'id': 'b', 'text': 'doc b'},
            {'id': 'c', 'text': 'doc c'},
        ]
        list2 = [
            {'id': 'c', 'text': 'doc c'},
            {'id': 'a', 'text': 'doc a'},
            {'id': 'd', 'text': 'doc d'},
        ]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        assert len(results) == 4  # a, b, c, d
        for r in results:
            assert 'rrf_score' in r

    def test_deduplication(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'a', 'text': 'doc a'}, {'id': 'c', 'text': 'doc c'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        ids = [r['id'] for r in results]
        assert len(ids) == len(set(ids))

    def test_rrf_score_accumulation(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'a', 'text': 'doc a'}, {'id': 'c', 'text': 'doc c'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        result_map = {r['id']: r['rrf_score'] for r in results}
        assert result_map['a'] > result_map['b']
        assert result_map['a'] > result_map['c']

    def test_k_parameter_effect(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        results_small_k = HybridSearchEngine.reciprocal_rank_fusion(list1, k=1)
        results_large_k = HybridSearchEngine.reciprocal_rank_fusion(list1, k=1000)
        small_k_diff = results_small_k[0]['rrf_score'] - results_small_k[1]['rrf_score']
        large_k_diff = results_large_k[0]['rrf_score'] - results_large_k[1]['rrf_score']
        assert small_k_diff > large_k_diff

    def test_empty_lists(self):
        results = HybridSearchEngine.reciprocal_rank_fusion([], [])
        assert results == []

    def test_single_list(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, k=60)
        assert len(results) == 2
        assert results[0]['rrf_score'] > results[1]['rrf_score']

    def test_ties_handled(self):
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        assert len(results) == 2
        assert results[0]['rrf_score'] == results[1]['rrf_score']

    def test_alpha_weighted_rrf(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'b', 'text': 'doc b'}, {'id': 'a', 'text': 'doc a'}]
        results_weighted = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[0.8, 0.2])
        score_map = {r['id']: r['rrf_score'] for r in results_weighted}
        assert score_map['a'] > score_map['b']

    def test_alpha_weighted_rrf_reversed(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'b', 'text': 'doc b'}, {'id': 'a', 'text': 'doc a'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[0.2, 0.8])
        score_map = {r['id']: r['rrf_score'] for r in results}
        assert score_map['b'] > score_map['a']

    def test_equal_weights_match_unweighted(self):
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'c', 'text': 'doc c'}, {'id': 'a', 'text': 'doc a'}]
        results_unweighted = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        results_weighted = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[1.0, 1.0])
        scores_unweighted = {r['id']: r['rrf_score'] for r in results_unweighted}
        scores_weighted = {r['id']: r['rrf_score'] for r in results_weighted}
        for doc_id in scores_unweighted:
            assert abs(scores_unweighted[doc_id] - scores_weighted[doc_id]) < 1e-10

    def test_weights_length_mismatch_raises(self):
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        with pytest.raises(ValueError, match='weights length must match'):
            HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[0.5])

    def test_anonymous_docs_do_not_collide_across_lists(self):
        """Two docs missing `id` and `text` in separate lists must keep separate identities.

        Regression for the fallback id `__unnamed_{rank}` colliding across the
        vector and BM25 result lists at the same rank (CodeRabbit major).
        """
        list1 = [{'something': 'one'}]  # rank 0, no id, no text
        list2 = [{'something': 'two'}]  # rank 0, no id, no text
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        # Both anonymous docs should survive -- no accidental dedup
        assert len(results) == 2
        seen = {tuple(sorted(d.items())) for d in [{'something': 'one'}, {'something': 'two'}]}
        got = {tuple(sorted((k, v) for k, v in r.items() if k != 'rrf_score')) for r in results}
        assert got == seen


# ===========================================================================
# Full hybrid search
# ===========================================================================


class TestFullHybridSearch:
    def test_balanced_search(self):
        engine = HybridSearchEngine(alpha=0.5)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert 0 < len(results) <= 5

    def test_bm25_only(self):
        engine = HybridSearchEngine(alpha=0.0)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert results[0]['id'] == 'doc1'

    def test_vector_only(self):
        engine = HybridSearchEngine(alpha=1.0)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('anything', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert results[0]['id'] == 'doc1'

    def test_no_vector_scores(self):
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=None, top_k=5)
        assert len(results) > 0

    def test_empty_documents(self):
        engine = HybridSearchEngine(alpha=0.5)
        assert engine.search('machine learning', [], top_k=5) == []

    def test_alpha_validation(self):
        with pytest.raises(ValueError, match='alpha must be between'):
            HybridSearchEngine(alpha=-0.1)
        with pytest.raises(ValueError, match='alpha must be between'):
            HybridSearchEngine(alpha=1.1)

    def test_top_k_respected(self):
        engine = HybridSearchEngine(alpha=0.5)
        vector_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        results = engine.search('learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=2)
        assert len(results) <= 2

    def test_alpha_weights_vector_higher(self):
        vector_scores = [0.1, 0.2, 0.3, 0.4, 0.9]
        engine_vec = HybridSearchEngine(alpha=0.8)
        results_heavy = engine_vec.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        engine_bm25 = HybridSearchEngine(alpha=0.2)
        results_bm25 = engine_bm25.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        heavy_ids = [r['id'] for r in results_heavy]
        bm25_ids = [r['id'] for r in results_bm25]
        doc5_rank_heavy = heavy_ids.index('doc5') if 'doc5' in heavy_ids else len(heavy_ids)
        doc5_rank_bm25 = bm25_ids.index('doc5') if 'doc5' in bm25_ids else len(bm25_ids)
        assert doc5_rank_heavy <= doc5_rank_bm25


# ===========================================================================
# Deep-copy / mutation prevention
# ===========================================================================


class TestDeepCopyPrevention:
    def test_bm25_does_not_mutate_input(self):
        engine = HybridSearchEngine(alpha=0.5)
        docs = copy.deepcopy(SAMPLE_DOCS)
        original = copy.deepcopy(docs)
        engine.bm25_search('machine learning', docs, top_k=5)
        assert docs == original

    def test_rrf_does_not_mutate_input(self):
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        original_list1 = copy.deepcopy(list1)
        original_list2 = copy.deepcopy(list2)
        HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        assert list1 == original_list1
        assert list2 == original_list2

    def test_hybrid_search_does_not_mutate_input(self):
        engine = HybridSearchEngine(alpha=0.5)
        docs = copy.deepcopy(SAMPLE_DOCS)
        original = copy.deepcopy(docs)
        engine.search('machine learning', docs, vector_scores=[0.9, 0.1, 0.5, 0.3, 0.7], top_k=5)
        assert docs == original

    def test_bm25_result_mutation_does_not_leak_into_input(self):
        """Deep-copy guarantees nested mutation of results cannot affect inputs."""
        engine = HybridSearchEngine(alpha=0.5)
        docs = [{'id': '1', 'text': 'hello world', 'metadata': {'tag': 'orig'}}]
        results = engine.bm25_search('hello', docs, top_k=1)
        results[0]['metadata']['tag'] = 'mutated'
        assert docs[0]['metadata']['tag'] == 'orig'

    def test_rrf_result_mutation_does_not_leak_into_input(self):
        docs = [{'id': '1', 'text': 'x', 'metadata': {'tag': 'orig'}}]
        results = HybridSearchEngine.reciprocal_rank_fusion(docs, k=60)
        results[0]['metadata']['tag'] = 'mutated'
        assert docs[0]['metadata']['tag'] == 'orig'


# ===========================================================================
# Tokenizer
# ===========================================================================


class TestTokenizer:
    def test_lowercases_text(self):
        tokens = HybridSearchEngine._tokenize('Hello WORLD')
        assert 'hello' in tokens and 'world' in tokens

    def test_strips_punctuation(self):
        tokens = HybridSearchEngine._tokenize('Hello, world! How are you?')
        assert all(t.isalnum() for t in tokens)

    def test_empty_text(self):
        assert HybridSearchEngine._tokenize('') == []
        assert HybridSearchEngine._tokenize(None) == []

    def test_splits_on_non_word(self):
        tokens = HybridSearchEngine._tokenize('machine-learning is great')
        assert {'machine', 'learning', 'is', 'great'}.issubset(set(tokens))


# ===========================================================================
# IGlobal alpha-clamp warning
# ===========================================================================
#
# The build interpreter provides `rocketlib`, `ai.*`, and `depends`; the
# search_hybrid package imports them for real. Import the node by package name
# (file-path-based imports bypass interpreter path configuration).


class TestIGlobalAlphaClamp:
    """alpha out of range should be clamped AND warned (not silently coerced).

    The engine-level invariant is already covered by
    ``TestFullHybridSearch.test_alpha_validation`` (rejects alpha<0 / alpha>1
    constructor args). This test additionally pins that the IGlobal
    out-of-range path clamps the value and emits a warning via rocketlib.

    Implementation note: the warning is captured by patching the IGlobal
    module's ``warning`` attribute through the module dict directly, rather
    than monkeypatch.setattr -- the build interpreter exposes the IGlobal
    module under a path that monkeypatch resolves to the class object, not
    the module.
    """

    def test_alpha_clamp_logs_warning(self):
        import importlib
        import types

        # Import the IGlobal *module* (not the re-exported class) so we can patch
        # its module-level ``warning`` symbol. ``search_hybrid.__init__`` binds
        # ``IGlobal`` to the class, so ``importlib.import_module`` is used to get
        # the submodule object reliably.
        iglobal_mod = importlib.import_module('search_hybrid.IGlobal')

        warnings_seen: list = []
        original = iglobal_mod.warning
        iglobal_mod.warning = lambda msg, *a, **kw: warnings_seen.append(msg)
        try:
            IGlobal = iglobal_mod.IGlobal
            ig = IGlobal.__new__(IGlobal)

            from rocketlib import OPEN_MODE

            class _Endpoint:
                class endpoint:
                    openMode = OPEN_MODE.RUN if hasattr(OPEN_MODE, 'RUN') else 'run'

            ig.IEndpoint = _Endpoint
            ig.glb = types.SimpleNamespace(logicalType='search_hybrid', connConfig={'alpha': 2.5})

            ig.beginGlobal()

            assert any('alpha' in m for m in warnings_seen), warnings_seen
            assert ig.engine is not None
            assert ig.engine.alpha == 1.0
        finally:
            iglobal_mod.warning = original

    @pytest.mark.parametrize(
        'bad_cfg, fragment',
        [
            ({'top_k': 0}, 'top_k'),
            ({'top_k': -1}, 'top_k'),
            ({'rrf_k': -1}, 'rrf_k'),
        ],
    )
    def test_invalid_bounds_raise_value_error(self, bad_cfg, fragment):
        """Out-of-range top_k / rrf_k should fail fast in beginGlobal."""
        import types

        from rocketlib import OPEN_MODE

        ig = IGlobal.__new__(IGlobal)

        class _Endpoint:
            class endpoint:
                openMode = OPEN_MODE.RUN if hasattr(OPEN_MODE, 'RUN') else 'run'

        ig.IEndpoint = _Endpoint
        ig.glb = types.SimpleNamespace(logicalType='search_hybrid', connConfig=bad_cfg)

        with pytest.raises(ValueError) as exc:
            ig.beginGlobal()
        assert fragment in str(exc.value)


# ===========================================================================
# IInstance integration (writeQuestions contract)
# ===========================================================================
#
# Restored from the original test/nodes/test_search_hybrid.py
# TestIInstanceIntegration class that was dropped during the relocation to
# nodes/test/search_hybrid/. These tests pin the post-fix IInstance contract:
#
#   - writeAnswers takes a SINGLE Answer (commit c7994358),
#   - hasListener('documents') / hasListener('answers') gate emission,
#   - engine is None raises RuntimeError,
#   - the input Question is deep-copied (no caller-side mutation),
#   - empty query / empty documents short-circuit cleanly,
#   - the structured answer text uses the [Document N] (score: ...) shape.
#
# The build interpreter (`builder nodes:test`) ships rocketlib / ai.* / depends.
# Those are provided modules and are NOT stubbed -- the node package imports
# them for real. We import IInstance / IGlobal and the schema types by package
# name; outside the build interpreter the import fails and collection errors
# out, by design.

from search_hybrid.IGlobal import IGlobal  # noqa: E402
from search_hybrid.IInstance import IInstance  # noqa: E402
from ai.common.schema import Answer, Doc, Question, QuestionText  # noqa: E402


@pytest.fixture
def search_hybrid_pkg():
    """Expose the IInstance class plus the real schema types for the tests.

    Yields a SimpleNamespace exposing the node ``IInstance`` class, the real
    schema types (``Doc``, ``Question``, ``Answer``, ``QuestionText``) and an
    ``make_instance`` helper so each test can build inputs without re-defining
    them. The framework modules (``rocketlib``, ``ai.*``, ``depends``) come from
    the build interpreter and are imported, not stubbed.
    """
    import types

    def make_instance(engine, top_k=10, rrf_k=60):
        """Build an IInstance with a mock IGlobal/engine and a mock pipeline."""
        inst = IInstance.__new__(IInstance)
        iglobal = MagicMock(spec=IGlobal)
        iglobal.engine = engine
        iglobal.top_k = top_k
        iglobal.rrf_k = rrf_k
        inst.IGlobal = iglobal
        mock_instance = MagicMock()
        inst.instance = mock_instance
        return inst, mock_instance

    return types.SimpleNamespace(
        IInstance=IInstance,
        Doc=Doc,
        Question=Question,
        Answer=Answer,
        # `Question.questions` holds QuestionText entries (each exposing `.text`).
        SubQuestion=QuestionText,
        make_instance=make_instance,
    )


class TestIInstanceIntegration:
    """writeQuestions contract for the search_hybrid IInstance."""

    def test_raises_runtime_error_when_engine_is_none(self, search_hybrid_pkg):
        """RuntimeError should be raised when engine is None."""
        pkg = search_hybrid_pkg
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='test query')],
            documents=[pkg.Doc(page_content='some text', score=0.9)],
        )
        inst, _ = pkg.make_instance(engine=None)
        with pytest.raises(RuntimeError, match='Hybrid search engine not initialized'):
            inst.writeQuestions(question)

    def test_deep_copy_prevents_question_mutation(self, search_hybrid_pkg):
        """Deep copy should prevent mutation of the original question object."""
        pkg = search_hybrid_pkg
        docs = [
            pkg.Doc(page_content='Machine learning is great.', score=0.9, metadata=None),
            pkg.Doc(page_content='Deep learning is powerful.', score=0.7, metadata=None),
        ]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        original_doc_count = len(question.documents)
        original_first_content = question.documents[0].page_content

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = False

        inst.writeQuestions(question)

        # Original question must not be mutated by the deepcopy inside IInstance
        assert len(question.documents) == original_doc_count
        assert question.documents[0].page_content == original_first_content

    def test_structured_answer_output(self, search_hybrid_pkg):
        """Answer text should use the structured [Document N] (score: ...) shape.

        CHANGED FROM ORIGINAL: the original asserted ``writeAnswers`` received a
        ``list[Answer]`` and indexed ``answers[0]``. The post-fix contract
        (commit c7994358) is that writeAnswers is invoked with a SINGLE Answer,
        so we now assert on that shape directly. The textual structure
        assertions are preserved verbatim.
        """
        pkg = search_hybrid_pkg
        docs = [
            pkg.Doc(page_content='Machine learning is a subset of AI.', score=0.9, metadata=None),
            pkg.Doc(page_content='Deep learning uses neural networks.', score=0.7, metadata=None),
        ]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = True

        inst.writeQuestions(question)

        assert mock_instance.writeAnswers.called
        # writeAnswers takes a single Answer (NOT a list) -- the previously-fixed
        # bug. Pin the new contract so a regression to list-shape is caught.
        call_args, call_kwargs = mock_instance.writeAnswers.call_args
        assert call_kwargs == {}
        assert len(call_args) == 1
        ans = call_args[0]
        assert isinstance(ans, pkg.Answer), f'expected single Answer, got {type(ans).__name__}'
        # The node sets a plain-text answer via ``Answer.setAnswer(...)`` (the
        # real model has no ``getAnswer``); read it back from the ``answer``
        # field, mirroring how the framework persists the response.
        answer_text = ans.answer

        # Structured format -- not raw concatenation
        assert 'Hybrid search returned' in answer_text
        assert 'results' in answer_text
        assert '[Document 1]' in answer_text
        # Score should contain actual numeric values, not 'N/A'
        assert '(score:' in answer_text
        assert 'N/A' not in answer_text

    def test_emits_reranked_documents(self, search_hybrid_pkg):
        """Emit reranked documents when the 'documents' listener exists."""
        pkg = search_hybrid_pkg
        docs = [
            pkg.Doc(page_content='First document about ML.', score=0.5, metadata=None),
            pkg.Doc(page_content='Second document about deep learning.', score=0.9, metadata=None),
        ]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='deep learning')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = True

        inst.writeQuestions(question)

        assert mock_instance.writeDocuments.called
        emitted_docs = mock_instance.writeDocuments.call_args[0][0]
        assert len(emitted_docs) > 0

    def test_listener_gating_documents_only(self, search_hybrid_pkg):
        """Only the listened lane should receive emissions.

        With only `documents` listened, writeDocuments fires and writeAnswers
        does NOT -- pinning the per-lane hasListener gate.
        """
        pkg = search_hybrid_pkg
        docs = [pkg.Doc(page_content='hello world', score=0.5, metadata=None)]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='hello')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.side_effect = lambda lane: lane == 'documents'

        inst.writeQuestions(question)

        assert mock_instance.writeDocuments.called
        assert not mock_instance.writeAnswers.called

    def test_listener_gating_answers_only(self, search_hybrid_pkg):
        """With only the 'answers' lane listened, writeDocuments stays silent."""
        pkg = search_hybrid_pkg
        docs = [pkg.Doc(page_content='hello world', score=0.5, metadata=None)]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='hello')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.side_effect = lambda lane: lane == 'answers'

        inst.writeQuestions(question)

        assert not mock_instance.writeDocuments.called
        assert mock_instance.writeAnswers.called

    def test_skips_empty_query(self, search_hybrid_pkg):
        """Should skip hybrid search when query text is empty."""
        pkg = search_hybrid_pkg
        docs = [pkg.Doc(page_content='Some doc.', score=0.5, metadata=None)]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)

        inst.writeQuestions(question)

        assert not mock_instance.writeDocuments.called
        assert not mock_instance.writeAnswers.called

    def test_skips_empty_documents(self, search_hybrid_pkg):
        """Should skip hybrid search when no documents are attached."""
        pkg = search_hybrid_pkg
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='test query')],
            documents=[],
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)

        inst.writeQuestions(question)

        assert not mock_instance.writeDocuments.called
        assert not mock_instance.writeAnswers.called
