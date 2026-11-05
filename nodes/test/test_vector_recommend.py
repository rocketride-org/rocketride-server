# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The ``recommend`` tool: chunks like the positive examples and unlike the negative ones.

Contract section 4.4-D. Examples are ``[objectId, chunkId]`` keys (at most
``recommend_examples_max`` per side); the only vector the tool accepts is the
query vector the embedding node returned, counted as one more positive. It
returns neighbour rows, never a stored vector.

* ``average_vector`` (every store): the node reads the examples' vectors from
  the store (``getVectors``; the latest cached sample only where the store
  cannot read vectors by key, since a sample keeps the chunks of a document
  removed after it was drawn), averages each side
  (``avg_positive``, ``avg_negative``; at unit length on a cosine store, as
  Qdrant does) and searches the whole collection with
  ``avg_positive + avg_positive - avg_negative`` (``avg_positive`` without
  negatives), the way ``neighbors`` searches, examples left out. The golden
  tests hold the ranking against the formula and against the mock Qdrant
  server's own ``average_vector`` answer on the same points.
* ``best_score``: only where the driver declares ``recommend_best_score`` and
  serves ``recommendNative`` (Qdrant); ranked by the store (``native: true``),
  negatives alone allowed; elsewhere ``UNSUPPORTED``.

Codes: ``INVALID_INPUT``, ``NOT_FOUND`` (no positive key resolved; unresolved
keys are always listed in ``not_found``), ``DIMENSION_MISMATCH``,
``COLLECTION_MISSING``, ``BUSY`` (one ``neighbors`` or ``recommend`` at a time
per store), ``UNSUPPORTED``, ``READS_PUBLIC``.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pytest

from ai.common.store import VectorStoreToolMixin, vx_tools
from ai.common.store.errors import StoreUnsupported
from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS

from .store_qdrant._mock_driver import load_driver, make_doc as qdrant_doc, make_store as qdrant_store
from .test_vector_hooks import MODEL, ExactListingStore, MemoryStore, VectorMemoryStore, corpus, make_doc
from .test_vector_write_gate import _dispatch, _tool_node, dap
from .test_vectordb_tool_mixin import _no_vectors_anywhere, clustered, node

qdrant = load_driver('_vx_qdrant_driver_mock_recommend_tool')


@pytest.fixture(autouse=True)
def _fresh_qdrant():
    qdrant.QdrantClient.reset()
    yield
    qdrant.QdrantClient.reset()


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def _keys(answer: Dict[str, Any]) -> List[tuple]:
    return [tuple(item['key']) for item in answer['items']]


def _sent_query(store) -> np.ndarray:
    """The embedding of the last semantic search the store was asked."""
    semantic = [call for call in store.calls if call[0] == 'semantic'][-1]
    return np.asarray(semantic[1].embedding, dtype=np.float64)


def _plane(*vectors, similarity='cosine'):
    """A store of one-chunk documents d0, d1, ... with the given 2-D vectors."""
    store = ExactListingStore(provider='postgres', similarity=similarity)
    store.seed([make_doc(f'd{i}', 0, vector=list(v)) for i, v in enumerate(vectors)])
    return store


# ---------------------------------------------------------------------------
# average_vector: the formula
# ---------------------------------------------------------------------------


def test_average_vector_searches_twice_the_positive_mean_minus_the_negative_mean():
    store = _plane([1, 0], [0, 1], [0.6, 0.8], [1, 1], [-1, 0.2])
    answer = node(store).recommend({'positive': [['d0', 0], ['d1', 0]], 'negative': [['d2', 0]], 'k': 5})
    assert answer['success'] is True, answer
    expected = 2 * np.mean([[1, 0], [0, 1]], axis=0) - np.array([0.6, 0.8])
    assert _sent_query(store) == pytest.approx(_unit(expected), abs=1e-6)
    assert (answer['strategy_used'], answer['native'], answer['metric']) == ('average_vector', False, 'cosine')


def test_average_vector_without_negatives_is_the_positive_mean():
    store = _plane([1, 0], [0, 1], [0.6, 0.8], [1, 1])
    node(store).recommend({'positive': [['d0', 0], ['d2', 0]]})
    assert _sent_query(store) == pytest.approx(_unit(np.mean([[1, 0], [0.6, 0.8]], axis=0)), abs=1e-6)


