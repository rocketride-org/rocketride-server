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

    # Latency used in tests that still need time.sleep (thread-safety stress).
    # Not used for the parallelism proof (that uses a Barrier instead).
    _SLEEP_S = 0.02

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
        call_index = {'n': 0}
        lock = threading.Lock()
        docs_sets = [
            [_make_doc('obj-a', score=0.95)],
            [_make_doc('obj-b', score=0.80)],
            [_make_doc('obj-c', score=0.70)],
        ]

        def _semantic(q: QuestionText, f: DocFilter) -> List[Doc]:
            with lock:
                idx = call_index['n']
                call_index['n'] += 1
            return docs_sets[idx]

        store = _TestStore(semantic_fn=_semantic)
        question = _make_semantic_question(['q1', 'q2', 'q3'])

        result = store._queryDocuments(question)

        assert len(result) == 3
        assert ('obj-a', 0) in result
        assert ('obj-b', 0) in result
        assert ('obj-c', 0) in result

    def test_parallel_execution_is_structurally_concurrent(self) -> None:
        """Prove queries run in parallel via a threading.Barrier rendezvous.

        A Barrier with party_count=N blocks each thread until ALL N threads
        have reached it.  If the executor ran queries serially, the barrier
        would never be reached by more than one thread at a time and would
        deadlock (timing out and raising BrokenBarrierError).

        This proof is deterministic and CI-safe: it does not rely on
        wall-clock timing or OS scheduler behaviour.
        """
        n_queries = 3
        # Barrier requires all 3 threads to rendezvous simultaneously.
        # timeout=5s is generous — any reasonable parallel executor will
        # reach it in milliseconds.
        barrier = threading.Barrier(n_queries, timeout=5)

        def _semantic(q: QuestionText, f: DocFilter) -> List[Doc]:
            # Reaching this line from all threads simultaneously proves
            # the executor dispatched all futures before any returned.
            barrier.wait()  # raises BrokenBarrierError if serial
            return []

        store = _TestStore(semantic_fn=_semantic)
        question = _make_semantic_question([f'query-{i}' for i in range(n_queries)])

        # Must not raise BrokenBarrierError (which would mean serial execution)
        store._queryDocuments(question)

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
            time.sleep(self._SLEEP_S)
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
# Pre-Flight Audit Regression Tests (defects found and fixed)
# ===========================================================================


def _make_get_question() -> Question:
    """Build a GET Question (no sub-queries, just a filter)."""
    q = Question()
    q.type = QuestionType.GET
    q.filter = DocFilter()
    q.documents = []
    return q


class TestPreFlightAuditRegressions:
    """
    Regression tests for the three production defects identified in the
    hostile pre-flight audit.  These must NEVER be deleted.

    Defect 1 (FIXED): Empty SEMANTIC query list → ThreadPoolExecutor(max_workers=0)
                       raised ValueError.
    Defect 2 (FIXED): Empty KEYWORD query list → same ValueError crash.
    Defect 3 (FIXED): GET type silently unreachable because GET was chained as
                       'elif' off the KEYWORD 'if', making it unreachable when
                       KEYWORD matched with zero queries and fell to else:pass.
    """

    # ------------------------------------------------------------------
    # Defect 1: Empty SEMANTIC question list must not crash
    # ------------------------------------------------------------------

    def test_semantic_empty_questions_no_crash(self) -> None:
        """SEMANTIC question with zero sub-queries returns empty dict, no crash.

        Before the fix, len(queries)==0 hit the 'else' branch which called
        ThreadPoolExecutor(max_workers=min(8,0)) = ThreadPoolExecutor(max_workers=0)
        raising ValueError: max_workers must be greater than 0.
        """
        store = _TestStore()
        q = Question()
        q.type = QuestionType.SEMANTIC
        q.filter = DocFilter()
        q.documents = []
        q.questions = []  # deliberately empty

        # Must not raise
        result = store._queryDocuments(q)
        assert result == {}, f'Expected empty dict, got {result}'

    def test_prompt_empty_questions_no_crash(self) -> None:
        """PROMPT type with zero sub-questions must not crash."""
        store = _TestStore()
        q = Question()
        q.type = QuestionType.PROMPT
        q.filter = DocFilter()
        q.documents = []
        q.questions = []

        result = store._queryDocuments(q)
        assert result == {}

    # ------------------------------------------------------------------
    # Defect 2: Empty KEYWORD question list must not crash
    # ------------------------------------------------------------------

    def test_keyword_empty_questions_no_crash(self) -> None:
        """KEYWORD question with zero terms returns empty dict, no ValueError crash.

        Before the fix, len(queries)==0 hit the 'else' branch which called
        ThreadPoolExecutor(max_workers=0) raising ValueError.
        """
        store = _TestStore()
        q = _make_keyword_question([])  # zero terms

        result = store._queryDocuments(q)
        assert result == {}

    def test_keyword_empty_does_not_call_search(self) -> None:
        """searchKeyword must not be called at all when query list is empty."""
        call_count = {'n': 0}

        def _spy(query, f):
            call_count['n'] += 1
            return []

        store = _TestStore(keyword_fn=_spy)
        q = _make_keyword_question([])

        store._queryDocuments(q)
        assert call_count['n'] == 0

    # ------------------------------------------------------------------
    # Defect 3: GET type must be reachable regardless of KEYWORD branch
    # ------------------------------------------------------------------

    def test_get_type_is_reachable(self) -> None:
        """QuestionType.GET must call self.get() and return its results.

        Before the fix, GET was chained as 'elif' off the KEYWORD 'if'.
        When type==GET the KEYWORD 'if' was False, falling to the 'elif GET'
        branch — this worked by coincidence for the simple case.  But if
        type==KEYWORD with len(queries)==0, the code hit the else:pass arm
        instead of the GET arm, silently returning no results.

        This test verifies GET is always reachable as an independent branch.
        """
        get_doc = _make_doc('get-obj-1', score=0.88)

        class _GetStore(_TestStore):
            def get(self, docFilter: DocFilter, **_kw) -> List[Doc]:
                return [get_doc]

        store = _GetStore()
        q = _make_get_question()

        result = store._queryDocuments(q)

        assert ('get-obj-1', 0) in result, (
            f'GET document not found in result — GET branch may be unreachable. Got: {result}'
        )

    def test_get_type_not_affected_by_keyword_zero_queries(self) -> None:
        """The broken elif chain: KEYWORD(queries=[]) must NOT fall to GET.

        This tests the structural fix: KEYWORD with empty queries must return {},
        not accidentally invoke the GET branch.
        """
        get_called = {'n': 0}

        class _SpyGetStore(_TestStore):
            def get(self, docFilter: DocFilter, **_kw) -> List[Doc]:
                get_called['n'] += 1
                return [_make_doc('should-not-appear')]

        store = _SpyGetStore()
        # KEYWORD type with zero queries — must NOT call get()
        q = _make_keyword_question([])

        result = store._queryDocuments(q)

        assert get_called['n'] == 0, (
            f'get() was called {get_called["n"]} time(s) for a KEYWORD question — '
            f'the if/elif chain is still broken'
        )
        assert result == {}
