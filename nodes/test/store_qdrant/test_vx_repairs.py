# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Qdrant driver repairs that ship with the Vector Explorer hooks.

Runs the real driver against the repository's mock ``qdrant_client``, which
mirrors the server's semantics for ids, paging and payload updates (the live
suite ``nodes/test/test_store_qdrant_full.py`` makes the same assertions against
a real Qdrant):

- new writes get deterministic point ids ``uuid5(NAMESPACE_URL, 'objectId#chunkId')``;
- a re-ingest that carries chunk 0 replaces the document (no stale chunks);
- ``parent`` filters match the exact path;
- the deleted filter is tri-state (``active`` / ``deleted`` / ``all``);
- a numeric ``offset`` skips rows (Qdrant's own ``offset`` is a point id);
- semantic search applies the score floor through ``effectiveFloor``;
- a non-zero offset on semantic search is a ``ValueError``;
- soft delete updates ``meta.isDeleted`` without wiping the rest of ``meta``;
- distance metrics (Euclid, Manhattan) score closer points higher;
- ``Dot`` scores ``(1 + dot) / 2`` (a perfect unit-vector match is 1.0);
- ``getPaths(parent=...)`` matches the exact path, never a token of it.
"""

from __future__ import annotations

import math
import uuid

import pytest

from ai.common.schema import DocFilter, QuestionText

from ._mock_driver import keys_of, load_driver, make_doc, make_store, vx_filter

drv = load_driver()


@pytest.fixture(autouse=True)
def _fresh_server():
    drv.QdrantClient.reset()
    yield
    drv.QdrantClient.reset()


def _ingest(store, docs):
    store.addChunks(docs)


def _points(store):
    return drv.QdrantClient._points[store.collection]


def test_new_writes_use_deterministic_point_ids():
    store = make_store(drv)
    _ingest(store, [make_doc('doc-a', 0, [1, 0, 0]), make_doc('doc-a', 1, [0, 1, 0])])

    ids = set(_points(store))
    assert str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-a#0')) in ids
    assert str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-a#1')) in ids
    assert str(uuid.uuid5(uuid.NAMESPACE_URL, 'schema#0')) in ids
    assert drv.point_id_for('doc-a', 1) == str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-a#1'))


def test_reingest_with_chunk_zero_replaces_the_document():
    store = make_store(drv)
    _ingest(store, [make_doc('doc-a', c, [1, c, 0]) for c in range(4)])
    _ingest(store, [make_doc('doc-a', c, [1, c, 1], text=f'v2 {c}') for c in range(2)])

    rows = [p for p in _points(store).values() if p.payload['meta']['objectId'] == 'doc-a']
    assert sorted(p.payload['meta']['chunkId'] for p in rows) == [0, 1]
    assert all(p.payload['content'].startswith('v2') for p in rows)


def test_parent_filter_matches_the_exact_path():
    store = make_store(drv)
    _ingest(
        store,
        [
            make_doc('doc-a', 0, [1, 0, 0], parent='C:/a/report.pdf'),
            make_doc('doc-b', 0, [0, 1, 0], parent='C:/a/report.pdf.bak'),
        ],
    )
    docs = store.get(DocFilter(parent='C:/a/report.pdf', limit=10))
    assert keys_of(docs) == [('doc-a', 0)]


@pytest.mark.parametrize(
    ('flt', 'expected'),
    [
        (DocFilter(limit=50), {'live', 'other'}),
        (DocFilter(limit=50, isDeleted=False), {'live', 'other'}),
        (DocFilter(limit=50, isDeleted=True), {'live', 'gone', 'other', 'schema'}),
    ],
)
def test_legacy_is_deleted_flag_keeps_its_meaning(flt, expected):
    store = make_store(drv)
    _ingest(
        store,
        [
            make_doc('live', 0, [1, 0, 0]),
            make_doc('gone', 0, [0, 1, 0], deleted=True),
            make_doc('other', 0, [0, 0, 1]),
        ],
    )
    assert {d.metadata.objectId for d in store.get(flt)} == expected


@pytest.mark.parametrize(
    ('deleted', 'expected'),
    [
        ('active', {'live'}),
        ('deleted', {'gone', 'schema'}),
        ('all', {'live', 'gone', 'schema'}),
    ],
)
def test_deleted_filter_is_tri_state(deleted, expected):
    # get() returns stored rows as they are: the control record is a row marked deleted.
    # The explorer hooks never list it (test_vx_hooks.py).
    store = make_store(drv)
    _ingest(store, [make_doc('live', 0, [1, 0, 0]), make_doc('gone', 0, [0, 1, 0], deleted=True)])
    docs = store.get(vx_filter(limit=50, deleted=deleted))
    assert {d.metadata.objectId for d in docs} == expected


def test_numeric_offset_skips_rows_in_a_stable_order():
    store = make_store(drv)
    _ingest(store, [make_doc(f'doc-{i}', 0, [1, i, 0]) for i in range(7)])

    everything = keys_of(store.get(DocFilter(limit=100, chunkIds=[0], isDeleted=False)))
    pages = []
    for offset in range(0, 7, 3):
        pages.extend(keys_of(store.get(DocFilter(limit=3, offset=offset, chunkIds=[0], isDeleted=False))))
    assert len(everything) == 7
    assert pages == everything


def test_get_paths_honours_a_numeric_offset_and_hides_the_control_record():
    store = make_store(drv)
    _ingest(store, [make_doc(f'doc-{i}', 0, [1, i, 0], parent=f'C:/p/{i}.md') for i in range(5)])
    _ingest(store, [make_doc('gone', 0, [0, 1, 1], parent='C:/p/gone.md', deleted=True)])

    first = store.getPaths(offset=0, limit=3)
    rest = store.getPaths(offset=3, limit=3)
    assert len(first) == 3 and len(rest) == 2
    assert set(first) | set(rest) == {f'C:/p/{i}.md' for i in range(5)}
    assert not set(first) & set(rest)


def test_semantic_search_applies_the_floor_through_effective_floor():
    store = make_store(drv)
    # Cosine similarity of the query with each: 1.0, 0.0, -1.0 -> rescaled 1.0, 0.5, 0.0.
    _ingest(
        store,
        [
            make_doc('same', 0, [1, 0, 0]),
            make_doc('orthogonal', 0, [0, 1, 0]),
            make_doc('opposite', 0, [-1, 0, 0]),
        ],
    )
    query = QuestionText(text='q')
    query.embedding = [1.0, 0.0, 0.0]
    query.embedding_model = 'unit-model'

    legacy = store.searchSemantic(query, DocFilter(limit=10))
    assert {d.metadata.objectId for d in legacy} == {'same', 'orthogonal'}

    everything = store.searchSemantic(query, vx_filter(limit=10, minScore=-math.inf))
    assert {d.metadata.objectId for d in everything} == {'same', 'orthogonal', 'opposite'}
    assert sorted(round(d.score, 4) for d in everything) == [0.0, 0.5, 1.0]

    strict = store.searchSemantic(query, vx_filter(limit=10, minScore=0.75))
    assert {d.metadata.objectId for d in strict} == {'same'}


def test_semantic_search_refuses_a_non_zero_offset_with_value_error():
    store = make_store(drv)
    _ingest(store, [make_doc('doc-a', 0, [1, 0, 0])])
    query = QuestionText(text='q')
    query.embedding = [1.0, 0.0, 0.0]
    query.embedding_model = 'unit-model'
    with pytest.raises(ValueError):
        store.searchSemantic(query, DocFilter(limit=10, offset=5))


@pytest.mark.parametrize('similarity', ['Euclid', 'Manhattan'])
def test_distance_metrics_score_closer_points_higher(similarity):
    store = make_store(drv, similarity=similarity)
    _ingest(store, [make_doc('near', 0, [1, 0, 0]), make_doc('far', 0, [9, 9, 9])])
    query = QuestionText(text='q')
    query.embedding = [1.0, 0.0, 0.0]
    query.embedding_model = 'unit-model'
    docs = store.searchSemantic(query, vx_filter(limit=10, minScore=-math.inf))
    scores = {d.metadata.objectId: d.score for d in docs}
    assert scores['near'] == pytest.approx(1.0)
    assert scores['near'] > scores['far'] > 0
    assert store.scoreInfo()['formula'] == '1 / (1 + distance)'


def test_dot_scores_spread_over_the_whole_range():
    store = make_store(drv, similarity='Dot')
    _ingest(
        store,
        [
            make_doc('same', 0, [1, 0, 0]),
            make_doc('orthogonal', 0, [0, 1, 0]),
            make_doc('opposite', 0, [-1, 0, 0]),
        ],
    )
    query = QuestionText(text='q')
    query.embedding = [1.0, 0.0, 0.0]
    query.embedding_model = 'unit-model'
    docs = store.searchSemantic(query, vx_filter(limit=10, minScore=-math.inf))
    scores = {d.metadata.objectId: round(d.score, 4) for d in docs}
    assert scores == {'same': 1.0, 'orthogonal': 0.5, 'opposite': 0.0}

    floored = store.searchSemantic(query, DocFilter(limit=10))
    assert {d.metadata.objectId for d in floored} == {'same', 'orthogonal'}

    info = store.scoreInfo()
    assert info['formula'] == '(1 + dot) / 2'
    assert 'range' in info and info['range'] is None  # unbounded unless the vectors are unit length


def test_get_paths_matches_the_exact_parent_and_keeps_legacy_rows():
    store = make_store(drv)
    _ingest(
        store,
        [
            make_doc('doc-a', 0, [1, 0, 0], parent='C:/p/harrier_handbook.md'),
            make_doc('doc-b', 0, [0, 1, 0], parent='C:/p/harrier_handbook.md.bak'),
        ],
    )
    # A row written before isDeleted existed (no flag at all) is an active document.
    store.client.upsert(
        store.collection,
        points=[
            drv.PointStruct(
                id=str(uuid.uuid4()),
                vector=[0.0, 0.0, 1.0],
                payload={'content': 'old', 'meta': {'objectId': 'old', 'chunkId': 0, 'parent': 'C:/p/old.md'}},
            )
        ],
    )

    assert store.getPaths(parent='C:/p/harrier_handbook.md') == {'C:/p/harrier_handbook.md': 'doc-a'}
    assert store.getPaths(parent='harrier_handbook') == {}
    assert store.getPaths(parent='C:/p/old.md') == {'C:/p/old.md': 'old'}
    assert set(store.getPaths()) == {'C:/p/harrier_handbook.md', 'C:/p/harrier_handbook.md.bak', 'C:/p/old.md'}


def test_soft_delete_keeps_the_rest_of_the_metadata():
    store = make_store(drv)
    _ingest(store, [make_doc('doc-a', 0, [1, 0, 0]), make_doc('doc-a', 1, [0, 1, 0])])

    store.markDeleted(['doc-a'])
    metas = [p.payload['meta'] for p in _points(store).values() if p.payload['meta'].get('objectId') == 'doc-a']
    assert len(metas) == 2
    assert all(m['isDeleted'] is True and m['parent'] == 'C:/docs/doc-a.md' for m in metas)

    store.markActive(['doc-a'])
    metas = [p.payload['meta'] for p in _points(store).values() if p.payload['meta'].get('objectId') == 'doc-a']
    assert all(m['isDeleted'] is False and m['chunkId'] in (0, 1) for m in metas)
