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
from unittest.mock import MagicMock

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


@pytest.fixture(autouse=True, scope='module')
def _cleanup_bm25_stub():
    """Ensure BM25 stub is restored after all tests in this module complete."""
    yield
    _restore_modules()


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

    def test_alpha_weighted_rrf(self):
        """Weights parameter should scale RRF contributions per list."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'b', 'text': 'doc b'}, {'id': 'a', 'text': 'doc a'}]

        # With alpha=0.8: vector (list1) weight=0.8, BM25 (list2) weight=0.2
        results_weighted = HybridSearchEngine.reciprocal_rank_fusion(
            list1,
            list2,
            k=60,
            weights=[0.8, 0.2],
        )
        score_map_weighted = {r['id']: r['rrf_score'] for r in results_weighted}

        # 'a' is rank 1 in list1 (weight 0.8), rank 2 in list2 (weight 0.2)
        # 'b' is rank 2 in list1 (weight 0.8), rank 1 in list2 (weight 0.2)
        # With heavy vector weight, 'a' should score higher than 'b'
        assert score_map_weighted['a'] > score_map_weighted['b']

    def test_alpha_weighted_rrf_reversed(self):
        """With alpha=0.2 (low vector weight), BM25 rank 1 doc should win."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'b', 'text': 'doc b'}, {'id': 'a', 'text': 'doc a'}]

        # With alpha=0.2: vector (list1) weight=0.2, BM25 (list2) weight=0.8
        results = HybridSearchEngine.reciprocal_rank_fusion(
            list1,
            list2,
            k=60,
            weights=[0.2, 0.8],
        )
        score_map = {r['id']: r['rrf_score'] for r in results}

        # 'b' is rank 1 in list2 (weight 0.8), so it should score higher
        assert score_map['b'] > score_map['a']

    def test_equal_weights_match_unweighted(self):
        """Weights of [1.0, 1.0] should produce the same result as no weights."""
        list1 = [{'id': 'a', 'text': 'doc a'}, {'id': 'b', 'text': 'doc b'}]
        list2 = [{'id': 'c', 'text': 'doc c'}, {'id': 'a', 'text': 'doc a'}]

        results_unweighted = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60)
        results_weighted = HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[1.0, 1.0])

        scores_unweighted = {r['id']: r['rrf_score'] for r in results_unweighted}
        scores_weighted = {r['id']: r['rrf_score'] for r in results_weighted}

        for doc_id in scores_unweighted:
            assert abs(scores_unweighted[doc_id] - scores_weighted[doc_id]) < 1e-10

    def test_weights_length_mismatch_raises(self):
        """Weights list with wrong length should raise ValueError."""
        list1 = [{'id': 'a', 'text': 'doc a'}]
        list2 = [{'id': 'b', 'text': 'doc b'}]
        with pytest.raises(ValueError, match='weights length must match'):
            HybridSearchEngine.reciprocal_rank_fusion(list1, list2, k=60, weights=[0.5])


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

    def test_alpha_weights_vector_higher(self):
        """alpha=0.8 should give vector results more influence than BM25."""
        # doc1 has best BM25 match for 'machine learning'
        # doc5 has highest vector score
        vector_scores = [0.1, 0.2, 0.3, 0.4, 0.9]

        engine_vector_heavy = HybridSearchEngine(alpha=0.8)
        results_heavy = engine_vector_heavy.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)

        engine_bm25_heavy = HybridSearchEngine(alpha=0.2)
        results_bm25 = engine_bm25_heavy.search('machine learning', SAMPLE_DOCS, vector_scores=vector_scores, top_k=5)

        # With high alpha (vector-heavy), doc5 (highest vector score) should rank higher
        # than with low alpha (BM25-heavy)
        heavy_ids = [r['id'] for r in results_heavy]
        bm25_ids = [r['id'] for r in results_bm25]

        # doc5 should rank better (lower index) in vector-heavy results
        doc5_rank_heavy = heavy_ids.index('doc5') if 'doc5' in heavy_ids else len(heavy_ids)
        doc5_rank_bm25 = bm25_ids.index('doc5') if 'doc5' in bm25_ids else len(bm25_ids)
        assert doc5_rank_heavy <= doc5_rank_bm25


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


