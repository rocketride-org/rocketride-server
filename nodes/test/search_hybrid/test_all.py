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
(local_text_output, rerank_cohere, tool_gohighlevel, ...) -- we prepend
``nodes/src/nodes`` and import the ``search_hybrid.*`` package by name. There is
no skip fallback: outside the build interpreter the ``rocketlib`` import fails
and collection errors out, by design.

``rank_bm25`` is a third-party PyPI compute library (resolved at runtime by
``depends()`` on the build interpreter), not a framework module. When the real
package is importable it is used as-is; only when it is absent does this file
install a local, test-scoped stand-in so the engine can be unit-tested in
isolation. The stub deliberately does NOT live in ``nodes/test/mocks/``: that
directory is injected engine-wide via ``ROCKETRIDE_MOCK``
(``packages/ai/src/ai/node.py`` prepends it to ``sys.path`` in the node
subprocess), so a ``rank_bm25`` package there would shadow the real library and
make the dynamic services.json test exercise fake BM25 scoring. ``mocks/`` is
reserved for network/API-client SDKs (openai, pinecone, ...) whose remote calls
must be faked; compute libraries are installed for real by ``depends()``. Other
suites that need a stand-in build it inside the test module for the same reason
(see ``nodes/test/agent_crewai/``). It is the only stub installed here --
``rocketlib`` / ``ai.*`` / ``depends`` are provided by the build interpreter
and NOT stubbed.

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
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(_NODES_SRC) in sys.path:
    sys.path.remove(str(_NODES_SRC))
sys.path.insert(0, str(_NODES_SRC))


# ---------------------------------------------------------------------------
# rank_bm25 is a PyPI dependency resolved at runtime by `depends()` on the
# build interpreter. If the real package is importable we use it. Only when it
# is absent do we install the minimal stand-in below -- scoped to this test
# module via sys.modules, NOT placed in nodes/test/mocks/, because that
# directory is prepended to sys.path in the engine's node subprocess
# (ROCKETRIDE_MOCK, see packages/ai/src/ai/node.py) and would shadow the real
# library during the dynamic services.json test. This is the only stub the
# test installs -- rocketlib / ai.* / depends are provided by the build
# interpreter and are NOT stubbed here.
# ---------------------------------------------------------------------------


class _StubBM25Okapi:
    """Minimal stand-in for ``rank_bm25.BM25Okapi``, used only when the real
    package is not installed.

    Implements the interface ``HybridSearchEngine`` uses (``__init__(corpus)``
    and ``get_scores(query_tokens)``) with a TF-IDF-ish score order good
    enough for ranking assertions. It is a compute-library stand-in defined at
    the point of use, never installed engine-wide.
    """

    def __init__(self, corpus):
        self.corpus = corpus
        self.doc_count = len(corpus)
        self.doc_freqs = {}
        for doc_tokens in corpus:
            for token in set(doc_tokens):
                self.doc_freqs[token] = self.doc_freqs.get(token, 0) + 1

    def get_scores(self, query_tokens):
        scores = []
        for doc_tokens in self.corpus:
            token_counts = {}
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


# Track our stub so the module-scoped teardown below can distinguish a
# stub we installed from a real ``rank_bm25`` that was already present.
_RANK_BM25_STUB_TOKEN = object()


def _build_rank_bm25_stub_module():
    """Build an in-memory ``rank_bm25`` module exposing the stub BM25Okapi."""
    import types

    module = types.ModuleType('rank_bm25')
    module.BM25Okapi = _StubBM25Okapi  # gitleaks:allow -- attribute assignment, not a secret
    module.__rank_bm25_test_stub__ = _RANK_BM25_STUB_TOKEN
    return module


