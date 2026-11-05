"""
Milvus markDeleted / markActive read every row of the documents they mark, a page at a time.

A query without a limit answers Milvus's default page only (100 rows on the mock), and
offset + limit may not pass MAX_QUERY_WINDOW. The driver therefore reads the rows of at
most MARK_IDS_PER_QUERY documents at a time, by windows of chunk ids that one query holds.
Here the window is made tiny so documents span several windows, with a gap in the chunk
ids that leaves a window empty.
"""

from typing import Dict, Tuple

import pytest

from ai.common.schema import DocFilter

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Milvus driver loaded against the pymilvus mock."""
    return h.MilvusAdapter()


#: Three documents: one with a gap in its chunk ids, one long, one short.
CHUNKS = {'doc-a': [0, 1, 2, 9, 10], 'doc-b': list(range(12)), 'doc-c': [0]}


def _flags(store) -> Dict[Tuple[str, int], bool]:
    """(objectId, chunkId) -> isDeleted, for every stored chunk of CHUNKS."""
    out: Dict[Tuple[str, int], bool] = {}
    for deleted in (False, True):
        flt = DocFilter(objectIds=list(CHUNKS), isDeleted=deleted, limit=1000, offset=0)
        flt.deleted = 'deleted' if deleted else 'active'
        for doc in store.get(flt):
            out[(doc.metadata.objectId, int(doc.metadata.chunkId))] = bool(doc.metadata.isDeleted)
    return out


@pytest.fixture
def store(adapter, monkeypatch):
    """The three documents, with windows of two chunk ids per document and two documents per read."""
    monkeypatch.setattr(adapter.module, 'MAX_QUERY_WINDOW', 4)
    monkeypatch.setattr(adapter.module, 'MARK_IDS_PER_QUERY', 2, raising=False)
    store = adapter.new_store()
    for object_id, chunk_ids in CHUNKS.items():
        h.ingest(store, object_id, f'/docs/{object_id}.md', chunk_ids)
    return store


def test_mark_deleted_moves_every_chunk_across_windows_and_gaps(store):
    total = sum(len(ids) for ids in CHUNKS.values())
    assert store.markDeleted(list(CHUNKS)) == total
    flags = _flags(store)
    assert len(flags) == total and all(flags.values()), flags
    assert store.markDeleted(list(CHUNKS)) == 0, 'a repeat moves nothing'


def test_mark_active_moves_every_chunk_back(store):
    total = sum(len(ids) for ids in CHUNKS.values())
    store.markDeleted(list(CHUNKS))
    assert store.markActive(['doc-b']) == 12
    assert store.markActive(list(CHUNKS)) == total - 12
    flags = _flags(store)
    assert len(flags) == total and not any(flags.values()), flags


def test_no_query_asks_past_the_query_window(store, adapter, monkeypatch):
    asked = []
    query = store.client.query

    def spy(**kw):
        if 'vector' in kw.get('output_fields', []):  # the reads of the rows to mark
            asked.append(kw.get('offset', 0) + kw.get('limit', 100))
        return query(**kw)

    monkeypatch.setattr(store.client, 'query', spy)
    store.markDeleted(list(CHUNKS))
    assert asked and max(asked) <= 4, asked


def test_a_count_that_never_reaches_zero_does_not_keep_the_read_going(store, monkeypatch):
    """A count(*) that answers rows the windowed reads never return ends at the driver's own bound."""
    total = sum(len(ids) for ids in CHUNKS.values())
    counted = store._countWhere
    monkeypatch.setattr(store, '_countWhere', lambda conditions: counted(conditions) + 5)
    query = store.client.query
    calls = []

    def bounded(**kw):
        calls.append(kw)
        if len(calls) > 2000:
            raise RuntimeError('the mark read did not stop')
        return query(**kw)

    monkeypatch.setattr(store.client, 'query', bounded)
    assert store.markDeleted(list(CHUNKS)) == total, 'every row the reads returned is marked, and counted once'
    assert all(_flags(store).values())
    assert len(calls) < 400, len(calls)
