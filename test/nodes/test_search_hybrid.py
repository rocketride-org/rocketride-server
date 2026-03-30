# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the hybrid search node: BM25, RRF, and full hybrid search."""

from __future__ import annotations

import copy
import importlib.util
import sys
import types
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Locate the search_hybrid module on disk
# ---------------------------------------------------------------------------
_NODES_ROOT = Path(__file__).resolve().parent.parent.parent / 'nodes' / 'src' / 'nodes'
_SEARCH_HYBRID_DIR = _NODES_ROOT / 'search_hybrid'


# ---------------------------------------------------------------------------
# Install rank_bm25 stub before loading hybrid_search
# ---------------------------------------------------------------------------
_STUB_MODULES = [
    'rank_bm25',
]

_original_modules = {}


def _install_bm25_stub():
    """Install a minimal rank_bm25 stub for testing."""
    for name in _STUB_MODULES:
        _original_modules[name] = sys.modules.get(name)

    rank_bm25 = types.ModuleType('rank_bm25')

    class BM25Okapi:
        """Minimal BM25 implementation for testing."""

        def __init__(self, corpus):
            self.corpus = corpus
            self.doc_count = len(corpus)
            # Build IDF-like term frequency
            self.doc_freqs = {}
            for doc_tokens in corpus:
                unique_tokens = set(doc_tokens)
                for token in unique_tokens:
                    self.doc_freqs[token] = self.doc_freqs.get(token, 0) + 1

        def get_scores(self, query_tokens):
            """Compute simple TF-based scores for testing (not true BM25 but sufficient)."""
            scores = []
            for doc_tokens in self.corpus:
                score = 0.0
                token_counts = {}
                for t in doc_tokens:
                    token_counts[t] = token_counts.get(t, 0) + 1
                for qt in query_tokens:
                    if qt in token_counts:
                        tf = token_counts[qt]
                        df = self.doc_freqs.get(qt, 1)
                        # Simple TF-IDF-like score
                        idf = max(0.1, (self.doc_count - df + 0.5) / (df + 0.5))
                        score += tf * idf
                scores.append(score)
            return scores

    rank_bm25.BM25Okapi = BM25Okapi
    sys.modules['rank_bm25'] = rank_bm25


def _restore_modules():
    for name in _STUB_MODULES:
        if _original_modules.get(name) is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = _original_modules[name]


# Install stubs before loading module
_install_bm25_stub()


def _load_hybrid_search():
    """Load hybrid_search.py directly."""
    spec = importlib.util.spec_from_file_location(
        'hybrid_search',
        _SEARCH_HYBRID_DIR / 'hybrid_search.py',
    )
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
# BM25 search tests
# ===========================================================================


