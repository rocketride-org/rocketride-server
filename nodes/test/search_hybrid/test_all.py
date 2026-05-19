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

"""Tests for the search_hybrid node.

These tests cover the pure-Python HybridSearchEngine (BM25, RRF, full hybrid).
The IInstance integration path is exercised by the services.json `test` block
through the dynamic test runner (see `nodes/test/test_dynamic.py`), so we keep
this file focused on the engine and avoid stubbing the framework types.

Usage:
    python -m pytest nodes/test/search_hybrid/ -v
"""

from __future__ import annotations

import copy
import importlib.util
import sys
import types
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Locate hybrid_search.py
# ---------------------------------------------------------------------------

_HERE = Path(__file__).resolve().parent
_SEARCH_HYBRID_DIR = _HERE.parent.parent / 'src' / 'nodes' / 'search_hybrid'
_HYBRID_PATH = _SEARCH_HYBRID_DIR / 'hybrid_search.py'


# ---------------------------------------------------------------------------
# rank_bm25 is a PyPI dependency resolved at runtime by `depends()` on the
# build interpreter. For unit-testing the engine in isolation we provide a
# minimal stand-in that produces a TF-IDF-ish score order. This is the only
# stub the test installs — rocketlib / ai.* / depends are intentionally NOT
# stubbed because the engine module does not import them.
# ---------------------------------------------------------------------------


def _install_bm25_stub():
    if 'rank_bm25' in sys.modules:
        return

    rank_bm25 = types.ModuleType('rank_bm25')

    class BM25Okapi:
        """Minimal stand-in for rank_bm25.BM25Okapi used only in tests."""

        def __init__(self, corpus):
            self.corpus = corpus
            self.doc_count = len(corpus)
            self.doc_freqs: dict = {}
            for doc_tokens in corpus:
                for token in set(doc_tokens):
                    self.doc_freqs[token] = self.doc_freqs.get(token, 0) + 1

        def get_scores(self, query_tokens):
            scores = []
            for doc_tokens in self.corpus:
                token_counts: dict = {}
                for t in doc_tokens:
                    token_counts[t] = token_counts.get(t, 0) + 1
                score = 0.0
                for qt in query_tokens:
                    if qt in token_counts:
                        tf = token_counts[qt]
                        df = self.doc_freqs.get(qt, 1)
                        idf = max(0.1, (self.doc_count - df + 0.5) / (df + 0.5))
                        score += tf * idf
                scores.append(score)
            return scores

    rank_bm25.BM25Okapi = BM25Okapi
    sys.modules['rank_bm25'] = rank_bm25


_install_bm25_stub()


