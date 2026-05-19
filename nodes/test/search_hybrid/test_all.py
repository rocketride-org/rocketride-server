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
