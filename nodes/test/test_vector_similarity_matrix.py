# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The ``similarity_matrix`` tool: the pairwise similarities of up to 100 chunks, by key.

Contract section 4.4-E. The input is keys only (no sample id, no indices), so a
matrix never depends on which sample the app drew last. The node reads each
key's vector from the latest cached sample, else through ``getVectors``, and says
which (``source``: ``cache``, ``store`` or ``mixed``); keys it cannot find are
listed in ``not_found`` and the matrix covers the rest (``n`` of them, in the
order given), by the store's metric, rounded to ``dp`` (2) places. Scalars only:
no vector leaves the node.

Codes: ``INVALID_INPUT`` (fewer than 2 distinct keys, bad keys),
``LIMIT_EXCEEDED`` (more than ``matrix_keys_max``), ``NOT_FOUND`` (fewer than 2
resolved), ``DIMENSION_MISMATCH``, ``COLLECTION_MISSING``, ``READS_PUBLIC``.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List

import numpy as np
import pytest

from ai.common.store import VectorStoreToolMixin, vx_math, vx_tools
from ai.common.store.vx_defaults import VECTOR_TOOL_LIMITS

from .test_vector_hooks import ExactListingStore, MemoryStore, VectorMemoryStore, corpus, make_doc
from .test_vector_write_gate import _dispatch, _tool_node, dap
from .test_vectordb_tool_mixin import clustered, node


def _sample_keys(sample: Dict[str, Any]) -> List[tuple]:
    docs = sample['docs']
    return [(docs[d]['objectId'], c) for d, c in zip(sample['points']['doc'], sample['points']['chunk'])]


def _gets(store) -> List[tuple]:
    """Every key the store was asked for through getVectors."""
    return [key for call in store.calls if call[0] == 'getVectors' for key in call[1]]


def _expected(store, keys, metric='cosine') -> np.ndarray:
    V = np.vstack([np.asarray(store.rows[k].embedding, dtype=np.float32) for k in keys])
    return vx_math.similarity(metric, V, V)


def _no_vectors_but_matrix_rows(answer: Dict[str, Any], dimension: int) -> bool:
    """No list of ``dimension`` floats in the answer, except the matrix rows (exempt when they hold ``n`` values)."""

    def walk(value: Any, exempt: bool = False) -> bool:
        if isinstance(value, dict):
            return all(walk(v, exempt=(k == 'matrix')) for k, v in value.items())
        if isinstance(value, list):
            if exempt and all(isinstance(row, list) and len(row) == answer['n'] for row in value):
                return True
            if len(value) == dimension and value and all(isinstance(x, float) for x in value):
                return False
            return all(walk(v) for v in value)
        return True

    return walk(answer)


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------


def test_the_matrix_is_symmetric_with_a_unit_diagonal_by_the_stores_metric():
    store = clustered(docs=4, chunks=5)
    keys = [('doc00', 0), ('doc00', 3), ('doc02', 1), ('doc03', 4), ('doc01', 2)]
    answer = node(store).similarity_matrix({'keys': [list(k) for k in keys]})
    assert answer['success'] is True, answer
    matrix = np.asarray(answer['matrix'])
    assert matrix.shape == (5, 5)
    assert (matrix == matrix.T).all()
    assert np.diag(matrix).tolist() == [1.0] * 5
    assert matrix == pytest.approx(np.round(_expected(store, keys), 2), abs=0.0051)
    assert answer['keys'] == [list(k) for k in keys] and answer['n'] == 5
    assert (answer['metric'], answer['dp'], answer['source'], answer['not_found']) == ('cosine', 2, 'store', [])


def test_every_value_has_two_decimal_places_at_most():
    answer = node(clustered(docs=3, chunks=4)).similarity_matrix({'keys': [['doc00', 0], ['doc01', 1], ['doc02', 2]]})
    for row in answer['matrix']:
        for value in row:
            assert value == round(value, 2)


def test_the_answer_has_the_contract_shape():
    answer = node(clustered()).similarity_matrix({'keys': [['doc00', 0], ['doc01', 1]]})
    assert list(answer) == ['success', 'n', 'keys', 'metric', 'dp', 'matrix', 'source', 'not_found']
    json.dumps(answer, allow_nan=False)


def test_a_rounded_negative_zero_is_zero():
    store = ExactListingStore(provider='postgres')
    store.seed([make_doc('a', 0, vector=[1, 0]), make_doc('b', 0, vector=[-0.001, 1])])
    answer = node(store).similarity_matrix({'keys': [['a', 0], ['b', 0]]})
    assert answer['matrix'][0][1] == 0.0 and '-0.0' not in json.dumps(answer)


