# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Qdrant's recommendation query: the mock server answers it, the driver serves it natively.

The mock ``qdrant_client`` (``nodes/test/mocks/qdrant_client``) answers
``query_points(query=RecommendQuery(recommend=RecommendInput(...)))`` the way a
Qdrant 1.17 server does (checked against one): examples may be point ids or raw
vectors and are never returned; ``average_vector`` searches with
``avg_positive + avg_positive - avg_negative`` (``avg_positive`` without
negatives), counting a stored point at unit length on a Cosine collection and a
raw example vector as given, and refuses an empty positive side; ``best_score``
scores every candidate by its best positive and best negative similarity (the
negated squared distance on Euclid) through Qdrant's sigmoid step and accepts
negatives alone; ``sum_scores`` sums them.

The driver's ``recommendNative`` hook resolves explorer keys to point ids (the
deterministic ids and the random ids of older rows alike), keeps to the active
rows of real documents (and to a scope of objectIds), counts the query vector as
a positive example and hands back each hit with the score Qdrant gave it. The
driver declares ``recommend_best_score`` and keyword search by whole words
(``VX_KEYWORD_MATCH = 'token'``).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import numpy as np
import pytest
from rocketlib import IInstanceBase

from ai.common.store import VectorStoreToolMixin, vx_types

from ._mock_driver import load_driver, make_doc, make_store

drv = load_driver('_vx_qdrant_driver_mock_recommend')
Client = drv.QdrantClient
models = drv.models


@pytest.fixture(autouse=True)
def _fresh_server():
    Client.reset()
    yield
    Client.reset()


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _cos(a, b):
    return float(_unit(a) @ _unit(b))


def _sigmoid(x):
    return 0.5 * (1.0 + (x / (1.0 + abs(x))))


# ---------------------------------------------------------------------------
# The mock server
# ---------------------------------------------------------------------------


def _server(distance='Cosine', n=20, dim=5, seed=11):
    """A collection of ``n`` points with integer ids 1..n and raw (not unit) vectors."""
    client = Client(url='http://127.0.0.1:6333')
    client.create_collection('rec', vectors_config=drv.types.VectorParams(size=dim, distance=distance))
    rng = np.random.default_rng(seed)
    vectors = {i: rng.normal(size=dim) * rng.uniform(0.5, 3.0) for i in range(1, n + 1)}
    client.upsert(
        'rec',
        points=[
            drv.PointStruct(id=i, vector=v.tolist(), payload={'n': i, 'odd': i % 2 == 1}) for i, v in vectors.items()
        ],
    )
    return client, vectors


def _recommend(client, positive=None, negative=None, strategy=None, limit=50, query_filter=None):
    query = models.RecommendQuery(
        recommend=models.RecommendInput(positive=positive, negative=negative, strategy=strategy)
    )
    return client.query_points('rec', query=query, query_filter=query_filter, limit=limit).points


def test_the_mock_models_carry_the_recommendation_types():
    assert [s.value for s in models.RecommendStrategy] == ['average_vector', 'best_score', 'sum_scores']
    query = models.RecommendQuery(recommend=models.RecommendInput(positive=[1], negative=[2], strategy='best_score'))
    assert query.recommend.positive == [1] and query.recommend.negative == [2]
    assert models.RecommendInput().positive is None and models.RecommendInput().strategy is None


def test_average_vector_searches_twice_the_positive_mean_minus_the_negative_mean_over_unit_examples():
    client, vectors = _server()
    points = _recommend(client, positive=[1, 2], negative=[3], strategy='average_vector')
    avg_p = np.mean([_unit(vectors[i]) for i in (1, 2)], axis=0)
    avg_n = np.mean([_unit(vectors[3])], axis=0)
    query = avg_p + avg_p - avg_n
    expected = sorted(((_cos(query, v), i) for i, v in vectors.items() if i not in (1, 2, 3)), reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected]
    assert [p.score for p in points] == pytest.approx([s for s, _i in expected])


