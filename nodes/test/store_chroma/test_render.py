# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""store_chroma render: every chunk of a document comes back, joined in chunkId order (#3353).

render asked Chroma for ``include=['documents']`` and then read
``results['metadatas'][i].chunkId``. Chroma returns ``None`` for a field the
request does not include, and each metadata is a dict, so render raised on
every document that had chunks. The collection is a fake with the client's
``get`` signature and its include semantics.
"""

from __future__ import annotations

import inspect
import random
import tracemalloc

import pytest

from .test_convert_filter_explicit_none import _load_store_class


class _FakeCollection:
    """A chromadb Collection reduced to the ``get`` that render calls.

    Like the client, ``get`` returns one dict of parallel lists, in storage
    order, and a field the request does not include comes back as ``None``.
    """

    def __init__(self, rows):
        self.rows = {row_id: (dict(meta), document) for row_id, (meta, document) in rows.items()}
        self.get_calls = []

    def get(self, ids=None, where=None, limit=None, offset=None, where_document=None, include=None):
        self.get_calls.append({'where': where, 'limit': limit, 'offset': offset, 'include': include})
        include = ['metadatas', 'documents'] if include is None else include

        def matches(meta, clause):
            if '$and' in clause:
                return all(matches(meta, child) for child in clause['$and'])
            assert len(clause) == 1  # Chroma requires one field per clause.
            field, condition = next(iter(clause.items()))
            ((op, value),) = condition.items()
            actual = meta.get(field)
            if op == '$eq':
                return actual == value
            if actual is None:
                return False
            if op == '$gte':
                return actual >= value
            if op == '$lt':
                return actual < value
            raise AssertionError(f'unexpected operator {op}')

        hits = [(row_id, row) for row_id, row in self.rows.items() if where is None or matches(row[0], where)]
        hits = hits[offset or 0 :]
        if limit is not None:
            hits = hits[:limit]
        return {
            'ids': [row_id for row_id, _ in hits],
            'metadatas': [dict(meta) for _, (meta, _) in hits] if 'metadatas' in include else None,
            'documents': [document for _, (_, document) in hits] if 'documents' in include else None,
            'embeddings': None,
            'uris': None,
            'data': None,
            'included': list(include),
        }


def _rows(object_id, count):
    return {
        f'{object_id}-{i}': ({'objectId': object_id, 'chunkId': i, 'parent': f'/{object_id}'}, f'chunk {i}')
        for i in range(count)
    }


def _shuffled(rows):
    """Chroma returns rows in any order, so store them out of chunkId order."""
    items = list(rows.items())
    random.Random(3353).shuffle(items)
    return dict(items)


def _store(rows):
    store_cls = _load_store_class()
    driver = store_cls.__new__(store_cls)  # no connection: render uses the collection object only
    driver.client = None
    driver.collectionObj = _FakeCollection(rows)
    driver.doesCollectionExist = lambda modelName=None: True
    return driver


def _render(driver, object_id):
    parts = []
    driver.render(object_id, parts.append)
    return parts


def _expected(stop, start=0):
    return ''.join(f'chunk {i}' for i in range(start, stop))


def test_the_fake_matches_the_installed_client():
    """Pins the fake's get to the real client's signature."""
    pytest.importorskip('chromadb')
    from chromadb.api.models.Collection import Collection

    assert set(inspect.signature(_FakeCollection.get).parameters) == set(inspect.signature(Collection.get).parameters)


def test_render_joins_every_chunk_in_order():
    """The issue's case: 25 chunks of one document, stored next to another document."""
    driver = _store({**_shuffled(_rows('o1', 25)), **_rows('o2', 3)})

    assert _render(driver, 'o1') == [_expected(25)]


def test_render_pages_through_a_long_document(monkeypatch):
    """A document longer than one page is read page by page, and no chunk is lost."""
    driver = _store(_shuffled(_rows('o1', 25)))
    monkeypatch.setitem(driver.render.__globals__, '_RENDER_PAGE_SIZE', 10)

    assert _render(driver, 'o1') == [_expected(25)]
    pages = [call['offset'] for call in driver.collectionObj.get_calls if call['limit'] == 10]
    assert pages == [0, 10, 20]


def test_render_hands_over_one_render_chunk_size_group_at_a_time():
    driver = _store(_shuffled(_rows('o1', 10)))
    driver.renderChunkSize = 4

    assert _render(driver, 'o1') == [_expected(4), _expected(8, 4), _expected(10, 8)]


def test_render_leaves_a_missing_chunk_empty():
    rows = _rows('o1', 15)
    del rows['o1-3']
    driver = _store(_shuffled(rows))

    assert _render(driver, 'o1') == [_expected(3) + _expected(15, 4)]


def test_render_goes_on_past_an_empty_group():
    """ChunkIds need not be contiguous: a group with no chunks is not the end of the document."""
    rows = _rows('o1', 10)
    rows = {key: rows[key] for key in ('o1-0', 'o1-1', 'o1-9')}
    driver = _store(rows)
    driver.renderChunkSize = 4

    assert _render(driver, 'o1') == [_expected(2), _expected(10, 9)]


def test_render_does_not_walk_the_gap_between_sparse_chunks():
    """Chunks 0 and 33554431 share the default group; joining them must not build an entry per missing id."""
    rows = {
        'o1-0': ({'objectId': 'o1', 'chunkId': 0, 'parent': '/o1'}, 'chunk 0'),
        'o1-last': ({'objectId': 'o1', 'chunkId': 32 * 1024 * 1024 - 1, 'parent': '/o1'}, 'chunk last'),
    }
    driver = _store(rows)

    tracemalloc.start()
    try:
        parts = _render(driver, 'o1')
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert parts == ['chunk 0chunk last']
    assert peak < 16 * 1024 * 1024  # an entry per id in the group would take hundreds of MB


def test_render_keeps_every_chunk_when_a_chunk_number_is_stored_twice():
    """A second copy of chunk 1 must not push chunk 3 out of a group of 4."""
    rows = _rows('o1', 4)
    order = ['o1-0', 'o1-1', 'o1-2', 'o1-1-copy', 'o1-3']
    rows['o1-1-copy'] = ({'objectId': 'o1', 'chunkId': 1, 'parent': '/o1'}, 'chunk 1 again')
    driver = _store({key: rows[key] for key in order})
    driver.renderChunkSize = 4

    assert _render(driver, 'o1') in (
        [_expected(4)],
        ['chunk 0chunk 1 againchunk 2chunk 3'],
    )


def test_render_of_an_unknown_document_calls_nothing():
    driver = _store(_rows('o1', 3))

    assert _render(driver, 'missing') == []
