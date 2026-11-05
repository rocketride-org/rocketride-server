# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Vector Explorer hooks of the Qdrant driver, against the mock client.

Each hook is called the way the explorer tools call it (contract section 2.2):
``describe``, ``scoreInfo``, ``countChunks``, ``countDocumentsWhere``,
``listDocumentPage`` (chunk-0 scroll + facet counts + orphan sweep),
``scrollChunks``, ``sampleChunks``, ``getVectors`` (deterministic-id fast path
with the filter fallback), ``knnGraph`` (Qdrant's ``search_matrix_offsets``)
and ``removeCounted``. The same assertions run against a live Qdrant in
``nodes/test/test_store_qdrant_full.py``.
"""

from __future__ import annotations

import base64
import json
import types
import uuid

import numpy as np
import pytest

from ai.common.store import DocumentStoreBase
from ai.common.store.errors import StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import ChunkPage, DocPage, KnnGraph, StoreInfo

from ._mock_driver import keys_of, load_driver, make_doc, make_store, vx_filter

drv = load_driver()
Client = drv.QdrantClient


@pytest.fixture(autouse=True)
def _fresh_server():
    Client.reset()
    yield
    Client.reset()


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


def _legacy_point(store, object_id, chunk_id, vector, **meta):
    """Write a row the way the previous driver did: random (uuid4) id, same payload."""
    payload_meta = {
        'objectId': object_id,
        'chunkId': chunk_id,
        'nodeId': 'chunk_1',
        'parent': meta.pop('parent', f'C:/legacy/{object_id}.md'),
        'isDeleted': meta.pop('isDeleted', False),
        'isTable': False,
        'tableId': 0,
        **meta,
    }
    pid = str(uuid.uuid4())
    store.client.upsert(
        store.collection,
        points=[
            drv.PointStruct(
                id=pid, vector=list(vector), payload={'content': f'legacy {chunk_id}', 'meta': payload_meta}
            )
        ],
    )
    return pid


def _delete_point(store, pid):
    store.client.delete(store.collection, points_selector=drv.models.PointIdsList(points=[pid]))


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


def test_capabilities_report_every_native_hook_and_the_native_knn():
    store = make_store(drv)
    caps = store.capabilities()
    for hook in DocumentStoreBase.VX_HOOKS:
        assert hook in caps, hook
    assert {'knn_native', 'documents_distinct', 'search_keyword'} <= caps
    assert 'sample_stratified_native' not in caps
    assert drv.Store.VX_SUPPORT == 'supported'


def test_describe_an_existing_collection():
    store = make_store(drv, collection='vx_describe')
    _corpus(store)
    info = store.describe()
    assert isinstance(info, StoreInfo)
    assert info.backend == 'qdrant'
    assert info.backend_version == 'mock'
    assert info.collection == 'vx_describe'
    assert info.collection_exists is True
    assert info.control_record is True
    assert info.meta_column is None
    assert info.metric == 'cosine'
    assert info.dimension == 6
    assert info.model == 'unit-model'
    assert info.index == {'type': 'hnsw', 'params': {'m': 16, 'ef_construction': 100}}
    assert 'brute_force_search' in info.caveats
    text = repr(info)
    assert '127.0.0.1' not in text and '6333' not in text


def test_describe_a_missing_collection_never_raises():
    store = make_store(drv, collection='vx_absent')
    info = store.describe()
    assert info.collection_exists is False
    assert info.control_record is None
    assert info.dimension is None and info.model is None
    assert store.countChunks(vx_filter()) == 0
    assert store.countDocumentsWhere(vx_filter()) == 0
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert page.items == [] and page.next_cursor is None and page.total == 0


def test_describe_reports_a_missing_control_record():
    store = make_store(drv, collection='vx_norecord')
    _corpus(store)
    _delete_point(store, drv.point_id_for('schema', 0))
    assert store.describe().control_record is False


def test_score_info_for_cosine():
    store = make_store(drv)
    info = store.scoreInfo()
    assert info['formula'] == '(1 + cosine_similarity) / 2'
    assert info['range'] == [0, 1]
    assert info['higher_is_better'] is True
    assert info['floor'] == pytest.approx(0.2)
    assert info['threshold'] == pytest.approx(0.3)


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
    assert store.countChunks(vx_filter(objectIds=['doc-0'])) == 4
    assert store.countChunks(vx_filter(objectIds=['schema'], deleted='all')) == 0


def test_count_documents_counts_distinct_ids_including_orphans():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    _delete_point(store, drv.point_id_for('doc-1', 0))
    assert store.countDocumentsWhere(vx_filter()) == 3
    assert store.countChunks(vx_filter(chunkIds=[0])) == 2


def test_count_documents_answers_none_above_the_cap(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=5, chunks=1)
    monkeypatch.setattr(drv.Store, 'COUNT_DOCUMENTS_CAP', 3)
    assert store.countDocumentsWhere(vx_filter()) is None


def test_stats_above_the_document_cap_counts_first_chunks(monkeypatch):
    # countDocumentsWhere is overridden (so dialect says count_documents) yet answers None
    # above COUNT_DOCUMENTS_CAP: stats must fall back on that None, not on the capability.
    from ai.common.store import VectorStoreToolMixin

    store = make_store(drv)
    _corpus(store, docs=5, chunks=2)
    monkeypatch.setattr(drv.Store, 'COUNT_DOCUMENTS_CAP', 3)
    node = VectorStoreToolMixin()
    node.IGlobal = types.SimpleNamespace(store=store)
    answer = node.stats({'mode': 'full'})
    assert answer['success'] is True
    assert answer['documents'] == 5 and answer['chunks'] == 10
    assert 'documents_by_first_chunk' in answer['caveats']


# --- listDocumentPage --------------------------------------------------------------------


def test_list_documents_pages_every_document_once_with_counts():
    store = make_store(drv)
    _corpus(store, docs=5, chunks=3, tables={('doc-2', 1), ('doc-2', 2)})
    items, pages = _all_pages(store, limit=2)

    assert sorted(i.objectId for i in items) == [f'doc-{d}' for d in range(5)]
    first = pages[0]
    assert isinstance(first, DocPage)
    assert first.total == 5
    assert first.distinct is True and first.sorted is False and first.counts_exact is True
    assert 'documents_unsorted' in first.caveats
    rows = {i.objectId: i for i in items}
    assert rows['doc-2'].chunks == 3 and rows['doc-2'].tables == 2
    assert rows['doc-0'].tables == 0
    row = rows['doc-1']
    assert row.path == 'C:/docs/doc-1.md'
    assert row.has_first_chunk is True and row.deleted is False
    assert row.nodeId == 'chunk_1' and row.size == 1001
    assert row.ingestedAt == '2026-10-08T18:20:11Z' and row.modifyTime is None
    assert row.pointId == drv.point_id_for('doc-1', 0)


def test_list_documents_sweeps_orphans_after_the_first_chunk_rows():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    _delete_point(store, drv.point_id_for('doc-1', 0))
    items, _ = _all_pages(store, limit=2)

    assert sorted(i.objectId for i in items) == ['doc-0', 'doc-1', 'doc-2']
    orphan = next(i for i in items if i.objectId == 'doc-1')
    assert orphan.has_first_chunk is False
    assert orphan.chunks == 2
    assert orphan.path == 'C:/docs/doc-1.md'
    assert orphan.pointId == drv.point_id_for('doc-1', 1)
    assert items[-1].objectId == 'doc-1'


def test_list_documents_finds_legacy_rows_and_orphans():
    store = make_store(drv, collection='vx_legacy_like')
    _corpus(store, docs=1, chunks=1)  # creates the collection and its control record
    rng = np.random.default_rng(9)
    for c in range(3):
        _legacy_point(store, 'legacy-a', c, _unit(rng.normal(size=6)))
    for c in (1, 2):  # chunk 0 never written: a legacy document without its first chunk
        _legacy_point(store, 'legacy-orphan', c, _unit(rng.normal(size=6)))
    items, pages = _all_pages(store, limit=10)

    rows = {i.objectId: i for i in items}
    assert set(rows) == {'doc-0', 'legacy-a', 'legacy-orphan'}
    assert rows['legacy-a'].has_first_chunk is True and rows['legacy-a'].chunks == 3
    assert rows['legacy-a'].size is None and rows['legacy-a'].ingestedAt is None
    assert rows['legacy-orphan'].has_first_chunk is False and rows['legacy-orphan'].chunks == 2
    assert pages[0].total == 3


def test_list_documents_filters_by_deleted_and_object_ids_and_never_lists_schema():
    store = make_store(drv)
    _corpus(store, docs=4, chunks=2)
    store.markDeleted(['doc-3'])

    active, _ = _all_pages(store, limit=10)
    assert sorted(i.objectId for i in active) == ['doc-0', 'doc-1', 'doc-2']
    gone, _ = _all_pages(store, limit=10, deleted='deleted')
    assert [(i.objectId, i.deleted) for i in gone] == [('doc-3', True)]
    everything, _ = _all_pages(store, limit=10, deleted='all')
    assert 'schema' not in {i.objectId for i in everything}
    assert len(everything) == 4
    some, _ = _all_pages(store, limit=10, object_ids=['doc-1', 'doc-3', 'nope'], deleted='all')
    assert sorted(i.objectId for i in some) == ['doc-1', 'doc-3']


def test_list_documents_finds_low_count_orphans_in_a_large_collection():
    # Documents without chunk 0 have the fewest rows, so a count-ordered top-N
    # facet drops them first; well past 1,000 documents they must still be listed.
    store = make_store(drv)
    batch = [make_doc(f'd{d:05d}', c, [1.0, d % 7, c]) for d in range(1200) for c in range(2)]
    batch += [make_doc(f'orphan-{i}', 1, [0.0, 1.0, i]) for i in range(2)]  # chunk 0 never written
    store.addChunks(batch)
    items, pages = _all_pages(store, limit=500)

    assert len(items) == 1202 and len({i.objectId for i in items}) == 1202
    assert sorted(i.objectId for i in items if not i.has_first_chunk) == ['orphan-0', 'orphan-1']
    assert {p.total for p in pages} == {1202}
    assert all(p.caveats == ['documents_unsorted'] for p in pages)
    assert store.countDocumentsWhere(vx_filter()) == 1202


def test_list_documents_flags_a_capped_count_and_lists_no_false_orphan(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=5, chunks=2)
    _delete_point(store, drv.point_id_for('doc-3', 0))
    monkeypatch.setattr(drv.Store, 'COUNT_DOCUMENTS_CAP', 3)
    items, pages = _all_pages(store, limit=2)

    assert all('document_count_capped' in p.caveats for p in pages)
    assert all(p.total is None for p in pages)
    orphans = {i.objectId for i in items if not i.has_first_chunk}
    assert orphans <= {'doc-3'}  # capped may miss an orphan, never invent one
    assert store.countDocumentsWhere(vx_filter()) is None


def _capped_orphan_corpus(store):
    # Four documents of two rows, and one of three rows whose chunk 0 was never written:
    # with the cap at 3 the counted documents are orphan-x, doc-0 and doc-1.
    store.addChunks([make_doc(f'doc-{d}', c, _unit([1.0, d + 1, c, 0, 0, 0])) for d in range(4) for c in (0, 1)])
    store.addChunks([make_doc('orphan-x', c, _unit([0.5, 9.0, c, 0, 0, 0])) for c in (1, 2, 3)])


def _facet_match_any_sizes(store, monkeypatch):
    """Spy on facet: per call, (length of the longest MatchAny list in its filter, whether it keeps chunk 0 only)."""
    calls = []
    facet = store.client.facet

    def spy(*args, **kwargs):
        conditions = getattr(kwargs.get('facet_filter'), 'must', None) or []
        lists = [c.match.any for c in conditions if getattr(getattr(c, 'match', None), 'any', None) is not None]
        first = any(c.key == 'meta.chunkId' and getattr(c.match, 'value', None) == 0 for c in conditions)
        calls.append((max((len(values) for values in lists), default=0), first))
        return facet(*args, **kwargs)

    monkeypatch.setattr(store.client, 'facet', spy)
    return calls


def test_list_documents_above_the_cap_reads_first_chunks_instead_of_faceting_over_the_counted_ids(monkeypatch):
    # Qdrant's exact facet slows down much faster than its MatchAny list grows (17-35 s for the
    # 10,000 ids of a capped listing): the sweep reads the counted documents' chunk-0 rows.
    store = make_store(drv)
    _capped_orphan_corpus(store)
    monkeypatch.setattr(drv.Store, 'COUNT_DOCUMENTS_CAP', 3)
    calls = _facet_match_any_sizes(store, monkeypatch)
    items, pages = _all_pages(store, limit=1)

    assert calls and max(size for size, _ in calls) <= 1, calls  # facets only ever cover one page's objectIds
    assert sorted(i.objectId for i in items) == ['doc-0', 'doc-1', 'doc-2', 'doc-3', 'orphan-x']
    assert [(i.objectId, i.chunks) for i in items if not i.has_first_chunk] == [('orphan-x', 3)]
    assert all('document_count_capped' in p.caveats and p.total is None for p in pages)


def test_a_sweep_that_cannot_read_every_first_chunk_lists_no_false_orphan(monkeypatch):
    # Past the row cap some chunk-0 rows are unread: no document may be listed as without chunk 0 on that basis.
    store = make_store(drv)
    _capped_orphan_corpus(store)
    monkeypatch.setattr(drv.Store, 'COUNT_DOCUMENTS_CAP', 3)
    monkeypatch.setattr(drv.Store, 'FACET_SCROLL_ROWS_CAP', 1)
    items, pages = _all_pages(store, limit=1)

    assert sorted(i.objectId for i in items if i.has_first_chunk) == ['doc-0', 'doc-1', 'doc-2', 'doc-3']
    assert {i.objectId for i in items if not i.has_first_chunk} <= {'orphan-x'}
    assert all('document_count_capped' in p.caveats for p in pages)


def test_a_scoped_listing_sweeps_without_faceting_over_the_scope(monkeypatch):
    # A scope (the sample tool passes up to 2,000 ids) is counted by facets; the sweep
    # reads the scope's chunk-0 rows rather than faceting over the list a second time.
    store = make_store(drv)
    _capped_orphan_corpus(store)
    scope = ['doc-1', 'doc-3', 'orphan-x', 'no-such-document']
    calls = _facet_match_any_sizes(store, monkeypatch)
    items, pages = _all_pages(store, limit=1, object_ids=scope)

    assert sorted(i.objectId for i in items) == ['doc-1', 'doc-3', 'orphan-x']
    assert [i.objectId for i in items if not i.has_first_chunk] == ['orphan-x']
    assert {p.total for p in pages} == {3}
    assert (len(scope), False) in calls, calls  # every row of the scope is counted by a facet
    assert not [size for size, first in calls if first and size > 1], calls  # but not its first chunks


def test_list_documents_computes_the_total_once_per_listing(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=7, chunks=2)
    limits = []
    facet = store.client.facet

    def spy(*args, **kwargs):
        limits.append(kwargs.get('limit'))
        return facet(*args, **kwargs)

    monkeypatch.setattr(store.client, 'facet', spy)
    first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    assert first.total == 7
    assert max(limits) > 7  # the first page counts every document once

    limits.clear()
    second = store.listDocumentPage(cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert second.total == 7
    assert limits and max(limits) <= 3  # later pages facet over their own objectIds only


def _orphan_corpus(store, orphans=6):
    _corpus(store, docs=2, chunks=2)
    # Documents whose chunk 0 was never written, each with two rows.
    store.addChunks(
        [make_doc(f'orphan-{i}', c, _unit([0.5, i + 1, c, 0, 0, 0])) for i in range(orphans) for c in (1, 2)]
    )


def _pages_with_facets(store, monkeypatch, limit=2, cursor=None):
    """Every page of a listing from ``cursor``, each with the limits of the facets it asked for."""
    calls = []
    facet = store.client.facet

    def spy(*args, **kwargs):
        calls.append(kwargs.get('limit'))
        return facet(*args, **kwargs)

    monkeypatch.setattr(store.client, 'facet', spy)
    pages = []
    for _ in range(50):
        calls.clear()
        page = store.listDocumentPage(cursor=cursor, limit=limit, object_ids=None, deleted='active', sort='path')
        pages.append((page, list(calls)))
        cursor = page.next_cursor
        if cursor is None:
            return pages
    raise AssertionError('listDocumentPage never ended')


def test_list_documents_builds_the_orphan_list_once_per_listing(monkeypatch):
    store = make_store(drv)
    _orphan_corpus(store)
    pages = _pages_with_facets(store, monkeypatch)

    items = [i for page, _ in pages for i in page.items]
    assert sorted(i.objectId for i in items if not i.has_first_chunk) == [f'orphan-{i}' for i in range(6)]
    assert all(i.chunks == 2 for i in items if not i.has_first_chunk)
    orphan_pages = [(page, facets) for page, facets in pages if page.items and not page.items[0].has_first_chunk]
    assert len(orphan_pages) == 3
    # The page where the chunk-0 rows run out builds the list; later pages reuse it.
    for page, facets in orphan_pages:
        assert facets == [], facets
    assert {page.total for page, _ in pages} == {8}


def test_list_documents_rebuilds_the_orphan_list_for_a_cursor_it_does_not_remember(monkeypatch):
    # Another instance (or an expired list) answers the same page from a fresh sweep.
    store = make_store(drv)
    _orphan_corpus(store)
    first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    second = store.listDocumentPage(cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    expected = store.listDocumentPage(
        cursor=second.next_cursor, limit=2, object_ids=None, deleted='active', sort='path'
    )

    other = make_store(drv)
    page = other.listDocumentPage(cursor=second.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert [i.objectId for i in page.items] == [i.objectId for i in expected.items]
    assert page.total == expected.total == 8

    monkeypatch.setattr(drv.Store, 'ORPHAN_LIST_TTL_S', -1)  # every remembered list has expired
    page = store.listDocumentPage(cursor=second.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert [i.objectId for i in page.items] == [i.objectId for i in expected.items]


def test_documents_are_counted_without_an_object_id_index():
    # A collection created outside this driver may lack the keyword index Qdrant needs to facet.
    store = make_store(drv)
    _corpus(store, docs=4, chunks=3)
    _delete_point(store, drv.point_id_for('doc-2', 0))
    Client._collections[store.collection]['payload_schema'].pop('meta.objectId')

    assert store.countDocumentsWhere(vx_filter()) == 4
    items, pages = _all_pages(store, limit=3)
    rows = {i.objectId: i for i in items}
    assert set(rows) == {'doc-0', 'doc-1', 'doc-2', 'doc-3'}
    assert rows['doc-2'].has_first_chunk is False and rows['doc-2'].chunks == 2
    assert rows['doc-1'].chunks == 3
    assert {p.total for p in pages} == {4}


def _cursor(state):
    return base64.urlsafe_b64encode(json.dumps(state).encode()).decode()


@pytest.mark.parametrize(
    'cursor',
    [
        'not-a-cursor',
        _cursor({'ph': 'x'}),
        _cursor({'ph': 'c', 'p': 'zzz'}),
        _cursor({'ph': 'c', 'p': -1}),
        _cursor({'ph': 'c', 'p': True}),
        _cursor({'ph': 'c', 'p': '{12345678-1234-1234-1234-123456789abc}'}),
        _cursor({'ph': 'c', 'p': 5, 't': 'many'}),
        _cursor({'ph': 'o', 'i': 0, 'x': 'yes'}),
        _cursor({'ph': 'o', 'i': 0, 'k': 7}),
        _cursor({'ph': 'o', 'i': 0, 'k': 'not hex at all!'}),
    ],
)
def test_list_documents_refuses_a_cursor_it_did_not_issue(cursor):
    store = make_store(drv)
    _corpus(store)
    Client.calls.clear()
    with pytest.raises(ToolRefusal) as err:
        store.listDocumentPage(cursor=cursor, limit=5, object_ids=None, deleted='active', sort='path')
    assert err.value.code == 'INVALID_INPUT'
    assert Client.calls.get('scroll', 0) == 0  # refused before anything reaches the server


def test_list_documents_accepts_a_well_formed_point_id_it_did_not_see():
    # Qdrant starts a scroll at the first id at or after the offset: a valid id is a position, not an error.
    store = make_store(drv)
    _corpus(store, docs=3, chunks=1)
    page = store.listDocumentPage(
        cursor=_cursor({'ph': 'c', 'p': '00000000-0000-0000-0000-000000000000'}),
        limit=10,
        object_ids=None,
        deleted='active',
        sort='path',
    )
    assert sorted(i.objectId for i in page.items) == ['doc-0', 'doc-1', 'doc-2']


# --- scrollChunks ---------------------------------------------------------------------


def test_scroll_chunks_pages_in_chunk_order_without_vectors():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=7)
    first = store.scrollChunks('doc-0', after_chunk=-1, limit=3, deleted='active')
    assert isinstance(first, ChunkPage)
    assert [d.metadata.chunkId for d in first.docs] == [0, 1, 2]
    assert first.has_more is True and first.next_after == 2
    assert all(not d.embedding for d in first.docs)
    assert first.docs[0].metadata.pointId == drv.point_id_for('doc-0', 0)

    second = store.scrollChunks('doc-0', after_chunk=first.next_after, limit=3, deleted='active')
    third = store.scrollChunks('doc-0', after_chunk=second.next_after, limit=3, deleted='active')
    assert [d.metadata.chunkId for d in second.docs] == [3, 4, 5]
    assert [d.metadata.chunkId for d in third.docs] == [6]
    assert third.has_more is False


def test_scroll_chunks_handles_gaps_and_refuses_the_control_record():
    store = make_store(drv)
    store.addChunks([make_doc('gappy', c, _unit([1, c, 0])) for c in (3, 7, 64)])
    page = store.scrollChunks('gappy', after_chunk=-1, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == [3, 7] and page.has_more is True
    page = store.scrollChunks('gappy', after_chunk=page.next_after, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == [64] and page.has_more is False

    assert store.scrollChunks('schema', after_chunk=-1, limit=5, deleted='all').docs == []
    assert store.scrollChunks('unknown', after_chunk=-1, limit=5, deleted='all').docs == []


def test_scroll_chunks_falls_back_when_order_by_is_unavailable():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=5)
    schema = Client._collections[store.collection]['payload_schema']
    schema.pop('meta.chunkId')
    page = store.scrollChunks('doc-0', after_chunk=0, limit=2, deleted='active')
    assert [d.metadata.chunkId for d in page.docs] == [1, 2] and page.has_more is True


# --- sampleChunks ---------------------------------------------------------------------


def test_sample_random_draws_vectors_and_never_the_control_record():
    store = make_store(drv)
    _corpus(store, docs=4, chunks=5)
    docs, used = store.sampleChunks(n=8, seed=7, strategy='random', docFilter=vx_filter(), include_keys=[])
    assert used == 'random'
    assert len(docs) == 8
    assert all(len(d.embedding) == 6 for d in docs)
    assert 'schema' not in {d.metadata.objectId for d in docs}
    assert all(d.metadata.pointId for d in docs)
    assert Client.calls.get('query_points', 0) == 1


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
    Client.calls.clear()
    docs = store.getVectors([('doc-1', 2), ('doc-0', 0), ('schema', 0)])
    assert keys_of(docs) == [('doc-1', 2), ('doc-0', 0)]
    assert all(len(d.embedding) == 6 for d in docs)
    assert docs[0].metadata.pointId == drv.point_id_for('doc-1', 2)
    assert Client.calls.get('retrieve') == 1
    assert Client.calls.get('scroll', 0) == 0  # every key hit: no filter read

    Client.calls.clear()
    docs = store.getVectors([('doc-2', 1), ('doc-9', 0)])
    assert keys_of(docs) == [('doc-2', 1)]
    assert Client.calls.get('scroll', 0) == 1  # one filter read for the one miss


def test_get_vectors_falls_back_to_the_filter_for_legacy_ids():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=1)
    pid = _legacy_point(store, 'legacy-a', 4, _unit([1, 2, 3, 4, 5, 6]), isDeleted=True)
    docs = store.getVectors([('legacy-a', 4)])
    assert keys_of(docs) == [('legacy-a', 4)]
    assert docs[0].metadata.pointId == pid
    assert docs[0].embedding == pytest.approx(_unit([1, 2, 3, 4, 5, 6]))


# --- knnGraph -------------------------------------------------------------------------


def _exact_knn(X, k):
    Xn = X / np.linalg.norm(X, axis=1, keepdims=True)
    S = Xn @ Xn.T
    np.fill_diagonal(S, -np.inf)
    return [set(np.argsort(-S[i])[:k].tolist()) for i in range(len(X))]


def test_knn_graph_is_computed_by_qdrant_and_agrees_with_the_exact_graph():
    store = make_store(drv)
    _corpus(store, docs=6, chunks=5, dim=8)
    keys = [(f'doc-{d}', c) for d in range(6) for c in range(5)]
    docs = store.getVectors(keys)
    X = np.asarray([d.embedding for d in docs], dtype=np.float32)
    Client.calls.clear()

    graph = store.knnGraph(keys, X, 'cosine', 4)
    assert isinstance(graph, KnnGraph)
    assert graph.source == 'native'
    assert Client.calls.get('search_matrix_offsets') == 1
    assert graph.k == 4
    assert len(graph.offsets_row) == len(keys) + 1
    exact = _exact_knn(X.astype(float), 4)
    agree = total = 0
    for i in range(len(keys)):
        cols = graph.cols[graph.offsets_row[i] : graph.offsets_row[i + 1]].tolist()
        sims = graph.sims[graph.offsets_row[i] : graph.offsets_row[i + 1]].tolist()
        assert i not in cols
        assert sims == sorted(sims, reverse=True)
        for j, s in zip(cols, sims):
            expected = float(np.dot(X[i], X[j]) / (np.linalg.norm(X[i]) * np.linalg.norm(X[j])))
            assert s == pytest.approx(expected, abs=1e-5)
        agree += len(set(cols) & exact[i])
        total += 4
    assert agree / total >= 0.95


def test_knn_graph_resolves_legacy_point_ids():
    store = make_store(drv)
    _corpus(store, docs=1, chunks=1)
    rng = np.random.default_rng(5)
    for c in range(6):
        _legacy_point(store, 'legacy-a', c, _unit(rng.normal(size=6)))
    keys = [('legacy-a', c) for c in range(6)]
    X = np.asarray([d.embedding for d in store.getVectors(keys)], dtype=np.float32)
    graph = store.knnGraph(keys, X, 'cosine', 2)
    assert graph.source == 'native'
    assert all(graph.offsets_row[i + 1] - graph.offsets_row[i] == 2 for i in range(6))


def test_knn_graph_falls_back_to_the_node_when_qdrant_cannot_answer(monkeypatch):
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    keys = [(f'doc-{d}', c) for d in range(3) for c in range(3)]
    X = np.asarray([d.embedding for d in store.getVectors(keys)], dtype=np.float32)

    def broken(*_a, **_k):
        raise RuntimeError('matrix API unavailable')

    logged = []
    monkeypatch.setattr(store.client, 'search_matrix_offsets', broken)
    monkeypatch.setattr(drv, 'debug', logged.append)
    graph = store.knnGraph(keys, X, 'cosine', 3)
    assert graph.source == 'node'
    assert len(graph.offsets_row) == 10
    exact = _exact_knn(X.astype(float), 3)
    for i in range(9):
        assert set(graph.cols[graph.offsets_row[i] : graph.offsets_row[i + 1]].tolist()) == exact[i]
    assert len(logged) == 1 and 'matrix API unavailable' in logged[0]


def test_knn_graph_above_the_native_cap_is_computed_on_the_node(monkeypatch):
    # search_matrix_offsets with a has_id filter costs the server memory that grows
    # with the square of the sample; above the cap the node computes the graph.
    store = make_store(drv)
    _corpus(store, docs=3, chunks=3)
    keys = [(f'doc-{d}', c) for d in range(3) for c in range(3)]
    X = np.asarray([d.embedding for d in store.getVectors(keys)], dtype=np.float32)
    assert drv.Store.NATIVE_KNN_MAX == 500
    monkeypatch.setattr(drv.Store, 'NATIVE_KNN_MAX', 8)
    logged = []
    monkeypatch.setattr(drv, 'debug', logged.append)
    Client.calls.clear()

    graph = store.knnGraph(keys, X, 'cosine', 3)
    assert graph.source == 'node'
    assert Client.calls.get('search_matrix_offsets', 0) == 0
    assert logged == []  # expected, not a failure
    exact = _exact_knn(X.astype(float), 3)
    for i in range(9):
        assert set(graph.cols[graph.offsets_row[i] : graph.offsets_row[i + 1]].tolist()) == exact[i]

    graph = store.knnGraph(keys[:8], X[:8], 'cosine', 3)
    assert graph.source == 'native'


def _reference_knn(metric, X, k):
    X = X.astype(np.float64)
    if metric == 'l2':
        S = 1.0 / (1.0 + np.linalg.norm(X[:, None, :] - X[None, :, :], axis=2))
    elif metric == 'ip':
        S = X @ X.T
    else:
        Xn = X / np.linalg.norm(X, axis=1, keepdims=True)
        S = Xn @ Xn.T
    np.fill_diagonal(S, -np.inf)
    cols = np.argsort(-S, axis=1, kind='stable')[:, :k]
    return cols, np.take_along_axis(S, cols, axis=1)


@pytest.mark.parametrize('metric', ['cosine', 'l2', 'ip'])
def test_node_knn_is_exact_in_blocks(metric):
    rng = np.random.default_rng(4)
    X = rng.normal(size=(37, 5)).astype(np.float32)
    offsets, cols, sims = drv._exact_knn(metric, X, 4, block=8)
    ref_cols, ref_sims = _reference_knn(metric, X, 4)
    assert offsets.tolist() == list(range(0, 37 * 4 + 1, 4))
    assert cols.reshape(37, 4).tolist() == ref_cols.tolist()
    assert np.allclose(sims.reshape(37, 4), ref_sims, atol=1e-5)


def test_node_knn_memory_stays_bounded():
    import tracemalloc

    X = np.random.default_rng(5).normal(size=(2000, 16)).astype(np.float32)
    tracemalloc.start()
    try:
        drv._exact_knn('cosine', X, 10)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # A full 2,000 x 2,000 float64 matrix alone is 32 MB; the blocked graph never holds one.
    assert peak < 24 * 2**20, peak


# --- removeCounted --------------------------------------------------------------------


def test_remove_counted_reports_the_rows_removed_and_spares_the_control_record():
    store = make_store(drv)
    _corpus(store, docs=3, chunks=4)
    store.markDeleted(['doc-2'])
    assert store.removeCounted(['doc-0', 'doc-2', 'schema', 'nope']) == 8
    assert store.countChunks(vx_filter(deleted='all')) == 4
    assert store.describe().control_record is True
    assert store.removeCounted(['doc-0']) == 0
