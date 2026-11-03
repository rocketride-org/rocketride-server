# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Filtered HNSW regressions against real PostgreSQL, with the real store/tools.

Uses the same RR_TEST_PG_DSN / RR_REQUIRE_DB_TESTS setup as the write suite.
The fixture deliberately puts more excluded neighbours ahead of the eligible
documents than HNSW's default candidate budget. EXPLAIN checks the executed
query, so a sequential scan cannot accidentally make the regression pass.
"""

from contextlib import contextmanager

import numpy as np
import pytest
from psycopg2.extras import execute_values

from .test_vector_store_listing_full import _tools
from .test_vector_store_writes_full import _doc
from .test_vector_store_writes_full import store_env as _shared_store_env

store_env = _shared_store_env
pytestmark = pytest.mark.parametrize('store_env', ['rocketride_vector'], indirect=True)


@pytest.fixture(params=['cosine', 'l2', 'inner_product'])
def indexed_store(store_env, monkeypatch, request):
    """100 near chunks, 30 eligible documents, and enough noise to use HNSW."""
    store, raw, table = store_env
    store.similarity = store.similarityDict[request.param]
    dimensions = 32
    query = [1.0] + [0.0] * (dimensions - 1)
    seed = _doc('seed', content='unrelated document')
    seed.embedding = [-1.0] + [0.0] * (dimensions - 1)
    store.addChunks([seed])

    rng = np.random.default_rng(2704)
    rows = []
    for i in range(4000):
        vector = rng.normal(size=dimensions)
        vector /= np.linalg.norm(vector)
        rows.append((f'noise-{i}', 0, '/noise', 'noise-node', 9, str(vector.tolist())))
    for i in range(100):
        vector = np.array([1.0, i / 1000] + [0.0] * (dimensions - 2))
        vector /= np.linalg.norm(vector)
        rows.append(('near', i, '/near', 'near-node', 1, str(vector.tolist())))
    for i in range(30):
        vector = np.array([1.0, 0.1 + i / 100] + [0.0] * (dimensions - 2))
        vector /= np.linalg.norm(vector)
        # Only the last three pass the metadata filters below. The closest
        # active neighbours must not crowd these out either.
        allowed = i >= 27
        rows.append(
            (
                f'active-{i:02d}',
                0,
                '/allowed' if allowed else '/other',
                'allowed-node' if allowed else 'other-node',
                7 if allowed else 2,
                str(vector.tolist()),
            )
        )
    with raw.cursor() as cur:
        execute_values(
            cur,
            f'INSERT INTO {table} (objectId, chunkId, parent, nodeId, permissionId, embedding, '
            'content, isDeleted, modelName, vectorSize) VALUES %s',
            rows,
            template="(%s, %s, %s, %s, %s, %s::vector, 'indexed fixture', false, 'test-model', 32)",
        )
        cur.execute(f'ANALYZE {table}')
    raw.commit()

    # Selective metadata filters can make the planner prefer a table scan.
    # Exercise HNSW explicitly on these isolated test connections; the exact
    # retry must still work without that index. Avoid JIT's artificial cost
    # threshold when a table scan is the only possible plan for the retry.
    for connection in (store.client, raw):
        with connection.cursor() as cur:
            cur.execute('SET enable_seqscan = off')
            cur.execute('SET jit = off')
            cur.execute('SET hnsw.ef_search = 40')
        connection.commit()

    # Record statements that the production driver actually executes.
    searches = []
    original_cursor = store._cursor

    class RecordingCursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def execute(self, sql, params=None):
            if ' AS distance ' in sql:
                searches.append((sql, params))
            return self.cursor.execute(sql, params)

        def __getattr__(self, name):
            return getattr(self.cursor, name)

    @contextmanager
    def recording_cursor():
        with original_cursor() as cur:
            yield RecordingCursor(cur)

    monkeypatch.setattr(store, '_cursor', recording_cursor)
    # Register the numpy adapter on the diagnostic connection too.
    from pgvector.psycopg2 import register_vector

    register_vector(raw)
    raw.commit()
    yield store, raw, table, query, searches


def _plan(raw, statement):
    with raw.cursor() as cur:
        cur.execute('EXPLAIN (ANALYZE, FORMAT JSON) ' + statement[0], statement[1])
        plan = cur.fetchone()[0][0]['Plan']
    raw.rollback()
    return plan


def _plan_nodes(plan):
    yield plan
    for child in plan.get('Plans', []):
        yield from _plan_nodes(child)


def _assert_indexed(raw, table, statement):
    nodes = list(_plan_nodes(_plan(raw, statement)))
    assert any(node.get('Index Name') == f'{table}_embedding_hnsw' for node in nodes), nodes


def test_semantic_search_survives_trash_and_restore(indexed_store):
    store, raw, table, query, searches = indexed_store
    tool = _tools(store)
    tool.IGlobal.embed_query = lambda text: query
    tool.IGlobal.embed_model_name = 'test-model'

    before = tool.search({'query': 'nearest document', 'top_k': 5})
    assert 'error' not in before, before
    assert {doc['metadata']['objectId'] for doc in before['results']} == {'near'}
    _assert_indexed(raw, table, searches[0])
    assert len(searches) == 1, 'A full approximate result needs no exact retry'

    assert tool.soft_delete({'object_ids': ['near']})['matched_chunks'] == 100
    searches.clear()
    after = tool.search({'query': 'nearest document', 'top_k': 5})
    _assert_indexed(raw, table, searches[0])
    assert 'error' not in after, after
    assert [doc['metadata']['objectId'] for doc in after['results']] == [f'active-{i:02d}' for i in range(5)]
    assert len(searches) == 2
    assert not any('hnsw' in node.get('Index Name', '') for node in _plan_nodes(_plan(raw, searches[1])))
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0
    assert tool.get({'object_id': 'near'})['success'] is False
    assert tool.list_documents({'deleted': True})['documents'] == [
        {'object_id': 'near', 'parent': '/near', 'chunk_count': 100}
    ]

    assert tool.restore({'object_ids': ['near']})['matched_chunks'] == 100
    restored = tool.search({'query': 'nearest document', 'top_k': 5})
    assert {doc['metadata']['objectId'] for doc in restored['results']} == {'near'}


@pytest.mark.parametrize(
    'filters',
    [
        {'parent': '/allowed'},
        {'nodeId': 'allowed-node'},
        {'permissions': {7}},
        {'objectIds': {'active-27', 'active-28', 'active-29'}},
    ],
)
def test_filtered_search_returns_eligible_documents_in_distance_order(indexed_store, filters):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    question = QuestionText(text='nearest document', embedding=query)
    results = store.searchSemantic(question, DocFilter(limit=5, **filters))
    _assert_indexed(raw, table, searches[0])
    assert [doc.metadata.objectId for doc in results] == ['active-27', 'active-28', 'active-29']
    assert [doc.score for doc in results] == sorted((doc.score for doc in results), reverse=True)


def test_unbounded_search_returns_all_eligible_documents(indexed_store):
    """An unlimited request returns every eligible document in one exact query."""
    from ai.common.schema import DocFilter, QuestionText

    store, raw, _, query, searches = indexed_store
    store.markDeleted(['near'])
    question = QuestionText(text='nearest document', embedding=query)
    results = store.searchSemantic(question, DocFilter(limit=None, nodeId='other-node'))
    assert [doc.metadata.objectId for doc in results] == [f'active-{i:02d}' for i in range(27)]
    assert len(searches) == 1
    assert not any('hnsw' in node.get('Index Name', '') for node in _plan_nodes(_plan(raw, searches[0])))


def test_empty_filtered_search_stays_empty(indexed_store):
    from ai.common.schema import DocFilter, QuestionText

    store, _, _, query, _ = indexed_store
    question = QuestionText(text='nearest document', embedding=query)
    assert store.searchSemantic(question, DocFilter(parent='/missing', limit=5)) == []
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0


def test_underfilled_nonempty_search_recovers_remaining_matches(indexed_store):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    question = QuestionText(text='nearest document', embedding=query)
    results = store.searchSemantic(
        question,
        DocFilter(limit=5, objectIds=['near', 'active-27', 'active-28', 'active-29'], chunkIds=[0]),
    )
    _assert_indexed(raw, table, searches[0])
    assert 0 < _plan(raw, searches[0])['Actual Rows'] < 4
    assert [doc.metadata.objectId for doc in results] == ['near', 'active-27', 'active-28', 'active-29']


@pytest.mark.parametrize('indexed_store', ['cosine'], indirect=True)
@pytest.mark.parametrize('missing', [False, True])
def test_exact_retry_omits_vectors_without_a_cosine_distance(indexed_store, missing):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    with raw.cursor() as cur:
        cur.execute(
            f'INSERT INTO {table} (objectId, content, isDeleted, embedding) VALUES (%s, %s, false, %s)',
            ('undefined-distance', 'no cosine distance', None if missing else str([0.0] * len(query))),
        )
    raw.commit()
    question = QuestionText(text='nearest document', embedding=query)
    assert store.searchSemantic(question, DocFilter(objectIds=['undefined-distance'], limit=5)) == []
    _assert_indexed(raw, table, searches[0])