def _load_hybrid_search():
    spec = importlib.util.spec_from_file_location('hybrid_search', _HYBRID_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hybrid_mod = _load_hybrid_search()
HybridSearchEngine = hybrid_mod.HybridSearchEngine


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
        # Both anonymous docs should survive — no accidental dedup
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


# The build interpreter provides `rocketlib`, `ai.*`, and `depends`. When this
# test file is executed under plain pytest those modules are absent — skip the
# IGlobal/IInstance tests rather than stubbing the framework.
_HAS_ROCKETLIB = importlib.util.find_spec('rocketlib') is not None


@pytest.mark.skipif(not _HAS_ROCKETLIB, reason='rocketlib not available outside build interpreter')
class TestIGlobalAlphaClamp:
    """alpha out of range should be clamped AND warned (not silently coerced)."""

    def test_alpha_clamp_logs_warning(self, monkeypatch):
        # Load IGlobal using the real ai.common.config / rocketlib types
        sys.path.insert(0, str(_SEARCH_HYBRID_DIR.parent.parent))
        try:
            from nodes.search_hybrid.IGlobal import IGlobal  # type: ignore
            import nodes.search_hybrid.IGlobal as iglobal_mod  # type: ignore
        except Exception as e:  # pragma: no cover - env-dependent
            pytest.skip(f'IGlobal not importable under this interpreter: {e}')

        warnings_seen: list = []
        monkeypatch.setattr(iglobal_mod, 'warning', lambda msg, *a, **kw: warnings_seen.append(msg))

        # Build a fake config object that triggers the out-of-range path
        ig = IGlobal.__new__(IGlobal)
        # Force the non-CONFIG branch via a minimal stand-in
        from rocketlib import OPEN_MODE  # type: ignore

        class _Endpoint:
            class endpoint:
                openMode = OPEN_MODE.RUN if hasattr(OPEN_MODE, 'RUN') else 'run'

        ig.IEndpoint = _Endpoint
        ig.glb = types.SimpleNamespace(logicalType='search_hybrid', connConfig={'alpha': 2.5})

        try:
            ig.beginGlobal()
        except Exception as e:  # pragma: no cover - env-dependent
            pytest.skip(f'beginGlobal not directly invokable in this env: {e}')

        assert any('alpha' in m for m in warnings_seen), warnings_seen
        assert ig.engine is not None
        assert ig.engine.alpha == 1.0


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
#   - the structured answer text uses the [Document N] (score: …) shape.
#
# The build interpreter (`builder nodes:test`) ships rocketlib / ai.* / depends;
# under plain `pytest` those are stubbed by the search_hybrid_pkg fixture so
# the same tests still run end-to-end. If IInstance ever picks up an import we
# can't stub, the fixture skips rather than failing — same pattern as the
# rerank_cohere `rerank_pkg` fixture.


@pytest.fixture
def search_hybrid_pkg():
    """Load search_hybrid.IInstance with framework stubs installed.

    Yields a SimpleNamespace exposing the loaded ``IInstance`` class plus the
    stubbed schema types (``Doc``, ``Question``, ``Answer``, ``SubQuestion``)
    so each test can build inputs without re-defining them. On teardown the
    fixture restores any modules it shadowed in ``sys.modules``.
    """
    from unittest.mock import MagicMock

    stub_names = [
        'rocketlib',
        'ai',
        'ai.common',
        'ai.common.config',
        'ai.common.schema',
        'depends',
    ]
    saved = {name: sys.modules.get(name) for name in stub_names}

    # --- rocketlib -------------------------------------------------------
    rocketlib_stub = types.ModuleType('rocketlib')

    class IGlobalBase:
        pass

    class IInstanceBase:
        pass

    class OPEN_MODE:
        CONFIG = 'config'
        RUN = 'run'

    rocketlib_stub.IGlobalBase = IGlobalBase
    rocketlib_stub.IInstanceBase = IInstanceBase
    rocketlib_stub.OPEN_MODE = OPEN_MODE
    rocketlib_stub.warning = lambda *a, **kw: None
    rocketlib_stub.debug = lambda *a, **kw: None
    sys.modules['rocketlib'] = rocketlib_stub

    # --- ai.common.{config,schema} ---------------------------------------
    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []

    config_mod = types.ModuleType('ai.common.config')

    class Config:
        @staticmethod
        def getNodeConfig(logicalType, connConfig):
            return connConfig or {}

    config_mod.Config = Config

    schema_mod = types.ModuleType('ai.common.schema')

    class Doc:
        def __init__(self, **kwargs):
            self.page_content = kwargs.get('page_content')
            self.metadata = kwargs.get('metadata')
            self.score = kwargs.get('score')
            for k, v in kwargs.items():
                setattr(self, k, v)

    class Question:
        def __init__(self, **kwargs):
            self.questions = kwargs.get('questions', [])
            self.documents = kwargs.get('documents', [])

    class SubQuestion:
        def __init__(self, text=''):
            self.text = text

    class Answer:
        def __init__(self):
            self._answer = None

        def setAnswer(self, text):
            self._answer = text

        def getAnswer(self):
            return self._answer

    schema_mod.Doc = Doc
    schema_mod.Question = Question
    schema_mod.Answer = Answer

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *a, **kw: None

    sys.modules['ai'] = ai_pkg
    sys.modules['ai.common'] = ai_common
    sys.modules['ai.common.config'] = config_mod
    sys.modules['ai.common.schema'] = schema_mod
    sys.modules['depends'] = depends_mod

    # Drop any cached search_hybrid module loaded under a non-stubbed
    # environment so the fresh import below resolves the stubbed types.
    for mod_name in list(sys.modules.keys()):
        if 'search_hybrid' in mod_name and 'test' not in mod_name:
            del sys.modules[mod_name]

    # Load the search_hybrid package + IInstance directly by file path so the
    # tests do not depend on `nodes` being importable as a top-level package
    # (it isn't — there is no nodes/__init__.py or nodes/src/__init__.py). The
    # build interpreter (`builder nodes:test`) makes the same import work via
    # PYTHONPATH wiring; here we explicitly anchor on the source tree.
    try:
        pkg_init = _SEARCH_HYBRID_DIR / '__init__.py'
        pkg_spec = importlib.util.spec_from_file_location(
            'search_hybrid_test_pkg',
            str(pkg_init),
            submodule_search_locations=[str(_SEARCH_HYBRID_DIR)],
        )
        assert pkg_spec is not None and pkg_spec.loader is not None
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules['search_hybrid_test_pkg'] = pkg_mod
        pkg_spec.loader.exec_module(pkg_mod)

        # IGlobal is referenced via `from .IGlobal import IGlobal` in IInstance
        iglobal_spec = importlib.util.spec_from_file_location(
            'search_hybrid_test_pkg.IGlobal',
            str(_SEARCH_HYBRID_DIR / 'IGlobal.py'),
        )
        assert iglobal_spec is not None and iglobal_spec.loader is not None
        iglobal_mod = importlib.util.module_from_spec(iglobal_spec)
        sys.modules['search_hybrid_test_pkg.IGlobal'] = iglobal_mod
        iglobal_spec.loader.exec_module(iglobal_mod)

        iinst_spec = importlib.util.spec_from_file_location(
            'search_hybrid_test_pkg.IInstance',
            str(_SEARCH_HYBRID_DIR / 'IInstance.py'),
        )
        assert iinst_spec is not None and iinst_spec.loader is not None
        iinst_mod = importlib.util.module_from_spec(iinst_spec)
        sys.modules['search_hybrid_test_pkg.IInstance'] = iinst_mod
        iinst_spec.loader.exec_module(iinst_mod)
        IInstance = iinst_mod.IInstance
    except ModuleNotFoundError as exc:  # pragma: no cover - env-dependent
        pytest.skip(f'search_hybrid.IInstance not importable: {exc}')
    except TypeError as exc:  # pragma: no cover - py<3.10 hits PEP 604 syntax
        # IGlobal uses `X | None` annotations evaluated at class-body time,
        # which requires Python 3.10+. The build interpreter satisfies this;
        # under older local pythons we skip rather than fail.
        pytest.skip(f'search_hybrid.IInstance not importable (py<3.10?): {exc}')

    def make_instance(engine, top_k=10, rrf_k=60):
        """Build an IInstance with a mock IGlobal/engine and a mock pipeline."""
        inst = IInstance.__new__(IInstance)
        iglobal = MagicMock()
        iglobal.engine = engine
        iglobal.top_k = top_k
        iglobal.rrf_k = rrf_k
        inst.IGlobal = iglobal
        mock_instance = MagicMock()
        inst.instance = mock_instance
        return inst, mock_instance

    pkg = types.SimpleNamespace(
        IInstance=IInstance,
        Doc=Doc,
        Question=Question,
        Answer=Answer,
        SubQuestion=SubQuestion,
        make_instance=make_instance,
    )

    try:
        yield pkg
    finally:
        for name in stub_names:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        # Drop the file-loaded copies so a later test that does NOT use this
        # fixture (e.g. TestIGlobalAlphaClamp under the build interpreter)
        # sees the real package, not our stubbed reload.
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith('search_hybrid_test_pkg'):
                sys.modules.pop(mod_name, None)
            elif 'search_hybrid' in mod_name and 'test' not in mod_name:
                sys.modules.pop(mod_name, None)


class TestIInstanceIntegration:
    """writeQuestions contract for the search_hybrid IInstance."""

    def test_raises_runtime_error_when_engine_is_none(self, search_hybrid_pkg):
        """RuntimeError should be raised when engine is None."""
        pkg = search_hybrid_pkg
        question = pkg.Question(
            questions=[pkg.SubQuestion('test query')],
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
            questions=[pkg.SubQuestion('machine learning')],
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
        """Answer text should use the structured [Document N] (score: …) shape.

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
            questions=[pkg.SubQuestion('machine learning')],
            documents=docs,
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = True

        inst.writeQuestions(question)

        assert mock_instance.writeAnswers.called
        # writeAnswers takes a single Answer (NOT a list) — the previously-fixed
        # bug. Pin the new contract so a regression to list-shape is caught.
        call_args, call_kwargs = mock_instance.writeAnswers.call_args
        assert call_kwargs == {}
        assert len(call_args) == 1
        ans = call_args[0]
        assert isinstance(ans, pkg.Answer), f'expected single Answer, got {type(ans).__name__}'
        answer_text = ans.getAnswer()

        # Structured format — not raw concatenation
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
            questions=[pkg.SubQuestion('deep learning')],
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
        does NOT — pinning the per-lane hasListener gate.
        """
        pkg = search_hybrid_pkg
        docs = [pkg.Doc(page_content='hello world', score=0.5, metadata=None)]
        question = pkg.Question(
            questions=[pkg.SubQuestion('hello')],
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
            questions=[pkg.SubQuestion('hello')],
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
            questions=[pkg.SubQuestion('')],
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
            questions=[pkg.SubQuestion('test query')],
            documents=[],
        )

        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)

        inst.writeQuestions(question)

        assert not mock_instance.writeDocuments.called
        assert not mock_instance.writeAnswers.called
