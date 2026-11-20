# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""store_elasticsearch render: every chunk of a document comes back, in chunkId order (#3355).

render sent ``'size': self.renderChunkSize`` (33554432 by default), and
Elasticsearch rejects a search whose from + size exceeds
index.max_result_window (10000 by default), so every render failed with HTTP
400. The client is the shared mock in ``nodes/test/mocks/elasticsearch``,
which applies the query's term and range filters, its sort and size, and that
limit.
"""

from __future__ import annotations

import random
import tracemalloc

import pytest

from nodes.store_elasticsearch.constants import CONTENT_FIELD
from nodes.store_elasticsearch.elasticsearch_store import Store

# The shared mock, imported as part of this test package: the real
# elasticsearch package, if loaded, is left alone
from .mocks import elasticsearch as es_mock

MAX_RESULT_WINDOW = es_mock.MAX_RESULT_WINDOW
_INDEX = 'test-index'


@pytest.fixture(autouse=True)
def _empty_mock_index():
    """Each test starts with an empty mock server, and leaves it as it found it."""
    saved_store, saved_indices = dict(es_mock._store), dict(es_mock._indices)
    es_mock._store.clear()
    es_mock._indices.clear()
    yield
    es_mock._store.clear()
    es_mock._store.update(saved_store)
    es_mock._indices.clear()
    es_mock._indices.update(saved_indices)


def _doc(object_id, chunk, content=None, copy=0):
    if content is None:
        content = f'chunk {chunk}'
    return {
        '_id': f'{object_id}-{chunk}-{copy}',
        '_source': {
            CONTENT_FIELD: content,
            'meta': {'objectId': object_id, 'chunkId': chunk},
        },
    }


def _docs(object_id, count):
    return [_doc(object_id, chunk) for chunk in range(count)]


def _shuffled(docs):
    """Elasticsearch stores documents in any order, so keep them out of chunkId order."""
    docs = list(docs)
    random.Random(3355).shuffle(docs)
    return docs


def _store(docs):
    """The driver on the shared mock, holding ``docs`` in one index, with every search body recorded."""
    client = es_mock.Elasticsearch()
    client.indices.create(index=_INDEX)
    es_mock._store[_INDEX] = list(docs)

    client.searches = []
    search = client.search

    def recorded_search(index, body=None, **kwargs):
        client.searches.append(body)
        assert len(client.searches) <= 20, 'render is not making progress'
        return search(index=index, body=body, **kwargs)

    client.search = recorded_search

    driver = Store.__new__(Store)  # no connection: render uses the client object only
    driver.client = client
    driver.index = _INDEX
    return driver


def _render(driver, object_id):
    parts = []
    driver.render(object_id, parts.append)
    return parts


def _expected(stop, start=0):
    return ''.join(f'chunk {chunk}' for chunk in range(start, stop))


def test_render_joins_every_chunk_in_order():
    """The issue's case: 25 chunks of one document, stored next to another document."""
    driver = _store(_shuffled(_docs('o1', 25) + _docs('o2', 3)))

    assert _render(driver, 'o1') == [_expected(25)]
    assert all(search['size'] <= MAX_RESULT_WINDOW for search in driver.client.searches)


def test_render_pages_past_the_result_window():
    """The issue's 10500-chunk document: no search asks for more than 10000 hits, and every chunk is rendered."""
    driver = _store(_shuffled(_docs('o1', 10_500)))

    assert _render(driver, 'o1') == [_expected(10_500)]
    assert [search['size'] for search in driver.client.searches] == [10_000, 10_000]


def test_render_stops_beside_many_other_documents():
    """Other documents in the index must not fill render's pages: the search filters by objectId."""
    driver = _store(_shuffled(_docs('o1', 3) + [_doc(f'other-{i}', 0) for i in range(10_000)]))

    assert _render(driver, 'o1') == [_expected(3)]
    assert len(driver.client.searches) == 1