def _install_bm25_stub_for_session():
    """Install the rank_bm25 stub only when the real package is missing.

    Returns ``True`` if this call installed the stub (and therefore owns
    its removal), ``False`` if the real package is importable (already in
    ``sys.modules`` or resolvable on ``sys.path``).
    """
    if 'rank_bm25' in sys.modules:
        return False
    if importlib.util.find_spec('rank_bm25') is not None:
        # Real package installed (e.g. by depends() on the build interpreter):
        # let the engine import it -- never shadow a real library.
        return False
    sys.modules['rank_bm25'] = _build_rank_bm25_stub_module()
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
# Missing vector scores (regression: arrival order must not become a ranking)
# ===========================================================================
#
# Regression cover for the defect reported on PR #899: `Doc.score` defaults to
# None, so any upstream node that emits documents without scoring them produced
# an all-zero vector_scores list. Sorting equal keys is stable, so the "vector"
# list was really the documents in arrival order, and RRF then fused that order
# with weight alpha as though it were vector relevance -- a plausible-looking
# ranking that was partly just input order. None now means "no vector evidence"
# and keeps the document out of the vector list entirely.

# Distinct BM25 relevance to 'machine learning', so the keyword ranking is
# strictly ordered and comparisons below are exact rather than tie-dependent.
UNSCORED_DOCS = [
    {'id': 'ml', 'text': 'machine learning machine learning powers modern systems'},
    {'id': 'learn', 'text': 'learning to cook takes practice'},
    {'id': 'harbour', 'text': 'the harbour was grey and cold'},
]
UNSCORED_QUERY = 'machine learning'


def _ids(results):
    return [r['id'] for r in results]


