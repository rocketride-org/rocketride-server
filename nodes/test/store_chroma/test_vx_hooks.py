# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Vector Explorer hooks of the Chroma driver, against the mock client.

Each hook is called the way the explorer tools call it (contract section 2.2):
``describe``, ``scoreInfo``, ``countChunks``, ``listDocumentPage`` (chunk-0 pages
by offset + per-page counts + a sweep for documents without chunk 0),
``scrollChunks``, ``sampleChunks``, ``getVectors`` and ``removeCounted``.
``countDocumentsWhere`` and ``knnGraph`` keep the shared defaults. The same
assertions run against a live Chroma in ``nodes/test/test_store_chroma_full.py``.
"""

from __future__ import annotations

import base64
import json
import uuid

import numpy as np
import pytest

from ai.common.schema import QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import ChunkPage, DocPage, StoreInfo

from ._mock_driver import keys_of, load_driver, make_doc, make_store, vx_filter

drv = load_driver()
Collection = drv.chromadb.Collection


@pytest.fixture(autouse=True)
def _fresh_server():
    drv.chromadb.HttpClient.reset()
    yield
    drv.chromadb.HttpClient.reset()


def _unit(v):
    v = np.asarray(v, dtype=float)
    return (v / np.linalg.norm(v)).tolist()


def _corpus(store, *, docs=4, chunks=3, dim=6, seed=3, tables=()):
    rng = np.random.default_rng(seed)
    batch = []
    for d in range(docs):
        oid = f'doc-{d}'
        for c in range(chunks):
            batch.append(
                make_doc(
                    oid,
                    c,
                    _unit(rng.normal(size=dim)),
                    is_table=(oid, c) in tables,
                    size=1000 + d,
                    ingestedAt='2026-10-08T18:20:11Z',
                )
            )
    store.addChunks(batch)


def _legacy_row(store, object_id, chunk_id, vector, **meta):
    """Write a row the way the previous driver did: random (uuid4) id, flat metadata."""
    rid = str(uuid.uuid4())
    metadata = {
        'objectId': object_id,
        'chunkId': chunk_id,
        'nodeId': 'chunk_1',
        'parent': meta.pop('parent', f'C:/legacy/{object_id}.md'),
        'isDeleted': meta.pop('isDeleted', False),
        'isTable': False,
        'tableId': 0,
        **meta,
    }
    store.collectionObj.upsert(
        ids=[rid], embeddings=[list(vector)], metadatas=[metadata], documents=[f'legacy {chunk_id}']
    )
    return rid


def _delete_row(store, rid):
    store.collectionObj.delete(ids=[rid])


def _all_pages(store, limit=2, object_ids=None, deleted='active'):
    items, cursor, pages = [], None, []
    for _ in range(50):
        page = store.listDocumentPage(cursor=cursor, limit=limit, object_ids=object_ids, deleted=deleted, sort='path')
        pages.append(page)
        items.extend(page.items)
        cursor = page.next_cursor
        if cursor is None:
            return items, pages
    raise AssertionError('listDocumentPage never ended')


# --- capabilities, describe, scoreInfo ------------------------------------------------


def test_capabilities():
    store = make_store(drv)
    caps = store.capabilities()
    for hook in (
        'describe',
        'scoreInfo',
        'countChunks',
        'listDocumentPage',
        'scrollChunks',
        'sampleChunks',
        'getVectors',
        'removeCounted',
    ):
        assert hook in caps, hook
    assert 'countDocumentsWhere' not in caps and 'knnGraph' not in caps
    assert {'documents_distinct', 'search_keyword'} <= caps
    assert 'knn_native' not in caps and 'sample_stratified_native' not in caps
    assert set(DocumentStoreBase.VX_HOOKS) >= caps - store.VX_DRIVER_CAPABILITIES
    assert drv.Store.VX_SUPPORT == 'supported'


def test_describe_an_existing_collection_without_reading_every_id():
    store = make_store(drv, collection='vx_describe')
    _corpus(store)
    Collection.calls.clear()
    info = store.describe()
    assert isinstance(info, StoreInfo)
    assert info.backend == 'chroma'
    assert info.backend_version == '1.0.0'
    assert info.collection == 'vx_describe'
    assert info.collection_exists is True and info.control_record is True
    assert info.meta_column is None
    assert info.metric == 'cosine'
    assert info.dimension == 6 and info.model == 'unit-model'
    # The explorer's names: m and ef_construction (Chroma calls m 'max_neighbors').
    assert info.index == {
        'type': 'hnsw',
        'params': {'space': 'cosine', 'm': 16, 'ef_construction': 100, 'ef_search': 100},
    }
    assert 'score_scale_inverted_fixed' in info.caveats
    assert '127.0.0.1' not in repr(info) and '8000' not in repr(info)
    assert [c for c in Collection.calls if c['include'] == []] == []


def test_describe_a_missing_collection_never_raises():
    store = make_store(drv, collection='vx_absent')
    info = store.describe()
    assert info.collection_exists is False and info.control_record is None
    assert store.countChunks(vx_filter()) == 0
    page = store.listDocumentPage(cursor=None, limit=5, object_ids=None, deleted='active', sort='path')
    assert page.items == [] and page.next_cursor is None


def test_describe_reports_a_missing_control_record():
    store = make_store(drv, collection='vx_norecord')
    _corpus(store)
    _delete_row(store, drv.point_id_for('schema', 0))
    assert store.describe().control_record is False


def test_describe_reads_the_space_of_the_collection():
    store = make_store(drv, collection='vx_l2', similarity='l2')
    _corpus(store)
    assert store.describe().metric == 'l2'


def test_score_info():
    store = make_store(drv)
    info = store.scoreInfo()
    assert info['formula'] == '(2 - cosine_distance) / 2'
    assert info['range'] == [0, 1] and info['higher_is_better'] is True
    assert info['floor'] == pytest.approx(0.2) and info['threshold'] == pytest.approx(0.3)
    assert make_store(drv, similarity='l2').scoreInfo()['formula'] == '1 / (1 + euclidean_distance)'
    ip = make_store(drv, similarity='ip').scoreInfo()
    assert ip['formula'] == '(2 - ip_distance) / 2'
    assert 'range' in ip and ip['range'] is None  # unbounded unless the vectors are unit length


def test_score_info_on_a_fresh_instance_reads_the_collection_space():
    # A node whose configured space differs from the collection's (created l2 by an
    # earlier configuration) must label scores by the collection before any read.
    _corpus(make_store(drv, collection='vx_space', similarity='l2'))
    fresh = make_store(drv, collection='vx_space', similarity='cosine')
    assert fresh.scoreInfo()['formula'] == '1 / (1 + euclidean_distance)'
    assert make_store(drv, collection='vx_not_created', similarity='ip').scoreInfo()['formula'] == (
        '(2 - ip_distance) / 2'
    )


def test_empty_id_lists_answer_nothing_without_asking_the_server():
    # Chroma refuses `$in: []`; an empty list selects no row, as it does on Qdrant.
    store = make_store(drv)
    _corpus(store, docs=2, chunks=2)
    for object_ids in (['schema'], []):
        page = store.listDocumentPage(cursor=None, limit=5, object_ids=object_ids, deleted='all', sort='path')
        assert page.items == [] and page.next_cursor is None and page.total == 0
    query = QuestionText(text='doc')
    query.embedding = [1.0, 0, 0, 0, 0, 0]
    query.embedding_model = 'unit-model'
    for field in ('objectIds', 'tableIds', 'permissions', 'chunkIds'):
        flt = vx_filter(**{field: []})
        assert store.countChunks(flt) == 0, field
        assert store.get(flt) == [], field
        assert store.searchSemantic(query, flt) == [], field
        assert store.searchKeyword(query, flt) == [], field
        assert store.sampleChunks(n=5, seed=1, strategy='first', docFilter=flt, include_keys=[]) == ([], 'first')
    assert store.countChunks(vx_filter(objectIds=['doc-0'])) == 2


# --- counts ---------------------------------------------------------------------------


def test_mark_deleted_and_active_return_the_chunks_they_moved():
    """The trash writes answer the chunks they moved into or out of the trash (soft_delete's matched_chunks)."""
    store = make_store(drv)
    _corpus(store, docs=3, chunks=4)
    assert store.markDeleted(['doc-1', 'ghost']) == 4
    assert store.markDeleted(['doc-1']) == 0, 'already in the trash: nothing moves'
    assert store.countChunks(vx_filter(deleted='deleted')) == 4
    assert store.markActive(['doc-1', 'doc-2']) == 4, 'doc-2 was never in the trash'
    assert store.markActive(['doc-1']) == 0
    assert store.markDeleted([]) == 0 and store.markActive([]) == 0
    assert store.countChunks(vx_filter()) == 12


def test_count_chunks_excludes_the_control_record_and_follows_the_filter():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=4)
    store.markDeleted(['doc-2'])
    assert store.countChunks(vx_filter()) == 8
    assert store.countChunks(vx_filter(deleted='all')) == 12
    assert store.countChunks(vx_filter(deleted='deleted')) == 4
    assert store.countChunks(vx_filter(chunkIds=[0])) == 2
    assert store.countChunks(vx_filter(objectIds=['schema'], deleted='all')) == 0
    assert store.countDocumentsWhere(vx_filter()) is None