def test_average_vector_is_the_default_strategy_and_needs_no_negative():
    client, vectors = _server()
    points = _recommend(client, positive=[4, 9])
    query = np.mean([_unit(vectors[i]) for i in (4, 9)], axis=0)
    expected = sorted(((_cos(query, v), i) for i, v in vectors.items() if i not in (4, 9)), reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected]


def test_average_vector_averages_raw_vectors_on_a_dot_collection():
    client, vectors = _server(distance='Dot')
    points = _recommend(client, positive=[1, 2], negative=[3], strategy='average_vector')
    query = 2 * np.mean([vectors[1], vectors[2]], axis=0) - vectors[3]
    expected = sorted(((float(query @ v), i) for i, v in vectors.items() if i not in (1, 2, 3)), reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected]


def test_average_vector_refuses_an_empty_positive_side_as_the_server_does():
    client, _vectors = _server()
    with pytest.raises(Exception, match='Positive vectors should not be empty'):
        _recommend(client, negative=[3], strategy='average_vector')


def test_best_score_follows_qdrants_step_formula():
    client, vectors = _server()
    points = _recommend(client, positive=[1, 2], negative=[3, 4], strategy='best_score')
    expected = []
    for i, v in vectors.items():
        if i in (1, 2, 3, 4):
            continue
        best_p = max(_cos(v, vectors[j]) for j in (1, 2))
        best_n = max(_cos(v, vectors[j]) for j in (3, 4))
        expected.append((_sigmoid(best_p) if best_p > best_n else -_sigmoid(best_n), i))
    expected.sort(reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected]
    assert [p.score for p in points] == pytest.approx([s for s, _i in expected])


def test_best_score_with_negatives_alone_lists_the_least_similar_first():
    client, vectors = _server()
    points = _recommend(client, negative=[5], strategy=models.RecommendStrategy.BEST_SCORE)
    assert all(p.score < 0 for p in points)
    assert [p.id for p in points] == [
        i for _s, i in sorted(((-_sigmoid(_cos(v, vectors[5])), i) for i, v in vectors.items() if i != 5), reverse=True)
    ]
    assert points[0].id == min((i for i in vectors if i != 5), key=lambda i: _cos(vectors[i], vectors[5]))


def test_sum_scores_adds_positive_and_subtracts_negative_similarities():
    client, vectors = _server()
    points = _recommend(client, positive=[1], negative=[2], strategy='sum_scores')
    expected = sorted(
        ((_cos(v, vectors[1]) - _cos(v, vectors[2]), i) for i, v in vectors.items() if i not in (1, 2)), reverse=True
    )
    assert [p.id for p in points] == [i for _s, i in expected]


def test_average_vector_takes_a_raw_example_vector_as_given_on_a_cosine_collection():
    client, vectors = _server()
    raw = vectors[7] * 5.0  # far from unit length
    assert abs(np.linalg.norm(raw) - 1.0) > 1.0
    points = _recommend(client, positive=[raw.tolist(), 1], negative=[3], strategy='average_vector', limit=100)
    avg_p = np.mean([raw, _unit(vectors[1])], axis=0)
    query = avg_p + avg_p - _unit(vectors[3])
    expected = sorted(((_cos(query, v), i) for i, v in vectors.items() if i not in (1, 3)), reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected], (
        'stored points count at unit length, raw vectors as given'
    )
    assert [p.score for p in points] == pytest.approx([s for s, _i in expected])


def test_best_score_on_euclid_measures_by_the_negated_squared_distance():
    client, vectors = _server(distance='Euclid')
    points = _recommend(client, positive=[1, 2], negative=[3], strategy='best_score', limit=100)

    def sim(a, b):
        return -float(np.sum((np.asarray(a) - np.asarray(b)) ** 2))

    expected = []
    for i, v in vectors.items():
        if i in (1, 2, 3):
            continue
        best_p = max(sim(v, vectors[j]) for j in (1, 2))
        best_n = sim(v, vectors[3])
        expected.append((_sigmoid(best_p) if best_p > best_n else -_sigmoid(best_n), i))
    expected.sort(reverse=True)
    assert [p.id for p in points] == [i for _s, i in expected]
    assert [p.score for p in points] == pytest.approx([s for s, _i in expected])


