# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Weaviate store turns a cosine distance into a score where a closer match scores higher.

Weaviate answers a cosine DISTANCE (``1 - cos(a, b)``): 0 for an identical
vector, 1 for an unrelated one, 2 for an opposite one. The store's retrieval
score is in [0, 1] with 1 as the best match, the space ``vector.score`` (0.7
by default) is set in, so an identical vector must score 1.0, not 0.5.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from .test_record_updates import _load_store_class


def _store() -> object:
    """A Store with no client, on the cosine metric every collection is created with."""
    store_class = _load_store_class()
    store = store_class.__new__(store_class)
    store.similarity = store_class.similarityDict['cosine']
    return store


def _point(distance: float | None, object_id: str = 'doc-1') -> SimpleNamespace:
    """A query result as the client returns it: the stored properties and the distance asked for."""
    return SimpleNamespace(
        properties={
            'content': 'The capital of France is Paris.',
            'objectId': object_id,
            'nodeId': 'node-1',
            'parent': '/test',
            'chunkId': 0,
            'isDeleted': False,
        },
        metadata=SimpleNamespace(distance=distance),
    )


@pytest.mark.parametrize(
    ('distance', 'score'),
    [
        (0.0, 1.0),  # an identical vector
        (0.2, 0.9),
        (0.6, 0.7),  # exactly the default retrieval score
        (1.0, 0.5),  # an unrelated vector
    ],
)
def test_a_cosine_distance_becomes_a_score_with_one_as_the_best_match(distance: float, score: float) -> None:
    docs = _store()._convertToDocs([_point(distance)])

    assert len(docs) == 1
    assert docs[0].score == pytest.approx(score)


def test_a_closer_match_scores_higher_than_a_farther_one() -> None:
    docs = _store()._convertToDocs([_point(0.1, 'near'), _point(0.9, 'far')])

    scores = {doc.metadata.objectId: doc.score for doc in docs}
    assert scores['near'] > scores['far']


def test_an_identical_vector_passes_the_default_retrieval_score() -> None:
    """The default ``vector.score`` is 0.7: the best possible match must not fall under it."""
    docs = _store()._convertToDocs([_point(0.0)])

    assert docs[0].score >= 0.7


@pytest.mark.parametrize('distance', [1.7, 2.0])
def test_a_match_near_the_opposite_vector_is_dropped(distance: float) -> None:
    """A score under 0.20 is not returned at all."""
    assert _store()._convertToDocs([_point(distance)]) == []


def test_a_result_without_a_distance_scores_zero() -> None:
    """A keyword or filter fetch asks for no distance: the chunk is kept with a zero score."""
    docs = _store()._convertToDocs([_point(None)])

    assert len(docs) == 1
    assert docs[0].score == 0.0
