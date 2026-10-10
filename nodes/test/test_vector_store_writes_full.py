# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Real PostgreSQL regression tests for both vector-store write paths.

Run with the built engine and RR_TEST_PG_DSN pointing to a pgvector database.
Set RR_REQUIRE_DB_TESTS=1 to fail instead of skip when dependencies or the DB
are unavailable. Each test uses a unique table; no existing data is modified.
The Doc models and DocumentStoreBase are real, including their schema row.
"""

import importlib.util
import os
import sys
import types
from pathlib import Path
from uuid import uuid4

import pytest

_REPO = Path(__file__).resolve().parents[2]
_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))


@pytest.fixture(params=['rocketride_vector', 'store_postgres'])
def store_env(monkeypatch, request):
    """Load the source driver and real schema against an isolated table."""
    if _REQUIRED:
        import rocketlib  # noqa: F401
        import psycopg2
        import pgvector  # noqa: F401
    else:
        pytest.importorskip('rocketlib', reason='Run these tests with the built engine')
        psycopg2 = pytest.importorskip('psycopg2')
        pytest.importorskip('pgvector')
    dsn = os.environ.get('RR_TEST_PG_DSN')
    if not dsn:
        if _REQUIRED:
            pytest.fail('RR_REQUIRE_DB_TESTS needs RR_TEST_PG_DSN')
        pytest.skip('Set RR_TEST_PG_DSN to a pgvector test database')
    try:
        raw = psycopg2.connect(dsn, connect_timeout=3)
    except psycopg2.OperationalError:
        if _REQUIRED:
            pytest.fail('Required PostgreSQL test database is unavailable')
        pytest.skip('PostgreSQL test database is unavailable')

    for src in ('packages/ai/src', 'packages/client-python/src', 'nodes/src'):
        monkeypatch.syspath_prepend(str(_REPO / src))
    monkeypatch.setenv('ROCKETRIDE_DB_DSN', dsn)
    node = request.param
    driver = 'rocketride_vector' if node == 'rocketride_vector' else 'postgres'
    node_dir = _REPO / 'nodes/src/nodes' / node
    pkg = types.ModuleType(f'nodes.{node}')
    pkg.__path__ = [str(node_dir)]
    monkeypatch.setitem(sys.modules, pkg.__name__, pkg)
    store = None
    table = 'rr_write_test_' + uuid4().hex
    try:
        for name in ('IGlobal', driver):
            spec = importlib.util.spec_from_file_location(f'nodes.{node}.{name}', node_dir / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            monkeypatch.setitem(sys.modules, spec.name, module)
            spec.loader.exec_module(module)
        config = {'collection': table, 'similarity': 'cosine'}
        if node == 'store_postgres':
            fields = psycopg2.extensions.parse_dsn(dsn)
            config.update(
                host=fields['host'],
                port=int(fields.get('port', 5432)),
                user=fields['user'],
                password=fields.get('password', ''),
                database=fields['dbname'],
            )
        store = module.Store(driver, config, {})
        yield store, raw, table
    finally:
        if store is not None and store.client is not None:
            store.client.close()
            store.client = None
        raw.rollback()
        with raw.cursor() as cur:
            cur.execute(f'DROP TABLE IF EXISTS {table}')
        raw.commit()
        raw.close()


def _doc(object_id='a', chunk_id=0, content='original', **metadata):
    from rocketride.schema import Doc, DocMetadata

    return Doc(
        page_content=content,
        metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, parent='/test', isDeleted=False, **metadata),
        embedding=[1.0, 0.0, 0.0],
        embedding_model='test-model',
    )


def _rows(conn, table):
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT objectId, chunkId, content FROM {table} WHERE objectId != 'schema' ORDER BY objectId, chunkId"
        )
        return cur.fetchall()


@pytest.mark.parametrize(
    'metadata',
    [{}, {'signature': 'test-signature', 'extraField': 'ignored'}],
    ids=['default-signature', 'signature-and-extra'],
)
def test_real_metadata_and_schema_row_can_be_written(store_env, metadata):
    store, raw, table = store_env
    doc = _doc(**metadata)
    assert 'signature' in doc.metadata.model_dump()
    store.addChunks([doc])
    assert _rows(raw, table) == [('a', 0, 'original')]
    with raw.cursor() as cur:
        cur.execute(f"SELECT modelName, vectorSize FROM {table} WHERE objectId = 'schema'")
        assert cur.fetchall() == [('test-model', 3)]


def test_replacement_preserves_other_documents(store_env):
    store, raw, table = store_env
    store.addChunks([_doc(), _doc(chunk_id=1), _doc('b')])
    store.addChunks([_doc(content='replacement')])
    assert _rows(raw, table) == [('a', 0, 'replacement'), ('b', 0, 'original')]


def test_failed_batch_rolls_back_deletion_and_partial_inserts(store_env):
    import psycopg2

    store, raw, table = store_env
    # Seed directly so the baseline metadata bug cannot mask the delete-before-
    # insert bug. This also exercises the driver with collection checks disabled.
    store._createCollection(3)
    with raw.cursor() as cur:
        cur.execute(
            f"INSERT INTO {table} (objectId, chunkId, content) VALUES ('a', 0, 'original'), ('b', 0, 'original'), ('c', 0, 'untouched')"
        )
    raw.commit()
    bad = _doc('b')
    bad.embedding = [float('nan'), 0.0, 0.0]
    with pytest.raises(psycopg2.DataError, match='NaN'):
        store.addChunks([_doc(content='replacement'), bad], checkCollection=False)
    assert _rows(raw, table) == [('a', 0, 'original'), ('b', 0, 'original'), ('c', 0, 'untouched')]
    # A failed transaction must be rolled back so this same connection works.
    store.addChunks([_doc(content='recovered')], checkCollection=False)
    assert _rows(raw, table) == [('a', 0, 'recovered'), ('b', 0, 'original'), ('c', 0, 'untouched')]


def test_empty_batch_does_not_create_a_collection(store_env):
    store, raw, table = store_env
    store.addChunks([])
    with raw.cursor() as cur:
        cur.execute('SELECT to_regclass(%s)', (table,))
        assert cur.fetchone()[0] is None