def test_examples_may_be_raw_vectors_and_are_never_returned():
    client, vectors = _server()
    raw = (vectors[7] * 2).tolist()
    points = _recommend(client, positive=[raw, 1], strategy='average_vector', limit=100)
    ids = [p.id for p in points]
    assert 1 not in ids and 7 in ids, 'a raw vector is not a point, so the point it copies may be returned'
    assert len(ids) == 19


def test_the_filter_selects_candidates_but_examples_are_looked_up_outside_it():
    client, _vectors = _server()
    odd = models.Filter(must=[models.FieldCondition(key='odd', match=models.MatchValue(value=True))])
    points = _recommend(client, positive=[2], strategy='best_score', query_filter=odd)
    assert points and all(p.id % 2 == 1 for p in points)


def test_an_unknown_example_id_is_refused():
    client, _vectors = _server()
    with pytest.raises(Exception, match='Not found'):
        _recommend(client, positive=[999])


def test_the_limit_and_the_call_counter():
    client, _vectors = _server()
    before = Client.calls.get('query_points', 0)
    assert len(_recommend(client, positive=[1], limit=3)) == 3
    assert Client.calls['query_points'] == before + 1


# ---------------------------------------------------------------------------
# The driver
# ---------------------------------------------------------------------------


def _corpus(store, *, docs=5, chunks=4, dim=6, seed=21):
    rng = np.random.default_rng(seed)
    batch = []
    for d in range(docs):
        centre = rng.normal(size=dim)
        for c in range(chunks):
            batch.append(make_doc(f'doc-{d}', c, _unit(centre + 0.4 * rng.normal(size=dim)).tolist()))
    store.addChunks(batch)
    return {(f'doc-{d}', c): None for d in range(docs) for c in range(chunks)}


def _vector_of(store, key):
    return np.asarray(store.getVectors([key])[0].embedding, dtype=float)


def _keys(docs):
    return [(d.metadata.objectId, d.metadata.chunkId) for d in docs]


def test_the_driver_declares_native_recommendation_and_whole_word_keyword_search():
    store = make_store(drv)
    assert 'recommend_best_score' in store.capabilities()
    assert {'knn_native', 'documents_distinct', 'search_keyword'} <= store.capabilities()
    assert drv.Store.VX_KEYWORD_MATCH == 'token'
    assert drv.Store.VX_KEYWORD_MATCH in vx_types.KEYWORD_MATCHES
    assert callable(getattr(store, 'recommendNative', None))


def test_recommend_native_best_score_by_keys_matches_the_formula():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    pos, neg = [('doc-0', 0), ('doc-1', 2)], [('doc-3', 1)]
    docs = store.recommendNative(positive=pos, negative=neg, strategy='best_score', limit=30)
    examples = {k: _vector_of(store, k) for k in pos + neg}
    expected = []
    for d in range(5):
        for c in range(4):
            key = (f'doc-{d}', c)
            if key in examples:
                continue
            v = _vector_of(store, key)
            best_p = max(_cos(v, examples[k]) for k in pos)
            best_n = max(_cos(v, examples[k]) for k in neg)
            expected.append((_sigmoid(best_p) if best_p > best_n else -_sigmoid(best_n), key))
    expected.sort(key=lambda sk: -sk[0])
    assert _keys(docs) == [k for _s, k in expected]
    assert [d.score for d in docs] == pytest.approx([s for s, _k in expected])


