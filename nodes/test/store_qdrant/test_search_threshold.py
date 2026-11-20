# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Regression test for the Qdrant score-threshold fix in searchSemantic.

threshold_search is in the rescaled [0, 1] space, but Qdrant's score_threshold
filters against the raw similarity score, so it must not be passed to the engine.
The threshold cut is applied post-rescale by the base store (_addDoc).
"""

import unittest

from ai.common.schema import DocFilter, QuestionText

from ._mock_driver import load_driver, make_doc, make_store

_drv = load_driver('_qdrant_store_threshold')


def _make_store(similarity: str):
    _drv.QdrantClient.reset()
    store = make_store(_drv, collection='c', similarity=similarity, score=0.7)
    store.addChunks([make_doc('doc-a', 0, [1.0, 0.0])])
    calls = []
    real = store.client.query_points

    def spy(*args, **kwargs):
        calls.append(kwargs)
        return real(*args, **kwargs)

    store.client.query_points = spy
    return store, calls


def _run_search(store) -> None:
    query = QuestionText(text='q')
    query.embedding = [0.1, 0.2]
    query.embedding_model = 'unit-model'
    store.searchSemantic(query, DocFilter(offset=0, limit=10))


class TestScoreThresholdNotPassedToEngine(unittest.TestCase):
    def tearDown(self):
        _drv.QdrantClient.reset()

    def test_cosine(self):
        store, calls = _make_store('Cosine')
        _run_search(store)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('score_threshold', calls[0])

    def test_non_cosine(self):
        store, calls = _make_store('Dot')
        _run_search(store)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('score_threshold', calls[0])


if __name__ == '__main__':
    unittest.main()
