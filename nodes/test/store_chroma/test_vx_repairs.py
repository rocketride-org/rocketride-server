# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Chroma driver repairs that ship with the Vector Explorer hooks.

Runs the real driver against the repository's mock ``chromadb`` (which mirrors
the server's filter, paging and distance semantics; the live suite
``nodes/test/test_store_chroma_full.py`` repeats these against a real Chroma):

- scores rise as points get closer: cosine/ip ``(2 - d) / 2`` (was ``(d + 1) / 2``,
  which ranked the farthest points highest), l2 ``1 / (1 + sqrt(d))``;
- semantic search applies the score floor through ``effectiveFloor``;
- a non-zero offset on semantic search is a ``ValueError``;
- ``isTable=False`` filters (it was dropped as falsy);
- the deleted filter is tri-state and ``isDeleted=True`` covers every row;
- ``getPaths`` filters on ``chunkId`` (the key it is stored under) and the
  exact path, and hides the control record and deleted rows;
- ``render`` rebuilds a document from its chunks;
- ``markDeleted``/``markActive`` update the rows they select;
- new writes use deterministic ids ``uuid5(NAMESPACE_URL, 'objectId#chunkId')``;
- ``count_documents`` uses the collection count, not a read of every id.
"""

from __future__ import annotations

import math
import uuid

import pytest

from ai.common.schema import DocFilter, QuestionText

from ._mock_driver import keys_of, load_driver, make_doc, make_store, vx_filter

drv = load_driver()
Collection = drv.chromadb.Collection


@pytest.fixture(autouse=True)
def _fresh_server():
    drv.chromadb.HttpClient.reset()
    yield
    drv.chromadb.HttpClient.reset()


def _rows(store):
    return Collection._all_storage[store.collection]


def _query(vector):
    query = QuestionText(text='q')
    query.embedding = list(vector)
    query.embedding_model = 'unit-model'
    return query


def test_cosine_scores_rise_as_points_get_closer():
    store = make_store(drv)
    store.addChunks(
        [
            make_doc('same', 0, [1, 0, 0]),
            make_doc('orthogonal', 0, [0, 1, 0]),
            make_doc('opposite', 0, [-1, 0, 0]),
        ]
    )
    docs = store.searchSemantic(_query([1, 0, 0]), vx_filter(limit=10, minScore=-math.inf))
    scores = {d.metadata.objectId: round(d.score, 4) for d in docs}
    assert scores == {'same': 1.0, 'orthogonal': 0.5, 'opposite': 0.0}
    assert [d.metadata.objectId for d in docs][0] == 'same'


def test_semantic_search_applies_the_floor_through_effective_floor():
    store = make_store(drv)
    store.addChunks([make_doc('same', 0, [1, 0, 0]), make_doc('opposite', 0, [-1, 0, 0])])
    legacy = store.searchSemantic(_query([1, 0, 0]), DocFilter(limit=10))
    assert {d.metadata.objectId for d in legacy} == {'same'}
    strict = store.searchSemantic(_query([1, 0, 0]), vx_filter(limit=10, minScore=0.99))
    assert {d.metadata.objectId for d in strict} == {'same'}


@pytest.mark.parametrize(('space', 'near', 'far'), [('l2', 1.0, 1 / (1 + math.sqrt(3))), ('ip', 1.0, 0.5)])
def test_other_spaces_score_closer_points_higher(space, near, far):
    store = make_store(drv, similarity=space)
    store.addChunks([make_doc('near', 0, [1, 0, 0]), make_doc('far', 0, [0, 1, 1])])
    docs = store.searchSemantic(_query([1, 0, 0]), vx_filter(limit=10, minScore=-math.inf))
    scores = {d.metadata.objectId: d.score for d in docs}
    assert scores['near'] == pytest.approx(near)
    assert scores['far'] == pytest.approx(far)


def test_semantic_search_refuses_a_non_zero_offset_with_value_error():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', 0, [1, 0, 0])])
    with pytest.raises(ValueError):
        store.searchSemantic(_query([1, 0, 0]), DocFilter(limit=10, offset=3))


def test_is_table_false_filters_out_tables():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', 0, [1, 0, 0]), make_doc('doc-a', 1, [0, 1, 0], is_table=True)])
    docs = store.get(DocFilter(isTable=False, limit=10))
    assert keys_of(docs) == [('doc-a', 0)]


@pytest.mark.parametrize(
    ('flt', 'expected'),
    [
        (DocFilter(limit=50), {'live'}),
        (DocFilter(limit=50, isDeleted=False), {'live'}),
        (DocFilter(limit=50, isDeleted=True), {'live', 'gone', 'schema'}),
    ],
)
def test_legacy_is_deleted_flag_follows_resolve_deleted(flt, expected):
    store = make_store(drv)
    store.addChunks([make_doc('live', 0, [1, 0, 0]), make_doc('gone', 0, [0, 1, 0], deleted=True)])
    assert {d.metadata.objectId for d in store.get(flt)} == expected


@pytest.mark.parametrize(('deleted', 'expected'), [('active', {'live'}), ('deleted', {'gone', 'schema'})])
def test_deleted_filter_is_tri_state(deleted, expected):
    # get() returns stored rows as they are: the control record is a row marked deleted.
    store = make_store(drv)
    store.addChunks([make_doc('live', 0, [1, 0, 0]), make_doc('gone', 0, [0, 1, 0], deleted=True)])
    assert {d.metadata.objectId for d in store.get(vx_filter(limit=50, deleted=deleted))} == expected


def test_get_paths_lists_first_chunks_by_exact_path():
    store = make_store(drv)
    store.addChunks(
        [
            make_doc('doc-a', 0, [1, 0, 0], parent='C:/a/report.pdf'),
            make_doc('doc-a', 1, [1, 1, 0], parent='C:/a/report.pdf'),
            make_doc('doc-b', 0, [0, 1, 0], parent='C:/b/notes.md'),
            make_doc('doc-c', 0, [0, 0, 1], parent='C:/c/old.md', deleted=True),
        ]
    )
    assert store.getPaths() == {'C:/a/report.pdf': 'doc-a', 'C:/b/notes.md': 'doc-b'}
    assert store.getPaths(parent='C:/b/notes.md') == {'C:/b/notes.md': 'doc-b'}
    assert len(store.getPaths(offset=1, limit=5)) == 1


def test_render_rebuilds_the_document_in_chunk_order():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', c, [1, c, 0], text=f'<{c}>') for c in (2, 0, 1)])
    out = []
    store.renderChunkSize = 2
    store.render('doc-a', out.append)
    assert ''.join(out) == '<0><1><2>'


def test_mark_deleted_and_active_update_the_selected_rows():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', 0, [1, 0, 0]), make_doc('doc-a', 1, [0, 1, 0]), make_doc('doc-b', 0, [0, 0, 1])])
    store.markDeleted(['doc-a'])
    metas = {(m['objectId'], m['chunkId']): m for m in (r['metadata'] for r in _rows(store).values())}
    assert metas[('doc-a', 0)]['isDeleted'] is True and metas[('doc-a', 1)]['isDeleted'] is True
    assert metas[('doc-b', 0)]['isDeleted'] is False
    assert metas[('doc-a', 1)]['parent'] == 'C:/docs/doc-a.md'
    store.markActive(['doc-a'])
    metas = {(m['objectId'], m['chunkId']): m for m in (r['metadata'] for r in _rows(store).values())}
    assert metas[('doc-a', 0)]['isDeleted'] is False


def test_new_writes_use_deterministic_ids_and_reingest_replaces():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', c, [1, c, 0]) for c in range(4)])
    assert str(uuid.uuid5(uuid.NAMESPACE_URL, 'doc-a#3')) in _rows(store)
    assert str(uuid.uuid5(uuid.NAMESPACE_URL, 'schema#0')) in _rows(store)
    store.addChunks([make_doc('doc-a', c, [1, c, 1], text=f'v2 {c}') for c in range(2)])
    rows = [r for r in _rows(store).values() if r['metadata']['objectId'] == 'doc-a']
    assert sorted(r['metadata']['chunkId'] for r in rows) == [0, 1]
    assert all(r['document'].startswith('v2') for r in rows)


def test_a_batch_with_a_repeated_key_keeps_the_last_chunk():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', 0, [1, 0, 0], text='first'), make_doc('doc-a', 0, [0, 1, 0], text='second')])
    rows = [r for r in _rows(store).values() if r['metadata']['objectId'] == 'doc-a']
    assert [r['document'] for r in rows] == ['second']


def test_count_documents_uses_the_collection_count():
    store = make_store(drv)
    store.addChunks([make_doc('doc-a', c, [1, c, 0]) for c in range(3)])
    Collection.calls.clear()
    assert store.count_documents() == 4  # three chunks and the control record, as before
    # The only read is the control record (it also loads the model name); no read of every id.
    assert [c for c in Collection.calls if c['include'] == []] == []
    assert all(c['where'] == {'objectId': {'$in': ['schema']}} for c in Collection.calls)


def test_a_failed_connect_names_no_host_or_port(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise ConnectionError('connection refused')

    monkeypatch.setattr(drv.chromadb, 'HttpClient', refuse)
    with pytest.raises(Exception) as err:
        make_store(drv)
    message = str(err.value)
    assert 'Failed to connect to Chroma' in message and 'connection refused' in message
    assert '127.0.0.1' not in message and '8000' not in message


def test_a_large_batch_replaces_its_documents_with_one_id_list():
    # The re-ingest delete once OR-ed one clause per document; the server refuses
    # an $or of about 1,000 clauses, so one call with that many first chunks failed.
    store = make_store(drv)
    batch = [make_doc(f'doc-{i:04d}', c, [1.0, i, c]) for i in range(1100) for c in range(2)]
    store.addChunks(batch)
    store.addChunks(batch[:4])  # a re-ingest of two documents keeps one record per chunk
    assert store.countChunks(vx_filter()) == 2200
    assert store.countChunks(vx_filter(objectIds=['doc-0000', 'doc-0001'])) == 4


def _id_lists(where):
    """Every $in list in a where filter."""
    if not isinstance(where, dict):
        return []
    lists = []
    for key, value in where.items():
        if key in ('$and', '$or'):
            for clause in value:
                lists += _id_lists(clause)
        elif isinstance(value, dict) and isinstance(value.get('$in'), list):
            lists.append(value['$in'])
    return lists


def test_deletes_of_many_documents_send_id_lists_the_server_accepts():
    # chromadb 1.5.9 refuses an $in list of about 32,760 values or more ("too many
    # SQL variables"); a folder deletion can name more documents than that.
    store = make_store(drv)
    store.addChunks([make_doc(f'doc-{d}', c, [1.0, d, c]) for d in range(4) for c in range(2)])
    many = [f'gone-{i:05d}' for i in range(33000)]

    store.markDeleted(many + ['doc-0'])
    assert store.countChunks(vx_filter(deleted='deleted')) == 2
    store.markActive(many + ['doc-0'])
    assert store.countChunks(vx_filter(deleted='deleted')) == 0

    Collection.calls.clear()
    Collection.deletes.clear()
    assert store.removeCounted(many + ['doc-1']) == 2
    store.remove(many + ['doc-2'])
    left = store.countChunks(vx_filter(objectIds=['doc-0', 'doc-1', 'doc-2', 'doc-3'], deleted='all'))
    assert left == 4  # doc-0 and doc-3 stay; doc-1 and doc-2 are gone
    assert store.countChunks(vx_filter(objectIds=['doc-1', 'doc-2'], deleted='all')) == 0

    sent = [ids for call in Collection.calls + Collection.deletes for ids in _id_lists(call['where'])]
    assert sent and max(len(ids) for ids in sent) <= 1000
    assert store.describe().control_record is True
