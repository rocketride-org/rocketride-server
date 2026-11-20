# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A partly trashed document on every driver: Active is "has a live chunk", Trash "has a trashed chunk".

A document becomes partly trashed when ``soft_delete`` runs while it is still being
ingested: the chunks stored so far go to the trash, and a later batch adds live ones.
Here ``part`` has chunks 0 and 1 in the trash and a live chunk 2, ``full`` has every
chunk in the trash and ``live`` none. The Active listing must hold ``live`` and
``part``, the Trash ``full`` and ``part``, and ``stats`` must count ``part`` among the
documents where it counts documents at all (contract section 4.5).

Stores that list by chunk 0 (caveat ``documents_by_first_chunk``: Astra, Milvus,
Pinecone, Weaviate and the base default) find ``part`` in a second phase of the Active
listing that reads the trash. The listing never answers an empty page with a cursor,
since a client takes an empty page for the end.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from ai.common.store import VectorStoreToolMixin, vx_write_gate
from ai.common.store import document_store as ds
from rocketlib import IInstanceBase

from . import test_vector_hooks as hooks
from . import vector_other_drivers_harness as h
from .store_chroma import _mock_driver as chroma_mock
from .store_qdrant import _mock_driver as qdrant_mock
from .test_vector_other_drivers import ADAPTERS
from .test_vector_write_gate import agent, dap

LIVE, FULL, PART = 'live-doc', 'full-doc', 'part-doc'

#: The fakes of test_vector_hooks, by name.
FAKES = {
    'memory': hooks.MemoryStore,
    'counting': hooks.CountingStore,
    'exact': hooks.ExactListingStore,
    'everyrow': hooks.EveryRowFlagStore,
    'deletedonly': hooks.DeletedOnlyFlagStore,
}

KINDS = sorted(FAKES) + ['chroma', 'qdrant'] + sorted(ADAPTERS)

#: Stores that list documents by chunk 0 (their listing answers documents_by_first_chunk).
FIRST_CHUNK_LISTINGS = {'memory', 'counting', 'everyrow', 'deletedonly', 'astra_db', 'milvus', 'pinecone', 'weaviate'}

_loaded: Dict[str, Any] = {}


class Node(VectorStoreToolMixin, IInstanceBase):
    pass


def _node(store, logical: str, model: str):
    inst = object.__new__(Node)
    inst.IGlobal = SimpleNamespace(
        store=store,
        glb=SimpleNamespace(logicalType=logical),
        serverName='vdb',
        allow_write=True,
        allow_writes=True,
        embed_query=lambda _text: [0.1, 0.2, 0.3, 0.4],
        embed_model_name=model,
    )
    inst.instance = SimpleNamespace(pipeType={'id': 'store_1'})
    return inst


def _fresh_collection() -> str:
    """A collection name of its own: the Qdrant and Chroma mocks keep their data between stores."""
    return f'vx_unit_{uuid.uuid4().hex[:12]}'


def _store(kind: str):
    """(store, chunk factory, model, logical type) for one kind of store."""
    if kind in FAKES:
        return FAKES[kind](), (lambda oid, ids: [hooks.make_doc(oid, i) for i in ids]), hooks.MODEL, 'postgres'
    if kind == 'qdrant':
        module = _loaded.setdefault('qdrant', qdrant_mock.load_driver())
        store = qdrant_mock.make_store(module, collection=_fresh_collection())
        return (
            store,
            (lambda oid, ids: [qdrant_mock.make_doc(oid, i, h.vector_for(oid, i, 4)) for i in ids]),
            'unit-model',
            'qdrant',
        )
    if kind == 'chroma':
        module = _loaded.setdefault('chroma', chroma_mock.load_driver())
        store = chroma_mock.make_store(module, collection=_fresh_collection())
        return (
            store,
            (lambda oid, ids: [chroma_mock.make_doc(oid, i, h.vector_for(oid, i, 4)) for i in ids]),
            'unit-model',
            'chroma',
        )
    adapter = _loaded.setdefault(kind, ADAPTERS[kind]())
    return adapter.new_store(), (lambda oid, ids: h.make_docs(oid, f'/docs/{oid}.md', ids)), h.MODEL, adapter.name


def _states(store, object_id: str) -> Dict[int, bool]:
    """Map each stored chunkId of ``object_id`` to whether it is in the trash (read as active, then deleted)."""
    out: Dict[int, bool] = {}
    for deleted in ('active', 'deleted'):
        for doc in store.get(ds.deletedFilter(deleted, objectIds=[object_id], limit=1000, offset=0)):
            if doc.metadata.objectId == object_id:
                out.setdefault(int(doc.metadata.chunkId), deleted == 'deleted')
    return out


@pytest.fixture
def context(monkeypatch):
    holder: Dict[str, Any] = {'ctx': agent()}
    monkeypatch.setattr(vx_write_gate, '_current_tool_call', lambda: holder['ctx'])
    return holder