def test_recommend_native_hands_back_docs_with_text_path_point_id_and_no_vector():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    doc = store.recommendNative(positive=[('doc-0', 0)], negative=[], strategy='best_score', limit=1)[0]
    assert doc.page_content == f'{doc.metadata.objectId} chunk {doc.metadata.chunkId}'
    assert doc.metadata.parent == f'C:/docs/{doc.metadata.objectId}.md'
    assert doc.metadata.pointId == drv.point_id_for(doc.metadata.objectId, doc.metadata.chunkId)
    assert doc.embedding is None
    assert isinstance(doc.score, float) and -1.0 <= doc.score <= 1.0


def test_recommend_native_average_vector_is_the_servers_own_ranking():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    pos, neg = [('doc-2', 0), ('doc-2', 3)], [('doc-4', 1)]
    docs = store.recommendNative(positive=pos, negative=neg, strategy='average_vector', limit=30)
    avg_p = np.mean([_unit(_vector_of(store, k)) for k in pos], axis=0)
    query = 2 * avg_p - _unit(_vector_of(store, neg[0]))
    others = [(f'doc-{d}', c) for d in range(5) for c in range(4) if (f'doc-{d}', c) not in pos + neg]
    assert _keys(docs) == sorted(others, key=lambda k: -_cos(query, _vector_of(store, k)))


def test_recommend_native_accepts_negatives_alone():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    docs = store.recommendNative(positive=[], negative=[('doc-1', 1)], strategy='best_score', limit=5)
    assert len(docs) == 5 and all(d.score < 0 for d in docs)
    assert ('doc-1', 1) not in _keys(docs)


def test_recommend_native_counts_the_query_vector_as_a_positive():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    target = _vector_of(store, ('doc-3', 2))
    docs = store.recommendNative(positive=[], negative=[], vector=target.tolist(), strategy='best_score', limit=3)
    assert _keys(docs)[0] == ('doc-3', 2), 'a raw vector is not an example point, so its twin ranks first'
    assert docs[0].score == pytest.approx(_sigmoid(1.0))


def test_recommend_native_keeps_to_active_rows_of_real_documents_and_the_scope():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    store.markDeleted(['doc-4'])
    docs = store.recommendNative(positive=[('doc-0', 1)], negative=[], strategy='best_score', limit=100)
    found = {k[0] for k in _keys(docs)}
    assert 'doc-4' not in found and 'schema' not in found
    assert len(docs) == 4 * 4 - 1
    scoped = store.recommendNative(
        positive=[('doc-0', 1)], negative=[], strategy='best_score', limit=100, object_ids=['doc-2', 'doc-3']
    )
    assert {k[0] for k in _keys(scoped)} == {'doc-2', 'doc-3'}


def test_recommend_native_resolves_the_random_ids_of_older_rows():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    legacy = _unit([1, 0, 0, 0, 0, 0])
    pid = str(uuid.uuid4())
    store.client.upsert(
        store.collection,
        points=[
            drv.PointStruct(
                id=pid,
                vector=legacy.tolist(),
                payload={
                    'content': 'legacy',
                    'meta': {
                        'objectId': 'old',
                        'chunkId': 0,
                        'nodeId': 'chunk_1',
                        'parent': 'C:/old.md',
                        'isDeleted': False,
                        'isTable': False,
                        'tableId': 0,
                    },
                },
            )
        ],
    )
    docs = store.recommendNative(positive=[('old', 0)], negative=[], strategy='best_score', limit=100)
    assert ('old', 0) not in _keys(docs), 'the example (a random id) is excluded like any other'
    assert len(docs) == 20


def test_recommend_native_without_any_resolvable_example_asks_nothing():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    before = Client.calls.get('query_points', 0)
    assert (
        store.recommendNative(positive=[('ghost', 0), ('schema', 0)], negative=[], strategy='best_score', limit=5) == []
    )
    assert Client.calls.get('query_points', 0) == before


def test_recommend_native_drops_unknown_examples_and_keeps_the_rest():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    docs = store.recommendNative(
        positive=[('ghost', 0), ('doc-1', 0)], negative=[('ghost', 1)], strategy='best_score', limit=100
    )
    assert len(docs) == 19 and ('doc-1', 0) not in _keys(docs)