def test_a_cosine_store_averages_the_examples_at_unit_length():
    store = _plane([10, 0], [0, 1], [0.6, 0.8], [1, 1])
    node(store).recommend({'positive': [['d0', 0], ['d1', 0]]})
    assert _sent_query(store) == pytest.approx(_unit([0.5, 0.5]), abs=1e-6), (
        'a long vector does not outweigh a short one'
    )


@pytest.mark.parametrize('similarity', ['ip', 'l2'])
def test_ip_and_l2_stores_average_the_examples_as_stored(similarity):
    store = _plane([10, 0], [0, 1], [0.6, 0.8], [1, 1], similarity=similarity)
    node(store).recommend({'positive': [['d0', 0], ['d1', 0]], 'negative': [['d2', 0]]})
    assert _sent_query(store) == pytest.approx(2 * np.array([5.0, 0.5]) - np.array([0.6, 0.8]), abs=1e-5)


def test_the_query_vector_counts_as_one_more_positive():
    store = _plane([1, 0], [0, 1], [0.6, 0.8], [1, 1])
    answer = node(store).recommend({'positive': [['d0', 0]], 'vector': [0, 3]})
    assert _sent_query(store) == pytest.approx(_unit([0.5, 0.5]), abs=1e-6)
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 0}, 'the vector is not an example key'


def test_the_query_vector_alone_is_enough():
    store = _plane([1, 0], [0, 1], [0.6, 0.8])
    answer = node(store).recommend({'vector': [0.6, 0.8], 'k': 1})
    assert _keys(answer) == [('d2', 0)]
    assert answer['examples_resolved'] == {'positive': 0, 'negative': 0}


def test_examples_that_cancel_out_on_a_cosine_store_are_refused():
    store = _plane([1, 0], [0.5, 0], [0, 1])
    answer = node(store).recommend({'positive': [['d1', 0]], 'vector': [-1, 0]})
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')
    assert not [call for call in store.calls if call[0] == 'semantic']


# ---------------------------------------------------------------------------
# average_vector: golden rankings
# ---------------------------------------------------------------------------


def test_the_ranking_is_the_formulas_on_a_clustered_collection():
    store = clustered(docs=6, chunks=5)
    pos, neg = [('doc01', 0), ('doc01', 3)], [('doc04', 2)]
    answer = node(store).recommend({'positive': [list(k) for k in pos], 'negative': [list(k) for k in neg], 'k': 25})
    query = 2 * np.mean([_unit(store.rows[k].embedding) for k in pos], axis=0) - _unit(store.rows[neg[0]].embedding)
    others = [k for k in store.rows if k not in pos + neg and k[0] != 'schema']
    expected = sorted(others, key=lambda k: -float(_unit(query) @ _unit(store.rows[k].embedding)))[:25]
    assert _keys(answer) == expected
    sims = [item['sim'] for item in answer['items']]
    assert sims == sorted(sims, reverse=True)
    assert sims[0] == pytest.approx(float(_unit(query) @ _unit(store.rows[expected[0]].embedding)), abs=1e-4)


def _qdrant_corpus(docs=6, chunks=5, dim=8, seed=1234):
    store = qdrant_store(qdrant, collection='vx_rec_tool')
    rng = np.random.default_rng(seed)
    batch = []
    for d in range(docs):
        centre = rng.normal(size=dim)
        for c in range(chunks):
            # raw, non-unit vectors, so the unit-length averaging is what makes the rankings agree
            batch.append(qdrant_doc(f'doc{d:02d}', c, (centre + 0.6 * rng.normal(size=dim)) * rng.uniform(0.5, 4.0)))
    store.addChunks(batch)
    return store


@pytest.mark.parametrize(
    'pos, neg',
    [
        ([('doc01', 0), ('doc01', 3)], [('doc04', 2)]),
        ([('doc02', 1), ('doc05', 4), ('doc00', 0)], [('doc03', 0), ('doc02', 2)]),
        ([('doc03', 3)], []),
        ([('doc00', 1), ('doc04', 4)], []),
    ],
)
def test_the_node_ranks_exactly_as_qdrant_ranks_average_vector_natively(pos, neg):
    store = _qdrant_corpus()
    answer = node(store, logical_type='qdrant').recommend(
        {'positive': [list(k) for k in pos], 'negative': [list(k) for k in neg], 'k': 50}
    )
    assert answer['success'] is True, answer
    native = store.recommendNative(positive=pos, negative=neg, strategy='average_vector', limit=50)
    assert _keys(answer) == [(d.metadata.objectId, d.metadata.chunkId) for d in native]
    assert len(answer['items']) == 30 - len(pos) - len(neg)
    assert answer['native'] is False, 'average_vector is computed by the node on every store'


