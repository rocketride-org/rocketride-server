"""
Tests for Milvus Store.searchSemantic score threshold filtering.

Validates that hits below ``retrieval_score_threshold`` are excluded
from the result set returned by ``searchSemantic``.
"""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'milvus'))

# Mock heavy dependencies only for the duration of the milvus import so that
# real modules (numpy, ai.*) remain available to other test files collected in
# the same pytest session.
class _FakeDocumentStoreBase:
    pass

with patch.dict(
    sys.modules,
    {
        'numpy': MagicMock(),
        'pymilvus': MagicMock(),
        'depends': MagicMock(),
        'engLib': MagicMock(),
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.schema': MagicMock(),
        'ai.common.store': MagicMock(DocumentStoreBase=_FakeDocumentStoreBase),
        'ai.common.config': MagicMock(),
    },
):
    from milvus import Store


class _Doc:
    def __init__(self, score: float, page_content: str) -> None:
        self.score = score
        self.page_content = page_content


class TestSearchSemanticScoreThreshold(unittest.TestCase):
    """``searchSemantic`` must filter out hits below retrieval_score_threshold."""

    def _make_self(self, threshold: float = 0.5) -> MagicMock:
        mock_self = MagicMock()
        mock_self.collection = 'c'
        mock_self.threshold_search = threshold
        mock_self.doesCollectionExist.return_value = True
        mock_self._convertFilter.return_value = []
        mock_self.client.search.return_value = [[]]
        return mock_self

    def _make_query_and_filter(self) -> tuple[MagicMock, MagicMock]:
        query = MagicMock()
        query.embedding = [0.1, 0.2]
        doc_filter = MagicMock()
        doc_filter.limit = 10
        doc_filter.offset = 0
        return query, doc_filter

    def test_filters_below_threshold(self):
        mock_self = self._make_self(threshold=0.5)
        mock_self._convertToDocs.return_value = [
            _Doc(0.6, 'high 1'),
            _Doc(0.25, 'low'),
            _Doc(0.8, 'high 2'),
        ]
        query, doc_filter = self._make_query_and_filter()

        results = Store.searchSemantic(mock_self, query, doc_filter)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].page_content, 'high 1')
        self.assertEqual(results[1].page_content, 'high 2')

    def test_exact_threshold_included(self):
        mock_self = self._make_self(threshold=0.5)
        mock_self._convertToDocs.return_value = [_Doc(0.5, 'exact')]
        query, doc_filter = self._make_query_and_filter()

        results = Store.searchSemantic(mock_self, query, doc_filter)

        self.assertEqual(len(results), 1)

    def test_all_below_threshold_returns_empty(self):
        mock_self = self._make_self(threshold=0.9)
        mock_self._convertToDocs.return_value = [
            _Doc(0.3, 'a'),
            _Doc(0.5, 'b'),
        ]
        query, doc_filter = self._make_query_and_filter()

        results = Store.searchSemantic(mock_self, query, doc_filter)

        self.assertEqual(results, [])

    def test_all_above_threshold_returned(self):
        mock_self = self._make_self(threshold=0.1)
        mock_self._convertToDocs.return_value = [
            _Doc(0.6, 'a'),
            _Doc(0.7, 'b'),
        ]
        query, doc_filter = self._make_query_and_filter()

        results = Store.searchSemantic(mock_self, query, doc_filter)

        self.assertEqual(len(results), 2)


if __name__ == '__main__':
    unittest.main()