@pytest.mark.parametrize('similarity', ['l2', 'ip'])
def test_l2_and_ip_stores_answer_their_own_similarity(similarity):
    store = ExactListingStore(provider='postgres', similarity=similarity)
    store.seed([make_doc('a', 0, vector=[3, 0]), make_doc('b', 0, vector=[0, 4]), make_doc('c', 0, vector=[1, 1])])
    answer = node(store).similarity_matrix({'keys': [['a', 0], ['b', 0], ['c', 0]]})
    assert answer['metric'] == similarity
    if similarity == 'l2':
        assert np.diag(answer['matrix']).tolist() == [1.0] * 3
        assert answer['matrix'][0][1] == round(1 / (1 + 5), 2)
    else:
        assert np.diag(answer['matrix']).tolist() == [9.0, 16.0, 2.0]
        assert answer['matrix'][0][2] == 3.0


# ---------------------------------------------------------------------------
# Where the vectors come from
# ---------------------------------------------------------------------------


def test_keys_held_by_the_cached_sample_are_read_from_it():
    store = clustered(docs=4, chunks=5)
    inst = node(store)
    sample = inst.sample({'n': 20, 'seed': 3})
    store.calls.clear()
    keys = _sample_keys(sample)[:4]
    answer = inst.similarity_matrix({'keys': [list(k) for k in keys]})
    assert answer['source'] == 'cache' and _gets(store) == []
    assert np.asarray(answer['matrix']) == pytest.approx(np.round(_expected(store, keys), 2), abs=0.0051)


def test_keys_partly_in_the_sample_are_mixed():
    store = clustered(docs=6, chunks=5)
    inst = node(store)
    sample = inst.sample({'n': 8, 'seed': 3})
    store.calls.clear()
    held = _sample_keys(sample)
    outside = [k for k in store.rows if k not in held and k[0] != 'schema'][:2]
    keys = held[:2] + outside
    answer = inst.similarity_matrix({'keys': [list(k) for k in keys]})
    assert answer['source'] == 'mixed' and answer['n'] == 4
    assert sorted(_gets(store)) == sorted(outside), 'only the keys the sample does not hold are read'


def test_without_a_sample_every_key_is_read_from_the_store():
    store = clustered(docs=3, chunks=3)
    answer = node(store).similarity_matrix({'keys': [['doc00', 0], ['doc01', 1], ['doc02', 2]]})
    assert answer['source'] == 'store' and sorted(_gets(store)) == [('doc00', 0), ('doc01', 1), ('doc02', 2)]


def test_the_same_keys_give_the_same_matrix_after_a_new_sample():
    store = clustered(docs=6, chunks=5)
    inst = node(store)
    first = inst.sample({'n': 10, 'seed': 1})
    keys = [list(k) for k in _sample_keys(first)[:5]]
    before = inst.similarity_matrix({'keys': keys})
    inst.sample({'n': 10, 'seed': 99})  # a re-drawn sample: other points, other indices
    after = inst.similarity_matrix({'keys': keys})
    assert after['keys'] == before['keys'] == keys
    assert after['matrix'] == before['matrix']


def test_the_tool_takes_keys_only():
    meta = VectorStoreToolMixin.similarity_matrix.__tool_meta__
    assert set(meta['input_schema']['properties']) == {'keys'} and meta['input_schema']['required'] == ['keys']
    answer = node(clustered()).similarity_matrix({'sample_id': 's-1-aaaaaaaa', 'indices': [0, 1]})
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')


# ---------------------------------------------------------------------------
# Unresolved keys and refusals
# ---------------------------------------------------------------------------


def test_unknown_keys_are_listed_and_left_out_of_the_matrix():
    store = clustered(docs=3, chunks=3)
    answer = node(store).similarity_matrix(
        {'keys': [['doc00', 0], ['ghost', 0], ['doc01', 1], ['schema', 0], ['doc02', 7], ['doc02', 2]]}
    )
    assert answer['n'] == 3 and answer['keys'] == [['doc00', 0], ['doc01', 1], ['doc02', 2]]
    assert answer['not_found'] == [['ghost', 0], ['schema', 0], ['doc02', 7]]
    assert len(answer['matrix']) == 3 and all(len(row) == 3 for row in answer['matrix'])
    assert ('schema', 0) not in _gets(store), 'the control record is never read'


def test_fewer_than_two_stored_keys_is_not_found():
    answer = node(clustered()).similarity_matrix({'keys': [['doc00', 0], ['ghost', 0], ['ghost', 1]]})
    assert (answer['success'], answer['code']) == (False, 'NOT_FOUND')
    assert answer['not_found'] == [['ghost', 0], ['ghost', 1]]