def test_the_node_takes_the_query_vector_at_unit_length_where_qdrant_takes_it_as_given():
    store = _qdrant_corpus()
    pos, neg = [('doc00', 1), ('doc04', 4)], [('doc05', 0)]
    vector = store.getVectors([('doc02', 3)])[0].embedding
    raw = (np.asarray(vector, dtype=np.float64) * 6.0).tolist()
    answer = node(store, logical_type='qdrant').recommend(
        {'positive': [list(k) for k in pos], 'negative': [list(k) for k in neg], 'vector': raw, 'k': 50}
    )
    assert answer['success'] is True, answer
    as_unit = store.recommendNative(
        positive=pos, negative=neg, vector=_unit(raw).tolist(), strategy='average_vector', limit=50
    )
    as_given = store.recommendNative(positive=pos, negative=neg, vector=raw, strategy='average_vector', limit=50)
    assert _keys(answer) == [(d.metadata.objectId, d.metadata.chunkId) for d in as_unit], (
        'every example, the query vector too, counts at unit length on a cosine store'
    )
    assert _keys(answer) != [(d.metadata.objectId, d.metadata.chunkId) for d in as_given], (
        'Qdrant would let a long query vector outweigh the examples; the node deliberately does not'
    )


# ---------------------------------------------------------------------------
# Examples, results and the answer
# ---------------------------------------------------------------------------


def test_the_answer_has_the_contract_shape():
    store = clustered(docs=4, chunks=5)
    answer = node(store).recommend({'positive': [['doc01', 2]], 'negative': [['doc03', 0]], 'k': 6})
    assert list(answer) == [
        'success',
        'items',
        'strategy_used',
        'native',
        'metric',
        'k_requested',
        'examples_resolved',
        'not_found',
    ]
    assert answer['k_requested'] == 6 and len(answer['items']) == 6
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1} and answer['not_found'] == []
    first = answer['items'][0]
    assert set(first) == {'key', 'sim', 'score', 'below_floor', 'path', 'chunkId', 'preview'}
    assert first['path'] == f'C:/demo/folder{int(first["key"][0][3:]) % 3}/{first["key"][0]}.md'
    assert first['chunkId'] == first['key'][1] and len(first['preview']) <= 120
    json.dumps(answer, allow_nan=False)


def test_the_examples_are_left_out_of_the_results_by_default():
    store = clustered(docs=3, chunks=4)
    examples = [['doc00', 0], ['doc00', 1], ['doc02', 3]]
    answer = node(store).recommend({'positive': examples[:2], 'negative': examples[2:], 'k': 50})
    assert not set(_keys(answer)) & {tuple(k) for k in examples}
    assert len(answer['items']) == 12 - 3


def test_the_examples_may_be_kept():
    store = clustered(docs=3, chunks=4)
    answer = node(store).recommend({'positive': [['doc01', 1]], 'k': 3, 'exclude_examples': False})
    assert _keys(answer)[0] == ('doc01', 1) and answer['items'][0]['sim'] == pytest.approx(1.0, abs=1e-4)


def test_rows_below_the_floor_are_listed_and_flagged():
    store = _plane([1, 0], [0.1, 1], [-1, 0.05])
    answer = node(store).recommend({'positive': [['d0', 0]], 'k': 5})
    assert _keys(answer) == [('d1', 0), ('d2', 0)]
    assert [item['below_floor'] for item in answer['items']] == [True, True]
    semantic = [call for call in store.calls if call[0] == 'semantic'][-1]
    assert semantic[2].minScore == float('-inf') and semantic[2].limit == 5 + 1


def test_unresolved_examples_are_listed_and_the_rest_used():
    store = clustered(docs=3, chunks=4)
    answer = node(store).recommend(
        {'positive': [['ghost', 0], ['doc00', 0]], 'negative': [['doc01', 9], ['doc02', 0], ['schema', 0]]}
    )
    assert answer['success'] is True
    assert answer['not_found'] == [['ghost', 0], ['doc01', 9], ['schema', 0]]
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1}