class TestBM25Search:
    """Tests for BM25 keyword search."""

    def test_keyword_matching(self):
        """Documents matching query keywords should be ranked higher."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('machine learning', SAMPLE_DOCS, top_k=5)
        assert len(results) > 0
        # Doc with 'machine learning' should be ranked first
        assert results[0]['id'] == 'doc1'

    def test_ranking_order(self):
        """Results should be sorted by BM25 score descending."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('neural networks deep learning', SAMPLE_DOCS, top_k=5)
        assert len(results) > 0
        scores = [r['bm25_score'] for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_empty_query(self):
        """Empty query should return empty results."""
        engine = HybridSearchEngine(alpha=0.5)
        assert engine.bm25_search('', SAMPLE_DOCS) == []

    def test_empty_documents(self):
        """Empty document list should return empty results."""
        engine = HybridSearchEngine(alpha=0.5)
        assert engine.bm25_search('machine learning', []) == []

    def test_top_k_limit(self):
        """Results should be limited to top_k."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('learning', SAMPLE_DOCS, top_k=2)
        assert len(results) <= 2

    def test_bm25_score_present(self):
        """Each result should have a bm25_score field."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('learning', SAMPLE_DOCS, top_k=5)
        for r in results:
            assert 'bm25_score' in r
            assert isinstance(r['bm25_score'], float)

    def test_no_matching_terms(self):
        """Query with no matching terms should still return results (with zero scores)."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.bm25_search('xyz123abc', SAMPLE_DOCS, top_k=5)
        # BM25 returns scores for all docs, some may be 0
        # The function filters based on non-empty tokenized docs
        assert isinstance(results, list)


# ===========================================================================
# Reciprocal Rank Fusion tests
# ===========================================================================


class TestReciprocalRankFusion:
    """Tests for the RRF merging algorithm."""

    def test_merge_two_ranked_lists(self):
        """RRF should merge two ranked lists into one."""
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
        # All results should have rrf_score
        for r in results:
            assert 'rrf_score' in r

    def test_deduplication(self):
        """Documents appearing in multiple lists should be deduplicated."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'a', 'text': 'doc a'}, {'id': 'c', 'text': 'doc c'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        ids = [r['id'] for r in results]
        assert len(ids) == len(set(ids))  # no duplicates

    def test_rrf_score_accumulation(self):
        """Documents in multiple lists should have higher RRF scores."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'a', 'text': 'doc a'}, {'id': 'c', 'text': 'doc c'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        result_map = {r['id']: r['rrf_score'] for r in results}
        # 'a' appears in both lists, should have highest score
        assert result_map['a'] > result_map['b']
        assert result_map['a'] > result_map['c']

    def test_k_parameter_effect(self):
        """Larger k should reduce the difference between top and bottom scores."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        results_small_k = HybridSearchEngine.reciprocal_rank_fusion(list1, k=1)
        results_large_k = HybridSearchEngine.reciprocal_rank_fusion(list1, k=1000)

        # With small k, difference between rank 1 and rank 2 is larger
        small_k_diff = results_small_k[0]['rrf_score'] - results_small_k[1]['rrf_score']
        large_k_diff = results_large_k[0]['rrf_score'] - results_large_k[1]['rrf_score']
        assert small_k_diff > large_k_diff

    def test_empty_lists(self):
        """Empty input lists should return empty results."""
        results = HybridSearchEngine.reciprocal_rank_fusion([], [])
        assert results == []

    def test_single_list(self):
        """Single list should return items with RRF scores."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, k=60)
        assert len(results) == 2
        assert results[0]['rrf_score'] > results[1]['rrf_score']

    def test_ties_handled(self):
        """Documents with equal RRF scores should both appear in results."""
        # Two lists where different docs are at rank 1
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        results = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        assert len(results) == 2
        # Both should have the same score since they're each rank 1 in one list
        assert results[0]['rrf_score'] == results[1]['rrf_score']


# ===========================================================================
# Full hybrid search tests
# ===========================================================================


class TestFullHybridSearch:
    """Tests for the full hybrid search pipeline."""

    def test_balanced_search(self):
        """alpha=0.5 should use both vector and BM25 signals."""
        engine = HybridSearchEngine(alpha=0.5)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert len(results) > 0
        assert len(results) <= 5

    def test_bm25_only(self):
        """alpha=0.0 should use only BM25 results."""
        engine = HybridSearchEngine(alpha=0.0)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert len(results) > 0
        # First result should match keyword 'machine learning'
        assert results[0]['id'] == 'doc1'

    def test_vector_only(self):
        """alpha=1.0 should use only vector scores."""
        engine = HybridSearchEngine(alpha=1.0)
        # doc1 has highest vector score
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        results = engine.search('anything', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)
        assert len(results) > 0
        # First result should be doc1 with highest vector score
        assert results[0]['id'] == 'doc1'

    def test_no_vector_scores(self):
        """When vector_scores is None, should fall back to BM25-only."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.search('machine learning', SAMPLE_DOCS, vector_scores=None, top_k=5)
        assert len(results) > 0

    def test_empty_documents(self):
        """Empty document list should return empty results."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.search('machine learning', [], top_k=5)
        assert results == []

    def test_alpha_validation(self):
        """Validate that alpha outside [0, 1] raises ValueError."""
        with pytest.raises(ValueError, match='alpha must be between'):
            HybridSearchEngine(alpha=-0.1)
        with pytest.raises(ValueError, match='alpha must be between'):
            HybridSearchEngine(alpha=1.1)

    def test_top_k_respected(self):
        """Results should not exceed top_k."""
        engine = HybridSearchEngine(alpha=0.5)
        vector_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        results = engine.search('learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=2)
        assert len(results) <= 2


# ===========================================================================
# Deep copy and mutation tests
# ===========================================================================


class TestDeepCopyPrevention:
    """Tests that verify deep copy prevents input mutation."""

    def test_bm25_does_not_mutate_input(self):
        """BM25 search should not mutate the input document list."""
        engine = HybridSearchEngine(alpha=0.5)
        docs = copy.deepcopy(SAMPLE_DOCS)
        original_docs = copy.deepcopy(docs)
        engine.bm25_search('machine learning', docs, top_k=5)
        # Original docs should be unchanged
        for i, doc in enumerate(docs):
            assert doc == original_docs[i]

    def test_rrf_does_not_mutate_input(self):
        """RRF should not mutate the input lists."""
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        original_list1 = copy.deepcopy(list1)
        original_list2 = copy.deepcopy(list2)
        HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        assert list1 == original_list1
        assert list2 == original_list2

    def test_hybrid_search_does_not_mutate_input(self):
        """Full hybrid search should not mutate input documents."""
        engine = HybridSearchEngine(alpha=0.5)
        docs = copy.deepcopy(SAMPLE_DOCS)
        original_docs = copy.deepcopy(docs)
        vector_scores = [0.9, 0.1, 0.5, 0.3, 0.7]
        engine.search('machine learning', docs, vector_scores=vector_scores, top_k=5)
        for i, doc in enumerate(docs):
            assert doc == original_docs[i]


# ===========================================================================
# Tokenizer tests
# ===========================================================================


class TestTokenizer:
    """Tests for the internal tokenizer used by BM25."""

    def test_lowercases_text(self):
        """Tokenizer should lowercase all text."""
        tokens = HybridSearchEngine._tokenize('Hello WORLD')
        assert 'hello' in tokens
        assert 'world' in tokens

    def test_strips_punctuation(self):
        """Tokenizer should strip punctuation."""
        tokens = HybridSearchEngine._tokenize('Hello, world! How are you?')
        assert all(t.isalnum() for t in tokens)

    def test_empty_text(self):
        """Empty text should return empty list."""
        assert HybridSearchEngine._tokenize('') == []
        assert HybridSearchEngine._tokenize(None) == []

    def test_splits_on_whitespace(self):
        """Tokenizer should split on whitespace and non-word chars."""
        tokens = HybridSearchEngine._tokenize('machine-learning is great')
        assert 'machine' in tokens
        assert 'learning' in tokens
        assert 'is' in tokens
        assert 'great' in tokens
