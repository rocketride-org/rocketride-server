# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Milvus driver repairs bundled with the Vector Explorer hooks (mocked client).

The shared hook contract is in ``nodes/test/test_vector_other_drivers.py``;
these tests pin what is specific to Milvus: metadata serialised as plain JSON,
typed filter literals, keyword search on the question text, the L2 score scale,
``render`` and ``describe``'s index details.
"""

import pytest

from ai.common.schema import DocFilter, QuestionText

from .. import vector_other_drivers_harness as h


@pytest.fixture(scope='module')
def adapter():
    """Milvus driver loaded against the pymilvus mock."""
    return h.MilvusAdapter()


@pytest.fixture
def store(adapter):
    """A fresh store on an empty mock server."""
    return adapter.new_store()


def test_rows_carry_plain_json_metadata_with_the_extras(adapter, store):
    """The meta column is a JSON dict (pymilvus cannot serialise a pydantic model), Nones dropped."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    records = [r for r in adapter.records(store) if r['meta'].get('objectId') == 'doc-a']
    assert len(records) == 2
    for record in records:
        assert type(record['meta']) is dict
        assert record['meta']['size'] >= 1000
        assert record['meta']['ingestedAt'] == '2026-10-08T18:20:11Z'
        assert None not in record['meta'].values()


def test_filter_literals_are_typed(store):
    """Booleans and integers are compared as such, not as quoted strings."""
    conditions = store._convertFilter(DocFilter(isTable=True, tableIds=[1, 2], permissions=[3]))
    assert "meta['isTable'] == True" in conditions
    assert "meta['tableId'] in [1, 2]" in conditions
    assert "meta['permissionId'] in [3]" in conditions


def test_filter_integers_cannot_carry_an_expression(store):
    """A non-integer table id is rejected instead of being interpolated."""
    with pytest.raises((TypeError, ValueError)):
        store._convertFilter(DocFilter.model_construct(tableIds=["1] or meta['x'] in [1"]))


def test_keyword_search_matches_the_question_text(store):
    """The keyword pattern is built from the question text, not the model's repr."""
    h.ingest(store, 'doc-a', '/geo/Paris.md', [0])
    h.ingest(store, 'doc-b', '/geo/Rome.md', [0])
    query = QuestionText(text='Paris', embedding=h.vector_for('q', 0), embedding_model=h.MODEL)
    found = store.searchKeyword(query, DocFilter())
    assert [doc.metadata.objectId for doc in found] == ['doc-a']


def test_l2_scores_fall_with_distance(adapter, store):
    """L2 distance d scores 1 / (1 + d): the closest row scores highest."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0, 1])
    store.similarity = 'L2'
    # The driver cuts at the node threshold (develop's rule); lowered so both rows come back.
    store.threshold_search = 0.0
    records = [r for r in adapter.records(store) if r['meta'].get('objectId') == 'doc-a']

    def search(collection_name, data, filter=None, limit=10, output_fields=None, **kwargs):
        return [
            [
                {'id': int(r['id']), 'distance': d, 'entity': {'meta': r['meta'], 'content': r['content']}}
                for r, d in zip(records, (0.0, 3.0))
            ]
        ]

    store.client.search = search
    docs = store.searchSemantic(
        QuestionText(text='q', embedding=h.vector_for('q', 0), embedding_model=h.MODEL), DocFilter()
    )
    assert [doc.score for doc in docs] == pytest.approx([1.0, 0.25])
    assert store.scoreInfo()['higher_is_better'] is True


def test_render_rebuilds_the_text_in_chunk_order(store):
    """Render reads chunkId from the metadata and joins the chunks in order."""
    h.ingest(store, 'doc-a', '/docs/a.md', [2, 0, 1])
    parts = []
    store.render('doc-a', parts.append)
    assert ''.join(parts) == ''.join(f'/docs/a.md chunk {i} text' for i in range(3))


def test_describe_reports_the_index_and_version(store):
    """The description carries the IVF index, its metric and the server version, never the host."""
    h.ingest(store, 'doc-a', '/docs/a.md', [0])
    info = store.describe()
    assert info.index['type'] == 'IVF_FLAT'
    assert info.index['params']['nlist'] == 1024
    assert isinstance(info.backend_version, str) and info.backend_version
    assert 'localhost' not in repr(info)


def test_listing_stops_with_a_note_at_the_query_window(adapter, store, monkeypatch):
    """Milvus cannot page past offset + limit = 16,384: the listing serves what fits, then says so."""
    monkeypatch.setattr(adapter.module, 'MAX_QUERY_WINDOW', 4)
    for i in range(6):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', [0])
    rows, pages = h.collect_listing(store, limit=2)
    assert len({row.objectId for row in rows}) == 4
    assert pages[-1].next_cursor is None
    assert 'documents_paging_unsupported' in pages[-1].caveats


def test_listing_counts_are_unknown_when_a_page_has_more_chunks_than_one_query(adapter, store, monkeypatch):
    """The page's chunks are tallied from one query; past Milvus' result window the counts are None, not wrong."""
    monkeypatch.setattr(adapter.module, 'MAX_QUERY_WINDOW', 5)
    for i in range(3):
        h.ingest(store, f'doc-{i}', f'/docs/{i}.md', [0, 1, 2])
    page = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
    assert len(page.items) == 2
    assert page.counts_exact is False
    assert [row.chunks for row in page.items] == [None, None]
    small = store.listDocumentPage(cursor=None, limit=1, object_ids=None, deleted='active', sort='path')
    assert small.counts_exact is True and small.items[0].chunks == 3