def test_no_positive_key_resolved_is_not_found_with_the_keys_listed():
    store = clustered(docs=3, chunks=4)
    answer = node(store).recommend({'positive': [['ghost', 0], ['ghost', 1]], 'negative': [['doc00', 0]]})
    assert (answer['success'], answer['code']) == (False, 'NOT_FOUND')
    assert answer['not_found'] == [['ghost', 0], ['ghost', 1]]
    assert not [call for call in store.calls if call[0] == 'semantic']


def test_unresolved_positives_with_the_query_vector_still_recommend():
    store = clustered(docs=3, chunks=4)
    answer = node(store).recommend({'positive': [['ghost', 0]], 'vector': store.rows[('doc02', 1)].embedding, 'k': 1})
    assert answer['success'] is True and _keys(answer) == [('doc02', 1)]
    assert answer['not_found'] == [['ghost', 0]]


def test_examples_are_read_from_the_store_even_when_the_sample_holds_them():
    store = clustered(docs=3, chunks=4)
    inst = node(store)
    inst.sample({'n': 12, 'seed': 3})
    store.calls.clear()
    answer = inst.recommend({'positive': [['doc00', 0]], 'negative': [['doc01', 1]], 'k': 2})
    assert answer['success'] is True
    read = [key for call in store.calls if call[0] == 'getVectors' for key in call[1]]
    assert {('doc00', 0), ('doc01', 1)} <= set(read), 'the store says which examples are stored, not the sample'


class _NoVectorReads(ExactListingStore):
    """Samples with vectors but cannot read them by key (``getVectors`` unsupported)."""

    def getVectors(self, keys):
        self.calls.append(('getVectors', [tuple(k) for k in keys]))
        raise StoreUnsupported('getVectors is not supported by this store')


def test_a_store_that_cannot_read_vectors_by_key_takes_the_examples_from_the_cached_sample():
    store = clustered(_NoVectorReads, docs=3, chunks=4)
    inst = node(store)
    before = inst.recommend({'positive': [['doc00', 0]], 'k': 2})
    assert (before['success'], before['code']) == (False, 'NOT_FOUND'), 'no sample, nothing to read the example from'
    inst.sample({'n': 12, 'seed': 3})
    answer = inst.recommend({'positive': [['doc00', 0]], 'negative': [['doc01', 1]], 'k': 2})
    assert answer['success'] is True, answer
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1} and answer['not_found'] == []


def test_the_scope_restricts_the_results():
    store = clustered(docs=4, chunks=3)
    answer = node(store).recommend({'positive': [['doc00', 0]], 'filter': {'object_ids': ['doc02', 'doc03']}, 'k': 50})
    assert {k[0] for k in _keys(answer)} == {'doc02', 'doc03'} and len(answer['items']) == 6
    semantic = [call for call in store.calls if call[0] == 'semantic'][-1]
    assert semantic[2].objectIds == ['doc02', 'doc03']


def test_deleted_rows_are_never_recommended():
    store = clustered(docs=3, chunks=3)
    store.markDeleted(['doc02'])
    answer = node(store).recommend({'positive': [['doc00', 0]], 'k': 50})
    assert 'doc02' not in {k[0] for k in _keys(answer)}


def test_k_is_clamped():
    answer = node(clustered()).recommend({'positive': [['doc00', 0]], 'k': 500})
    assert answer['k_requested'] == VECTOR_TOOL_LIMITS['neighbors_k_max'] and answer['warnings'] == ['k_clamped']


