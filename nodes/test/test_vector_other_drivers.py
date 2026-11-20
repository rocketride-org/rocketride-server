# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Explorer-hook contract of the experimental vector stores, against mocked clients.

One suite, parameterised by driver (Milvus, Weaviate, Pinecone, Astra DB,
MongoDB Atlas): every driver must answer the optional ``DocumentStoreBase``
hooks the Vector Explorer tools call (docs/development/nodes/vector-tool-contract.md
sections 2 and 3) on a new collection, on a legacy collection written the way
today's drivers write it, and on a backend that ignores paging offsets.

The clients are mocks (see ``vector_other_drivers_harness``). Passing here is not
evidence that a driver works against a live server: these drivers stay
``support='experimental'`` whatever this suite says.
"""

import base64
import dataclasses
import json
import math

import pytest

from ai.common.schema import Doc, DocFilter, Question, QuestionText
from ai.common.store.errors import StoreError, StoreUnsupported, ToolRefusal
from ai.common.store.vx_types import ChunkPage, DocPage, StoreInfo

from . import vector_other_drivers_harness as h

ADAPTERS = {
    'milvus': h.MilvusAdapter,
    'weaviate': h.WeaviateAdapter,
    'pinecone': h.PineconeAdapter,
    'astra_db': h.AstraAdapter,
    'atlas': h.AtlasAdapter,
}


@pytest.fixture(scope='module', params=sorted(ADAPTERS))
def adapter(request):
    """One adapter (driver module + mock client) per driver."""
    return ADAPTERS[request.param]()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty mocked backend."""
    return adapter.new_store()


def _object_ids(rows):
    return [row.objectId for row in rows]


def _chunk_ids(rows, object_id):
    return sorted(row['chunkId'] for row in rows if row['objectId'] == object_id)


def _question(text='question'):
    return QuestionText(text=text, embedding=h.vector_for('question', 0), embedding_model=h.MODEL)


# -----------------------------------------------------------------------------
# Support level and capabilities
# -----------------------------------------------------------------------------


def test_support_stays_experimental(adapter):
    """Mocked evidence never promotes a driver: the support level is fixed in code."""
    assert adapter.module.Store.VX_SUPPORT == 'experimental'


def test_capabilities_name_the_native_hooks(adapter, store):
    """The driver overrides the hooks it answers natively and leaves knnGraph to the node."""
    caps = store.capabilities()
    for hook in ('describe', 'scoreInfo', 'listDocumentPage', 'scrollChunks', 'getVectors', 'sampleChunks'):
        assert hook in caps, hook
    assert 'knn_native' not in caps
    assert ('sample_stratified_native' in caps) == adapter.stratified_native


# -----------------------------------------------------------------------------
# describe / scoreInfo
# -----------------------------------------------------------------------------


def test_describe_a_missing_collection_does_not_raise(adapter, store):
    """No collection: an answer with collection_exists False and no control record."""
    info = store.describe()
    assert isinstance(info, StoreInfo)
    assert info.backend == adapter.backend
    assert info.collection_exists is False
    assert info.control_record is None
    assert info.meta_column is None
    assert 'experimental' in info.caveats


def test_describe_reads_the_control_record(adapter, store):
    """Model and dimension come from the control record; no host or credential is reported."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    info = store.describe()
    assert info.collection_exists is True
    assert info.control_record is True
    assert info.model == h.MODEL
    assert info.dimension == h.DIM
    assert info.metric == 'cosine'
    text = json.dumps(dataclasses.asdict(info), default=str).lower()
    for secret in ('localhost', 'apikey', 'token', 'mongodb', 'https://', 'example.invalid'):
        assert secret not in text, secret


def test_describe_reads_a_legacy_collection(adapter, store):
    """A collection written by today's driver still describes itself."""
    adapter.seed_legacy(store)
    info = store.describe()
    assert info.collection_exists is True
    assert info.control_record is True
    assert info.dimension == h.DIM
    # Astra and Atlas used to drop the control record's extras: the model is unknown there
    assert info.model == (h.MODEL if adapter.legacy_control_has_model else None)


def test_score_info_reports_floor_and_threshold(adapter, store):
    """The score info carries the legacy floor; minScore=-inf lifts it."""
    info = store.scoreInfo()
    assert {'formula', 'higher_is_better', 'floor', 'threshold'} <= set(info)
    assert info['formula'] != 'unknown'  # the driver describes its own score, not the base default
    assert info['floor'] == pytest.approx(adapter.floor)
    assert store.effectiveFloor(DocFilter()) == pytest.approx(adapter.floor)
    assert store.effectiveFloor(h.VxFilter(minScore=float('-inf'))) == float('-inf')