def _setup(kind: str):
    """``live`` [0, 1]; ``full`` [0, 1] trashed; ``part`` [0, 1] trashed, then a later batch adds a live [2]."""
    store, docs, model, logical = _store(kind)
    store.addChunks(docs(LIVE, [0, 1]) + docs(FULL, [0, 1]) + docs(PART, [0, 1]))
    tools = _node(store, logical, model)
    moved = tools.soft_delete({'object_ids': [FULL, PART]})
    assert moved['success'], moved
    store.addChunks(docs(PART, [2]))
    assert _states(store, PART) == {0: True, 1: True, 2: False}, kind
    return store, tools


def _listing(tools, *, limit: Optional[int] = None, **args) -> List[Dict[str, Any]]:
    """Every row of a listing, following next_cursor; a page with a cursor is never empty."""
    rows: List[Dict[str, Any]] = []
    cursor = None
    for _ in range(50):
        call = dict(args, cursor=cursor)
        if limit is not None:
            call['limit'] = limit
        page = tools.list_documents(call)
        assert page['success'], page
        if page['next_cursor'] is not None:
            assert page['items'], ('an empty page with a cursor ends a client listing early', page)
        rows.extend(page['items'])
        cursor = page['next_cursor']
        if cursor is None:
            return rows
    raise AssertionError('the listing did not end')


@pytest.mark.parametrize('kind', KINDS)
def test_the_active_listing_holds_a_partly_trashed_document(context, kind):
    _store_, tools = _setup(kind)
    rows = _listing(tools, deleted='active')
    ids = [row['objectId'] for row in rows]
    assert sorted(ids) == [LIVE, PART], (kind, ids)
    part = next(row for row in rows if row['objectId'] == PART)
    assert part['deleted'] is False, (kind, part)
    assert part['chunks'] in (1, None), (kind, part)


@pytest.mark.parametrize('kind', KINDS)
def test_the_trash_holds_the_fully_and_the_partly_trashed_document(context, kind):
    _store_, tools = _setup(kind)
    trash = sorted(row['objectId'] for row in _listing(tools, deleted='deleted'))
    assert trash == [FULL, PART], (kind, trash)
    assert sorted(row['objectId'] for row in _listing(tools, deleted=True)) == trash


@pytest.mark.parametrize('kind', KINDS)
def test_stats_count_a_partly_trashed_document_as_a_document(context, kind):
    _store_, tools = _setup(kind)
    stats = tools.stats({'mode': 'full'})
    assert stats['success'], stats
    if stats['documents'] is None:
        assert 'no_filtered_count' in stats.get('caveats', []), (kind, stats)
    else:
        assert stats['documents'] == 2, (kind, stats['documents'], stats.get('caveats'))
    assert stats['deleted_documents'] in (2, None), (kind, stats['deleted_documents'])


@pytest.mark.parametrize('kind', ['memory', 'counting'])
def test_the_second_phase_pages_one_document_at_a_time(context, kind):
    store, tools = _setup(kind)
    docs = _store(kind)[1]
    # More fully trashed documents around the partly trashed one: the second phase reads past them.
    extra = [f'gone-{n}' for n in range(5)]
    store.addChunks([chunk for oid in extra for chunk in docs(oid, [0, 1])])
    assert tools.soft_delete({'object_ids': extra})['success']
    rows = _listing(tools, deleted='active', limit=1)
    assert sorted(row['objectId'] for row in rows) == [LIVE, PART]


def test_a_store_that_lists_by_chunk_0_says_so(context):
    _store_, tools = _setup('memory')
    page = tools.list_documents({'deleted': 'active'})
    assert 'documents_by_first_chunk' in page['caveats'], page


def test_an_empty_trash_ends_the_active_listing_in_one_page(context):
    store, docs, model, logical = _store('counting')
    store.addChunks(docs(LIVE, [0, 1]))
    tools = _node(store, logical, model)
    page = tools.list_documents({'deleted': 'active'})
    assert [row['objectId'] for row in page['items']] == [LIVE]
    assert page['next_cursor'] is None, page


def test_one_page_holds_the_partly_trashed_document_when_it_fits(context):
    _store_, tools = _setup('counting')
    page = tools.list_documents({'deleted': 'active'})
    assert sorted(row['objectId'] for row in page['items']) == [LIVE, PART]
    assert page['next_cursor'] is None, page


def test_a_cursor_of_the_second_phase_is_refused_by_another_listing(context):
    _store_, tools = _setup('counting')
    page = tools.list_documents({'deleted': 'active', 'limit': 1})
    assert [row['objectId'] for row in page['items']] == [LIVE]
    assert page['next_cursor'] is not None, 'a full last page hands the trash on to the next call'
    for deleted in ('deleted', 'all'):
        refused = tools.list_documents({'deleted': deleted, 'cursor': page['next_cursor']})
        assert (refused['success'], refused.get('code')) == (False, 'INVALID_INPUT'), (deleted, refused)
    following = tools.list_documents({'deleted': 'active', 'limit': 1, 'cursor': page['next_cursor']})
    assert [row['objectId'] for row in following['items']] == [PART]
    assert following['total'] is None, following