def test_recommend_native_never_turns_positives_that_resolve_to_nothing_into_a_negatives_only_query():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    store.getVectors([('doc-1', 0)])  # the driver remembers the point id
    store.removeCounted(['doc-1'])
    before = Client.calls.get('query_points', 0)
    for positive in ([('ghost', 0)], [('doc-1', 0)], [('schema', 0)], [('ghost', 0), ('doc-1', 0), ('schema', 0)]):
        docs = store.recommendNative(positive=positive, negative=[('doc-2', 1)], strategy='best_score', limit=5)
        assert docs == [], positive
    assert Client.calls.get('query_points', 0) == before, 'positives were asked for, none is stored'
    with_vector = store.recommendNative(
        positive=[('ghost', 0)],
        negative=[('doc-2', 1)],
        vector=_vector_of(store, ('doc-3', 2)).tolist(),
        strategy='best_score',
        limit=3,
    )
    assert _keys(with_vector)[0] == ('doc-3', 2), 'the query vector is a positive example of its own'
    alone = store.recommendNative(positive=[], negative=[('doc-2', 1)], strategy='best_score', limit=5)
    assert len(alone) == 5 and all(d.score < 0 for d in alone), 'negatives alone, as asked, are still answered'


def test_recommend_native_on_a_missing_collection_is_empty():
    store = make_store(drv, collection='vx_absent')
    assert store.recommendNative(positive=[('doc-0', 0)], negative=[], strategy='best_score', limit=5) == []


@pytest.mark.parametrize('strategy', ['', 'nearest', None, 'sum'])
def test_recommend_native_refuses_a_strategy_it_does_not_serve(strategy):
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    with pytest.raises(ValueError):
        store.recommendNative(positive=[('doc-0', 0)], negative=[], strategy=strategy, limit=5)


def test_recommend_native_searches_exactly():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    seen = {}
    original = Client.query_points

    def spy(self, *args, **kwargs):
        seen.update(kwargs)
        return original(self, *args, **kwargs)

    Client.query_points = spy
    try:
        store.recommendNative(positive=[('doc-0', 0)], negative=[], strategy='best_score', limit=4)
    finally:
        Client.query_points = original
    assert seen['limit'] == 4 and seen['with_vectors'] is False and seen['with_payload'] is True
    assert seen['search_params'].exact is True
    assert seen['query'].recommend.strategy == 'best_score'
    assert seen['query'].recommend.positive and seen['query'].recommend.negative is None


def test_recommend_native_never_hands_qdrant_an_id_remembered_for_a_removed_point():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    store.getVectors([('doc-1', 0), ('doc-2', 0)])  # the driver remembers both point ids
    store.removeCounted(['doc-1'])
    docs = store.recommendNative(positive=[('doc-1', 0), ('doc-2', 0)], negative=[], strategy='best_score', limit=100)
    assert ('doc-2', 0) not in _keys(docs) and not any(k[0] == 'doc-1' for k in _keys(docs))
    assert len(docs) == 15


# ---------------------------------------------------------------------------
# What the node reports for the driver
# ---------------------------------------------------------------------------


class _Node(VectorStoreToolMixin, IInstanceBase):
    pass


def _node(store):
    inst = object.__new__(_Node)
    inst.IGlobal = SimpleNamespace(store=store, glb=SimpleNamespace(logicalType='qdrant'))
    inst.instance = SimpleNamespace(pipeType={'id': 'store_1'})
    return inst


def test_the_dialect_reports_native_recommendation_and_whole_word_keyword_search():
    store = make_store(drv, collection='vx_rec')
    _corpus(store)
    answer = _node(store).dialect({})
    assert answer['capabilities']['recommend_best_score'] is True
    assert answer['capabilities']['search_keyword'] is True
    assert answer['keyword_match'] == 'token'
