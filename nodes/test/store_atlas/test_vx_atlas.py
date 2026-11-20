# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""MongoDB Atlas driver repairs bundled with the Vector Explorer hooks (fake client).

The shared hook contract is in ``nodes/test/test_vector_other_drivers.py``;
these tests pin what is specific to Atlas: vector scores used as Atlas returns
them (already normalised), a failed vector search reported instead of an
UnboundLocalError, no result logging, a vectorSearch index for new
collections, the legacy knnVector index reported by ``describe``, the stored
metadata, the aggregated document listing and native stratified sampling.
"""

import logging

import pytest

from ai.common.schema import DocFilter, QuestionText
from ai.common.store.errors import StoreError

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Atlas driver loaded against the installed pymongo, with a fake client."""
    return h.AtlasAdapter()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty fake cluster."""
    return adapter.new_store()


def _query(vector):
    return QuestionText(text='q', embedding=vector, embedding_model=h.MODEL)


def test_vector_scores_are_used_as_atlas_returns_them(store):
    """VectorSearchScore is already in [0, 1]; an identical vector scores 1.0, not 1.0 rescaled again."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    docs = store.searchSemantic(_query(h.vector_for('doc-a', 0)), DocFilter())
    assert docs[0].metadata.objectId == 'doc-a'
    assert docs[0].score == pytest.approx(1.0)
    other = next(doc for doc in docs if doc.metadata.objectId == 'doc-b')
    assert other.score < 1.0


def test_new_collections_get_a_vector_search_index(store):
    """$vectorSearch needs a vectorSearch index with the filtered metadata paths declared."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    index = store.collection.search_indexes[0]
    assert index['name'] == 'vector_index'
    assert index['type'] == 'vectorSearch'
    fields = index['latestDefinition']['fields']
    vector = next(f for f in fields if f['type'] == 'vector')
    assert vector == {'type': 'vector', 'path': 'embedding', 'numDimensions': h.DIM, 'similarity': 'cosine'}
    assert {'meta.isDeleted', 'meta.objectId', 'meta.chunkId'} <= {f['path'] for f in fields if f['type'] == 'filter'}


def test_a_failed_vector_search_is_reported(store):
    """Without a usable vector search index the search fails with a clear StoreError."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    store.collection.search_indexes.clear()
    with pytest.raises(StoreError) as excinfo:
        store.searchSemantic(_query(h.vector_for('q', 0)), DocFilter())
    assert 'vector search index' in str(excinfo.value)
    assert 'example.invalid' not in str(excinfo.value)


def test_search_results_are_not_logged(store, caplog):
    """Search results (document content) never go to the log."""
    h.ingest(store, 'doc-a', '/geo/Paris.md', [0])
    with caplog.at_level(logging.DEBUG):
        store.searchSemantic(_query(h.vector_for('doc-a', 0)), DocFilter())
    assert not any('Paris' in record.getMessage() for record in caplog.records)


def test_describe_reports_the_index_type(adapter, store):
    """A new collection reports its vectorSearch index; a legacy one its knnVector index."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    info = store.describe()
    assert info.index['type'] == 'vectorSearch'
    assert {'experimental', 'cloud_only_unverified', 'extras_not_stored'} <= set(info.caveats)
    legacy = adapter.new_store()
    adapter.seed_legacy(legacy)
    legacy_info = legacy.describe()
    assert legacy_info.index['type'] == 'knnVector'
    assert legacy_info.index['vector_search_ready'] is False
    assert legacy_info.dimension == h.DIM


def test_metadata_keeps_the_control_extras_and_drops_nulls(adapter, store):
    """The control record keeps vectorSize/modelName; chunks keep declared fields only, never nulls."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    rows = {r['objectId']: r['meta'] for r in adapter.raw_rows(store)}
    assert rows['schema']['vectorSize'] == h.DIM
    assert rows['schema']['modelName'] == h.MODEL
    assert 'size' not in rows['doc-a'] and 'ingestedAt' not in rows['doc-a']
    for meta in rows.values():
        assert None not in meta.values()


def test_listing_counts_chunks_and_tables_per_document(store):
    """The aggregated listing carries exact chunk and table counts, sorted by path."""
    h.ingest(store, 'doc-b', '/docs/b.md', [0, 1, 2])
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1], is_table=True)
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert [(r.objectId, r.chunks, r.tables) for r in page.items] == [('doc-a', 2, 2), ('doc-b', 3, 0)]
    assert page.total == 2 and page.distinct is True and page.counts_exact is True


def test_count_documents_groups_by_object(adapter, store):
    """Documents are counted natively, a document without chunk 0 included."""
    adapter.seed_legacy(store)
    assert store.countDocumentsWhere(h.VxFilter(deleted='active')) == 3


def test_get_paths_skip_the_control_record(store):
    """Objdir lists live documents only."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    assert store.getPaths() == {'/docs/a.md': 'doc-a'}


def test_render_emits_every_chunk_in_order(store):
    """Rendering joins every chunk of the document in chunk order."""
    h.ingest(store, 'doc-a', '/docs/a.md', list(range(25)))
    parts = []
    store.render('doc-a', parts.append)
    assert ''.join(parts) == ''.join(f'/docs/a.md chunk {c} text' for c in range(25))


def test_render_does_not_allocate_the_render_chunk_size(store):
    """Render reads a bounded window of chunk ids instead of building a renderChunkSize-long list."""
    import tracemalloc

    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    store.renderChunkSize = 4_000_000  # a list this long would take about 32 MB
    parts = []
    tracemalloc.start()
    try:
        store.render('doc-a', parts.append)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert ''.join(parts) == ''.join(f'/docs/a.md chunk {c} text' for c in range(3))
    assert peak < 8 * 1024 * 1024, peak


def test_stratified_sample_takes_every_first_chunk_before_any_second_one(store):
    """
    With fewer rows than documents x per-document quota, the round-robin order decides coverage:
    every document's chunk 0 comes before any document's second chunk.
    """
    for i in range(4):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', list(range(6)))
    pinned = [('doc-2', 3)]
    docs, used = store.sampleChunks(
        n=5, seed=1, strategy='stratified', docFilter=h.VxFilter(deleted='active'), include_keys=pinned
    )
    keys = [(doc.metadata.objectId, doc.metadata.chunkId) for doc in docs]
    assert used == 'stratified'
    assert len(keys) == 5 and ('doc-2', 3) not in keys
    assert sorted(keys[:4]) == [(f'doc-{i}', 0) for i in range(4)]
    assert keys[4][1] != 0