def _spy_trash_reads(store) -> List[int]:
    """Record the documents each read of the store's Trash listing returns."""
    reads: List[int] = []
    listing = store.listDocumentPage

    def spy(**kw):
        page = listing(**kw)
        if kw['deleted'] == 'deleted':
            reads.append(len(page.items))
        return page

    store.listDocumentPage = spy
    return reads


def test_the_end_of_an_active_listing_reads_a_bounded_part_of_a_big_trash(context):
    store, docs, model, logical = _store('counting')
    gone = [f'gone-{n:04d}' for n in range(3000)]
    store.addChunks(docs(LIVE, [0, 1]) + [chunk for oid in gone for chunk in docs(oid, [0, 1])])
    store.markDeleted(gone)
    tools = _node(store, logical, model)
    reads = _spy_trash_reads(store)
    pages = []
    cursor = None
    for _ in range(20):
        page = tools.list_documents({'deleted': 'active', 'limit': 200, 'cursor': cursor})
        assert page['success'] and (page['items'] or page['next_cursor'] is None), page
        pages.append(page)
        cursor = page['next_cursor']
        if cursor is None:
            break
    assert [row['objectId'] for page in pages for row in page['items']] == [LIVE]
    assert sum(reads) <= 1000 and len(reads) <= 6, ('the listing reads at most 1,000 trashed documents', reads)
    assert 'trash_scan_cut' in pages[-1]['caveats'], pages[-1]
    assert all('trash_scan_cut' not in page['caveats'] for page in pages[:-1])


def test_a_trash_read_to_its_end_does_not_say_it_was_cut(context):
    _store_, tools = _setup('counting')
    rows = _listing(tools, deleted='active', limit=1)
    assert sorted(row['objectId'] for row in rows) == [LIVE, PART]
    for limit in (1, 200):
        cursor = None
        while True:
            page = tools.list_documents({'deleted': 'active', 'limit': limit, 'cursor': cursor})
            assert 'trash_scan_cut' not in page['caveats'], page
            cursor = page['next_cursor']
            if cursor is None:
                break


def test_the_bound_stops_a_trash_read_and_the_listing_says_so(context, monkeypatch):
    from ai.common.store import vx_tools

    _store_, tools = _setup('memory')
    monkeypatch.setattr(vx_tools, '_TRASH_READ_PAGES', 1)
    monkeypatch.setattr(vx_tools, '_TRASH_READ_MAX', 1)
    pages = []
    cursor = None
    while True:
        page = tools.list_documents({'deleted': 'active', 'limit': 1, 'cursor': cursor})
        assert page['items'] or page['next_cursor'] is None, page
        pages.append(page)
        cursor = page['next_cursor']
        if cursor is None:
            break
    assert [row['objectId'] for page in pages for row in page['items']] == [LIVE], 'the read stopped before PART'
    assert 'trash_scan_cut' in pages[-1]['caveats'], pages[-1]


def test_stats_leave_out_a_trash_read_that_was_cut(context, monkeypatch):
    _store_, tools = _setup('chroma')

    def cut(self, store, cursor, **_kw):
        return SimpleNamespace(caveats=[], items=[]), [], None, 1000, True

    monkeypatch.setattr(Node, '_vx_live_in_trash', cut)
    stats = tools.stats({'mode': 'full'})
    assert (stats['documents'], stats.get('caveats')) == (1, ['documents_by_first_chunk']), stats


@pytest.mark.parametrize('kind', sorted(FIRST_CHUNK_LISTINGS))
def test_a_store_that_lists_by_chunk_0_answers_no_total_while_the_trash_may_hold_documents(context, kind):
    _store_, tools = _setup(kind)
    first = tools.list_documents({'deleted': 'active', 'limit': 1})
    assert first['success'] and first['total'] is None, (kind, first['total'])


@pytest.mark.parametrize('kind', ['astra_db', 'milvus', 'weaviate'])
def test_a_store_that_lists_by_chunk_0_keeps_its_total_with_an_empty_trash(context, kind):
    store, docs, model, logical = _store(kind)
    store.addChunks(docs(LIVE, [0, 1]) + docs(FULL, [0, 1]))
    tools = _node(store, logical, model)
    page = tools.list_documents({'deleted': 'active'})
    assert page['success'] and page['total'] == 2, (kind, page['total'])
    assert 'trash_scan_cut' not in page['caveats']


def test_a_dap_caller_reads_the_same_listing(context):
    context['ctx'] = dap()
    _store_, tools = _setup('weaviate')
    assert sorted(row['objectId'] for row in _listing(tools, deleted='active')) == [LIVE, PART]
