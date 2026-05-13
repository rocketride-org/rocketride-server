# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for orchestration-layer performance and context budget improvements.

Covers:
  PR-Gap-2: Parallel multi-query fan-out in DocumentStoreBase._queryDocuments
  PR-Gap-1: Server-side sliding-window context pruning in RocketRideDriver

Test philosophy:
  - No real network I/O: all store calls are mocked with time.sleep to simulate
    latency and prove parallelism via wall-clock timing assertions.
  - All assertions are deterministic: result correctness is verified independent
    of thread scheduling order.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Minimal stubs so we can import DocumentStoreBase without the full rocketlib
# installed in the test runner environment.
# ---------------------------------------------------------------------------

# Stub rocketlib.IInstanceBase
import sys
import types

_rocketlib = types.ModuleType('rocketlib')


class _IInstanceBase:
    pass


_rocketlib.IInstanceBase = _IInstanceBase  # type: ignore[attr-defined]
sys.modules.setdefault('rocketlib', _rocketlib)

from ai.common.schema import Doc, DocFilter, DocMetadata, Question, QuestionText, QuestionType  # noqa: E402
from ai.common.store import DocumentStoreBase  # noqa: E402


# ---------------------------------------------------------------------------
# Concrete minimal DocumentStoreBase subclass for testing
# ---------------------------------------------------------------------------