# -----------------------------------------------------------------------------
# Writes: re-ingest in several batches
# -----------------------------------------------------------------------------


def test_later_batches_of_a_document_keep_the_earlier_ones(adapter, store):
    """The embedding nodes send one document in several batches; only the chunk-0 batch replaces."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-a', '/docs/a.md', [2, 3])
    assert _chunk_ids(adapter.raw_rows(store), 'doc-a') == [0, 1, 2, 3]


def test_a_new_chunk0_batch_replaces_the_document(adapter, store):
    """Re-ingesting from chunk 0 drops the chunks of the previous version."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    assert _chunk_ids(adapter.raw_rows(store), 'doc-a') == [0, 1]


def test_a_later_batch_sent_twice_keeps_one_row_per_chunk(adapter, store):
    """A retried later batch replaces its own chunks instead of storing them twice."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-a', '/docs/a.md', [2, 3])
    h.ingest(store, 'doc-a', '/docs/a.md', [2, 3])
    assert _chunk_ids(adapter.raw_rows(store), 'doc-a') == [0, 1, 2, 3]
    if adapter.counts:
        assert store.countChunks(DocFilter(objectIds=['doc-a'])) == 4
    listed, _ = h.collect_listing(store, limit=10)
    assert [row.chunks for row in listed] == [4 if adapter.listing_counts else None]


def test_scroll_chunks_shows_a_chunk_stored_twice_once(adapter, store):
    """Rows an earlier retried write stored twice: each chunk appears once and no page exceeds its limit."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2, 3, 4])
    adapter.duplicate_rows(store, 'doc-a')
    seen, after = [], -1
    for _ in range(10):
        page = store.scrollChunks('doc-a', after_chunk=after, limit=2, deleted='active')
        assert len(page.docs) <= 2, [doc.metadata.chunkId for doc in page.docs]
        seen.extend(doc.metadata.chunkId for doc in page.docs)
        after = page.next_after
        if not page.has_more:
            break
    assert seen == [0, 1, 2, 3, 4]


# -----------------------------------------------------------------------------
# Counts
# -----------------------------------------------------------------------------


def test_count_chunks_honours_the_deleted_modes(adapter, store):
    """Counts honour active / deleted / all and the legacy isDeleted flag, never the control record."""
    if not adapter.counts:
        assert store.countChunks(DocFilter()) is None
        return
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1])
    store.markDeleted(['doc-b'])
    assert store.countChunks(h.VxFilter(deleted='active')) == 3
    assert store.countChunks(h.VxFilter(deleted='deleted')) == 2
    assert store.countChunks(h.VxFilter(deleted='all')) == 5
    assert store.countChunks(DocFilter()) == 3
    assert store.countChunks(DocFilter(isDeleted=True)) == 5
    assert store.countChunks(DocFilter(chunkIds=[0])) == 1
    assert store.countChunks(h.VxFilter(objectIds=['doc-b'], deleted='all')) == 2


def test_count_chunks_on_a_missing_collection_is_zero(adapter, store):
    """Nothing stored yet: zero where the driver counts, None where the backend cannot."""
    assert store.countChunks(DocFilter()) == (0 if adapter.counts else None)


# -----------------------------------------------------------------------------
# listDocumentPage
# -----------------------------------------------------------------------------


def _ingest_five(store):
    for i in range(5):
        h.ingest(store, f'doc-{i}', f'/docs/{chr(ord("e") - i)}.md', list(range(i + 1)))


def test_listing_pages_cover_every_document_once(adapter, store):
    """Following next_cursor lists each document once, never the control record."""
    _ingest_five(store)
    rows, pages = h.collect_listing(store, limit=2)
    assert sorted(_object_ids(rows)) == [f'doc-{i}' for i in range(5)]
    assert all(len(page.items) <= 2 for page in pages)
    assert pages[-1].next_cursor is None
    for page in pages:
        assert isinstance(page, DocPage)
        assert page.sorted is adapter.listing_sorted
        if not adapter.listing_sorted:
            assert 'documents_unsorted' in page.caveats
    by_id = {row.objectId: row for row in rows}
    for i in range(5):
        row = by_id[f'doc-{i}']
        assert row.path == f'/docs/{chr(ord("e") - i)}.md'
        assert row.has_first_chunk is True
        assert row.deleted is False
        assert row.nodeId == 'chunk_1'
        assert isinstance(row.pointId, str) and row.pointId
        assert row.chunks == ((i + 1) if adapter.listing_counts else None)
        if adapter.extras_stored:
            assert row.size == 1000
            assert row.ingestedAt == '2026-10-08T18:20:11Z'
        else:
            assert row.size is None and row.ingestedAt is None
    if adapter.listing_sorted:
        paths = [row.path for row in rows]
        assert paths == sorted(paths)


