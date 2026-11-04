# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Filtered HNSW regressions for both PostgreSQL vector stores and their tools.

Uses the same RR_TEST_PG_DSN / RR_REQUIRE_DB_TESTS setup as the write suite.
Deliberately not named *_full.py: Linux CI provisions pgvector but the normal
nodes:test runner excludes that suffix. Other platforms skip without a DB.
The fixture deliberately puts more excluded neighbours ahead of the eligible
documents than HNSW's default candidate budget. EXPLAIN checks the executed
query, so a sequential scan cannot accidentally make the regression pass.
"""

from concurrent.futures import ThreadPoolExecutor

import pytest

from .test_vector_store_listing_full import _tools
from .test_vector_store_writes_full import _doc
from .test_vector_store_writes_full import store_env as _shared_store_env

store_env = _shared_store_env
pytestmark = pytest.mark.parametrize('store_env', ['rocketride_vector', 'store_postgres'], indirect=True)


@pytest.fixture(params=['cosine', 'l2', 'inner_product'])
def indexed_store(store_env, request):
    """100 near chunks, 30 eligible documents, and enough noise to use HNSW."""
    import numpy as np
    from psycopg2.extras import execute_values

    store, raw, table = store_env
    store.similarity = store.similarityDict[request.param]
    dimensions = 32
    query = [1.0] + [0.0] * (dimensions - 1)
    seed = _doc('seed', content='unrelated document')
    seed.embedding = [-1.0] + [0.0] * (dimensions - 1)
    store.addChunks([seed])
    # The generic store deliberately creates no vector index. Exercise the
    # same supported pgvector query after an administrator adds HNSW.
    with raw.cursor() as cur:
        opclass = {'cosine': 'vector_cosine_ops', 'l2': 'vector_l2_ops', 'inner_product': 'vector_ip_ops'}[
            request.param
        ]
        cur.execute(f'CREATE INDEX IF NOT EXISTS {table}_embedding_hnsw ON {table} USING hnsw (embedding {opclass})')
    raw.commit()

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

    # Instrument the DB cursor rather than store helper methods so this same
    # fixture can exercise the pre-fix drivers, which used direct cursors.
    from psycopg2.extensions import cursor

    class RecordingCursor(cursor):
        def execute(self, sql, params=None):
            if ' AS distance ' in sql:
                searches.append((sql, params))
            return super().execute(sql, params)

    store.client.cursor_factory = RecordingCursor
    # Register the numpy adapter on the diagnostic connection too.
    from pgvector.psycopg2 import register_vector

    register_vector(raw)
    raw.commit()
    yield store, raw, table, query, searches


def _plan(raw, statement):
    with raw.cursor() as cur:
        cur.execute('SET LOCAL hnsw.iterative_scan = strict_order')
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
    assert len(searches) == 1, 'Modern pgvector needs only the iterative query'

    assert tool.soft_delete({'object_ids': ['near']})['matched_chunks'] == 100
    searches.clear()
    after = tool.search({'query': 'nearest document', 'top_k': 5})
    _assert_indexed(raw, table, searches[0])
    assert 'error' not in after, after
    assert [doc['metadata']['objectId'] for doc in after['results']] == [f'active-{i:02d}' for i in range(5)]
    assert len(searches) == 1
    assert 'distance + 0' not in searches[0][0]
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0
    with store.client.cursor() as cur:
        cur.execute('SHOW hnsw.iterative_scan')
        assert cur.fetchone()[0] == 'off', 'SET LOCAL must not leak beyond the search'
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
    assert len(searches) == 1, 'Fewer qualifying documents must not cause an exact retry'


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

    store, _, _, query, searches = indexed_store
    question = QuestionText(text='nearest document', embedding=query)
    assert store.searchSemantic(question, DocFilter(parent='/missing', limit=5)) == []
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0
    assert len(searches) == 2, 'An empty ANN answer needs exact confirmation'


@pytest.mark.parametrize('indexed_store', ['cosine'], indirect=True)
def test_unindexed_search_does_not_repeat_an_exact_scan(indexed_store):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    with raw.cursor() as cur:
        cur.execute(f'DROP INDEX {table}_embedding_hnsw')
    raw.commit()
    results = store.searchSemantic(QuestionText(text='nearest', embedding=query), DocFilter(parent='/missing', limit=5))
    assert results == []
    assert len(searches) == 1
    assert not any('hnsw' in node.get('Index Name', '') for node in _plan_nodes(_plan(raw, searches[0])))


def test_underfilled_nonempty_search_recovers_remaining_matches(indexed_store):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    question = QuestionText(text='nearest document', embedding=query)
    results = store.searchSemantic(
        question,
        DocFilter(limit=5, objectIds=['near', 'active-27', 'active-28', 'active-29'], chunkIds=[0]),
    )
    _assert_indexed(raw, table, searches[0])
    assert _plan(raw, searches[0])['Actual Rows'] == 4
    assert [doc.metadata.objectId for doc in results] == ['near', 'active-27', 'active-28', 'active-29']
    assert len(searches) == 1


def test_limit_larger_than_initial_candidate_budget_uses_one_scan(indexed_store):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    results = store.searchSemantic(QuestionText(text='nearest', embedding=query), DocFilter(limit=100))
    assert len(results) == 100
    assert {doc.metadata.objectId for doc in results} == {'near'}
    assert len(searches) == 1
    _assert_indexed(raw, table, searches[0])


@pytest.mark.parametrize('indexed_store', ['cosine'], indirect=True)
def test_duplicate_neighbours_do_not_hide_last_relevant_active_document(indexed_store):
    """Mirror the duplicate-heavy OpenAI reproducer without a network dependency."""
    import numpy as np
    from psycopg2.extras import execute_values
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    rng = np.random.default_rng(2631)
    other = np.array([1.0, 0.38] + [0.0] * 30)
    other /= np.linalg.norm(other)
    noise = rng.normal(size=(300, 32))
    noise[:, 0] = 0.0
    noise /= np.linalg.norm(noise, axis=1, keepdims=True)
    rows = [('near', 0, str(query)), ('other', 0, str(other.tolist()))]
    rows += [(f'noise-{i}', chunk, str(vector.tolist())) for chunk in range(20) for i, vector in enumerate(noise)]
    rows += [('near', chunk, str(query)) for chunk in range(1, 100)]
    with raw.cursor() as cur:
        cur.execute(f'TRUNCATE {table}')
        execute_values(
            cur,
            f'INSERT INTO {table} (objectId, chunkId, embedding, content, isDeleted) VALUES %s',
            rows,
            template="(%s, %s, %s::vector, 'duplicate fixture', false)",
        )
        cur.execute(f'ANALYZE {table}')
    raw.commit()
    store.markDeleted(['near'])
    results = store.searchSemantic(QuestionText(text='nearest', embedding=query), DocFilter(limit=10))
    assert [doc.metadata.objectId for doc in results] == ['other']
    assert results[0].score > 0.9
    _assert_indexed(raw, table, searches[0])


@pytest.mark.parametrize('indexed_store', ['cosine'], indirect=True)
@pytest.mark.parametrize('missing', [False, True])
@pytest.mark.parametrize('ann_index', [False, True])
def test_search_omits_vectors_without_a_cosine_distance(indexed_store, missing, ann_index):
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    store._iterative_scan = False  # Exercise the compatibility path for pgvector before 0.8.
    with raw.cursor() as cur:
        if not ann_index:
            cur.execute(f'DROP INDEX {table}_embedding_hnsw')
        cur.execute(
            f'INSERT INTO {table} (objectId, chunkId, content, isDeleted, embedding) VALUES (%s, 0, %s, false, %s)',
            ('undefined-distance', 'no cosine distance', None if missing else str([0.0] * len(query))),
        )
    raw.commit()
    question = QuestionText(text='nearest document', embedding=query)
    assert store.searchSemantic(question, DocFilter(objectIds=['undefined-distance'], limit=5)) == []
    if ann_index:
        _assert_indexed(raw, table, searches[0])


def test_legacy_fallback_recovers_matches_after_trash(indexed_store):
    """The pre-0.8 path keeps exact recovery for excluded HNSW neighbours."""
    from ai.common.schema import DocFilter, QuestionText

    store, raw, table, query, searches = indexed_store
    store._iterative_scan = False
    store.markDeleted(['near'])
    results = store.searchSemantic(QuestionText(text='nearest', embedding=query), DocFilter(limit=5))
    assert [doc.metadata.objectId for doc in results] == [f'active-{i:02d}' for i in range(5)]
    assert len(searches) == 2
    _assert_indexed(raw, table, searches[0])
    assert not any('hnsw' in node.get('Index Name', '') for node in _plan_nodes(_plan(raw, searches[1])))


def test_failed_iterative_query_releases_transaction_and_local_setting(indexed_store):
    """A failed search leaves the shared connection usable and unpinned."""
    import psycopg2
    from ai.common.schema import DocFilter, QuestionText

    store, _, _, query, _ = indexed_store
    with pytest.raises(psycopg2.DataError, match='different vector dimensions'):
        store.searchSemantic(QuestionText(text='bad dimensions', embedding=[1.0, 0.0]), DocFilter(limit=5))
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0
    with store.client.cursor() as cur:
        cur.execute('SHOW hnsw.iterative_scan')
        assert cur.fetchone()[0] == 'off'
    assert store.searchSemantic(QuestionText(text='nearest', embedding=query), DocFilter(limit=5))


def test_shared_connection_serializes_iterative_searches(indexed_store):
    """Concurrent callers do not leak transactions or overlap connection settings."""
    from ai.common.schema import DocFilter, QuestionText

    store, _, _, query, _ = indexed_store
    question = QuestionText(text='nearest', embedding=query)
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: store.searchSemantic(question, DocFilter(limit=5)), range(6)))
    assert all({doc.metadata.objectId for doc in docs} == {'near'} for docs in results)
    assert store.client.autocommit is True
    assert store.client.get_transaction_status() == 0
