# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Astra DB driver repairs bundled with the Vector Explorer hooks (mocked client).

The shared hook contract is in ``nodes/test/test_vector_other_drivers.py``;
these tests pin what is specific to Astra: counts with the required
``upper_bound``, the metadata written (control-record extras kept, other extras
and nulls dropped), rows written with nulls still read, ``describe`` from the
collection definition, and reads that never sort on a regular field: the Data API
answers such a find with at most 20 documents (and refuses one over more than
10,000 matching rows), so listings, chunk scrolls, paths and ``get`` page through
unsorted finds instead.
"""

import pytest

from ai.common.schema import DocFilter

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Astra driver loaded against the astrapy mock."""
    return h.AstraAdapter()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty mock database."""
    return adapter.new_store()


def test_count_documents_passes_an_upper_bound(adapter, store):
    """Astrapy 2 requires upper_bound; past it the estimated count answers."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    assert store.count_documents() == 4
    adapter.module.COUNT_UPPER_BOUND, saved = 2, adapter.module.COUNT_UPPER_BOUND
    try:
        assert store.count_documents() == 4
        assert store.countChunks(DocFilter()) is None
    finally:
        adapter.module.COUNT_UPPER_BOUND = saved


def test_metadata_keeps_the_control_extras_and_drops_nulls(adapter, store):
    """The control record keeps vectorSize/modelName; chunks keep declared fields only, never nulls."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    rows = {r['objectId']: r['meta'] for r in adapter.raw_rows(store)}
    assert rows['schema']['vectorSize'] == h.DIM
    assert rows['schema']['modelName'] == h.MODEL
    assert 'size' not in rows['doc-a'] and 'ingestedAt' not in rows['doc-a']
    for meta in rows.values():
        assert None not in meta.values()


def test_rows_written_with_nulls_are_still_read(adapter, store):
    """Older rows hold explicit nulls; reading them does not fail validation."""
    adapter.seed_legacy(store)
    docs = store.get(DocFilter(objectIds=['legacy-a'], limit=10))
    assert sorted(doc.metadata.chunkId for doc in docs) == [0, 1, 2]


def test_get_honours_the_offset(store):
    """Get pages with an offset instead of returning the first page again."""
    for i in range(5):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', [0])
    first = store.get(DocFilter(chunkIds=[0], limit=2))
    second = store.get(DocFilter(chunkIds=[0], limit=2, offset=2))
    assert len(first) == 2 and len(second) == 2
    assert {d.metadata.objectId for d in first}.isdisjoint({d.metadata.objectId for d in second})


def test_describe_reads_the_collection_definition(store):
    """Dimension and metric come from the definition; the endpoint is never reported."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    info = store.describe()
    assert info.dimension == h.DIM
    assert info.metric == 'cosine'
    assert info.index['type'] == 'vector'
    assert {'experimental', 'cloud_only_unverified', 'extras_not_stored'} <= set(info.caveats)
    assert 'example.invalid' not in repr(info)


# -----------------------------------------------------------------------------
# The Data API returns at most 20 documents for a find sorted on a regular field
# -----------------------------------------------------------------------------


def _ingest_many(store, count):
    for i in range(count):
        h.ingest(store, f'doc-{i:02d}', f'/docs/{i:02d}.md', [0])


def test_the_mock_caps_field_sorted_finds_like_the_data_api(adapter, store):
    """A find sorted on a regular field stops at 20 documents; past 10,000 matches it is refused."""
    _ingest_many(store, 25)
    collection = store.database.get_collection(store.collection_name)
    assert len(list(collection.find({}, sort={'meta.objectId': 1}, limit=100))) == 20
    assert len(list(collection.find({}, limit=100))) == 26  # unsorted: every page (control record included)
    adapter.mock.IN_MEMORY_SORT_LIMIT, saved = 10, adapter.mock.IN_MEMORY_SORT_LIMIT
    try:
        with pytest.raises(adapter.mock.DataAPIResponseException):
            collection.find({}, sort={'meta.objectId': 1})
    finally:
        adapter.mock.IN_MEMORY_SORT_LIMIT = saved


@pytest.mark.parametrize('limit', [7, 20, 200])
def test_listing_reaches_every_document_past_one_data_api_page(store, limit):
    """45 documents list in full whatever the page size, each once, no page over the limit."""
    _ingest_many(store, 45)
    rows, pages = h.collect_listing(store, limit=limit)
    assert sorted(row.objectId for row in rows) == [f'doc-{i:02d}' for i in range(45)]
    assert all(len(page.items) <= limit for page in pages)
    assert pages[-1].next_cursor is None


def test_scroll_chunks_reaches_every_chunk_past_twenty(store):
    """A 45-chunk document scrolls in full, in chunk order, in one page of 100."""
    h.ingest(store, 'doc-a', '/docs/a.md', list(range(45)))
    docs, pages = h.collect_chunks(store, 'doc-a', limit=100)
    assert [doc.metadata.chunkId for doc in docs] == list(range(45))
    assert len(pages) == 1 and pages[0].has_more is False


def test_get_paths_reaches_every_document_past_twenty(store):
    """The objdir paths list all 45 documents, and their offset/limit still page them."""
    _ingest_many(store, 45)
    assert len(store.getPaths()) == 45
    assert len(store.getPaths(offset=40, limit=10)) == 5


def test_get_pages_past_twenty(store):
    """A get with an offset returns full pages past the first 20 documents."""
    _ingest_many(store, 45)
    first = store.get(DocFilter(chunkIds=[0], limit=30))
    second = store.get(DocFilter(chunkIds=[0], limit=30, offset=30))
    ids_first = {d.metadata.objectId for d in first}
    ids_second = {d.metadata.objectId for d in second}
    assert len(ids_first) == 30 and len(ids_second) == 15
    assert ids_first.isdisjoint(ids_second)


def test_explorer_reads_never_sort_on_a_regular_field(store):
    """Every read the explorer and the legacy tools make is unsorted or ranked by vector / lexical."""
    _ingest_many(store, 3)
    h.ingest(store, 'doc-long', '/docs/long.md', [0, 4, 9])
    sorts = []
    original_get = store.database.get_collection

    def get_collection(name):
        collection = original_get(name)
        original_find = collection.find

        def find(*args, **kwargs):
            sorts.append(kwargs.get('sort'))
            return original_find(*args, **kwargs)

        collection.find = find
        return collection

    store.database.get_collection = get_collection
    h.collect_listing(store, limit=2)
    h.collect_chunks(store, 'doc-long', limit=2)
    store.getPaths(offset=1, limit=2)
    store.get(DocFilter(limit=2, offset=1))
    store.getVectors([('doc-00', 0), ('doc-long', 9)])
    store.sampleChunks(n=2, seed=1, strategy='first', docFilter=h.VxFilter(deleted='active'), include_keys=[])
    store.render('doc-long', lambda text: None)
    assert sorts, 'no find recorded'
    field_sorts = [s for s in sorts if s and not ({'$vector', '$lexical'} & set(s))]
    assert field_sorts == []