def test_listing_costs_the_same_backend_calls_whatever_the_page_size(adapter, store):
    """A page of 12 documents costs no more backend calls than a page of 3 (no count per document)."""
    for i in range(12):
        h.ingest(store, f'doc-{i:02d}', f'/docs/{i:02d}.md', [0, 1, 2])
    store.listDocumentPage(cursor=None, limit=1, object_ids=None, deleted='active', sort='path')  # fills driver caches
    counter = adapter.count_calls(store)
    small = store.listDocumentPage(cursor=None, limit=3, object_ids=None, deleted='active', sort='path')
    small_calls, counter['calls'] = counter['calls'], 0
    large = store.listDocumentPage(cursor=None, limit=12, object_ids=None, deleted='active', sort='path')
    assert len(small.items) == 3 and len(large.items) == 12
    assert counter['calls'] == small_calls, (small_calls, counter['calls'])
    assert small_calls <= 5, small_calls


def test_listing_filters_by_object_ids(adapter, store):
    """object_ids restricts the listing."""
    _ingest_five(store)
    rows, _ = h.collect_listing(store, limit=10, object_ids=['doc-1', 'doc-3'])
    assert sorted(_object_ids(rows)) == ['doc-1', 'doc-3']


def test_listing_honours_the_deleted_modes(adapter, store):
    """Soft-deleted documents appear only under 'deleted' and 'all'."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    store.markDeleted(['doc-b'])
    active, _ = h.collect_listing(store, limit=10, deleted='active')
    deleted, _ = h.collect_listing(store, limit=10, deleted='deleted')
    every, _ = h.collect_listing(store, limit=10, deleted='all')
    assert _object_ids(active) == ['doc-a']
    assert _object_ids(deleted) == ['doc-b']
    assert deleted[0].deleted is True
    assert sorted(_object_ids(every)) == ['doc-a', 'doc-b']


#: Every hook read that takes a deleted mode, asked for one outside active / deleted / all
UNKNOWN_DELETED_MODE = {
    'listDocumentPage': lambda store: store.listDocumentPage(
        cursor=None, limit=5, object_ids=None, deleted='bogus', sort='path'
    ),
    'scrollChunks': lambda store: store.scrollChunks('doc-a', after_chunk=-1, limit=5, deleted='bogus'),
    'sampleChunks': lambda store: store.sampleChunks(
        n=3, seed=1, strategy='random', docFilter=h.VxFilter(deleted='bogus'), include_keys=[]
    ),
    'countChunks': lambda store: store.countChunks(h.VxFilter(deleted='bogus')),
    'countDocumentsWhere': lambda store: store.countDocumentsWhere(h.VxFilter(deleted='bogus')),
}


@pytest.mark.parametrize('call', sorted(UNKNOWN_DELETED_MODE))
def test_an_unknown_deleted_mode_is_invalid_input(adapter, store, call):
    """Listings, chunk pages, samples and counts refuse an unknown mode alike (none reads it as 'all')."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    store.markDeleted(['doc-b'])
    if ANSWERS_WITHOUT_BACKEND.get((adapter.name, call)) == 'inherits':
        assert UNKNOWN_DELETED_MODE[call](store) is None  # the base default reads nothing
        return
    with pytest.raises(ToolRefusal) as refused:
        UNKNOWN_DELETED_MODE[call](store)
    assert refused.value.code == 'INVALID_INPUT'


def test_listing_a_legacy_collection(adapter, store):
    """Legacy rows list without the new extras; a document without chunk 0 is flagged or noted."""
    adapter.seed_legacy(store)
    rows, pages = h.collect_listing(store, limit=10)
    by_id = {row.objectId: row for row in rows}
    assert {'legacy-a', 'legacy-b'} <= set(by_id)
    assert 'schema' not in by_id
    assert by_id['legacy-a'].size is None
    assert by_id['legacy-a'].ingestedAt is None
    if adapter.listing_counts:
        assert by_id['legacy-a'].chunks == 3
        assert by_id['legacy-b'].chunks == 2
    if 'legacy-orphan' in by_id:
        assert by_id['legacy-orphan'].has_first_chunk is False
    else:
        assert 'documents_by_first_chunk' in pages[0].caveats