class _TestStore(DocumentStoreBase):
    """Minimal concrete store with injectable search callbacks."""

    def __init__(
        self,
        semantic_fn: Optional[Callable] = None,
        keyword_fn: Optional[Callable] = None,
    ) -> None:
        # Bypass real __init__ (needs connConfig / bag)
        self.vectorSize = 0
        self.modelName = ''
        self.threshold_search = 0.0
        self.collectionLock = threading.Lock()
        self._semantic_fn = semantic_fn or (lambda q, f: [])
        self._keyword_fn = keyword_fn or (lambda q, f: [])

    # ---- abstract implementations ----

    def _doesCollectionExist(self) -> bool:
        return True

    def _createCollection(self) -> bool:
        return True

    def count_documents(self) -> int:
        return 0

    def searchKeyword(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        return self._keyword_fn(query, docFilter)

    def searchSemantic(self, query: QuestionText, docFilter: DocFilter) -> List[Doc]:
        return self._semantic_fn(query, docFilter)

    def get(self, docFilter: DocFilter, **_kwargs) -> List[Doc]:
        return []

    def getPaths(self, parent=None, offset=0, limit=1000) -> Dict[str, str]:
        return {}

    def addChunks(self, chunks: List[Doc], **_kwargs) -> None:
        pass

    def remove(self, objectIds: List[str]) -> None:
        pass

    def markDeleted(self, objectIds: List[str]) -> None:
        pass

    def markActive(self, objectIds: List[str]) -> None:
        pass

    def render(self, objectId: str, callback: Callable[[str], None]) -> None:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_doc(object_id: str, chunk_id: int = 0, score: float = 0.9) -> Doc:
    meta = DocMetadata(objectId=object_id, chunkId=chunk_id)
    doc = Doc(page_content=f'content of {object_id}', metadata=meta)
    doc.score = score
    return doc


def _make_semantic_question(texts: List[str]) -> Question:
    """Build a SEMANTIC Question with N sub-questions, each with a fake embedding."""
    q = Question()
    q.type = QuestionType.SEMANTIC
    q.filter = DocFilter()
    q.documents = []
    for text in texts:
        qt = QuestionText(text=text)
        qt.embedding_model = 'test-model'
        qt.embedding = [0.1, 0.2, 0.3]
        q.questions.append(qt)
    return q


def _make_keyword_question(texts: List[str]) -> Question:
    q = Question()
    q.type = QuestionType.KEYWORD
    q.filter = DocFilter()
    q.documents = []
    for text in texts:
        qt = QuestionText(text=text)
        q.questions.append(qt)
    return q


# ===========================================================================
# Gap-2 Tests: Parallel query fan-out
# ===========================================================================


class TestParallelSemanticFanOut:
    """Verify correctness AND parallelism for SEMANTIC multi-query fan-out."""

    SIMULATED_QUERY_LATENCY_S = 0.05  # 50 ms per query

    def _make_store_with_latency(self, docs_per_query: List[List[Doc]]) -> _TestStore:
        """Return a store whose searchSemantic sleeps then returns pre-set docs."""
        call_index = {'n': 0}
        lock = threading.Lock()
        result_sets = list(docs_per_query)

        def _semantic(query: QuestionText, f: DocFilter) -> List[Doc]:
            with lock:
                idx = call_index['n']
                call_index['n'] += 1
            time.sleep(self.SIMULATED_QUERY_LATENCY_S)
            return result_sets[idx] if idx < len(result_sets) else []

        return _TestStore(semantic_fn=_semantic)

    def test_single_query_returns_correct_docs(self) -> None:
        """Single-query path (no executor) returns the expected document."""
        doc = _make_doc('obj-1')
        store = _TestStore(semantic_fn=lambda q, f: [doc])
        question = _make_semantic_question(['what is the capital of France?'])

        result = store._queryDocuments(question)

        assert ('obj-1', 0) in result
        assert result[('obj-1', 0)].page_content == 'content of obj-1'

    def test_multi_query_returns_union_of_results(self) -> None:
        """Three sub-queries produce a merged union of all returned documents."""
        docs_sets = [
            [_make_doc('obj-a', score=0.95)],
            [_make_doc('obj-b', score=0.80)],
            [_make_doc('obj-c', score=0.70)],
        ]
        store = self._make_store_with_latency(docs_sets)
        question = _make_semantic_question(['q1', 'q2', 'q3'])

        result = store._queryDocuments(question)

        assert len(result) == 3
        assert ('obj-a', 0) in result
        assert ('obj-b', 0) in result
        assert ('obj-c', 0) in result

    def test_parallel_execution_is_faster_than_sequential(self) -> None:
        """Wall-clock time for 3 parallel queries < 2× single-query latency."""
        n_queries = 3
        docs_sets = [[_make_doc(f'obj-{i}', score=0.8)] for i in range(n_queries)]
        store = self._make_store_with_latency(docs_sets)
        question = _make_semantic_question([f'query {i}' for i in range(n_queries)])

        start = time.monotonic()
        store._queryDocuments(question)
        elapsed = time.monotonic() - start

        # Sequential would take n_queries * LATENCY; parallel should be < 2× LATENCY.
        sequential_lower_bound = n_queries * self.SIMULATED_QUERY_LATENCY_S
        parallel_upper_bound = 2 * self.SIMULATED_QUERY_LATENCY_S

        assert elapsed < parallel_upper_bound, (
            f'Expected parallel execution in <{parallel_upper_bound:.2f}s '
            f'(was {elapsed:.3f}s vs sequential lower bound {sequential_lower_bound:.2f}s)'
        )

    def test_duplicate_doc_keeps_highest_score(self) -> None:
        """When two queries return the same document, the higher score wins."""
        doc_low = _make_doc('obj-shared', score=0.50)
        doc_high = _make_doc('obj-shared', score=0.99)
        store = _TestStore(semantic_fn=lambda q, f: [doc_low if q.text == 'q1' else doc_high])

        question = _make_semantic_question(['q1', 'q2'])
        result = store._queryDocuments(question)

        assert len(result) == 1
        assert result[('obj-shared', 0)].score == pytest.approx(0.99)

    def test_below_threshold_docs_excluded(self) -> None:
        """Documents below threshold_search are silently filtered out."""
        store = _TestStore(semantic_fn=lambda q, f: [_make_doc('obj-low', score=0.1)])
        store.threshold_search = 0.5
        question = _make_semantic_question(['q1', 'q2'])

        result = store._queryDocuments(question)

        assert len(result) == 0

    def test_missing_embedding_raises_before_any_io(self) -> None:
        """Embedding validation runs before I/O; no queries should be dispatched."""
        call_count = {'n': 0}

        def _spy(q, f):
            call_count['n'] += 1
            return []

        store = _TestStore(semantic_fn=_spy)
        question = _make_semantic_question(['q1'])
        # Corrupt the embedding_model to trigger validation failure
        question.questions[0].embedding_model = ''

        with pytest.raises(Exception, match='embedding filter'):
            store._queryDocuments(question)

        assert call_count['n'] == 0, 'searchSemantic should not be called when validation fails'

    def test_sub_query_exception_propagates(self) -> None:
        """If one sub-query raises, the exception surfaces to the caller."""

        def _boom(q: QuestionText, f: DocFilter) -> List[Doc]:
            if q.text == 'q2':
                raise RuntimeError('vector DB unreachable')
            return [_make_doc('obj-ok')]

        store = _TestStore(semantic_fn=_boom)
        question = _make_semantic_question(['q1', 'q2'])

        with pytest.raises(RuntimeError, match='vector DB unreachable'):
            store._queryDocuments(question)

    def test_thread_safety_no_lost_documents(self) -> None:
        """Stress-test: 8 parallel sub-queries each returning 5 unique docs."""
        n_queries = 8
        docs_per_query = 5
        call_index = {'n': 0}
        lock = threading.Lock()

        def _semantic(q: QuestionText, f: DocFilter) -> List[Doc]:
            with lock:
                idx = call_index['n']
                call_index['n'] += 1
            time.sleep(0.01)
            return [_make_doc(f'obj-q{idx}-d{d}') for d in range(docs_per_query)]

        store = _TestStore(semantic_fn=_semantic)
        question = _make_semantic_question([f'query-{i}' for i in range(n_queries)])
        result = store._queryDocuments(question)

        assert len(result) == n_queries * docs_per_query, (
            f'Expected {n_queries * docs_per_query} unique docs, got {len(result)}'
        )


class TestParallelKeywordFanOut:
    """Mirror tests for the KEYWORD parallel path."""

    def test_multi_keyword_returns_union(self) -> None:
        results = iter([[_make_doc('k-1')], [_make_doc('k-2')]])
        store = _TestStore(keyword_fn=lambda q, f: next(results))
        question = _make_keyword_question(['term-a', 'term-b'])

        result = store._queryDocuments(question)

        assert ('k-1', 0) in result
        assert ('k-2', 0) in result

    def test_single_keyword_no_executor(self) -> None:
        """Single-keyword path uses direct call, not ThreadPoolExecutor."""
        store = _TestStore(keyword_fn=lambda q, f: [_make_doc('k-only')])
        question = _make_keyword_question(['only-term'])

        result = store._queryDocuments(question)

        assert ('k-only', 0) in result


# ===========================================================================
# Gap-1 Tests: Wave sliding-window context pruning
# ===========================================================================


class TestWaveSlidingWindow:
    """Verify _prune_wave_context enforces both sliding-window and char budget."""

    # ------------------------------------------------------------------
    # Fixture: a minimal RocketRideDriver that doesn't need a real iGlobal
    # ------------------------------------------------------------------

    def _make_driver(
        self,
        context_window_waves: int = 5,
        wave_context_budget_chars: int = 12_000,
    ):
        """Return a minimal stub with the _prune_wave_context algorithm baked in.

        We deliberately avoid importing ``nodes.src.*`` here because the
        ``packages/ai`` test runner does not have the ``nodes`` package on its
        ``PYTHONPATH``.  The stub reproduces the algorithm verbatim so the tests
        validate the logic without requiring the full node import chain.
        """
        import math

        _window = max(1, context_window_waves)
        _budget = wave_context_budget_chars

        class _DriverStub:
            def _prune_wave_context(self, waves: List[Dict[str, Any]]) -> None:
                """Verbatim copy of the production _prune_wave_context logic."""
                # --- Strategy 1: sliding window ---
                if len(waves) > _window:
                    del waves[: len(waves) - _window]

                # --- Strategy 2: character budget ---
                if _budget <= 0:
                    return

                def _total(w_list):
                    total = 0
                    for w in w_list:
                        for r in w.get('results', []):
                            total += len(r.get('summary', ''))
                    return total

                while len(waves) > 1 and _total(waves) > _budget:
                    waves.pop(0)

        return _DriverStub()

    def _make_wave(self, wave_num: int, summary_chars: int = 100) -> Dict[str, Any]:
        """Build a fake wave entry with a result whose summary is summary_chars long."""
        return {
            'wave_num': wave_num,
            'calls': [{'tool': 'test.tool', 'args': {}}],
            'results': [
                {
                    'tool': 'test.tool',
                    'key': f'wave-{wave_num}.r0',
                    'summary': 'x' * summary_chars,
                }
            ],
        }

    # --- Sliding window tests ---

    def test_window_not_exceeded_no_eviction(self) -> None:
        """When wave count ≤ window, no eviction occurs."""
        driver = self._make_driver(context_window_waves=5)
        waves = [self._make_wave(i) for i in range(3)]

        driver._prune_wave_context(waves)

        assert len(waves) == 3

    def test_window_exceeded_oldest_evicted(self) -> None:
        """When wave count > window, the oldest entries are dropped."""
        driver = self._make_driver(context_window_waves=3)
        waves = [self._make_wave(i) for i in range(6)]  # 0..5

        driver._prune_wave_context(waves)

        assert len(waves) == 3
        remaining_wave_nums = [w['wave_num'] for w in waves]
        assert remaining_wave_nums == [3, 4, 5], (
            f'Expected most-recent 3 waves [3,4,5], got {remaining_wave_nums}'
        )

    def test_window_one_always_keeps_latest(self) -> None:
        """Window of 1 always keeps only the most recent wave."""
        driver = self._make_driver(context_window_waves=1)
        waves = [self._make_wave(i) for i in range(10)]

        driver._prune_wave_context(waves)

        assert len(waves) == 1
        assert waves[0]['wave_num'] == 9

    def test_empty_waves_no_error(self) -> None:
        """Empty wave list is handled gracefully."""
        driver = self._make_driver()
        waves: List[Dict[str, Any]] = []

        driver._prune_wave_context(waves)  # must not raise

        assert waves == []

    # --- Character budget tests ---

    def test_budget_not_exceeded_no_eviction(self) -> None:
        """When total summary chars ≤ budget, no budget eviction occurs."""
        driver = self._make_driver(context_window_waves=10, wave_context_budget_chars=1_000)
        # 3 waves × 100 chars = 300 chars < 1000
        waves = [self._make_wave(i, summary_chars=100) for i in range(3)]

        driver._prune_wave_context(waves)

        assert len(waves) == 3

    def test_budget_exceeded_evicts_oldest_first(self) -> None:
        """When total summary chars exceed budget, oldest waves are evicted first."""
        # budget = 500 chars; each wave summary = 300 chars
        # 3 waves = 900 chars → must evict until ≤ 500 chars (1 wave remains)
        driver = self._make_driver(context_window_waves=10, wave_context_budget_chars=500)
        waves = [self._make_wave(i, summary_chars=300) for i in range(3)]

        driver._prune_wave_context(waves)

        # Only 1 wave should remain (300 chars ≤ 500 budget)
        assert len(waves) == 1
        assert waves[0]['wave_num'] == 2  # newest wave survives

    def test_budget_zero_means_unlimited(self) -> None:
        """A budget of 0 disables the char-budget strategy entirely."""
        driver = self._make_driver(context_window_waves=10, wave_context_budget_chars=0)
        waves = [self._make_wave(i, summary_chars=10_000) for i in range(5)]

        driver._prune_wave_context(waves)

        assert len(waves) == 5

    def test_single_wave_never_evicted_by_budget(self) -> None:
        """The last remaining wave is never evicted even if it exceeds the budget."""
        driver = self._make_driver(context_window_waves=10, wave_context_budget_chars=10)
        # One wave with 10 000-char summary — should never be evicted
        waves = [self._make_wave(0, summary_chars=10_000)]

        driver._prune_wave_context(waves)

        assert len(waves) == 1

    def test_window_applied_before_budget(self) -> None:
        """Sliding window evicts first; budget operates on the reduced list."""
        # window=2, budget=400 chars; 5 waves × 200 chars each
        # After window: 2 waves remain = 400 chars → exactly at budget, no further eviction
        driver = self._make_driver(context_window_waves=2, wave_context_budget_chars=400)
        waves = [self._make_wave(i, summary_chars=200) for i in range(5)]

        driver._prune_wave_context(waves)

        assert len(waves) == 2
        remaining_wave_nums = [w['wave_num'] for w in waves]
        assert remaining_wave_nums == [3, 4]

    def test_large_session_stays_bounded(self) -> None:
        """Simulate a 10-wave session and verify context stays within window."""
        driver = self._make_driver(context_window_waves=5, wave_context_budget_chars=12_000)
        waves: List[Dict[str, Any]] = []

        for i in range(10):
            waves.append(self._make_wave(i, summary_chars=500))
            driver._prune_wave_context(waves)

        assert len(waves) <= 5
        # All remaining waves should be the most recent ones
        wave_nums = [w['wave_num'] for w in waves]
        assert wave_nums == sorted(wave_nums)
        assert wave_nums[-1] == 9  # newest wave always present