def test_count_chunks_pages_through_large_sets(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=5, chunks=3)
    monkeypatch.setattr(drv.Store, 'READ_PAGE', 4)
    assert store.countChunks(vx_filter()) == 15


# --- listDocumentPage --------------------------------------------------------------------


def test_list_documents_pages_every_document_once_with_counts():
    store = make_store(drv)
    _corpus(store, docs=5, chunks=3, tables={('doc-2', 1), ('doc-2', 2)})
    items, pages = _all_pages(store, limit=2)
    assert sorted(i.objectId for i in items) == [f'doc-{d}' for d in range(5)]
    first = pages[0]
    assert isinstance(first, DocPage)
    assert first.distinct is True and first.sorted is False and first.counts_exact is True
    assert 'documents_unsorted' in first.caveats
    rows = {i.objectId: i for i in items}
    assert rows['doc-2'].chunks == 3 and rows['doc-2'].tables == 2
    row = rows['doc-1']
    assert row.path == 'C:/docs/doc-1.md' and row.has_first_chunk is True and row.deleted is False
    assert row.size == 1001 and row.ingestedAt == '2026-10-08T18:20:11Z' and row.modifyTime is None
    assert row.pointId == drv.point_id_for('doc-1', 0)
    assert pages[-1].total == 5


def test_list_documents_sweeps_orphans_after_the_first_chunk_rows():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    _delete_row(store, drv.point_id_for('doc-1', 0))
    items, _ = _all_pages(store, limit=2)
    assert sorted(i.objectId for i in items) == ['doc-0', 'doc-1', 'doc-2']
    orphan = items[-1]
    assert orphan.objectId == 'doc-1' and orphan.has_first_chunk is False and orphan.chunks == 2
    assert orphan.pointId == drv.point_id_for('doc-1', 1)