def test_listing_on_a_backend_that_ignores_offsets_ends_with_a_caveat(adapter, store):
    """A repeated page ends the listing instead of looping (documents_paging_unsupported)."""
    _ingest_five(store)
    adapter.ignore_offsets(store)
    first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    assert len(first.items) == 2
    assert first.next_cursor is not None
    second = store.listDocumentPage(cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path')
    assert second.items == []
    assert second.next_cursor is None
    assert 'documents_paging_unsupported' in second.caveats


def test_listing_refuses_a_cursor_it_did_not_issue(adapter, store):
    """A malformed cursor is INVALID_INPUT, not a crash."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    with pytest.raises(ToolRefusal) as excinfo:
        store.listDocumentPage(cursor='%%not-a-cursor%%', limit=2, object_ids=None, deleted='active', sort='path')
    assert excinfo.value.code == 'INVALID_INPUT'


def _cursor(data):
    """A listing cursor in the drivers' encoding (url-safe base64 JSON) holding ``data``."""
    raw = json.dumps(data, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


#: A cursor of each driver's shape whose position field (offset, skip or page token) holds ``value``
CURSOR_SHAPES = {
    'milvus': lambda value: {'o': value, 'f': None},
    'weaviate': lambda value: {'o': value, 'f': None},
    'atlas': lambda value: {'o': value, 'f': None},
    'astra_db': lambda value: {'s': None, 'k': value, 'f': None},
    'pinecone': lambda value: {'t': value, 'f': None},
}


@pytest.mark.parametrize(
    'value', [1.5, True, -1, 10**30, '7'], ids=['float', 'bool', 'negative', 'beyond-reach', 'string']
)
def test_listing_refuses_a_forged_position(adapter, store, value):
    """A cursor carrying a position the driver never issues (not an integer, or out of reach) is INVALID_INPUT."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    if adapter.name == 'pinecone' and isinstance(value, str):
        value = 7  # Pinecone's position is the backend's token: a string is its own shape
    with pytest.raises(ToolRefusal) as excinfo:
        store.listDocumentPage(
            cursor=_cursor(CURSOR_SHAPES[adapter.name](value)), limit=2, object_ids=None, deleted='active', sort='path'
        )
    assert excinfo.value.code == 'INVALID_INPUT'


#: A forged backend page token is only caught by the backend: (cursor, the client error it answers)
BACKEND_TOKENS = {
    'pinecone': ({'t': 'garbage-token', 'f': None}, 'PineconeApiException (code 400)'),
    'astra_db': ({'s': 'garbage-state', 'k': 0, 'f': None}, 'DataAPIResponseException'),
}


def test_listing_with_a_page_token_the_backend_rejects(adapter, store):
    """A forged backend token fails as a host-free backend error naming the client's rejection."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    if adapter.name not in BACKEND_TOKENS:
        # Offset cursors: the driver itself refuses a position it never issues
        with pytest.raises(ToolRefusal):
            store.listDocumentPage(
                cursor=_cursor(CURSOR_SHAPES[adapter.name]('garbage')),
                limit=2,
                object_ids=None,
                deleted='active',
                sort='path',
            )
        return
    cursor, rejection = BACKEND_TOKENS[adapter.name]
    with pytest.raises(StoreError) as excinfo:
        store.listDocumentPage(cursor=_cursor(cursor), limit=2, object_ids=None, deleted='active', sort='path')
    assert rejection in str(excinfo.value)


def test_listing_an_empty_id_list_is_empty(adapter, store):
    """object_ids=[] asks for no document: an empty last page, not the whole collection."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    page = store.listDocumentPage(cursor=None, limit=5, object_ids=[], deleted='active', sort='path')
    assert page.items == []
    assert page.next_cursor is None


def test_listing_a_missing_collection_is_empty(adapter, store):
    """No collection: an empty last page."""
    page = store.listDocumentPage(cursor=None, limit=5, object_ids=None, deleted='active', sort='path')
    assert page.items == []
    assert page.next_cursor is None


# -----------------------------------------------------------------------------
# scrollChunks
# -----------------------------------------------------------------------------


def test_scroll_chunks_pages_in_chunk_order_without_vectors(adapter, store):
    """Chunks come back in order, paged, and never carry embeddings."""
    h.ingest(store, 'doc-a', '/docs/a.md', list(range(7)))
    docs, pages = h.collect_chunks(store, 'doc-a', limit=3)
    assert [doc.metadata.chunkId for doc in docs] == list(range(7))
    assert all(isinstance(page, ChunkPage) and len(page.docs) <= 3 for page in pages)
    assert pages[-1].has_more is False
    assert all(not doc.embedding for doc in docs)
    assert all('chunk' in doc.page_content for doc in docs)


def test_scroll_chunks_walks_over_gaps_in_chunk_ids(adapter, store):
    """Non-contiguous chunk ids are all reached."""
    h.ingest(store, 'doc-a', '/docs/a.md', [3, 7, 64])
    docs, _ = h.collect_chunks(store, 'doc-a', limit=3)
    assert [doc.metadata.chunkId for doc in docs] == [3, 7, 64]


def test_scroll_chunks_jumps_gaps_without_empty_pages(adapter, store):
    """
    A gap in chunk ids costs no empty pages: each page before the last carries chunks. The chunks
    are stored out of chunk order, so a jump to "whichever row lies beyond the window" would skip some.
    """
    for chunk_id in (64, 7, 3):
        h.ingest(store, 'doc-a', '/docs/a.md', [chunk_id])
    h.ingest(store, 'doc-b', '/docs/b.md', [5000])
    docs, pages = h.collect_chunks(store, 'doc-a', limit=3)
    assert [doc.metadata.chunkId for doc in docs] == [3, 7, 64]
    assert all(page.docs for page in pages), [len(page.docs) for page in pages]
    docs, pages = h.collect_chunks(store, 'doc-b', limit=3)
    assert [doc.metadata.chunkId for doc in docs] == [5000]
    assert len(pages) == 1


def test_scroll_chunks_never_returns_the_control_record(adapter, store):
    """The control record (objectId 'schema') is not a document."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    page = store.scrollChunks('schema', after_chunk=-1, limit=10, deleted='all')
    assert page.docs == []
    assert page.has_more is False


def test_scroll_chunks_of_a_deleted_document(adapter, store):
    """A soft-deleted document scrolls under 'deleted'/'all' only."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    store.markDeleted(['doc-a'])
    assert store.scrollChunks('doc-a', after_chunk=-1, limit=10, deleted='active').docs == []
    assert len(store.scrollChunks('doc-a', after_chunk=-1, limit=10, deleted='all').docs) == 2


# -----------------------------------------------------------------------------
# getVectors / sampleChunks
# -----------------------------------------------------------------------------


def test_get_vectors_pairs_the_requested_keys(adapter, store):
    """Vectors by (objectId, chunkId), in request order; unknown keys and the control record omitted."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1])
    docs = store.getVectors([('doc-a', 2), ('doc-b', 0), ('doc-a', 9), ('schema', 0)])
    assert [(doc.metadata.objectId, doc.metadata.chunkId) for doc in docs] == [('doc-a', 2), ('doc-b', 0)]
    for doc in docs:
        expected = h.vector_for(doc.metadata.objectId, doc.metadata.chunkId)
        assert doc.embedding == pytest.approx(expected, rel=1e-5)
        assert isinstance(doc.metadata.pointId, str) and doc.metadata.pointId


def test_get_vectors_on_a_legacy_collection(adapter, store):
    """Legacy rows have random ids: the filter path still finds them."""
    adapter.seed_legacy(store)
    docs = store.getVectors([('legacy-a', 1), ('legacy-orphan', 2)])
    assert sorted((doc.metadata.objectId, doc.metadata.chunkId) for doc in docs) == [
        ('legacy-a', 1),
        ('legacy-orphan', 2),
    ]
    assert all(len(doc.embedding) == h.DIM for doc in docs)


@pytest.mark.parametrize('scrambled', [False, True], ids=['keyed', 'random-ids'])
def test_get_vectors_batches_large_requests(adapter, store, scrambled, monkeypatch):
    """Many keys over many documents are read in bounded batches and all come back, in order."""
    for i in range(12):
        h.ingest(store, f'doc-{i:02d}', f'/docs/{i:02d}.md', list(range(5)))
    if scrambled:
        adapter.scramble_ids(store)
    monkeypatch.setattr(adapter.module, 'VECTOR_BATCH_ROWS', 10)
    if hasattr(adapter.module, 'FETCH_BATCH_IDS'):
        monkeypatch.setattr(adapter.module, 'FETCH_BATCH_IDS', 7)
    keys = [(f'doc-{i:02d}', c) for i in reversed(range(12)) for c in (4, 0, 2)]
    docs = store.getVectors(keys)
    assert [(doc.metadata.objectId, doc.metadata.chunkId) for doc in docs] == keys
    assert all(len(doc.embedding) == h.DIM for doc in docs)


def test_sample_chunks_returns_vectors_and_the_strategy_used(adapter, store):
    """A sample carries embeddings, skips the control record and deleted rows."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1])
    h.ingest(store, 'doc-c', '/docs/c.md', [0])
    store.markDeleted(['doc-c'])
    docs, used = store.sampleChunks(
        n=4, seed=7, strategy='random', docFilter=h.VxFilter(deleted='active'), include_keys=[]
    )
    assert used == adapter.random_strategy
    assert len(docs) == 4  # min(n, active rows): five active chunks, four asked for
    assert len({(doc.metadata.objectId, doc.metadata.chunkId) for doc in docs}) == 4
    for doc in docs:
        assert doc.metadata.objectId in ('doc-a', 'doc-b')
        assert len(doc.embedding) == h.DIM
        assert isinstance(doc.metadata.pointId, str)


def test_sample_chunks_stratified(adapter, store):
    """Stratified sampling is native only where cheap; otherwise the shared sampler falls back."""
    for i in range(4):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', list(range(6)))
    if not adapter.stratified_native:
        with pytest.raises(StoreUnsupported):
            store.sampleChunks(
                n=8, seed=1, strategy='stratified', docFilter=h.VxFilter(deleted='active'), include_keys=[]
            )
        return
    docs, used = store.sampleChunks(
        n=8, seed=1, strategy='stratified', docFilter=h.VxFilter(deleted='active'), include_keys=[]
    )
    assert used == 'stratified'
    assert len(docs) == 8
    assert {doc.metadata.objectId for doc in docs} == {f'doc-{i}' for i in range(4)}
    assert all(len(doc.embedding) == h.DIM for doc in docs)


# -----------------------------------------------------------------------------
# removeCounted
# -----------------------------------------------------------------------------


def test_remove_counted_reports_the_rows_removed(adapter, store):
    """Removing a document reports its chunk rows and leaves the rest (and the control record).

    A driver that cannot count chunks gets the base removeCounted, which still removes
    the rows and answers None (the tools then report removed_chunks as null).
    """
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1])
    removed = store.removeCounted(['doc-a', 'no-such-doc'])
    if adapter.remove_counts:
        assert removed == 3
    else:
        assert removed is None
    rows = adapter.raw_rows(store)
    assert _chunk_ids(rows, 'doc-a') == []
    assert _chunk_ids(rows, 'doc-b') == [0, 1]
    assert store.describe().control_record is True


def test_mark_deleted_and_active_return_the_chunks_they_moved(adapter, store):
    """The trash writes answer the chunks they moved into or out of the trash (soft_delete's matched_chunks)."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1])
    assert store.markDeleted(['doc-a', 'ghost']) == 3
    assert store.markDeleted(['doc-a']) == 0, 'already in the trash: nothing moves'
    assert store.markActive(['doc-a', 'doc-b']) == 3, 'doc-b was never in the trash'
    assert store.markActive(['doc-a']) == 0
    assert store.markDeleted([]) == 0 and store.markActive([]) == 0
    assert sorted(doc.metadata.objectId for doc in store.get(DocFilter(chunkIds=[0], isDeleted=False))) == [
        'doc-a',
        'doc-b',
    ]


# -----------------------------------------------------------------------------
# Search and paths
# -----------------------------------------------------------------------------


def test_semantic_search_cuts_at_the_floor_or_the_drivers_threshold(adapter, store):
    """Rows under the cut are dropped unless minScore is -inf.

    The cut is the floor, so rows under the node threshold survive (the questions lane
    applies it), except on Milvus, whose driver cut at the threshold on develop and still does.
    """
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    adapter.set_scores(store, [0.9, 0.35, 0.1])
    kept = [doc.score for doc in store.searchSemantic(_question(), DocFilter(limit=10))]
    cut = store.threshold_search if adapter.threshold_in_driver else adapter.floor
    expected = [s for s in (0.9, 0.35, 0.1) if s >= cut]
    assert kept == pytest.approx(expected, abs=1e-6)
    adapter.set_scores(store, [0.9, 0.35, 0.1])
    every = [doc.score for doc in store.searchSemantic(_question(), h.VxFilter(limit=10, minScore=-math.inf))]
    assert every == pytest.approx([0.9, 0.35, 0.1], abs=1e-6)


def test_semantic_search_refuses_offsets_with_valueerror(adapter, store):
    """A non-zero offset is a ValueError (it used to be a bare BaseException)."""
    if not adapter.offset_raises:
        pytest.skip('NOT RUN: this driver ignores offsets in semantic search')
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    with pytest.raises(ValueError):
        store.searchSemantic(_question(), DocFilter(offset=5))


def test_get_paths_skips_the_control_record_and_deleted_documents(adapter, store):
    """The objdir paths list live documents only."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    h.ingest(store, 'doc-c', '/docs/c.md', [0])
    store.markDeleted(['doc-c'])
    assert store.getPaths() == {'/docs/a.md': 'doc-a', '/docs/b.md': 'doc-b'}


def test_services_json_cases_replay_on_the_mock(adapter, store):
    """The node's own services.json cases (data lane) still pass through the repaired driver."""
    if not adapter.services:
        pytest.skip('NOT RUN: this node has no services.json test cases')
    cases = h.services_cases(adapter.services)
    assert cases, 'expected test cases in services.json'
    for case in cases:
        if 'documents' in case:
            docs = [Doc.model_validate(doc) for doc in case['documents']]
            store.addChunks(docs)
            failures = h.find_case_expectation_failures(docs, case['expect']['documents'])
        else:
            question = Question.model_validate(case['questions'])
            # Rank by score as dispatchSearch does, but break ties against storage order, so a case
            # that only passes because equal scores keep the mock's insertion order fails here
            found = sorted(reversed(list(store._queryDocuments(question).values())), key=lambda doc: -doc.score)
            failures = h.find_case_expectation_failures(found, case['expect']['documents'])
        assert failures == [], f'{case.get("name")}: {failures}'


# -----------------------------------------------------------------------------
# Backend failures never carry the server address
# -----------------------------------------------------------------------------


#: Every store call a tool or the data lane can reach: the explorer hooks, the methods behind the
#: legacy tools (``upsert`` writes through addChunks) and the data lane's writes, marks and render.
TOOL_CALLS = {
    'describe': lambda store: store.describe(),
    'countChunks': lambda store: store.countChunks(DocFilter()),
    'countDocumentsWhere': lambda store: store.countDocumentsWhere(DocFilter()),
    'listDocumentPage': lambda store: store.listDocumentPage(
        cursor=None, limit=5, object_ids=None, deleted='active', sort='path'
    ),
    'scrollChunks': lambda store: store.scrollChunks('doc-a', after_chunk=-1, limit=5, deleted='active'),
    'sampleChunks': lambda store: store.sampleChunks(
        n=3, seed=1, strategy='random', docFilter=h.VxFilter(deleted='active'), include_keys=[]
    ),
    'getVectors': lambda store: store.getVectors([('doc-a', 0)]),
    'removeCounted': lambda store: store.removeCounted(['doc-a']),
    'searchSemantic': lambda store: store.searchSemantic(_question(), DocFilter(limit=5)),
    'searchKeyword': lambda store: store.searchKeyword(_question('chunk'), DocFilter(limit=5)),
    'count_documents': lambda store: store.count_documents(),
    'get': lambda store: store.get(DocFilter(objectIds=['doc-a'])),
    'getPaths': lambda store: store.getPaths(),
    'remove': lambda store: store.remove(['doc-a']),
    'addChunks-new-document': lambda store: store.addChunks(h.make_docs('doc-b', '/docs/b.md', [0, 1])),
    'addChunks-later-batch': lambda store: store.addChunks(h.make_docs('doc-a', '/docs/a.md', [2])),
    'createCollection': lambda store: store.createCollection(h.make_docs('doc-b', '/docs/b.md', [0])),
    'doesCollectionExist': lambda store: store.doesCollectionExist(),
    'markDeleted': lambda store: store.markDeleted(['doc-a']),
    'markActive': lambda store: store.markActive(['doc-a']),
    'render': lambda store: store.render('doc-a', lambda text: None),
}

#: The (driver, call) pairs that answer without reaching the backend, and how. Every other pair
#: must fail with the injected client error in its chain, so a hook that starts refusing (or
#: answering) before it reaches the backend fails here instead of passing unchecked.
ANSWERS_WITHOUT_BACKEND = {
    ('pinecone', 'searchKeyword'): 'refuses',  # no keyword search on Pinecone: StoreUnsupported
    ('milvus', 'countDocumentsWhere'): 'inherits',  # base default None: no distinct count
    ('astra_db', 'countDocumentsWhere'): 'inherits',
    ('pinecone', 'countChunks'): 'inherits',  # Pinecone cannot count
    ('pinecone', 'countDocumentsWhere'): 'inherits',
    ('pinecone', 'removeCounted'): 'inherits',
    ('astra_db', 'doesCollectionExist'): 'reads_missing',  # Astra reads a failed check as a missing collection
}


def _method(call):
    """The store method a TOOL_CALLS entry calls ('addChunks' for 'addChunks-later-batch')."""
    return call.split('-', 1)[0]


def _chain(error):
    """``error`` and every exception it was raised from or during."""
    links = []
    while error is not None and not any(error is link for link in links):
        links.append(error)
        error = error.__cause__ or error.__context__
    return links


#: How a backend failure reaches the driver: (error built from the message, module raising it, what the
#: host-free answer still names). A client's own error type; a network failure under the client (an
#: OSError); and a plain ValueError raised inside the client library, which carries the client's text.
FAILURES = {
    'client-error': (lambda adapter, message: h.client_error(adapter.client_module, message), False, 'FakeClientError'),
    'network': (lambda adapter, message: ConnectionRefusedError(message), False, 'ConnectionRefusedError'),
    'raised-in-client': (lambda adapter, message: ValueError(message), True, 'ValueError'),
}


@pytest.mark.parametrize('failure', sorted(FAILURES))
@pytest.mark.parametrize('after_exists', [False, True], ids=['unreachable', 'reads-fail'])
@pytest.mark.parametrize('call', sorted(TOOL_CALLS))
def test_backend_failures_do_not_name_the_server(adapter, store, call, after_exists, failure):
    """A client error that names the server surfaces as a host-free error (the tool's STORE_ERROR text)."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    address = adapter.server_address(store)
    build, in_client, error_name = FAILURES[failure]
    injected = build(adapter, f'Fail connecting to server on {address}: Connection refused')
    raise_from = adapter.client_module if in_client else None
    adapter.fail_backend(store, injected, after_exists=after_exists, raise_from=raise_from)
    expected = ANSWERS_WITHOUT_BACKEND.get((adapter.name, call))
    if expected == 'refuses':
        with pytest.raises(StoreUnsupported):
            TOOL_CALLS[call](store)
        return
    if expected == 'reads_missing':
        assert TOOL_CALLS[call](store) is False
        return

    def assert_host_free(error):
        answer = f'{type(error).__name__}: {error}'  # what the tool wrapper puts in STORE_ERROR
        assert address not in answer, answer
        assert error_name in answer, answer
        if failure == 'client-error':
            assert '(code 2)' in answer, answer
        assert any(link is injected for link in _chain(error)), f'{call} never reached the backend: {answer}'

    if expected == 'inherits':
        assert _method(call) not in vars(type(store)), f'{call} is now overridden: drop it from the allowlist'
        try:
            answer = TOOL_CALLS[call](store)
        except StoreUnsupported:  # removeCounted's day-0 base default
            return
        except Exception as error:  # noqa: BLE001 - a base default that goes through the driver (remove)
            assert_host_free(error)
            return
        assert answer is None
        return
    with pytest.raises(Exception) as raised:
        TOOL_CALLS[call](store)
    assert_host_free(raised.value)


@pytest.mark.parametrize(
    'call',
    [
        'getVectors',
        'scrollChunks',
        'sampleChunks',
    ],
)
def test_driver_bugs_keep_their_own_error(adapter, store, call, monkeypatch):
    """A bug in the driver's own code is not reported as a backend failure: its error and text pass through."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])

    def broken(*args, **kwargs):
        raise KeyError('objectId missing from a stored row')

    monkeypatch.setattr(store, '_toDoc', broken)
    with pytest.raises(KeyError, match='objectId missing from a stored row'):
        TOOL_CALLS[call](store)


def test_dialect_and_stats_through_the_mixin(adapter, store):
    """The dialect and stats tools answer through VectorStoreToolMixin with this driver's hooks."""
    from types import SimpleNamespace

    from ai.common.store import VectorStoreToolMixin

    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    node = VectorStoreToolMixin()
    node.IGlobal = SimpleNamespace(store=store, serverName=adapter.name, glb=SimpleNamespace(logicalType=adapter.name))
    dialect = node.dialect({})
    assert dialect['success'] is True, dialect
    assert dialect['support'] == 'experimental'
    assert dialect['backend'] == adapter.backend
    assert 'experimental' in dialect['caveats']
    stats = node.stats({'mode': 'full'})
    assert stats['success'] is True, stats
    assert stats['model'] == h.MODEL
    assert stats['vector_size'] == h.DIM
