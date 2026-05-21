# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for Qdrant score threshold fixes in searchSemantic / _convertToDocs.

Two bugs were fixed in qdrant.py:

1. ``score_threshold`` passed to ``query_points()`` is now inverse-transformed
   for Cosine similarity so the raw [-1, 1] Qdrant space matches the normalised
   [0, 1] user threshold:
       raw_threshold = (threshold_search * 2) - 1

2. The hardcoded ``if score < 0.20`` guard in ``_convertToDocs()`` was replaced
   with ``if score < self.threshold_search``, so the configured threshold is
   actually applied.

Usage:
    python -m pytest nodes/test/qdrant/test_search_threshold.py -v
"""

import math
import sys
import threading
import importlib
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Bootstrap mocks so qdrant.py can be imported without real dependencies
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'


# --- ai.common.store: provide a real DocumentStoreBase with stub methods ---
class _FakeDocumentStoreBase:
    """Minimal stand-in for ai.common.store.DocumentStoreBase."""

    def __init__(self, *a, **kw):
        self.vectorSize = 0
        self.modelName = ''
        self.threshold_search = 0.5
        self.collectionLock = threading.Lock()

    def doesCollectionExist(self, *a, **kw):
        return True

    def _doesCollectionExist(self):
        return True

    def _checkCollectionExists(self):
        return True

    def createCollection(self, *a, **kw):
        return True


# Install module-level stubs before any qdrant imports
_mock_store_mod = MagicMock()
_mock_store_mod.DocumentStoreBase = _FakeDocumentStoreBase

_mock_config_mod = MagicMock()
_mock_schema_mod = MagicMock()

for name, mock in {
    'numpy': MagicMock(),
    'qdrant_client': MagicMock(),
    'qdrant_client.models': MagicMock(),
    'qdrant_client.http': MagicMock(),
    'qdrant_client.http.models': MagicMock(),
    'qdrant_client.conversions': MagicMock(),
    'qdrant_client.conversions.common_types': MagicMock(),
}.items():
    sys.modules.setdefault(name, mock)


# ---------------------------------------------------------------------------
# Import qdrant.py DIRECTLY (bypassing __init__.py which pulls IEndpoint etc.)
# ---------------------------------------------------------------------------

_qdrant_path = NODES_SRC / 'qdrant' / 'qdrant.py'
_spec = importlib.util.spec_from_file_location('_qdrant_store', str(_qdrant_path))
_qdrant_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qdrant_mod)

Store = _qdrant_mod.Store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_store(threshold: float = 0.5, similarity: str = 'Cosine') -> Store:
    """Create a Store instance with a mocked QdrantClient (bypasses __init__)."""
    store = object.__new__(Store)
    store.client = MagicMock()
    store.collection = 'test-collection'
    store.vectorSize = 384
    store.modelName = 'test-model'
    store.threshold_search = threshold
    store.similarity = similarity
    store.collectionLock = threading.Lock()
    store._checkCollectionExists = lambda: True
    return store


def _fake_query_result(points):
    """Wrap a list of points in a mock QueryResult-like object."""
    result = MagicMock()
    result.points = points
    return result


def _approx_equal(a: float, b: float, tol: float = 1e-9) -> bool:
    """Float equality with tolerance (avoids pytest.approx which touches numpy)."""
    return math.isclose(a, b, abs_tol=tol)


# ---------------------------------------------------------------------------
# Tests: score_threshold inverse-transform for query_points()
# ---------------------------------------------------------------------------


class TestScoreThresholdTransform:
    """Verify that score_threshold is correctly inverse-transformed before being
    passed to query_points() for Cosine similarity.
    """

    def _call_search_semantic(self, store: Store) -> None:
        """Invoke searchSemantic with the minimal QuestionText / DocFilter mocks."""
        question = MagicMock()
        question.embedding = [0.1, 0.2, 0.3]
        question.embedding_model = 'test-model'

        doc_filter = MagicMock()
        doc_filter.nodeId = None
        doc_filter.isTable = None
        doc_filter.tableIds = None
        doc_filter.parent = None
        doc_filter.permissions = None
        doc_filter.objectIds = None
        doc_filter.isDeleted = None
        doc_filter.chunkIds = None
        doc_filter.minChunkId = None
        doc_filter.maxChunkId = None
        doc_filter.offset = 0
        doc_filter.limit = 10

        # query_points must return something iterable via .points
        store.client.query_points.return_value = _fake_query_result([])

        store.searchSemantic(question, doc_filter)

    def test_cosine_threshold_0_7_passed_as_0_4(self):
        """threshold_search=0.7, Cosine → score_threshold=0.4 sent to Qdrant."""
        store = _make_store(threshold=0.7, similarity='Cosine')

        self._call_search_semantic(store)

        store.client.query_points.assert_called_once()
        _, kwargs = store.client.query_points.call_args
        expected_raw = (0.7 * 2) - 1  # 0.4
        assert _approx_equal(kwargs['score_threshold'], expected_raw), (
            f'Expected score_threshold={expected_raw} but got {kwargs["score_threshold"]}'
        )

    def test_cosine_threshold_0_0_passed_as_minus_1(self):
        """threshold_search=0.0 (All results), Cosine → score_threshold=-1.0."""
        store = _make_store(threshold=0.0, similarity='Cosine')

        self._call_search_semantic(store)

        store.client.query_points.assert_called_once()
        _, kwargs = store.client.query_points.call_args
        expected_raw = (0.0 * 2) - 1  # -1.0
        assert _approx_equal(kwargs['score_threshold'], expected_raw), (
            f'Expected score_threshold={expected_raw} but got {kwargs["score_threshold"]}'
        )

    def test_cosine_threshold_0_5_passed_as_0_0(self):
        """threshold_search=0.5, Cosine → score_threshold=0.0."""
        store = _make_store(threshold=0.5, similarity='Cosine')

        self._call_search_semantic(store)

        _, kwargs = store.client.query_points.call_args
        expected_raw = (0.5 * 2) - 1  # 0.0
        assert _approx_equal(kwargs['score_threshold'], expected_raw)

    def test_non_cosine_threshold_not_transformed(self):
        """threshold_search=0.7, Dot similarity → score_threshold=0.7 (no transform)."""
        store = _make_store(threshold=0.7, similarity='Dot')

        self._call_search_semantic(store)

        _, kwargs = store.client.query_points.call_args
        assert _approx_equal(kwargs['score_threshold'], 0.7), (
            f'Expected score_threshold=0.7 for Dot similarity but got {kwargs["score_threshold"]}'
        )

    def test_euclid_threshold_not_transformed(self):
        """threshold_search=0.3, Euclid similarity → score_threshold=0.3 (no transform)."""
        store = _make_store(threshold=0.3, similarity='Euclid')

        self._call_search_semantic(store)

        _, kwargs = store.client.query_points.call_args
        assert _approx_equal(kwargs['score_threshold'], 0.3)


# ---------------------------------------------------------------------------
# Tests: _convertToDocs() threshold filtering
# ---------------------------------------------------------------------------


class TestConvertToDocsThreshold:
    """Verify that _convertToDocs() uses threshold_search (not 0.20) to filter."""

    def _run_convert(self, store: Store, raw_scores: list) -> list:
        """
        Call _convertToDocs with fake ScoredPoints having the given raw scores.

        Because qdrant_client is fully mocked, ScoredPoint in _qdrant_mod is itself
        a MagicMock.  We replace it temporarily with a real sentinel class so that
        ``isinstance(point, ScoredPoint)`` works correctly inside _convertToDocs.
        We also patch DocMetadata so payload unpacking does not raise.
        """

        # Create a real (non-mock) class to stand in for ScoredPoint
        class _RealScoredPoint:
            def __init__(self, score, payload):
                self.score = score
                self.payload = payload

        fake_metadata = MagicMock()
        DocMetadata_mock = MagicMock(return_value=fake_metadata)

        points = [
            _RealScoredPoint(
                score=raw,
                payload={'content': 'chunk text', 'meta': {}},
            )
            for raw in raw_scores
        ]

        # Doc is a Pydantic model that validates its fields; replace it with a
        # plain container so tests that reach the Doc(...) call don't fail on
        # metadata type validation.
        class _FakeDoc:
            def __init__(self, **kwargs):
                for k, v in kwargs.items():
                    setattr(self, k, v)

        with (
            patch.object(_qdrant_mod, 'ScoredPoint', _RealScoredPoint),
            patch.object(_qdrant_mod, 'DocMetadata', DocMetadata_mock),
            patch.object(_qdrant_mod, 'Doc', _FakeDoc),
        ):
            docs = store._convertToDocs(points)

        return docs

    def test_cosine_score_above_threshold_passes(self):
        """
        Raw score=0.8 → normalised=(0.8+1)/2=0.9; threshold=0.7 → doc is kept.
        """
        store = _make_store(threshold=0.7, similarity='Cosine')
        # raw 0.8 → normalised 0.9, which is >= 0.7
        docs = self._run_convert(store, raw_scores=[0.8])
        assert len(docs) == 1, f'Expected 1 doc (score above threshold) but got {len(docs)}'

    def test_cosine_score_at_threshold_passes(self):
        """
        Raw score=0.4 → normalised=(0.4+1)/2=0.7; threshold=0.7 → doc is kept (equal).
        """
        store = _make_store(threshold=0.7, similarity='Cosine')
        # raw 0.4 → normalised exactly 0.7
        docs = self._run_convert(store, raw_scores=[0.4])
        assert len(docs) == 1, f'Expected 1 doc (score at threshold) but got {len(docs)}'

    def test_cosine_score_below_threshold_filtered(self):
        """
        Raw score=0.2 → normalised=(0.2+1)/2=0.6; threshold=0.7 → doc is filtered out.
        """
        store = _make_store(threshold=0.7, similarity='Cosine')
        # raw 0.2 → normalised 0.6, which is < 0.7
        docs = self._run_convert(store, raw_scores=[0.2])
        assert len(docs) == 0, f'Expected 0 docs (score below threshold) but got {len(docs)}'

    def test_threshold_0_0_keeps_all_results(self):
        """
        threshold_search=0.0 → all results pass regardless of score.
        """
        store = _make_store(threshold=0.0, similarity='Cosine')
        # raw -0.5 → normalised 0.25, still >= 0.0
        docs = self._run_convert(store, raw_scores=[-0.5, 0.0, 0.95])
        assert len(docs) == 3, f'Expected 3 docs (threshold=0) but got {len(docs)}'

    def test_score_previously_hardcoded_0_20_passes_with_low_threshold(self):
        """
        Regression: the old code had ``if score < 0.20`` hardcoded.

        A normalised score of 0.15 (raw=-0.7) with threshold_search=0.10
        should now PASS, whereas the old code would have filtered it out.
        """
        store = _make_store(threshold=0.10, similarity='Cosine')
        # raw -0.7 → normalised (-0.7+1)/2 = 0.15, which is >= 0.10
        docs = self._run_convert(store, raw_scores=[-0.7])
        assert len(docs) == 1, (
            'Score 0.15 should pass when threshold=0.10 (regression: old hardcoded 0.20 would have filtered it)'
        )

    def test_mixed_scores_partial_filter(self):
        """
        Multiple points: only those with normalised score >= threshold pass.
        threshold=0.7:
          raw 0.8 → 0.9  (pass)
          raw 0.2 → 0.6  (fail)
          raw 0.4 → 0.7  (pass, equal)
        """
        store = _make_store(threshold=0.7, similarity='Cosine')
        docs = self._run_convert(store, raw_scores=[0.8, 0.2, 0.4])
        assert len(docs) == 2, f'Expected 2 docs but got {len(docs)}'