class TestMissingVectorScores:
    """None means 'no vector evidence', which is not the same as a score of 0.0."""

    def test_all_unscored_ranking_is_independent_of_arrival_order(self):
        """The headline defect: with no scores, input order leaked into the ranking.

        Same documents, same query, nothing that could legitimately change the
        ranking -- only the order they arrive in. Before the fix the two orders
        produced different rankings because the all-zero vector list was the
        arrival order wearing a ranking's clothes.
        """
        engine = HybridSearchEngine(alpha=0.5)
        forward = UNSCORED_DOCS
        shuffled = [UNSCORED_DOCS[2], UNSCORED_DOCS[0], UNSCORED_DOCS[1]]

        ranked_forward = _ids(engine.search(UNSCORED_QUERY, forward, [None, None, None], top_k=10))
        ranked_shuffled = _ids(engine.search(UNSCORED_QUERY, shuffled, [None, None, None], top_k=10))

        assert ranked_forward == ranked_shuffled, (
            f'ranking changed with input order: {ranked_forward} vs {ranked_shuffled}'
        )
        # And it is the keyword ranking, not the arrival order.
        assert ranked_forward[0] == 'ml'

    def test_all_unscored_matches_bm25_only(self):
        """No vector signal at all degrades to BM25-only, the honest answer."""
        engine = HybridSearchEngine(alpha=0.5)
        fused = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [None, None, None], top_k=10))
        bm25_only = _ids(engine.bm25_search(UNSCORED_QUERY, UNSCORED_DOCS, top_k=10))
        assert fused == bm25_only

    def test_all_unscored_equivalent_to_omitting_scores(self):
        """An all-None list means the same as passing no vector_scores at all."""
        engine = HybridSearchEngine(alpha=0.5)
        explicit_none = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [None, None, None], top_k=10))
        omitted = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, None, top_k=10))
        assert explicit_none == omitted

    def test_real_zero_scores_are_still_a_real_signal(self):
        """A scored-0.0 document is evidence; it must keep its place in the vector list.

        This is the distinction the fix turns on: 0.0 means "the store scored
        this and it scored badly", None means "the store never scored this".
        Only the latter is dropped, so genuine 0.0 scores must still produce a
        vector-ranked list and a fused RRF score.
        """
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.0, 0.0, 0.0], top_k=10)
        assert results, 'real 0.0 scores must not be discarded'
        # Fused (both legs present) rather than the BM25-only fallback.
        assert all('rrf_score' in r for r in results)

    def test_real_zeros_and_nones_are_not_interchangeable(self):
        """Guards against a fix that simply treats every falsy score as missing."""
        engine = HybridSearchEngine(alpha=0.5)
        with_zeros = engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.0, 0.0, 0.0], top_k=10)
        with_nones = engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [None, None, None], top_k=10)
        # The zero-scored run fuses two legs and carries RRF scores; the
        # all-missing run falls through to the BM25-only list.
        assert all('rrf_score' in r for r in with_zeros)
        assert not any('rrf_score' in r for r in with_nones)

    def test_equal_real_scores_tie_deterministically(self):
        """Equal real scores are a legitimate tie, broken stably by input order.

        Ranking documents that genuinely tie is not the defect -- inventing a
        ranking for documents that were never scored is. Pin the stable-sort
        behaviour so the tie stays deterministic.
        """
        engine = HybridSearchEngine(alpha=1.0)  # vector-only, so BM25 cannot break the tie
        first = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.5, 0.5, 0.5], top_k=10))
        again = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.5, 0.5, 0.5], top_k=10))
        assert first == again == ['ml', 'learn', 'harbour']

    def test_mixed_scores_do_not_fabricate_a_rank_for_unscored_docs(self):
        """Partially-scored input: unscored docs take no part in the vector leg.

        They are still ranked -- via BM25 -- but they never receive a vector
        rank they did not earn, so the result no longer depends on where they
        happened to sit in the input list.
        """
        engine = HybridSearchEngine(alpha=0.5)
        # 'harbour' is unscored; the other two carry real scores.
        forward = _ids(engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.9, 0.8, None], top_k=10))
        # Same documents and same scores, different arrival order.
        shuffled_docs = [UNSCORED_DOCS[2], UNSCORED_DOCS[0], UNSCORED_DOCS[1]]
        shuffled = _ids(engine.search(UNSCORED_QUERY, shuffled_docs, [None, 0.9, 0.8], top_k=10))
        assert forward == shuffled

    def test_mixed_scores_keep_scored_documents_in_the_vector_leg(self):
        """The surviving vector evidence is still used, not thrown away wholesale."""
        engine = HybridSearchEngine(alpha=0.5)
        results = engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [0.9, 0.8, None], top_k=10)
        by_id = {r['id']: r for r in results}
        assert 'vector_score' in by_id['ml']
        assert 'vector_score' in by_id['learn']
        # The unscored document is present but carries no vector score.
        assert 'vector_score' not in by_id['harbour']

    def test_length_mismatch_still_raises_with_none_entries(self):
        engine = HybridSearchEngine(alpha=0.5)
        with pytest.raises(ValueError, match='vector_scores length must match'):
            engine.search(UNSCORED_QUERY, UNSCORED_DOCS, [None, 0.5], top_k=10)


# ===========================================================================
# alpha endpoints must not drop documents
# ===========================================================================
#
# Follow-up regression cover. Keeping unscored documents out of the vector leg
# is right, but `alpha == 0.0` / `alpha == 1.0` used to return one leg and
# discard the other outright. At alpha=1.0 that discarded leg was the only one
# the unscored documents were in, so they vanished from the output entirely --
# mis-ranking traded for silent document loss. alpha=0.0 lost the mirror case:
# a document carrying a real vector score whose text tokenizes to nothing is
# absent from the BM25 leg.
#
# The endpoints are now the limits of the fusion weights ([1.0, 0.0] and
# [0.0, 1.0]) rather than a separate code path, so a zero-weighted leg
# contributes 0.0 to a document's score instead of removing it from the result.

# 'gap' carries no keyword overlap with UNSCORED_QUERY but still earns a BM25
# rank (rank_bm25 scores every document in the corpus, including at 0.0); only
# text that tokenizes to nothing is absent from the BM25 leg.
ENDPOINT_DOCS = [
    {'id': 'ml', 'text': 'machine learning machine learning powers modern systems'},
    {'id': 'learn', 'text': 'learning to cook takes practice'},
    {'id': 'harbour', 'text': 'the harbour was grey and cold'},
]