def test_no_stored_vector_leaves_the_node():
    store = clustered(docs=4, chunks=5, dim=8)
    answer = node(store).recommend({'positive': [['doc00', 0]], 'negative': [['doc01', 1]], 'k': 20})
    assert _no_vectors_anywhere(answer, 8)


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'args',
    [
        {},
        {'negative': [['doc00', 0]]},
        {'positive': [], 'negative': []},
        {'positive': 'doc00'},
        {'positive': [['doc00']]},
        {'positive': [['doc00', 0.5]]},
        {'positive': [['doc00', 0]], 'negative': [['doc00', 0]]},
        {'positive': [['doc00', i] for i in range(11)]},
        {'positive': [['doc00', 0]], 'negative': [['doc01', i] for i in range(11)]},
        {'positive': [['doc00', 0]], 'strategy': 'sum_scores'},
        {'positive': [['doc00', 0]], 'strategy': 7},
        {'positive': [['doc00', 0]], 'exclude_examples': 'yes'},
        {'positive': [['doc00', 0]], 'k': 'many'},
        {'vector': []},
        {'vector': ['a', 'b']},
        {'positive': [['doc00', 0]], 'filter': 'doc01'},
        {'positive': [['doc00', 0]], 'filter': {'object_ids': [f'd{i}' for i in range(2001)]}},
        {'strategy': 'best_score'},
    ],
)
def test_bad_input_is_invalid(args):
    store = clustered()
    answer = node(store).recommend(args)
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT'), args
    assert not [call for call in store.calls if call[0] in ('semantic', 'getVectors')]


def test_ten_examples_a_side_are_allowed():
    store = clustered(docs=5, chunks=5)
    answer = node(store).recommend(
        {'positive': [['doc00', i % 5] if i < 5 else ['doc01', i % 5] for i in range(10)], 'negative': [['doc04', 0]]}
    )
    assert answer['success'] is True and answer['examples_resolved'] == {'positive': 10, 'negative': 1}


def test_a_query_vector_of_the_wrong_length_is_a_dimension_mismatch():
    answer = node(clustered()).recommend({'positive': [['doc00', 0]], 'vector': [0.1, 0.2]})
    assert (answer['success'], answer['code']) == (False, 'DIMENSION_MISMATCH')


def test_examples_of_different_lengths_are_a_dimension_mismatch():
    store = ExactListingStore(provider='postgres')
    store.seed([make_doc('a', 0, vector=[1, 0, 0]), make_doc('c', 0, vector=[1, 1, 0])])
    store.rows[('b', 0)] = make_doc('b', 0, vector=[0, 1])  # a row of another length, written behind the driver's back
    answer = node(store).recommend({'positive': [['a', 0], ['b', 0]]})
    assert (answer['success'], answer['code']) == (False, 'DIMENSION_MISMATCH')


def test_a_missing_collection():
    answer = node(VectorMemoryStore()).recommend({'positive': [['a', 0]]})
    assert (answer['success'], answer['code']) == (False, 'COLLECTION_MISSING')


def test_best_score_where_the_store_cannot_rank_it_is_unsupported():
    store = clustered()
    answer = node(store).recommend({'positive': [['doc00', 0]], 'strategy': 'best_score'})
    assert answer == {
        'success': False,
        'code': 'UNSUPPORTED',
        'error': 'best_score is not supported by this store; use average_vector.',
    }
    assert not [call for call in store.calls if call[0] in ('semantic', 'getVectors')]


class _DeclaresButCannot(ExactListingStore):
    VX_DRIVER_CAPABILITIES = frozenset({'recommend_best_score'})


def test_a_declared_capability_without_the_hook_is_unsupported():
    store = clustered(_DeclaresButCannot)
    answer = node(store).recommend({'positive': [['doc00', 0]], 'strategy': 'best_score'})
    assert (answer['success'], answer['code']) == (False, 'UNSUPPORTED')


def test_one_recommendation_or_neighbour_search_at_a_time():
    store = clustered()
    lock = vx_tools._vx_state(store).neighbors_busy
    assert lock.acquire(blocking=False)
    try:
        answer = node(store).recommend({'positive': [['doc00', 0]]})
    finally:
        lock.release()
    assert (answer['success'], answer['code']) == (False, 'BUSY')


class _Reentrant(ExactListingStore):
    """Asks for a neighbour search while a recommendation is being searched."""

    inst: Any = None
    seen: Dict[str, Any] = {}

    def searchSemantic(self, query, docFilter):
        if self.inst is not None:
            self.seen['neighbors'] = self.inst.neighbors({'key': ['doc00', 1]})
        return super().searchSemantic(query, docFilter)


def test_a_recommendation_holds_the_neighbour_lock_while_it_runs():
    store = clustered(_Reentrant)
    inst = node(store)
    store.inst, store.seen = inst, {}
    assert inst.recommend({'positive': [['doc00', 0]]})['success'] is True
    assert store.seen['neighbors']['code'] == 'BUSY'
    store.inst = None
    assert inst.neighbors({'key': ['doc00', 1]})['success'] is True, 'the lock is released afterwards'


