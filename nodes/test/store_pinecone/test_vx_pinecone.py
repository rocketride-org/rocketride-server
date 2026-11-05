# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pinecone driver repairs bundled with the Vector Explorer hooks (mocked client).

The shared hook contract is in ``nodes/test/test_vector_other_drivers.py``;
these tests pin what is specific to Pinecone: no null metadata values, reads
within the 1000-match cap (paged past it), the tri-state deleted filter, keyed
ids with a fetch fast path, keyword search reported as unsupported, the raw
score scale and the pod/serverless split.
"""

import pytest

from ai.common.schema import DocFilter, QuestionText
from ai.common.store.errors import StoreUnsupported

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Pinecone driver loaded against the pinecone mock."""
    return h.PineconeAdapter()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty mock project."""
    return adapter.new_store()


def _spy(adapter, store, method):
    """Record the keyword arguments of every call to ``Index.<method>``."""
    calls = []

    def factory(original):
        def wrapper(*args, **kwargs):
            calls.append(kwargs)
            return original(*args, **kwargs)

        return wrapper

    adapter._wrap_index(store, method, factory)
    return calls


def test_metadata_never_carries_null_values(adapter, store):
    """Pinecone rejects null metadata; unset fields are left out."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    rows = adapter.raw_rows(store)
    assert {r['objectId'] for r in rows} == {'schema', 'doc-a'}
    for row in rows:
        assert None not in row['meta'].values()
    doc_rows = [r for r in rows if r['objectId'] == 'doc-a']
    assert all(r['meta']['ingestedAt'] == '2026-10-08T18:20:11Z' for r in doc_rows)


def test_queries_stay_within_the_1000_match_cap(adapter, store):
    """No query asks for more than 1000 matches with metadata or values."""
    calls = _spy(adapter, store, 'query')
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1, 2])
    store.get(DocFilter(objectIds=['doc-a'], limit=5000))
    assert calls and all(c['top_k'] <= 1000 for c in calls)


def test_get_pages_past_1000_matches(adapter, store):
    """Reads beyond the query cap page through fetch_by_metadata."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    for i in range(1, 1200):
        meta = {**h.legacy_meta('doc-a', i, '/docs/a.md'), 'content': f'chunk {i}'}
        adapter.storage(store)[h.keyed_uuid('doc-a', i)] = {'values': h.vector_for('doc-a', i), 'metadata': meta}
    page = store.get(DocFilter(objectIds=['doc-a'], offset=1100, limit=50))
    assert len(page) == 50
    assert len({doc.metadata.chunkId for doc in page}) == 50


def test_is_deleted_true_reads_every_row(adapter, store):
    """isDeleted=True means deleted and live rows alike (it used to mean deleted only)."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    store.markDeleted(['doc-b'])
    every = store.get(DocFilter(isDeleted=True, objectIds=['doc-a', 'doc-b'], limit=100))
    assert sorted(doc.metadata.objectId for doc in every) == ['doc-a', 'doc-a', 'doc-b']


def test_vectors_are_keyed_by_object_and_chunk(adapter, store):
    """New writes use uuid5('<objectId>#<chunkId>') as the vector id."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    ids = sorted(r['id'] for r in adapter.raw_rows(store) if r['objectId'] == 'doc-a')
    assert ids == sorted(h.keyed_uuid('doc-a', c) for c in (0, 1))


def test_get_vectors_fetches_keyed_ids_without_a_query(adapter, store):
    """Keys of new rows are fetched by id; no filtered query is needed."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    queries = _spy(adapter, store, 'query')
    docs = store.getVectors([('doc-a', 1), ('doc-a', 0)])
    assert [(d.metadata.objectId, d.metadata.chunkId) for d in docs] == [('doc-a', 1), ('doc-a', 0)]
    assert queries == []


def test_keyword_search_is_unsupported(store):
    """Pinecone has no keyword search: the explorer is told so instead of seeing a crash."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    with pytest.raises(StoreUnsupported):
        store.searchKeyword(
            QuestionText(text='a', embedding=h.vector_for('q', 0), embedding_model=h.MODEL), DocFilter()
        )


def test_describe_reports_the_spec_and_never_the_host(store):
    """The description names the index type and metric, never the index host."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    info = store.describe()
    assert info.index['type'] == 'serverless'
    assert info.metric == 'cosine'
    assert {'experimental', 'cloud_only_unverified', 'score_scale_raw'} <= set(info.caveats)
    assert 'example.invalid' not in repr(info) and 'host' not in repr(info.index)


def test_euclidean_scores_are_lower_is_better(store):
    """Raw squared-euclidean scores rank the smallest first."""
    store.similarity = 'euclidean'
    assert store.scoreInfo()['higher_is_better'] is False


def test_a_pod_index_cannot_sample_or_list(adapter):
    """Pod-based indexes have no metadata fetch: sampling and paging say so."""
    store = adapter.new_store(profile='pod')
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    with pytest.raises(StoreUnsupported):
        store.sampleChunks(n=2, seed=1, strategy='random', docFilter=h.VxFilter(deleted='active'), include_keys=[])
    page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
    assert [row.objectId for row in page.items] == ['doc-a']
    assert page.next_cursor is None


def test_metadata_numbers_come_back_as_integers(adapter, store):
    """Pinecone keeps every metadata number as a float; integer fields are reported as ints again."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    fetched = store.client.Index(store.collection).fetch(ids=[h.keyed_uuid('doc-a', 1)])
    raw = next(iter(fetched['vectors'].values()))['metadata']
    assert type(raw['chunkId']) is float and type(raw['size']) is float  # the service's shape

    rows, _ = h.collect_listing(store, limit=10)
    assert (rows[0].size, rows[0].modifyTime) == (1000, 1700000000)
    assert type(rows[0].size) is int and type(rows[0].modifyTime) is int
    docs, _ = h.collect_chunks(store, 'doc-a', limit=10)
    for doc in docs + store.getVectors([('doc-a', 1)]):
        meta = doc.metadata.model_dump()
        assert all(type(meta[key]) is int for key in ('chunkId', 'size', 'modifyTime', 'tableId', 'permissionId'))
