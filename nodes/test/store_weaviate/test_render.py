# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Weaviate render: every chunk of a document comes back, in order (#3354)."""

from __future__ import annotations

import random

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
    assert limits == [10_000, 10_000, 10_000, 10_000]  # three data pages, then an empty one


def test_render_hands_over_one_render_chunk_size_group_at_a_time():
    store, _ = _make_store(_shuffled(_make_obj_records('doc', 10, is_deleted=False)))
    store.renderChunkSize = 4

    assert _render(store, 'doc') == [_expected(4), _expected(8, 4), _expected(10, 8)]


def test_render_leaves_a_missing_chunk_empty():
    records = _make_obj_records('doc', 15, is_deleted=False)
    del records['doc-3']
    store, _ = _make_store(_shuffled(records))

    assert _render(store, 'doc') == [_expected(3) + _expected(15, 4)]


def test_render_of_an_unknown_document_calls_nothing():
    store, _ = _make_store(_make_obj_records('doc', 3, is_deleted=False))

    assert _render(store, 'missing') == []