def test_list_documents_finds_legacy_rows_and_orphans():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=1)
    rng = np.random.default_rng(9)
    for c in range(3):
        _legacy_row(store, 'legacy-a', c, _unit(rng.normal(size=6)))
    for c in (1, 2):
        _legacy_row(store, 'legacy-orphan', c, _unit(rng.normal(size=6)))
    items, _ = _all_pages(store, limit=10)
    rows = {i.objectId: i for i in items}
    assert set(rows) == {'doc-0', 'legacy-a', 'legacy-orphan'}
    assert rows['legacy-a'].chunks == 3 and rows['legacy-a'].size is None
    assert rows['legacy-orphan'].has_first_chunk is False and rows['legacy-orphan'].chunks == 2


def test_list_documents_filters_by_deleted_and_object_ids_and_never_lists_schema():
    store = make_store(drv)
    _corpus(store, docs=4, chunks=2)
    store.markDeleted(['doc-3'])
    active, _ = _all_pages(store, limit=10)
    assert sorted(i.objectId for i in active) == ['doc-0', 'doc-1', 'doc-2']
    gone, _ = _all_pages(store, limit=10, deleted='deleted')
    assert [(i.objectId, i.deleted) for i in gone] == [('doc-3', True)]
    everything, _ = _all_pages(store, limit=10, deleted='all')
    assert 'schema' not in {i.objectId for i in everything} and len(everything) == 4
    some, _ = _all_pages(store, limit=10, object_ids=['doc-1', 'doc-3', 'nope'], deleted='all')
    assert sorted(i.objectId for i in some) == ['doc-1', 'doc-3']