def test_a_read_from_a_public_task_key_is_refused_before_the_store_is_read():
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    seen = len(store.calls)
    answer = _dispatch(_tool_node(store), 'recommend', {'positive': [['a', 0]]}, dap(auth='public'))
    assert answer == {'success': False, 'code': 'READS_PUBLIC', 'error': 'The store refused this request.'}
    assert len(store.calls) == seen


def test_a_backend_failure_is_a_store_error():
    store = clustered()
    store.raise_semantic = RuntimeError('search failed')
    answer = node(store).recommend({'positive': [['doc00', 0]]})
    assert (answer['success'], answer['code']) == (False, 'STORE_ERROR')
    lock = vx_tools._vx_state(store).neighbors_busy
    assert lock.acquire(blocking=False), 'the lock was released'
    lock.release()


# ---------------------------------------------------------------------------
# best_score: ranked by the store
# ---------------------------------------------------------------------------


class _NativeStore(ExactListingStore):
    """A driver that ranks recommendations itself (answers are scripted per test)."""

    VX_DRIVER_CAPABILITIES = frozenset(
        {'search_keyword', 'documents_distinct', 'documents_sorted', 'recommend_best_score'}
    )

    def recommendNative(self, *, positive, negative, strategy, limit, object_ids=None, vector=None):
        self.calls.append(('recommendNative', list(positive), list(negative), strategy, limit, object_ids, vector))
        hits = []
        for key, score in self.script:
            doc = self._copy(self.rows[key])
            doc.score = score
            hits.append(doc)
        return hits


def _native(**kw):
    store = clustered(_NativeStore, docs=3, chunks=4, **kw)
    store.script = [(('doc02', 1), 0.71), (('doc01', 3), 0.55), (('doc02', 0), -0.2)]
    return store


def test_best_score_is_ranked_by_the_store_with_the_resolved_examples():
    store = _native()
    answer = node(store).recommend(
        {
            'positive': [['doc00', 0], ['ghost', 0]],
            'negative': [['doc01', 0]],
            'strategy': 'best_score',
            'k': 7,
            'filter': {'object_ids': ['doc01', 'doc02']},
        }
    )
    assert answer['success'] is True, answer
    assert (answer['strategy_used'], answer['native']) == ('best_score', True)
    call = [c for c in store.calls if c[0] == 'recommendNative'][-1]
    assert call[1:] == ([('doc00', 0)], [('doc01', 0)], 'best_score', 7, ['doc01', 'doc02'], None)
    assert _keys(answer) == [('doc02', 1), ('doc01', 3), ('doc02', 0)], 'the store order is kept'
    assert [item['score'] for item in answer['items']] == [0.71, 0.55, -0.2]
    assert [item['below_floor'] for item in answer['items']] == [False, False, False]
    assert answer['not_found'] == [['ghost', 0]]
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1}
    assert not [c for c in store.calls if c[0] == 'semantic']


def test_best_score_sim_is_the_similarity_to_the_nearest_positive_example():
    store = _native()
    answer = node(store).recommend({'positive': [['doc00', 0], ['doc01', 2]], 'strategy': 'best_score'})
    for item in answer['items']:
        hit = _unit(store.rows[tuple(item['key'])].embedding)
        best = max(float(hit @ _unit(store.rows[k].embedding)) for k in (('doc00', 0), ('doc01', 2)))
        assert item['sim'] == pytest.approx(best, abs=1e-4)


def test_best_score_accepts_negatives_alone():
    store = _native()
    answer = node(store).recommend({'negative': [['doc00', 3]], 'strategy': 'best_score'})
    assert answer['success'] is True and answer['examples_resolved'] == {'positive': 0, 'negative': 1}
    for item in answer['items']:
        hit = _unit(store.rows[tuple(item['key'])].embedding)
        assert item['sim'] == pytest.approx(float(hit @ _unit(store.rows[('doc00', 3)].embedding)), abs=1e-4)


def test_best_score_negatives_that_do_not_resolve_are_not_found():
    answer = node(_native()).recommend({'negative': [['ghost', 0]], 'strategy': 'best_score'})
    assert (answer['success'], answer['code']) == (False, 'NOT_FOUND') and answer['not_found'] == [['ghost', 0]]


