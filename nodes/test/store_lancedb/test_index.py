# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The vector index policy and the optimize cadence.

A table that crosses indexAfterRows gets a vector index, and search through
that index still agrees with an exact search computed here in Python.
"""

from datetime import timedelta

from ai.common.schema import DocFilter
from nodes.store_lancedb import lancedb_store

from ._helpers import chunk, question, random_vector

ROWS = 3000
INDEX_AFTER = 2000
SAMPLES = 20
TOP = 10


def _vector_indexed(store) -> bool:
    return any('vector' in (index.columns or []) for index in store._getTable().list_indices())


def _exact_top(vectors, query, count):
    """Ids of the nearest vectors by cosine similarity (vectors are unit length)."""
    scored = sorted(vectors.items(), key=lambda item: -sum(a * b for a, b in zip(item[1], query)))
    return [f'doc-{i}' for i, _ in scored[:count]]


def test_index_is_built_after_the_threshold_and_matches_exact_search(make_store, rng):
    store = make_store(indexAfterRows=INDEX_AFTER)
    vectors = {}

    for start in range(0, ROWS, 500):
        batch = []
        for i in range(start, start + 500):
            vectors[i] = random_vector(rng)
            batch.append(chunk(f'doc-{i}', 0, f'text {i}', vectors[i]))
        store.addChunks(batch)

        # No index while the table is under the threshold
        if start + 500 < INDEX_AFTER:
            assert not _vector_indexed(store)

    assert _vector_indexed(store)
    assert store._vectorIndexed

    # A store that only reads finds the existing index when it opens the table
    reader = make_store(indexAfterRows=0)
    assert reader.doesCollectionExist()
    assert reader._vectorIndexed

    top_one = 0
    overlap = 0
    for _ in range(SAMPLES):
        query = random_vector(rng)
        found = [doc.metadata.objectId for doc in store.searchSemantic(question('q', query), DocFilter(limit=TOP))]
        exact = _exact_top(vectors, query, TOP)
        top_one += found[0] == exact[0]
        overlap += len(set(found) & set(exact))

    # The refine pass re-ranks on the raw vectors, so the index stays close to exact
    assert top_one >= SAMPLES - 1
    assert overlap / (SAMPLES * TOP) >= 0.9


def test_rows_written_after_the_index_are_still_found(make_store, rng):
    store = make_store(indexAfterRows=500)
    store.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng)) for i in range(600)])
    assert _vector_indexed(store)

    late = random_vector(rng)
    store.addChunks([chunk('doc-late', 0, 'late arrival', late)])
    assert store.searchSemantic(question('q', late), DocFilter(limit=1))[0].metadata.objectId == 'doc-late'


def test_open_reader_picks_up_an_index_built_later(make_store, rng, monkeypatch):
    monkeypatch.setattr(lancedb_store, 'READ_CONSISTENCY_INTERVAL', timedelta(0))
    writer = make_store(indexAfterRows=500)
    writer.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng)) for i in range(100)])

    reader = make_store(indexAfterRows=0)
    reader.searchSemantic(question('q', random_vector(rng)), DocFilter(limit=1))
    assert not reader._vectorIndexed

    writer.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng)) for i in range(100, 600)])
    assert _vector_indexed(writer)

    reader.searchSemantic(question('q', random_vector(rng)), DocFilter(limit=1))
    assert reader._vectorIndexed


def test_index_is_never_built_when_disabled(make_store, rng):
    store = make_store(indexAfterRows=0)
    store.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng)) for i in range(600)])
    assert not _vector_indexed(store)


def test_optimize_runs_on_its_cadence(make_store, rng, monkeypatch):
    store = make_store(optimizeAfterWrites=2)
    store.addChunks([chunk('doc-0', 0, 'first', random_vector(rng))])

    # Count from here: creating the table also wrote the schema control row
    store._writes = 0
    calls = []
    table = store._getTable()
    original = table.optimize
    monkeypatch.setattr(table, 'optimize', lambda *a, **k: calls.append(1) or original(*a, **k))

    for i in range(1, 6):
        store.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng))])

    # Five writes with optimize on every second one: after writes 2 and 4
    assert len(calls) == 2
    assert store.count_documents() == 6