def test_list_documents_caps_the_orphan_sweep(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=4, chunks=2)
    monkeypatch.setattr(drv.Store, 'READ_PAGE', 2)
    monkeypatch.setattr(drv.Store, 'SWEEP_ROWS_CAP', 4)
    _, pages = _all_pages(store, limit=10)
    assert 'document_count_capped' in pages[-1].caveats


def test_list_documents_reports_a_sweep_of_exactly_the_cap_as_complete(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=4, chunks=2)  # eight document rows
    monkeypatch.setattr(drv.Store, 'READ_PAGE', 3)
    monkeypatch.setattr(drv.Store, 'SWEEP_ROWS_CAP', 8)
    _, pages = _all_pages(store, limit=10)
    assert 'document_count_capped' not in pages[-1].caveats
    assert pages[-1].total == 4 and pages[-1].counts_exact is True
    monkeypatch.setattr(drv.Store, 'SWEEP_ROWS_CAP', 7)
    _, pages = _all_pages(store, limit=10)
    assert 'document_count_capped' in pages[-1].caveats and pages[-1].total is None


def _cursor(state):
    return base64.urlsafe_b64encode(json.dumps(state).encode()).decode()


@pytest.mark.parametrize(
    'cursor',
    [
        '%%%',
        _cursor({'ph': 'o', 'i': True}),
        _cursor({'ph': 'c', 'o': False}),
        _cursor({'ph': 'c', 'o': -1}),
        _cursor({'ph': 'x', 'o': 0}),
    ],
)
def test_list_documents_refuses_a_forged_cursor(cursor):
    store = make_store(drv)
    _corpus(store)
    with pytest.raises(ToolRefusal) as err:
        store.listDocumentPage(cursor=cursor, limit=5, object_ids=None, deleted='active', sort='path')
    assert err.value.code == 'INVALID_INPUT'


# --- scrollChunks ---------------------------------------------------------------------


def test_scroll_chunks_pages_in_chunk_order_without_vectors():
    store = make_store(drv)
    store.addChunks([make_doc('doc-0', c, _unit([1, c, 0])) for c in (4, 0, 6, 2, 1, 3, 5)])
    first = store.scrollChunks('doc-0', after_chunk=-1, limit=3, deleted='active')
    assert isinstance(first, ChunkPage)
    assert [d.metadata.chunkId for d in first.docs] == [0, 1, 2]
    assert first.has_more is True and first.next_after == 2
    assert all(not d.embedding for d in first.docs)
    assert first.docs[0].metadata.pointId == drv.point_id_for('doc-0', 0)
    second = store.scrollChunks('doc-0', after_chunk=2, limit=3, deleted='active')
    third = store.scrollChunks('doc-0', after_chunk=second.next_after, limit=3, deleted='active')
    assert [d.metadata.chunkId for d in second.docs] == [3, 4, 5]
    assert [d.metadata.chunkId for d in third.docs] == [6] and third.has_more is False