# Same documents, but 'blank' tokenizes to nothing, so BM25 cannot rank it --
# the mirror of an unscored document, for the alpha=0.0 endpoint.
TEXTLESS_DOCS = [
    {'id': 'ml', 'text': 'machine learning machine learning powers modern systems'},
    {'id': 'blank', 'text': '   '},
    {'id': 'harbour', 'text': 'the harbour was grey and cold'},
]


class TestAlphaEndpointsKeepEveryDocument:
    """A zero-weighted leg contributes nothing to the score, not nothing to the result."""

    def test_vector_only_keeps_unscored_documents(self):
        """THE follow-up regression: alpha=1.0 dropped every unscored document.

        Verified counterexample from the audit: two scored documents and one
        unscored one returned ``['ml', 'harbour']`` -- 'learn' was silently gone
        from the output, not merely mis-ranked.
        """
        engine = HybridSearchEngine(alpha=1.0)
        results = engine.search(UNSCORED_QUERY, ENDPOINT_DOCS, [0.9, None, 0.4], top_k=10)

        assert set(_ids(results)) == {'ml', 'learn', 'harbour'}, f'alpha=1.0 dropped documents: {_ids(results)}'
        # The scored documents keep their pure vector ranking (0.9 before 0.4),
        # and the unscored one sorts below both rather than being interleaved.
        assert _ids(results) == ['ml', 'harbour', 'learn']

    def test_vector_only_scored_order_is_exactly_the_vector_ranking(self):
        """Keeping the unscored documents must not perturb the scored ones.

        BM25 ranks 'ml' above 'harbour' too, so use vector scores that invert
        the keyword order: if BM25 had any say, 'ml' would not come last.
        """
        engine = HybridSearchEngine(alpha=1.0)
        results = engine.search(UNSCORED_QUERY, ENDPOINT_DOCS, [0.1, None, 0.8], top_k=10)
        scored = [r['id'] for r in results if 'vector_score' in r]
        assert scored == ['harbour', 'ml'], 'BM25 leaked into the alpha=1.0 ranking'

    def test_vector_only_ranks_every_scored_document_above_every_unscored_one(self):
        """No unscored document may outrank a document that carries evidence."""
        engine = HybridSearchEngine(alpha=1.0)
        results = engine.search(UNSCORED_QUERY, ENDPOINT_DOCS, [None, 0.2, None], top_k=10)
        assert set(_ids(results)) == {'ml', 'learn', 'harbour'}
        # 'learn' is the only scored document, so it leads despite ranking last
        # on keywords.
        assert _ids(results)[0] == 'learn'

    def test_bm25_only_keeps_documents_bm25_cannot_rank(self):
        """The alpha=0.0 mirror: a scored document with no BM25-able text.

        'blank' tokenizes to nothing so it never reaches the BM25 leg. Before
        the fix alpha=0.0 returned the BM25 leg alone and 'blank' disappeared,
        even though it carried a perfectly real vector score.
        """
        engine = HybridSearchEngine(alpha=0.0)
        results = engine.search(UNSCORED_QUERY, TEXTLESS_DOCS, [0.9, 0.8, 0.4], top_k=10)

        assert set(_ids(results)) == {'ml', 'blank', 'harbour'}, f'alpha=0.0 dropped documents: {_ids(results)}'
        # BM25 order for the documents BM25 could rank, then the one it could not.
        assert _ids(results) == ['ml', 'harbour', 'blank']

    def test_bm25_only_order_is_exactly_the_bm25_ranking(self):
        """Vector scores must not leak into the alpha=0.0 ranking.

        The vector scores below invert the keyword order; if the vector leg had
        any weight, 'harbour' would outrank 'ml'.
        """
        engine = HybridSearchEngine(alpha=0.0)
        fused = _ids(engine.search(UNSCORED_QUERY, ENDPOINT_DOCS, [0.1, 0.2, 0.9], top_k=10))
        bm25_only = _ids(engine.bm25_search(UNSCORED_QUERY, ENDPOINT_DOCS, top_k=10))
        assert fused == bm25_only

    @pytest.mark.parametrize('alpha', [0.0, 1.0])
    def test_endpoints_are_permutation_invariant(self, alpha):
        """Shuffling the input must not change the ranking at either endpoint.

        Distinct vector scores and distinct BM25 relevance, so nothing legitimate
        can reorder the result -- only arrival order could, and it must not.
        """
        engine = HybridSearchEngine(alpha=alpha)
        scores = {'ml': 0.9, 'learn': None, 'harbour': 0.4}

        forward = ENDPOINT_DOCS
        shuffled = [ENDPOINT_DOCS[2], ENDPOINT_DOCS[0], ENDPOINT_DOCS[1]]

        ranked_forward = _ids(engine.search(UNSCORED_QUERY, forward, [scores[d['id']] for d in forward], top_k=10))
        ranked_shuffled = _ids(engine.search(UNSCORED_QUERY, shuffled, [scores[d['id']] for d in shuffled], top_k=10))

        assert ranked_forward == ranked_shuffled, (
            f'alpha={alpha} ranking depends on arrival order: {ranked_forward} vs {ranked_shuffled}'
        )

    @pytest.mark.parametrize('alpha', [0.0, 1.0])
    @pytest.mark.parametrize('docs', [ENDPOINT_DOCS, TEXTLESS_DOCS], ids=['all-rankable', 'one-textless'])
    @pytest.mark.parametrize('scores', [[0.9, None, 0.4], [None, None, 0.4], [0.9, 0.5, 0.4], [0.0, None, 0.0]])
    def test_endpoints_return_exactly_the_documents_that_carry_evidence(self, alpha, docs, scores):
        """The invariant behind both fixes, stated once and checked at both ends.

        A document is returned iff it has evidence in at least one leg: a vector
        score, or text BM25 can rank. Which leg carries it, and which ``alpha``
        weights that leg to zero, must not decide whether it appears at all.
        """
        engine = HybridSearchEngine(alpha=alpha)
        results = engine.search(UNSCORED_QUERY, docs, list(scores), top_k=10)

        has_vector = {d['id'] for d, s in zip(docs, scores) if s is not None}
        has_bm25 = set(_ids(engine.bm25_search(UNSCORED_QUERY, docs, top_k=len(docs))))

        assert set(_ids(results)) == has_vector | has_bm25, (
            f'alpha={alpha} scores={scores} changed the document set: {_ids(results)}'
        )

    def test_endpoint_matches_its_neighbouring_blend(self):
        """alpha=1.0 must not differ from alpha=0.99, nor 0.0 from 0.01.

        The endpoints used to be discontinuous with the blended range: one
        hundredth of a config value away, the result gained a document. Pin that
        they now agree, since that discontinuity is what the loss was made of.
        """
        scores = [0.9, None, 0.4]
        assert _ids(HybridSearchEngine(alpha=1.0).search(UNSCORED_QUERY, ENDPOINT_DOCS, scores, top_k=10)) == _ids(
            HybridSearchEngine(alpha=0.99).search(UNSCORED_QUERY, ENDPOINT_DOCS, scores, top_k=10)
        )
        textless_scores = [0.9, 0.8, 0.4]
        assert _ids(HybridSearchEngine(alpha=0.0).search(UNSCORED_QUERY, TEXTLESS_DOCS, textless_scores, top_k=10)) == (
            _ids(HybridSearchEngine(alpha=0.01).search(UNSCORED_QUERY, TEXTLESS_DOCS, textless_scores, top_k=10))
        )

    def test_all_unscored_still_falls_through_to_bm25_alone(self):
        """The degenerate legs keep their short-circuit -- they drop nothing.

        An empty leg holds no document, so returning the other leg unchanged
        cannot lose anything. Pin that this path still emits the raw BM25 list
        (no ``rrf_score``) at the endpoints as well as in the blended range.
        """
        results = HybridSearchEngine(alpha=1.0).search(UNSCORED_QUERY, ENDPOINT_DOCS, [None, None, None], top_k=10)
        assert _ids(results) == _ids(HybridSearchEngine(alpha=1.0).bm25_search(UNSCORED_QUERY, ENDPOINT_DOCS, top_k=10))
        assert not any('rrf_score' in r for r in results)

    def test_endpoints_still_respect_top_k(self):
        """Keeping every document is not a licence to overrun the caller's top_k."""
        for alpha in (0.0, 1.0):
            results = HybridSearchEngine(alpha=alpha).search(UNSCORED_QUERY, ENDPOINT_DOCS, [0.9, None, 0.4], top_k=2)
            assert len(results) == 2


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
        # "Hybrid rerank", matching the node's display title -- the node
        # re-ranks an existing candidate set, it does not search for one.
        assert 'Hybrid rerank returned' in answer_text
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


