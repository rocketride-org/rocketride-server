# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Weaviate driver repairs bundled with the Vector Explorer hooks (mocked client).

The shared hook contract is in ``nodes/test/test_vector_other_drivers.py``;
these tests pin what is specific to Weaviate: the score scale per distance
metric, ids keyed by (objectId, chunkId), paging by offset in ``get``,
keyword search on the question text, group-by document counts and
``describe``'s index details.
"""

import pytest

from ai.common.schema import DocFilter, QuestionText

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Weaviate driver loaded against the weaviate mock."""
    return h.WeaviateAdapter()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty mock server."""
    return adapter.new_store()


def _query(vector):
    return QuestionText(text='q', embedding=vector, embedding_model=h.MODEL)


def test_cosine_scores_rank_the_identical_vector_first(store):
    """Cosine distance d scores (2 - d) / 2: an identical vector scores 1.0, not 0.5."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    h.ingest(store, 'doc-b', '/docs/b.md', [0])
    docs = store.searchSemantic(_query(h.vector_for('doc-a', 0)), DocFilter())
    assert docs[0].metadata.objectId == 'doc-a'
    assert docs[0].score == pytest.approx(1.0)
    assert all(doc.score <= docs[0].score for doc in docs)


@pytest.mark.parametrize(
    ('metric', 'distance', 'score'),
    [('dot', -0.8, 0.8), ('l2-squared', 3.0, 0.25), ('manhattan', 1.0, 0.5)],
)
def test_other_metrics_score_higher_when_closer(adapter, store, metric, distance, score):
    """Dot distance is the negative dot product; l2-squared and manhattan score 1 / (1 + d)."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    store.similarity = store.similarityDict[metric]
    obj_id, obj = next((uid, o) for uid, o in adapter.storage(store).items() if o['properties']['objectId'] == 'doc-a')
    mock = adapter.mock

    def near_vector(*args, **kwargs):
        props = {k: v for k, v in obj['properties'].items() if v is not None}
        return mock.QueryResult(
            objects=[mock.QueryObject(uuid=obj_id, properties=props, metadata=mock.MetadataResult(distance=distance))]
        )

    store.collectionObj.query.near_vector = near_vector
    docs = store.searchSemantic(_query(h.vector_for('q', 0)), h.VxFilter(minScore=float('-inf')))
    assert [doc.score for doc in docs] == pytest.approx([score])


def test_objects_are_keyed_by_object_and_chunk(adapter, store):
    """New writes use uuid5('<objectId>#<chunkId>'), so a key maps to one object."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    ids = {o['properties']['objectId']: [] for o in adapter.storage(store).values()}
    for uid, obj in adapter.storage(store).items():
        ids[obj['properties']['objectId']].append(uid)
    assert sorted(ids['doc-a']) == sorted(h.keyed_uuid('doc-a', c) for c in (0, 1))
    assert ids['schema'] == [h.keyed_uuid('schema', 0)]


def test_get_honours_the_offset(store):
    """Get pages with offset instead of returning the first page again."""
    for i in range(5):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', [0])
    first = store.get(DocFilter(chunkIds=[0], limit=2))
    second = store.get(DocFilter(chunkIds=[0], limit=2, offset=2))
    assert len(first) == 2 and len(second) == 2
    assert {d.metadata.objectId for d in first}.isdisjoint({d.metadata.objectId for d in second})


def test_keyword_search_matches_the_question_text(store):
    """The keyword pattern is built from the question text, not the model's repr."""
    h.ingest(store, 'doc-a', '/geo/Paris.md', [0])
    h.ingest(store, 'doc-b', '/geo/Rome.md', [0])
    found = store.searchKeyword(_query(h.vector_for('q', 0)).model_copy(update={'text': 'Paris'}), DocFilter())
    assert [doc.metadata.objectId for doc in found] == ['doc-a']


def test_count_documents_groups_by_object(adapter, store):
    """Documents are counted natively (group by objectId), a document without chunk 0 included."""
    adapter.seed_legacy(store)
    assert store.countDocumentsWhere(h.VxFilter(deleted='active')) == 3
    assert 'countDocumentsWhere' in store.capabilities()