def test_scroll_chunks_reads_a_short_last_window_without_a_metadata_sweep():
    store = make_store(drv)
    store.addChunks([make_doc('doc-0', c, _unit([1, c, 0])) for c in range(7)])
    Collection.calls.clear()
    last = store.scrollChunks('doc-0', after_chunk=5, limit=3, deleted='active')
    assert [d.metadata.chunkId for d in last.docs] == [6] and last.has_more is False
    # The window and a one-row probe beyond it; no read of every remaining chunk, no fetch by id.
    assert len(Collection.calls) == 2
    assert all(c['ids'] is None for c in Collection.calls)
    assert Collection.calls[1]['include'] == [] and Collection.calls[1]['limit'] == 1


def test_scroll_chunks_handles_gaps_and_refuses_the_control_record():
    store = make_store(drv)
    store.addChunks([make_doc('gappy', c, _unit([1, c, 0])) for c in (3, 7, 64)])
    page = store.scrollChunks('gappy', after_chunk=-1, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == [3, 7] and page.has_more is True
    page = store.scrollChunks('gappy', after_chunk=page.next_after, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == [64] and page.has_more is False
    assert store.scrollChunks('schema', after_chunk=-1, limit=5, deleted='all').docs == []


# --- sampleChunks ---------------------------------------------------------------------


def test_sample_random_reads_a_seeded_window_and_reports_first():
    store = make_store(drv)
    _corpus(store, docs=5, chunks=4)
    docs, used = store.sampleChunks(n=6, seed=7, strategy='random', docFilter=vx_filter(), include_keys=[])
    again, _ = store.sampleChunks(n=6, seed=7, strategy='random', docFilter=vx_filter(), include_keys=[])
    assert used == 'first'
    assert len(docs) == 6 and keys_of(docs) == keys_of(again)
    assert all(len(d.embedding) == 6 and isinstance(d.embedding[0], float) for d in docs)
    assert 'schema' not in {d.metadata.objectId for d in docs}
    assert all(d.metadata.pointId for d in docs)


def test_sample_first_and_stratified():
    store = make_store(drv)
    _corpus(store, docs=2, chunks=5)
    store.markDeleted(['doc-1'])
    docs, used = store.sampleChunks(n=50, seed=1, strategy='first', docFilter=vx_filter(), include_keys=[])
    assert used == 'first' and len(docs) == 5 and {d.metadata.objectId for d in docs} == {'doc-0'}
    with pytest.raises(StoreUnsupported):
        store.sampleChunks(n=5, seed=1, strategy='stratified', docFilter=vx_filter(), include_keys=[])


# --- getVectors -----------------------------------------------------------------------


def test_get_vectors_uses_the_deterministic_id_fast_path():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    Collection.calls.clear()
    docs = store.getVectors([('doc-1', 2), ('doc-0', 0), ('schema', 0)])
    assert keys_of(docs) == [('doc-1', 2), ('doc-0', 0)]
    assert docs[0].metadata.pointId == drv.point_id_for('doc-1', 2)
    assert all(len(d.embedding) == 6 for d in docs)
    assert len(Collection.calls) == 1 and Collection.calls[0]['ids'] is not None


def test_get_vectors_falls_back_to_the_filter_for_legacy_ids():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=1)
    rid = _legacy_row(store, 'legacy-a', 4, _unit([1, 2, 3, 4, 5, 6]), isDeleted=True)
    docs = store.getVectors([('legacy-a', 4), ('nope', 1)])
    assert keys_of(docs) == [('legacy-a', 4)]
    assert docs[0].metadata.pointId == rid
    assert docs[0].embedding == pytest.approx(_unit([1, 2, 3, 4, 5, 6]))


# --- removeCounted --------------------------------------------------------------------


def test_remove_counted_reports_the_rows_removed_and_spares_the_control_record():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=4)
    store.markDeleted(['doc-2'])
    assert store.removeCounted(['doc-0', 'doc-2', 'schema', 'nope']) == 8
    assert store.countChunks(vx_filter(deleted='all')) == 4
    assert store.describe().control_record is True
    assert store.removeCounted(['doc-0']) == 0