def test_a_hundred_keys_are_allowed_and_more_are_refused():
    store = clustered(docs=21, chunks=5)
    keys = [[f'doc{d:02d}', c] for d in range(21) for c in range(5)]
    assert node(store).similarity_matrix({'keys': keys[:100]})['n'] == VECTOR_TOOL_LIMITS['matrix_keys_max'] == 100
    answer = node(store).similarity_matrix({'keys': keys[:101]})
    assert (answer['success'], answer['code']) == (False, 'LIMIT_EXCEEDED')
    assert _gets(store) and len(_gets(store)) == 100, 'the refused call read nothing'


@pytest.mark.parametrize(
    'args',
    [
        {},
        {'keys': None},
        {'keys': 'doc00'},
        {'keys': []},
        {'keys': [['doc00', 0]]},
        {'keys': [['doc00', 0], ['doc00', 0]]},
        {'keys': [['doc00', 0], ['doc01']]},
        {'keys': [['doc00', 0], ['doc01', 'one']]},
        {'keys': [['doc00', 0], ['doc01', 1.5]]},
        {'keys': [['doc00', 0], [7, 1]]},
    ],
)
def test_bad_keys_are_invalid(args):
    store = clustered()
    answer = node(store).similarity_matrix(args)
    assert (answer['success'], answer['code']) == (False, 'INVALID_INPUT')
    assert _gets(store) == []


def test_vectors_of_different_lengths_are_a_dimension_mismatch():
    store = ExactListingStore(provider='postgres')
    store.seed([make_doc('a', 0, vector=[1, 0, 0]), make_doc('c', 0, vector=[1, 1, 0])])
    store.rows[('b', 0)] = make_doc('b', 0, vector=[0, 1])  # a row of another length, written behind the driver's back
    answer = node(store).similarity_matrix({'keys': [['a', 0], ['b', 0], ['c', 0]]})
    assert (answer['success'], answer['code']) == (False, 'DIMENSION_MISMATCH')


def test_a_missing_collection():
    answer = node(VectorMemoryStore()).similarity_matrix({'keys': [['a', 0], ['b', 0]]})
    assert (answer['success'], answer['code']) == (False, 'COLLECTION_MISSING')


def test_a_store_that_cannot_read_vectors_finds_nothing():
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    answer = node(store).similarity_matrix({'keys': [['a', 0], ['a', 1]]})
    assert (answer['success'], answer['code']) == (False, 'NOT_FOUND')


def test_a_read_from_a_public_task_key_is_refused_before_the_store_is_read():
    store = MemoryStore().seed(corpus({'a': [0, 1]}))
    seen = len(store.calls)
    answer = _dispatch(_tool_node(store), 'similarity_matrix', {'keys': [['a', 0], ['a', 1]]}, dap(auth='public'))
    assert answer == {'success': False, 'code': 'READS_PUBLIC', 'error': 'The store refused this request.'}
    assert len(store.calls) == seen


def test_the_matrix_waits_for_no_sample_and_no_neighbour_search():
    store = clustered()
    state = vx_tools._vx_state(store)
    assert state.neighbors_busy.acquire(blocking=False)
    try:
        with state.samples().exclusive():
            answer = node(store).similarity_matrix({'keys': [['doc00', 0], ['doc01', 1]]})
    finally:
        state.neighbors_busy.release()
    assert answer['success'] is True


# ---------------------------------------------------------------------------
# Privacy and size
# ---------------------------------------------------------------------------


def test_no_stored_vector_leaves_the_node_even_when_n_equals_the_dimension():
    store = clustered(docs=2, chunks=4, dim=8)
    keys = [[f'doc{d:02d}', c] for d in range(2) for c in range(4)]
    answer = node(store).similarity_matrix({'keys': keys})
    assert answer['n'] == 8
    assert _no_vectors_but_matrix_rows(answer, 8)
    assert not _no_vectors_but_matrix_rows({'n': 8, 'leak': [0.5] * 8}, 8), 'the checker sees a vector'


def test_a_full_matrix_of_uuid_keys_stays_under_sixty_kilobytes():
    rng = np.random.default_rng(7)
    store = ExactListingStore(provider='postgres')
    ids = [str(uuid.uuid5(uuid.NAMESPACE_URL, f'doc-{d}')) for d in range(25)]
    store.seed([make_doc(oid, c, vector=rng.normal(size=16).tolist()) for oid in ids for c in range(100, 104)])
    keys = [[oid, c] for oid in ids for c in range(100, 104)]
    answer = node(store).similarity_matrix({'keys': keys})
    assert answer['n'] == 100
    assert sum(1 for row in answer['matrix'] for v in row if v < 0) > 3000, 'random directions: many negative values'
    size = len(json.dumps(answer, separators=(',', ':')))
    assert size <= 60 * 1024, size
