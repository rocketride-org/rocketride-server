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

import sys
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import MagicMock

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'


class _FakeDocumentStoreBase:
    def doesCollectionExist(self, *a, **kw):
        return True


for _name in (
    'numpy',
    'qdrant_client',
    'qdrant_client.models',
    'qdrant_client.http',
    'qdrant_client.http.models',
    'qdrant_client.conversions',
    'qdrant_client.conversions.common_types',
    'depends',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.config',
):
    sys.modules.setdefault(_name, MagicMock())

_store_mod = MagicMock()
_store_mod.DocumentStoreBase = _FakeDocumentStoreBase
sys.modules['ai.common.store'] = _store_mod

_spec = importlib.util.spec_from_file_location('_qdrant_store', str(NODES_SRC / 'qdrant' / 'qdrant.py'))
_qdrant_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qdrant_mod)
Store = _qdrant_mod.Store


def _make_store(similarity: str) -> Store:
    store = object.__new__(Store)
    store.client = MagicMock()
    store.client.query_points.return_value.points = []
    store.collection = 'c'
    store.threshold_search = 0.7
    store.similarity = similarity
    return store


def _run_search(store: Store) -> None:
    query = MagicMock(embedding=[0.1, 0.2], embedding_model='m')
    store.searchSemantic(query, MagicMock(offset=0, limit=10))


class TestScoreThresholdNotPassedToEngine(unittest.TestCase):
    def test_cosine(self):
        store = _make_store('Cosine')
        _run_search(store)
        self.assertNotIn('score_threshold', store.client.query_points.call_args.kwargs)

    def test_non_cosine(self):
        store = _make_store('Dot')
        _run_search(store)
        self.assertNotIn('score_threshold', store.client.query_points.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