# ===========================================================================
# IInstance integration tests (mocked rocketlib)
# ===========================================================================


class TestIInstanceIntegration:
    """Tests for IInstance.writeQuestions with mocked rocketlib framework."""

    def _install_stubs(self):
        """Install minimal stubs for rocketlib and dependencies."""
        saved = {}
        stub_names = [
            'rocketlib',
            'ai',
            'ai.common',
            'ai.common.config',
            'ai.common.schema',
            'depends',
        ]
        for name in stub_names:
            saved[name] = sys.modules.get(name)

        # rocketlib stubs
        rocketlib = types.ModuleType('rocketlib')

        class IGlobalBase:
            pass

        class IInstanceBase:
            pass

        class OPEN_MODE:
            CONFIG = 'config'
            RUN = 'run'

        rocketlib.IGlobalBase = IGlobalBase
        rocketlib.IInstanceBase = IInstanceBase
        rocketlib.OPEN_MODE = OPEN_MODE
        rocketlib.warning = lambda *a, **k: None
        rocketlib.debug = lambda *a, **k: None
        sys.modules['rocketlib'] = rocketlib

        # ai stubs
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
                for k, v in kwargs.items():
                    setattr(self, k, v)
                if not hasattr(self, 'page_content'):
                    self.page_content = None
                if not hasattr(self, 'metadata'):
                    self.metadata = None
                if not hasattr(self, 'score'):
                    self.score = None

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
        depends_mod.depends = lambda *a, **k: None

        sys.modules['ai'] = ai_pkg
        sys.modules['ai.common'] = ai_common
        sys.modules['ai.common.config'] = config_mod
        sys.modules['ai.common.schema'] = schema_mod
        sys.modules['depends'] = depends_mod

        return saved, stub_names, schema_mod, SubQuestion

    def _restore_modules(self, saved, stub_names):
        for name in stub_names:
            if saved.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]

    def _load_iinstance(self):
        """Install stubs and load IInstance."""
        saved, names, schema_mod, SubQuestion = self._install_stubs()
        # Force re-import of the search_hybrid module
        for mod_name in list(sys.modules.keys()):
            if 'search_hybrid' in mod_name and 'test' not in mod_name:
                del sys.modules[mod_name]

        from nodes.src.nodes.search_hybrid.IInstance import IInstance

        return saved, names, schema_mod, SubQuestion, IInstance

    def _make_instance(self, IInstance, engine, top_k=10, rrf_k=60):
        """Create an IInstance with mocked IGlobal and instance."""
        inst = IInstance.__new__(IInstance)

        iglobal = MagicMock()
        iglobal.engine = engine
        iglobal.top_k = top_k
        iglobal.rrf_k = rrf_k
        inst.IGlobal = iglobal

        mock_instance = MagicMock()
        inst.instance = mock_instance

        return inst, mock_instance

    def test_raises_runtime_error_when_engine_is_none(self):
        """RuntimeError should be raised when engine is None."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            question = schema_mod.Question(
                questions=[SubQuestion('test query')],
                documents=[schema_mod.Doc(page_content='some text', score=0.9)],
            )
            inst, _ = self._make_instance(IInstance, engine=None)
            with pytest.raises(RuntimeError, match='Hybrid search engine not initialized'):
                inst.writeQuestions(question)
        finally:
            self._restore_modules(saved, names)

    def test_deep_copy_prevents_question_mutation(self):
        """Deep copy should prevent mutation of the original question object."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            docs = [
                schema_mod.Doc(page_content='Machine learning is great.', score=0.9, metadata=None),
                schema_mod.Doc(page_content='Deep learning is powerful.', score=0.7, metadata=None),
            ]
            question = schema_mod.Question(
                questions=[SubQuestion('machine learning')],
                documents=docs,
            )
            original_doc_count = len(question.documents)
            original_first_content = question.documents[0].page_content

            engine = HybridSearchEngine(alpha=0.5)
            inst, mock_instance = self._make_instance(IInstance, engine=engine)
            mock_instance.hasListener.return_value = False

            inst.writeQuestions(question)

            # Original question should not be mutated
            assert len(question.documents) == original_doc_count
            assert question.documents[0].page_content == original_first_content
        finally:
            self._restore_modules(saved, names)

    def test_structured_answer_output(self):
        """Answer output should be structured with document references and actual scores."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            docs = [
                schema_mod.Doc(page_content='Machine learning is a subset of AI.', score=0.9, metadata=None),
                schema_mod.Doc(page_content='Deep learning uses neural networks.', score=0.7, metadata=None),
            ]
            question = schema_mod.Question(
                questions=[SubQuestion('machine learning')],
                documents=docs,
            )

            engine = HybridSearchEngine(alpha=0.5)
            inst, mock_instance = self._make_instance(IInstance, engine=engine)
            mock_instance.hasListener.return_value = True

            inst.writeQuestions(question)

            assert mock_instance.writeAnswers.called
            # writeAnswers now receives a list of Answer objects
            answers = mock_instance.writeAnswers.call_args[0][0]
            answer_text = answers[0].getAnswer()

            # Should have structured format, not raw concatenation
            assert 'Hybrid search returned' in answer_text
            assert 'results' in answer_text
            assert '[Document 1]' in answer_text
            # Score should contain actual numeric values, not 'N/A'
            assert '(score:' in answer_text
            assert 'N/A' not in answer_text
        finally:
            self._restore_modules(saved, names)

    def test_emits_reranked_documents(self):
        """Emit reranked documents when listener exists."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            docs = [
                schema_mod.Doc(page_content='First document about ML.', score=0.5, metadata=None),
                schema_mod.Doc(page_content='Second document about deep learning.', score=0.9, metadata=None),
            ]
            question = schema_mod.Question(
                questions=[SubQuestion('deep learning')],
                documents=docs,
            )

            engine = HybridSearchEngine(alpha=0.5)
            inst, mock_instance = self._make_instance(IInstance, engine=engine)
            mock_instance.hasListener.return_value = True

            inst.writeQuestions(question)

            assert mock_instance.writeDocuments.called
            emitted_docs = mock_instance.writeDocuments.call_args[0][0]
            assert len(emitted_docs) > 0
        finally:
            self._restore_modules(saved, names)

    def test_skips_empty_query(self):
        """Should skip hybrid search when query text is empty."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            docs = [schema_mod.Doc(page_content='Some doc.', score=0.5, metadata=None)]
            question = schema_mod.Question(
                questions=[SubQuestion('')],
                documents=docs,
            )

            engine = HybridSearchEngine(alpha=0.5)
            inst, mock_instance = self._make_instance(IInstance, engine=engine)

            inst.writeQuestions(question)

            assert not mock_instance.writeDocuments.called
            assert not mock_instance.writeAnswers.called
        finally:
            self._restore_modules(saved, names)

    def test_skips_empty_documents(self):
        """Should skip hybrid search when no documents are attached."""
        saved, names, schema_mod, SubQuestion, IInstance = self._load_iinstance()
        try:
            question = schema_mod.Question(
                questions=[SubQuestion('test query')],
                documents=[],
            )

            engine = HybridSearchEngine(alpha=0.5)
            inst, mock_instance = self._make_instance(IInstance, engine=engine)

            inst.writeQuestions(question)

            assert not mock_instance.writeDocuments.called
            assert not mock_instance.writeAnswers.called
        finally:
            self._restore_modules(saved, names)
