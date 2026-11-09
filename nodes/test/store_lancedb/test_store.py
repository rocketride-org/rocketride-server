# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""End to end behaviour of the LanceDB store on a real table.

Covers what the documents and questions lanes rely on: ingest, semantic,
keyword and hybrid search, re-ingest, soft delete, remove, render, paths and
counts, and that a fresh Store sees what an earlier one wrote.
"""

from datetime import timedelta

import pytest
from lancedb.merge import LanceMergeInsertBuilder

from ai.common.schema import DocFilter
from nodes.store_lancedb import lancedb_store

from ._helpers import DIM, chunk, nearby, question, random_vector


def _texts(docs):
    return [doc.page_content for doc in docs]


class TestCollection:
    def test_missing_table_reads_empty(self, make_store, rng):
        store = make_store()
        assert not store.doesCollectionExist()
        assert store.get(DocFilter()) == []
        assert store.searchSemantic(question('q', random_vector(rng)), DocFilter()) == []
        assert store.searchKeyword(question('q'), DocFilter()) == []
        assert store.getPaths() == {}
        assert store.count_documents() == 0
        store.remove(['nothing'])
        store.markDeleted(['nothing'])

    def test_open_store_sees_writes_from_another_store(self, make_store, rng, monkeypatch):
        monkeypatch.setattr(lancedb_store, 'READ_CONSISTENCY_INTERVAL', timedelta(0))
        writer = make_store()
        writer.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])
        reader = make_store()
        assert reader.count_documents() == 1

        writer.addChunks([chunk('doc-b', 0, 'beta', random_vector(rng))])
        writer.markDeleted(['doc-a'])
        assert {doc.metadata.objectId for doc in reader.get(DocFilter(limit=10))} == {'doc-b'}

    def test_fresh_store_sees_earlier_writes(self, make_store, rng):
        make_store().addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])

        store = make_store()
        assert store.doesCollectionExist()
        assert store.vectorSize == DIM
        assert store.modelName == 'test-model'
        assert store.count_documents() == 1

    def test_other_embedding_model_is_refused(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])
        with pytest.raises(Exception, match='other-model'):
            store.addChunks([chunk('doc-b', 0, 'beta', random_vector(rng), model='other-model')])

    def test_other_vector_size_is_refused(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])
        with pytest.raises(Exception, match='vector size'):
            store.addChunks([chunk('doc-b', 0, 'beta', [0.1] * (DIM + 1))])

    def test_chunk_without_embedding_is_refused(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])
        doc = chunk('doc-b', 0, 'beta', random_vector(rng))
        doc.embedding = None
        with pytest.raises(Exception, match='embedding'):
            store.addChunks([doc], checkCollection=False)


class TestSearch:
    def test_semantic_finds_the_nearest_document(self, make_store, rng):
        store = make_store()
        target = random_vector(rng)
        store.addChunks(
            [
                chunk('doc-a', 0, 'the capital of France is Paris', target),
                chunk('doc-b', 0, 'bananas are yellow', random_vector(rng)),
            ]
        )

        docs = store.searchSemantic(question('capital of France', nearby(target, rng)), DocFilter())
        assert docs[0].metadata.objectId == 'doc-a'
        assert docs[0].score > 0.9
        assert all(0.0 <= doc.score <= 1.0 for doc in docs)

    def test_semantic_needs_an_embedding(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])
        with pytest.raises(Exception, match='embedding'):
            store.searchSemantic(question('alpha'), DocFilter())

    @pytest.mark.parametrize('distance', ['cosine', 'dot', 'l2'])
    def test_every_distance_ranks_the_match_first(self, make_store, rng, distance):
        store = make_store(distance=distance)
        target = random_vector(rng)
        store.addChunks(
            [chunk('doc-a', 0, 'match', target)]
            + [chunk(f'doc-{i}', 0, f'other {i}', random_vector(rng)) for i in range(20)]
        )
        docs = store.searchSemantic(question('match', target), DocFilter(limit=5))
        assert docs[0].metadata.objectId == 'doc-a'
        assert docs[0].score == pytest.approx(1.0, abs=1e-4)

    def test_semantic_offset_pages_results(self, make_store, rng):
        store = make_store()
        target = random_vector(rng)
        store.addChunks([chunk(f'doc-{i}', 0, f'text {i}', nearby(target, rng, 0.3)) for i in range(10)])

        everything = store.searchSemantic(question('q', target), DocFilter(limit=10))
        page = store.searchSemantic(question('q', target), DocFilter(offset=3, limit=3))
        assert _texts(page) == _texts(everything)[3:6]

    def test_keyword_search_scores_the_best_hit_one(self, make_store, rng):
        store = make_store()
        store.addChunks(
            [
                chunk('doc-a', 0, 'lancedb keeps tables as files on object storage', random_vector(rng)),
                chunk('doc-b', 0, 'a recipe for tomato soup', random_vector(rng)),
                chunk('doc-c', 0, 'object storage is cheap; object storage scales', random_vector(rng)),
            ]
        )

        docs = store.searchKeyword(question('object storage'), DocFilter())
        assert {doc.metadata.objectId for doc in docs} == {'doc-a', 'doc-c'}
        assert max(doc.score for doc in docs) == pytest.approx(1.0)
        assert store.searchKeyword(question('   '), DocFilter()) == []

    def test_keyword_search_sees_rows_written_after_the_index(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'first text about rome', random_vector(rng))])
        assert _texts(store.searchKeyword(question('rome'), DocFilter())) == ['first text about rome']

        store.addChunks([chunk('doc-b', 0, 'later text about tokyo', random_vector(rng))])
        assert _texts(store.searchKeyword(question('tokyo'), DocFilter())) == ['later text about tokyo']

    def test_hybrid_mode_adds_keyword_only_hits(self, make_store, rng):
        target = random_vector(rng)
        far = [-value for value in target]
        rows = [
            chunk('doc-near', 0, 'unrelated words entirely', target),
            chunk('doc-word', 0, 'the zephyr protocol handbook', far),
        ]

        vector_store = make_store(table='vector_only')
        vector_store.addChunks(rows)
        vector_ids = {
            doc.metadata.objectId for doc in vector_store.searchSemantic(question('zephyr', target), DocFilter())
        }
        assert vector_ids == {'doc-near'}

        hybrid_store = make_store(table='hybrid', searchMode='hybrid')
        hybrid_store.addChunks(rows)
        docs = hybrid_store.searchSemantic(question('zephyr', target), DocFilter())
        scores = {doc.metadata.objectId: doc.score for doc in docs}
        assert set(scores) == {'doc-near', 'doc-word'}
        assert scores['doc-near'] > 0.9
        assert scores['doc-word'] == pytest.approx(1.0)


class TestWrites:
    def test_reingest_replaces_every_chunk(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', i, f'old {i}', random_vector(rng)) for i in range(5)])
        store.addChunks([chunk('doc-b', i, f'other {i}', random_vector(rng)) for i in range(3)])
        store.addChunks([chunk('doc-a', i, f'new {i}', random_vector(rng)) for i in range(2)])

        docs = store.get(DocFilter(objectIds=['doc-a'], limit=100))
        assert sorted(_texts(docs)) == ['new 0', 'new 1']
        assert len(store.get(DocFilter(objectIds=['doc-b'], limit=100))) == 3

    def test_failed_reingest_keeps_the_previous_version(self, make_store, rng, monkeypatch):
        store = make_store()
        store.addChunks([chunk('doc-a', i, f'old {i}', random_vector(rng)) for i in range(3)])

        def fail(*args, **kwargs):
            raise RuntimeError('write interrupted')

        monkeypatch.setattr(LanceMergeInsertBuilder, 'execute', fail)
        with pytest.raises(Exception, match='write interrupted'):
            store.addChunks([chunk('doc-a', i, f'new {i}', random_vector(rng)) for i in range(2)])

        docs = store.get(DocFilter(objectIds=['doc-a'], limit=100))
        assert sorted(_texts(docs)) == ['old 0', 'old 1', 'old 2']

    def test_later_chunks_upsert_without_dropping_earlier_ones(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk('doc-a', 0, 'part 0', random_vector(rng))])
        store.addChunks([chunk('doc-a', 1, 'part 1', random_vector(rng))])
        store.addChunks([chunk('doc-a', 1, 'part 1 again', random_vector(rng))])

        docs = store.get(DocFilter(objectIds=['doc-a'], limit=100))
        assert sorted(_texts(docs)) == ['part 0', 'part 1 again']

    def test_mark_deleted_hides_and_mark_active_restores(self, make_store, rng):
        store = make_store()
        target = random_vector(rng)
        store.addChunks([chunk('doc-a', 0, 'alpha', target), chunk('doc-b', 0, 'beta', random_vector(rng))])

        store.markDeleted(['doc-a'])
        assert 'doc-a' not in {doc.metadata.objectId for doc in store.get(DocFilter(limit=100))}
        assert store.searchSemantic(question('alpha', target), DocFilter())[0].metadata.objectId != 'doc-a'
        assert store.searchKeyword(question('alpha'), DocFilter()) == []
        assert store.count_documents() == 1

        hidden = store.get(DocFilter(objectIds=['doc-a'], isDeleted=True))
        assert _texts(hidden) == ['alpha']
        assert hidden[0].metadata.isDeleted is True

        store.markActive(['doc-a'])
        assert store.get(DocFilter(objectIds=['doc-a']))[0].metadata.isDeleted is False
        assert store.searchSemantic(question('alpha', target), DocFilter())[0].metadata.objectId == 'doc-a'
        assert store.count_documents() == 2

    def test_remove_deletes_rows(self, make_store, rng):
        store = make_store()
        store.addChunks([chunk(f'doc-{i}', 0, f'text {i}', random_vector(rng)) for i in range(3)])
        store.remove(['doc-0', 'doc-2'])
        assert _texts(store.get(DocFilter(limit=100))) == ['text 1']

    def test_metadata_round_trips(self, make_store, rng):
        store = make_store()
        store.addChunks(
            [chunk('doc-t', 3, 'cell', random_vector(rng), parent='/x/t.csv', nodeId='n9', isTable=True, tableId=2)]
        )
        meta = store.get(DocFilter(objectIds=['doc-t']))[0].metadata
        assert (meta.objectId, meta.chunkId, meta.parent, meta.nodeId, meta.isTable, meta.tableId) == (
            'doc-t',
            3,
            '/x/t.csv',
            'n9',
            True,
            2,
        )


class TestReading:
    def test_render_joins_chunks_in_order(self, make_store, rng):
        store = make_store(renderChunkSize=4)
        order = [7, 2, 9, 0, 5, 1, 8, 3, 6, 4]
        store.addChunks([chunk('doc-a', 0, '[0]', random_vector(rng))])
        store.addChunks([chunk('doc-a', i, f'[{i}]', random_vector(rng)) for i in order if i])

        parts = []
        store.render('doc-a', parts.append)
        assert ''.join(parts) == ''.join(f'[{i}]' for i in range(10))
        assert len(parts) == 3

    def test_get_paths_lists_chunk_zero_of_live_documents(self, make_store, rng):
        store = make_store()
        store.addChunks(
            [
                chunk('doc-a', 0, 'a', random_vector(rng), parent='/x/a.txt'),
                chunk('doc-a', 1, 'a1', random_vector(rng), parent='/x/a.txt'),
                chunk('doc-b', 0, 'b', random_vector(rng), parent='/x/b.txt'),
                chunk('doc-c', 0, 'c', random_vector(rng), parent='/x/c.txt'),
            ]
        )
        store.markDeleted(['doc-c'])

        assert store.getPaths() == {'/x/a.txt': 'doc-a', '/x/b.txt': 'doc-b'}
        assert store.getPaths(parent='/x/b.txt') == {'/x/b.txt': 'doc-b'}
        assert len(store.getPaths(limit=1)) == 1


class TestLargerTable:
    def test_two_thousand_rows_end_to_end(self, make_store, rng):
        store = make_store(optimizeAfterWrites=3)
        vectors = {}
        for start in range(0, 2000, 250):
            batch = []
            for i in range(start, start + 250):
                vectors[i] = random_vector(rng)
                batch.append(chunk(f'doc-{i}', 0, f'document number {i} topic{i % 7}', vectors[i]))
            store.addChunks(batch)

        assert store.count_documents() == 2000

        for i in (0, 777, 1999):
            hits = store.searchSemantic(question('q', vectors[i]), DocFilter(limit=3))
            assert hits[0].metadata.objectId == f'doc-{i}'

        keyword = store.searchKeyword(question('topic3'), DocFilter(limit=1000))
        assert len(keyword) == len([i for i in range(2000) if i % 7 == 3])

        store.remove([f'doc-{i}' for i in range(1500)])
        assert store.count_documents() == 500
        assert store.searchSemantic(question('q', vectors[10]), DocFilter(limit=3))[0].metadata.objectId != 'doc-10'

        parts = []
        store.render('doc-1999', parts.append)
        assert parts == ['document number 1999 topic4']
