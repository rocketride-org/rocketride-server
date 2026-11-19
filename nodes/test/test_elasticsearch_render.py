# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""store_elasticsearch render: every chunk of a document comes back, in chunkId order (#3355).

render sent ``'size': self.renderChunkSize`` (33554432 by default), and
Elasticsearch rejects a search whose from + size exceeds
index.max_result_window (10000 by default), so every render failed with HTTP
400. The client here is a fake that applies the query's term and range
filters, its sort and size, and that limit.
"""

from __future__ import annotations

import importlib.util
import math
import random
import sys
import tracemalloc
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'store_elasticsearch'
_PACKAGE = 'es_render_under_test'
_STUB_MODULE_NAMES = ('elasticsearch', 'elasticsearch.helpers', 'numpy', _PACKAGE)

MAX_RESULT_WINDOW = 10000


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Stand in the client packages and a bare parent package, so the driver loads without the node's __init__."""
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}

    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = object
    helpers = types.ModuleType('elasticsearch.helpers')
    helpers.bulk = helpers.scan = lambda *args, **kwargs: None
    helpers.BulkIndexError = Exception
    numpy = types.ModuleType('numpy')
    numpy.exp = math.exp
    package = types.ModuleType(_PACKAGE)
    package.__path__ = [str(_NODE_DIR)]
    sys.modules.update(
        {'elasticsearch': elasticsearch, 'elasticsearch.helpers': helpers, 'numpy': numpy, _PACKAGE: package}
    )
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _load_store_class() -> type:
    with _scoped_stubs():
        name = f'{_PACKAGE}.elasticsearch_store'
        spec = importlib.util.spec_from_file_location(name, _NODE_DIR / 'elasticsearch_store.py')
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(name, None)
        return module.Store


class _FakeIndices:
    def exists(self, index):
        return True


class _FakeClient:
    """An Elasticsearch client reduced to the search render sends.

    Applies term and range clauses under bool.must, a sort on one field
    (stable, so equal values keep storage order), size, and the server's
    from + size limit.
    """

    def __init__(self, docs):
        self.docs = list(docs)
        self.indices = _FakeIndices()
        self.searches = []

    def search(self, index, body=None, **kwargs):
        body = body or {}
        self.searches.append(body)
        window = body.get('from', 0) + body.get('size', 10)
        if window > MAX_RESULT_WINDOW:
            raise ValueError(
                f'Result window is too large, from + size must be less than or equal to: [10000] but was [{window}]'
            )

        def field(source, path):
            for part in path.split('.'):
                source = (source or {}).get(part)
            return source

        def matches(source, clause):
            ((kind, condition),) = clause.items()
            ((path, value),) = condition.items()
            actual = field(source, path)
            if kind == 'term':
                return actual == value
            assert kind == 'range'
            if actual is None:
                return False
            return all(
                {'gte': actual >= bound, 'gt': actual > bound, 'lte': actual <= bound, 'lt': actual < bound}[op]
                for op, bound in value.items()
            )

        must = body.get('query', {}).get('bool', {}).get('must', [])
        hits = [doc for doc in self.docs if all(matches(doc['_source'], clause) for clause in must)]
        for sort in reversed(body.get('sort', [])):
            ((path, order),) = sort.items()
            hits.sort(key=lambda doc, path=path: field(doc['_source'], path), reverse=order.get('order') == 'desc')
        hits = hits[body.get('from', 0) : body.get('from', 0) + body.get('size', 10)]
        return {'hits': {'total': {'value': len(hits)}, 'hits': [dict(doc, _score=None) for doc in hits]}}


def _doc(object_id, chunk, content=None):
    return {
        '_id': f'{object_id}-{chunk}-{random.random()}',
        '_source': {
            'content': f'chunk {chunk}' if content is None else content,
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
    store_cls = _load_store_class()
    driver = store_cls.__new__(store_cls)  # no connection: render uses the client object only
    driver.client = _FakeClient(docs)
    driver.index = 'test-index'
    return driver


def _render(driver, object_id):
    parts = []
    driver.render(object_id, parts.append)
    return parts


def _expected(stop, start=0):
    return ''.join(f'chunk {chunk}' for chunk in range(start, stop))


def _content_field_is_content():
    """The fake stores text under 'content'; check the driver reads it from there."""
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location(f'{_PACKAGE}.constants', _NODE_DIR / 'constants.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.CONTENT_FIELD == 'content'


def test_the_fake_stores_text_where_the_driver_reads_it():
    assert _content_field_is_content()


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


def test_render_passes_a_full_page_of_copies_of_one_chunk(monkeypatch):
    """More copies of one chunk number than a page holds must not hide the chunks after it."""
    docs = _docs('o1', 4) + [_doc('o1', 1) for _ in range(9)]
    driver = _store(_shuffled(docs))
    monkeypatch.setitem(driver.render.__globals__, '_RENDER_PAGE_SIZE', 4)
    search = driver.client.search

    def counted_search(**kwargs):
        assert len(driver.client.searches) < 10, 'render is not making progress'
        return search(**kwargs)

    monkeypatch.setattr(driver.client, 'search', counted_search)

    assert _render(driver, 'o1') == [_expected(4)]


def test_render_keeps_one_copy_when_a_chunk_number_is_stored_twice():
    driver = _store(_docs('o1', 4) + [_doc('o1', 1, 'chunk 1 again')])
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
def test_the_fake_enforces_the_result_window(size):
    client = _FakeClient([])
    if size > MAX_RESULT_WINDOW:
        with pytest.raises(ValueError, match='Result window is too large'):
            client.search(index='i', body={'size': size})
    else:
        assert client.search(index='i', body={'size': size})['hits']['hits'] == []