def test_best_score_passes_the_query_vector_through():
    store = _native()
    vector = store.rows[('doc01', 1)].embedding
    node(store).recommend({'vector': vector, 'strategy': 'best_score'})
    call = [c for c in store.calls if c[0] == 'recommendNative'][-1]
    assert call[1] == [] and call[6] == pytest.approx(vector)


def test_best_score_always_leaves_the_examples_out_and_says_so_when_asked_to_keep_them():
    store = _native()
    answer = node(store).recommend({'positive': [['doc00', 0]], 'strategy': 'best_score', 'exclude_examples': False})
    assert answer['warnings'] == ['examples_always_excluded']


def test_best_score_on_qdrant_is_qdrants_ranking():
    store = _qdrant_corpus()
    pos, neg = [('doc01', 0), ('doc03', 2)], [('doc04', 1)]
    answer = node(store, logical_type='qdrant').recommend(
        {'positive': [list(k) for k in pos], 'negative': [list(k) for k in neg], 'strategy': 'best_score', 'k': 50}
    )
    native = store.recommendNative(positive=pos, negative=neg, strategy='best_score', limit=50)
    assert answer['native'] is True and _keys(answer) == [(d.metadata.objectId, d.metadata.chunkId) for d in native]
    assert [item['score'] for item in answer['items']] == pytest.approx([d.score for d in native], abs=1e-4)
    assert len(answer['items']) == 27


def test_negatives_alone_on_qdrant_list_the_least_similar_first():
    store = _qdrant_corpus()
    answer = node(store, logical_type='qdrant').recommend(
        {'negative': [['doc02', 2]], 'strategy': 'best_score', 'k': 5}
    )
    assert answer['success'] is True and all(item['score'] < 0 for item in answer['items'])
    sims = [item['sim'] for item in answer['items']]
    assert sims == sorted(sims), 'least similar to the negative example first'


# ---------------------------------------------------------------------------
# An example removed after the sample was drawn
# ---------------------------------------------------------------------------


def _sampled_then_removed(removed='doc00'):
    """The mock Qdrant corpus, every chunk in a cached sample, then ``removed`` taken out by another writer.

    The node's own removals drop its cached samples (``test_vector_tool_set``), so the rows
    go through the backend client here, as another engine writing to the same collection
    would: this node's cache still holds them, and recommend must not use them.
    """
    store = _qdrant_corpus()
    inst = node(store, logical_type='qdrant')
    assert inst.sample({'n': 30, 'seed': 3})['success'] is True
    latest = vx_tools._vx_state(store).samples().latest()
    assert all((removed, chunk) in latest.index for chunk in range(5)), 'the sample holds every chunk of it'
    selector = qdrant.Filter(
        must=[qdrant.FieldCondition(key='meta.objectId', match=qdrant.models.MatchAny(any=[removed]))]
    )
    store.client.delete(collection_name=store.collection, points_selector=selector, wait=True)
    assert inst.chunks({'object_id': removed})['code'] == 'NOT_FOUND', 'the document is gone from the store'
    assert vx_tools._vx_state(store).samples().latest() is latest, 'and the sample still holds it'
    return store, inst


def _query_points_calls() -> int:
    return qdrant.QdrantClient.calls.get('query_points', 0)


def test_best_score_with_only_a_removed_positive_is_not_found_while_the_sample_still_holds_it():
    store, inst = _sampled_then_removed()
    before = _query_points_calls()
    answer = inst.recommend({'positive': [['doc00', 1]], 'negative': [['doc03', 2]], 'strategy': 'best_score'})
    assert (answer['success'], answer.get('code')) == (False, 'NOT_FOUND'), answer
    assert answer['not_found'] == [['doc00', 1]]
    assert _query_points_calls() == before, 'never a negatives-only query in place of "like A, unlike B"'


def test_best_score_with_a_removed_positive_ranks_by_the_positives_left_and_lists_it():
    store, inst = _sampled_then_removed()
    answer = inst.recommend(
        {'positive': [['doc00', 1], ['doc02', 0]], 'negative': [['doc03', 2]], 'strategy': 'best_score', 'k': 50}
    )
    assert answer['success'] is True, answer
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1}
    assert answer['not_found'] == [['doc00', 1]]
    native = store.recommendNative(positive=[('doc02', 0)], negative=[('doc03', 2)], strategy='best_score', limit=50)
    assert _keys(answer) == [(d.metadata.objectId, d.metadata.chunkId) for d in native]
    assert not any(key[0] == 'doc00' for key in _keys(answer))