def test_describe_reports_the_index_and_version(store):
    """The description carries the HNSW index and the server version, never the host."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    info = store.describe()
    assert info.index['type'] == 'hnsw'
    assert info.backend_version == '1.30.0-mock'
    assert 'score_scale_inverted_fixed' in info.caveats
    assert '8080' not in repr(info) and 'localhost' not in repr(info)


def test_listing_stops_with_a_note_at_the_query_window(adapter, store, monkeypatch):
    """Weaviate cannot page past 10,000 results: the listing serves what fits, then says so."""
    monkeypatch.setattr(adapter.module, 'MAX_QUERY_RESULTS', 4)
    for i in range(6):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', [0])
    rows, pages = h.collect_listing(store, limit=2)
    assert len({row.objectId for row in rows}) == 4
    assert pages[-1].next_cursor is None
    assert 'documents_paging_unsupported' in pages[-1].caveats


# -----------------------------------------------------------------------------
# Explorer extras (size, modifyTime, ingestedAt) and Weaviate's auto-schema
# -----------------------------------------------------------------------------

EXTRAS = ('size', 'modifyTime', 'ingestedAt')


def test_new_collections_declare_the_explorer_extras(adapter, store):
    """New collections declare size/modifyTime as INT and ingestedAt as TEXT, so auto-schema never types them."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    declared = {
        p.name: str(p.data_type.value) for p in adapter.mock.MockCollections._configs[store.collection]['properties']
    }
    assert {name: declared.get(name) for name in EXTRAS} == {'size': 'int', 'modifyTime': 'int', 'ingestedAt': 'text'}
    rows, _ = h.collect_listing(store, limit=10)
    assert (rows[0].size, rows[0].modifyTime, rows[0].ingestedAt) == (1000, 1700000000, '2026-10-08T18:20:11Z')


def test_auto_schemaed_extras_read_back_as_written(adapter, store):
    """
    A collection created before the extras were declared gets them from auto-schema on the first write:
    ingestedAt as a date (the client returns a datetime), size and modifyTime as numbers (floats).
    The explorer still reports the ISO-8601 string and integers.
    """
    adapter.seed_legacy(store)
    schema = adapter.mock.MockCollections._schemas[store.collection]
    for name in EXTRAS:
        schema.pop(name, None)  # as the previous driver created the collection
    h.ingest(store, 'doc-new', '/docs/new.md', [0, 1])

    stored = next(
        o['properties']
        for o in adapter.storage(store).values()
        if o['properties'].get('objectId') == 'doc-new' and o['properties'].get('chunkId') == 0
    )
    assert type(stored['ingestedAt']).__name__ == 'datetime'
    assert isinstance(stored['size'], float) and isinstance(stored['modifyTime'], float)

    rows, _ = h.collect_listing(store, limit=10)
    row = next(r for r in rows if r.objectId == 'doc-new')
    assert row.ingestedAt == '2026-10-08T18:20:11Z'
    assert row.size == 1000 and isinstance(row.size, int)
    assert row.modifyTime == 1700000000 and isinstance(row.modifyTime, int)

    docs, _ = h.collect_chunks(store, 'doc-new', limit=10)
    vectors = store.getVectors([('doc-new', 1)])
    for doc in docs + vectors:
        extras = doc.metadata.model_dump()
        assert extras['ingestedAt'] == '2026-10-08T18:20:11Z'
        assert isinstance(extras['size'], int) and isinstance(extras['modifyTime'], int)


# -----------------------------------------------------------------------------
# Unbounded reads: Weaviate answers 10 objects when no limit is given
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('method', ['markDeleted', 'markActive'])
def test_soft_delete_reaches_every_chunk_of_a_long_document(adapter, store, method):
    """Marking a 25-chunk document touches all 25 chunks, not the server's default page of 10."""
    h.ingest(store, 'doc-a', '/docs/a.md', list(range(25)), deleted=method == 'markActive')
    h.ingest(store, 'doc-b', '/docs/b.md', [0], deleted=method == 'markActive')
    getattr(store, method)(['doc-a'])
    flags = {
        o['properties']['chunkId']: o['properties']['isDeleted']
        for o in adapter.storage(store).values()
        if o['properties']['objectId'] == 'doc-a'
    }
    assert flags == {chunk: method == 'markDeleted' for chunk in range(25)}
    other = [
        o['properties']['isDeleted'] for o in adapter.storage(store).values() if o['properties']['objectId'] == 'doc-b'
    ]
    assert other == [method == 'markActive']


def test_render_emits_every_chunk_in_order(store):
    """Rendering a 25-chunk document joins all 25 chunks in chunk order."""
    h.ingest(store, 'doc-a', '/docs/a.md', list(range(25)))
    parts = []
    store.render('doc-a', parts.append)
    assert ''.join(parts) == ''.join(f'/docs/a.md chunk {c} text' for c in range(25))


def test_render_does_not_allocate_the_render_chunk_size(store):
    """The render window is bounded by what Weaviate can return, not a renderChunkSize-long list."""
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