def test_render_hands_over_one_render_chunk_size_group_at_a_time():
    driver = _store(_shuffled(_docs('o1', 10)))
    driver.renderChunkSize = 4

    assert _render(driver, 'o1') == [_expected(4), _expected(8, 4), _expected(10, 8)]


def test_render_leaves_out_a_missing_chunk():
    docs = [doc for doc in _docs('o1', 15) if doc['_source']['meta']['chunkId'] != 3]
    driver = _store(_shuffled(docs))

    assert _render(driver, 'o1') == [_expected(3) + _expected(15, 4)]


def test_render_reaches_a_chunk_past_a_wide_gap():
    """ChunkIds need not be contiguous: an upsert can store chunks 0 and 20000 alone."""
    driver = _store([_doc('o1', 20_000), _doc('o1', 0)])

    assert _render(driver, 'o1') == ['chunk 0chunk 20000']


def test_render_passes_a_full_page_of_copies_of_one_chunk():
    """More copies of one chunk number than a page holds must not hide the chunks after it."""
    docs = _docs('o1', 4) + [_doc('o1', 1, copy=copy) for copy in range(1, 10)]
    driver = _store(_shuffled(docs))
    driver.renderPageSize = 4

    assert _render(driver, 'o1') == [_expected(4)]
    assert all(search['size'] == 4 for search in driver.client.searches)


def test_render_keeps_one_copy_when_a_chunk_number_is_stored_twice():
    driver = _store(_docs('o1', 4) + [_doc('o1', 1, 'chunk 1 again', copy=1)])
    driver.renderChunkSize = 4

    assert _render(driver, 'o1') in ([_expected(4)], ['chunk 0chunk 1 againchunk 2chunk 3'])


def test_render_does_not_walk_the_gap_between_sparse_chunks():
    """Chunks 0 and 33554431 share the default group; joining them must not build an entry per missing id."""
    driver = _store([_doc('o1', 0), _doc('o1', 32 * 1024 * 1024 - 1, 'chunk last')])

    tracemalloc.start()
    try:
        parts = _render(driver, 'o1')
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert parts == ['chunk 0chunk last']
    assert peak < 16 * 1024 * 1024  # an entry per id in the group would take hundreds of MB


def test_render_of_an_unknown_document_calls_nothing():
    driver = _store(_docs('o1', 3))

    assert _render(driver, 'missing') == []


@pytest.mark.parametrize('size', [MAX_RESULT_WINDOW, MAX_RESULT_WINDOW + 1])
def test_the_mock_enforces_the_result_window(size):
    client = es_mock.Elasticsearch()
    if size > MAX_RESULT_WINDOW:
        with pytest.raises(ValueError, match='Result window is too large'):
            client.search(index=_INDEX, body={'size': size})
    else:
        assert client.search(index=_INDEX, body={'size': size})['hits']['hits'] == []


@pytest.mark.parametrize(
    'must',
    [
        [{'term': {'meta.objectId': 'o1'}}],
        {'term': {'meta.objectId': 'o1'}},
    ],
    ids=['list', 'single-clause'],
)
def test_the_mock_takes_bool_must_as_a_list_or_a_single_clause(must):
    """Elasticsearch accepts bool.must as a list of clauses or as one clause; both match the same documents."""
    es_mock._store[_INDEX] = _docs('o1', 2) + _docs('o2', 3)
    body = {'query': {'bool': {'must': must}}}

    hits = es_mock.Elasticsearch().search(index=_INDEX, body=body)['hits']['hits']

    assert sorted(hit['_id'] for hit in hits) == ['o1-0-0', 'o1-1-0']


def test_the_mock_ignores_clauses_it_does_not_model():
    """A match or knn query still sees every document, as before the mock applied filters."""
    es_mock._store[_INDEX] = _docs('o1', 3)
    body = {'query': {'bool': {'must': [{'match': {CONTENT_FIELD: 'anything'}}]}}}

    assert len(es_mock.Elasticsearch().search(index=_INDEX, body=body)['hits']['hits']) == 3
