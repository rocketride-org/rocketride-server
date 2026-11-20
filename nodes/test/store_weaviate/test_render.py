# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Weaviate render: every chunk of a document comes back, in order (#3354)."""

from __future__ import annotations

import random
import tracemalloc

from .test_record_updates import _make_obj_records, _make_store


def _shuffled(records: dict[str, dict]) -> dict[str, dict]:
    """Return the records in a random order, since Weaviate returns objects in any order."""
    items = list(records.items())
    random.Random(3354).shuffle(items)
    return dict(items)


def _render(store, object_id: str) -> list[str]:
    parts: list[str] = []
    store.render(object_id, parts.append)
    return parts


def _expected(count: int, start: int = 0) -> str:
    return ''.join(f'chunk {index}' for index in range(start, count))


def test_render_returns_more_than_the_default_query_limit():
    """A query without a limit returns 10 objects; a 25-chunk document must still render whole."""
    records = _shuffled(_make_obj_records('doc', 25, is_deleted=False))
    records.update(_make_obj_records('other', 5, is_deleted=False))
    store, _ = _make_store(records)

    assert _render(store, 'doc') == [_expected(25)]


def test_render_pages_past_the_query_maximum(monkeypatch):
    """No single query may ask for more than QUERY_MAXIMUM_RESULTS, yet every chunk is rendered."""
    store, collection = _make_store(_shuffled(_make_obj_records('doc', 25_001, is_deleted=False)))
    fetch = collection.query.fetch_objects
    limits = []

    def recorded_fetch(**kwargs):
        limits.append(kwargs.get('limit'))
        return fetch(**kwargs)

    monkeypatch.setattr(collection.query, 'fetch_objects', recorded_fetch)

    assert _render(store, 'doc') == [_expected(25_001)]
    assert limits == [10_000, 10_000, 10_000]  # two full pages, then a short one


def test_render_hands_over_one_render_chunk_size_group_at_a_time():
    store, _ = _make_store(_shuffled(_make_obj_records('doc', 10, is_deleted=False)))
    store.renderChunkSize = 4

    assert _render(store, 'doc') == [_expected(4), _expected(8, 4), _expected(10, 8)]


def test_render_leaves_a_missing_chunk_empty():
    records = _make_obj_records('doc', 15, is_deleted=False)
    del records['doc-3']
    store, _ = _make_store(_shuffled(records))

    assert _render(store, 'doc') == [_expected(3) + _expected(15, 4)]


def test_render_reaches_a_chunk_past_a_wide_gap():
    """ChunkIds need not be contiguous: an upsert can store chunks 0 and 20000 alone."""
    records = _make_obj_records('doc', 20_001, is_deleted=False)
    records = {key: records[key] for key in ('doc-0', 'doc-20000')}
    store, _ = _make_store(records)

    assert _render(store, 'doc') == ['chunk 0chunk 20000']


def _second_copy(records: dict[str, dict], chunk: int, content: str) -> None:
    """Store another object with an existing chunk number, as an upsert without chunk 0 can."""
    copy = dict(records[f'doc-{chunk}'], properties=dict(records[f'doc-{chunk}']['properties'], content=content))
    records[f'doc-{chunk}-copy'] = copy


def test_render_keeps_every_chunk_when_a_chunk_number_is_stored_twice():
    """A second copy of chunk 1 must not push chunk 3 out of a group of 4."""
    records = _make_obj_records('doc', 4, is_deleted=False)
    _second_copy(records, 1, 'chunk 1 again')
    # Weaviate's order: 0, 1, 2, the copy of 1, then 3
    order = ('doc-0', 'doc-1', 'doc-2', 'doc-1-copy', 'doc-3')
    store, _ = _make_store({key: records[key] for key in order})
    store.renderChunkSize = 4

    assert _render(store, 'doc') in (
        [_expected(4)],
        ['chunk 0chunk 1 againchunk 2chunk 3'],
    )


def test_render_keeps_every_chunk_when_copies_straddle_a_page(monkeypatch):
    """Copies of the chunk a page ends on are read once, and the next page goes on from there."""
    records = _make_obj_records('doc', 10, is_deleted=False)
    _second_copy(records, 3, 'chunk 3')
    _second_copy(records, 4, 'chunk 4')
    store, collection = _make_store(_shuffled(records))
    store.renderPageSize = 4
    fetch = collection.query.fetch_objects
    calls = []

    def counted_fetch(**kwargs):
        calls.append(kwargs)
        assert len(calls) <= 10, 'render is not making progress'
        return fetch(**kwargs)

    monkeypatch.setattr(collection.query, 'fetch_objects', counted_fetch)

    assert _render(store, 'doc') == [_expected(10)]
    assert [call['limit'] for call in calls] == [4] * len(calls)


def test_render_passes_a_full_page_of_copies_of_one_chunk(monkeypatch):
    """More copies of one chunk number than a page holds must not hide the chunks after it."""
    records = _make_obj_records('doc', 4, is_deleted=False)
    for copy in range(9):
        _second_copy(records, 1, 'chunk 1')
        records[f'doc-1-copy-{copy}'] = records.pop('doc-1-copy')
    store, collection = _make_store(_shuffled(records))
    store.renderPageSize = 4
    fetch = collection.query.fetch_objects
    calls = []

    def counted_fetch(**kwargs):
        calls.append(kwargs)
        assert len(calls) <= 10, 'render is not making progress'
        return fetch(**kwargs)

    monkeypatch.setattr(collection.query, 'fetch_objects', counted_fetch)

    assert _render(store, 'doc') == [_expected(4)]
    assert [call['limit'] for call in calls] == [4] * len(calls)


def test_render_does_not_walk_the_gap_between_sparse_chunks():
    """Chunks 0 and 33554431 share the default group; joining them must not build an entry per missing id."""
    records = _make_obj_records('doc', 1, is_deleted=False)
    last = 32 * 1024 * 1024 - 1
    records['doc-last'] = dict(
        records['doc-0'], properties=dict(records['doc-0']['properties'], chunkId=last, content='chunk last')
    )
    store, _ = _make_store(records)

    tracemalloc.start()
    try:
        parts = _render(store, 'doc')
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert parts == ['chunk 0chunk last']
    assert peak < 16 * 1024 * 1024  # an entry per id in the group would take hundreds of MB


def test_render_of_an_unknown_document_calls_nothing():
    store, _ = _make_store(_make_obj_records('doc', 3, is_deleted=False))

    assert _render(store, 'missing') == []