# ===========================================================================
# IInstance regression: documents that arrive without a score
# ===========================================================================
#
# End-to-end cover for the PR #899 defect, exercised the way it actually
# reached users: `Doc.score` is declared `score: float = Field(None, ...)`, so
# any upstream node that does not score its documents hands this node
# `score=None`. IInstance used to coerce that to 0.0, which made the vector
# "ranking" nothing more than the order the documents arrived in.


class TestIInstanceMissingScores:
    """Unscored documents must not have their arrival order sold as a ranking."""

    # Distinct keyword relevance to the query, so the expected ordering is exact.
    _TEXTS = [
        'machine learning machine learning powers modern systems',
        'learning to cook takes practice',
        'the harbour was grey and cold',
    ]

    @staticmethod
    def _make_doc(pkg, text, score):
        """Build a Doc, leaving `score` unset when there is none.

        ``Doc.score`` is declared ``score: float = Field(None, ...)``: the
        default is None but the annotation is not Optional, so pydantic rejects
        an explicit ``score=None``. An unscored document is therefore one whose
        score was never set -- exactly what an upstream node that does not score
        its output produces.
        """
        if score is None:
            return pkg.Doc(page_content=text, metadata=None)
        return pkg.Doc(page_content=text, score=score, metadata=None)

    def _emit_order(self, pkg, texts, scores):
        """Run writeQuestions and return the emitted page_content order."""
        docs = [self._make_doc(pkg, t, s) for t, s in zip(texts, scores)]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.side_effect = lambda lane: lane == 'documents'
        inst.writeQuestions(question)
        emitted = mock_instance.writeDocuments.call_args[0][0]
        return [d.page_content for d in emitted]

    def test_doc_score_defaults_to_none(self, search_hybrid_pkg):
        """Pin the premise: an unscored Doc really does carry score=None.

        If this ever becomes 0.0 upstream, the distinction this class defends
        disappears and these tests should be revisited.
        """
        pkg = search_hybrid_pkg
        assert pkg.Doc(page_content='x').score is None

    def test_unscored_documents_do_not_rank_by_arrival_order(self, search_hybrid_pkg):
        """THE regression: same documents, different input order, same ranking.

        Before the fix the two calls returned different orderings, because every
        document scored 0.0, the stable sort left the vector list in arrival
        order, and RRF fused that order in with weight alpha.
        """
        pkg = search_hybrid_pkg
        forward = self._TEXTS
        shuffled = [self._TEXTS[2], self._TEXTS[0], self._TEXTS[1]]

        ranked_forward = self._emit_order(pkg, forward, [None, None, None])
        ranked_shuffled = self._emit_order(pkg, shuffled, [None, None, None])

        assert ranked_forward == ranked_shuffled, (
            f'ranking depends on input order:\n  {ranked_forward}\n  {ranked_shuffled}'
        )
        # The keyword-relevant document leads, in both orders.
        assert ranked_forward[0] == self._TEXTS[0]
        assert ranked_shuffled[0] == self._TEXTS[0]

    def test_scored_documents_still_use_the_vector_signal(self, search_hybrid_pkg):
        """The fix must not disable hybrid ranking for properly scored input."""
        pkg = search_hybrid_pkg
        # The keyword-poor document carries by far the strongest vector score,
        # so a working vector leg pulls it above where BM25 alone would put it.
        ranked = self._emit_order(pkg, self._TEXTS, [0.1, 0.2, 0.99])
        bm25_only = self._emit_order(pkg, self._TEXTS, [None, None, None])
        assert ranked != bm25_only, 'vector scores had no effect on the ranking'
        assert ranked.index(self._TEXTS[2]) < bm25_only.index(self._TEXTS[2])

    def test_warns_once_when_no_document_carries_a_score(self, search_hybrid_pkg, monkeypatch):
        """A missing vector signal is surfaced, not swallowed."""
        import importlib

        pkg = search_hybrid_pkg
        iinstance_mod = importlib.import_module('search_hybrid.IInstance')
        seen: list = []
        monkeypatch.setattr(iinstance_mod, 'warning', lambda msg, *a, **kw: seen.append(msg))

        docs = [self._make_doc(pkg, t, None) for t in self._TEXTS]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = False

        inst.writeQuestions(question)
        inst.writeQuestions(question)  # second question, same instance

        assert len(seen) == 1, f'expected exactly one warning, got {seen}'
        assert 'no vector signal' in seen[0]

    def test_warns_when_only_some_documents_carry_a_score(self, search_hybrid_pkg, monkeypatch):
        """Partially-scored input is a pipeline smell worth naming."""
        import importlib

        pkg = search_hybrid_pkg
        iinstance_mod = importlib.import_module('search_hybrid.IInstance')
        seen: list = []
        monkeypatch.setattr(iinstance_mod, 'warning', lambda msg, *a, **kw: seen.append(msg))

        docs = [
            self._make_doc(pkg, self._TEXTS[0], 0.9),
            self._make_doc(pkg, self._TEXTS[1], None),
            self._make_doc(pkg, self._TEXTS[2], 0.4),
        ]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = False

        inst.writeQuestions(question)

        assert len(seen) == 1
        assert '1 of 3' in seen[0]

    def test_no_warning_when_every_document_is_scored(self, search_hybrid_pkg, monkeypatch):
        """The healthy path stays quiet."""
        import importlib

        pkg = search_hybrid_pkg
        iinstance_mod = importlib.import_module('search_hybrid.IInstance')
        seen: list = []
        monkeypatch.setattr(iinstance_mod, 'warning', lambda msg, *a, **kw: seen.append(msg))

        docs = [pkg.Doc(page_content=t, score=0.5, metadata=None) for t in self._TEXTS]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        engine = HybridSearchEngine(alpha=0.5)
        inst, mock_instance = pkg.make_instance(engine=engine)
        mock_instance.hasListener.return_value = False

        inst.writeQuestions(question)

        assert seen == []

    def test_none_is_passed_through_to_the_engine_not_coerced(self, search_hybrid_pkg):
        """Pin the contract at the boundary: IInstance must not send 0.0 for None."""
        pkg = search_hybrid_pkg
        captured: dict = {}

        class _SpyEngine:
            def search(self, query, documents, vector_scores, top_k, rrf_k):
                captured['vector_scores'] = vector_scores
                return []

        docs = [
            self._make_doc(pkg, self._TEXTS[0], 0.9),
            self._make_doc(pkg, self._TEXTS[1], None),
            self._make_doc(pkg, self._TEXTS[2], 0.0),
        ]
        question = pkg.Question(
            questions=[pkg.SubQuestion(text='machine learning')],
            documents=docs,
        )
        inst, mock_instance = pkg.make_instance(engine=_SpyEngine())
        mock_instance.hasListener.return_value = False

        inst.writeQuestions(question)

        # A real 0.0 stays 0.0; a missing score stays None. The two must not collapse.
        assert captured['vector_scores'] == [0.9, None, 0.0]