def test_average_vector_with_a_removed_example_lists_it_while_the_sample_still_holds_it():
    store, inst = _sampled_then_removed()
    alone = inst.recommend({'positive': [['doc00', 1]], 'negative': [['doc03', 2]]})
    assert (alone['success'], alone.get('code')) == (False, 'NOT_FOUND'), alone
    assert alone['not_found'] == [['doc00', 1]]
    answer = inst.recommend(
        {'positive': [['doc00', 1], ['doc02', 0]], 'negative': [['doc03', 2], ['doc00', 4]], 'k': 50}
    )
    assert answer['success'] is True, answer
    assert answer['examples_resolved'] == {'positive': 1, 'negative': 1}
    assert answer['not_found'] == [['doc00', 1], ['doc00', 4]]
    native = store.recommendNative(
        positive=[('doc02', 0)], negative=[('doc03', 2)], strategy='average_vector', limit=50
    )
    assert _keys(answer) == [(d.metadata.objectId, d.metadata.chunkId) for d in native], (
        'the removed examples take no part in the search vector'
    )


# ---------------------------------------------------------------------------
# The descriptor
# ---------------------------------------------------------------------------


def test_the_tool_is_external_only_wrapped_and_described():
    meta = VectorStoreToolMixin.recommend.__tool_meta__
    assert meta['audience'] == ('dap',)
    assert getattr(VectorStoreToolMixin.recommend, '__vectordb_tool__', False) is True
    props = meta['input_schema']['properties']
    assert set(props) == {'positive', 'negative', 'vector', 'k', 'strategy', 'filter', 'exclude_examples'}
    assert props['strategy']['enum'] == ['average_vector', 'best_score']
    assert props['positive']['maxItems'] == props['negative']['maxItems'] == 10
    out = meta['output_schema']['properties']
    assert {'items', 'strategy_used', 'native', 'metric', 'k_requested', 'examples_resolved', 'not_found'} <= set(out)


def test_the_store_answers_the_model_it_was_asked_for():
    store = clustered()
    node(store).recommend({'positive': [['doc00', 0]]})
    semantic = [call for call in store.calls if call[0] == 'semantic'][-1]
    assert semantic[1].embedding_model == MODEL and semantic[1].text == ''


# ---------------------------------------------------------------------------
# Which drivers rank best_score themselves
# ---------------------------------------------------------------------------

_REPO = Path(__file__).resolve().parents[2]

#: The keyword-only parameters the tool passes to ``recommendNative``.
_NATIVE_PARAMS = {'positive', 'negative', 'strategy', 'limit', 'object_ids', 'vector'}


def _declares_best_score(cls: ast.ClassDef) -> bool:
    for node_ in cls.body:
        targets = node_.targets if isinstance(node_, ast.Assign) else [getattr(node_, 'target', None)]
        if any(isinstance(t, ast.Name) and t.id == 'VX_DRIVER_CAPABILITIES' for t in targets):
            value = getattr(node_, 'value', None)
            if value is not None and any(
                isinstance(c, ast.Constant) and c.value == 'recommend_best_score' for c in ast.walk(value)
            ):
                return True
    return False


def test_only_qdrant_declares_best_score_and_every_declaring_driver_serves_the_hook():
    sources = [
        *sorted((_REPO / 'packages/ai/src/ai/common/store').rglob('*.py')),
        *sorted((_REPO / 'nodes/src/nodes').glob('*/**/*.py')),
    ]
    declaring = {}
    for path in sources:
        for cls in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if isinstance(cls, ast.ClassDef) and _declares_best_score(cls):
                hook = next(
                    (n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'recommendNative'), None
                )
                declaring[f'{path.parent.name}/{path.name}:{cls.name}'] = (
                    hook is not None and {a.arg for a in hook.args.kwonlyargs} >= _NATIVE_PARAMS
                )
    assert declaring == {'store_qdrant/qdrant.py:Store': True}


def test_pgvector_answers_unsupported_for_best_score():
    from ai.common.store.pgvector import PgVectorStore

    assert 'recommend_best_score' not in PgVectorStore.VX_DRIVER_CAPABILITIES
    assert not callable(getattr(PgVectorStore, 'recommendNative', None))
