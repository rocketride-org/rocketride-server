# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Live suite for the shared pgvector driver (``ai.common.store.pgvector``).

Both ``store_postgres`` and ``rocketride_vector`` store their chunks through
``PgVectorStore``. This suite drives the real driver, with the real schema
classes (``Doc``, ``DocMetadata``, ``DocFilter``), against a real PostgreSQL +
pgvector server, once directly and once through a transaction-mode pooler:

* ``RR_TEST_PG_DSN`` — the database itself
  (default ``postgresql://rruser:rrpass@localhost:55432/rrtenant``);
* ``RR_TEST_PGVECTOR_POOLER_DSN`` — the same database behind PgBouncer in
  ``pool_mode = transaction``; the pooled cases are not run without it;
* ``RR_TEST_PG_ADMIN_DSN`` — where the suite inspects the server
  (``pg_stat_activity``, ``DROP TABLE``); defaults to ``RR_TEST_PG_DSN``;
* ``RR_TEST_PGVECTOR_LEGACY_TABLE`` — a table written by the drivers this one
  replaces (default ``vx_legacy_docs``). The suite copies it into a table of its
  own before opening it, because opening adds the ``meta`` column.

Every table this suite creates is named ``vx_l2_*`` and dropped afterwards.
The duration of the parallel-load case is ``RR_TEST_PGVECTOR_SOAK_S``
(default 60 seconds).

Skips when the database is unreachable, unless ``RR_REQUIRE_DB_TESTS`` is set.
"""

from __future__ import annotations

import dataclasses
import importlib
import json
import math
import os
import sys
import threading
import time
import types
import uuid

from typing import Optional

import pytest

DIRECT_DSN = os.environ.get('RR_TEST_PG_DSN', 'postgresql://rruser:rrpass@localhost:55432/rrtenant')
POOLER_DSN = os.environ.get('RR_TEST_PGVECTOR_POOLER_DSN', '').strip()
ADMIN_DSN = os.environ.get('RR_TEST_PG_ADMIN_DSN', DIRECT_DSN)
LEGACY_TABLE = os.environ.get('RR_TEST_PGVECTOR_LEGACY_TABLE', 'vx_legacy_docs')
SOAK_S = float(os.environ.get('RR_TEST_PGVECTOR_SOAK_S', '60'))

_DB_TESTS_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))

if _DB_TESTS_REQUIRED:
    import numpy as np
    import psycopg2
else:
    psycopg2 = pytest.importorskip('psycopg2')
    np = pytest.importorskip('numpy')


def _db_reachable(dsn: str) -> bool:
    try:
        conn = psycopg2.connect(dsn, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


if _DB_TESTS_REQUIRED and not _db_reachable(DIRECT_DSN):
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but the test database is not reachable at {DIRECT_DSN}', pytrace=False)

pytestmark = pytest.mark.skipif(
    not _db_reachable(DIRECT_DSN), reason=f'pgvector test database not reachable at {DIRECT_DSN}'
)

DIM = 16
MODEL = 'test-model'


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(params=['direct', 'pooler'])
def dsn(request) -> str:
    """The DSN the driver connects with: the database itself, or the transaction-mode pooler."""
    if request.param == 'pooler':
        if not POOLER_DSN:
            pytest.skip('NOT RUN: RR_TEST_PGVECTOR_POOLER_DSN is not set (the transaction-mode pooler pass)')
        if not _db_reachable(POOLER_DSN):
            if _DB_TESTS_REQUIRED:
                pytest.fail(f'RR_TEST_PGVECTOR_POOLER_DSN is set but not reachable: {POOLER_DSN}')
            pytest.skip(f'NOT RUN: pooler not reachable at {POOLER_DSN}')
        return POOLER_DSN
    return DIRECT_DSN


@pytest.fixture()
def admin():
    """An autocommit connection straight to the database, for inspection and cleanup."""
    conn = psycopg2.connect(ADMIN_DSN, connect_timeout=5)
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture()
def table(admin):
    """A fresh ``vx_l2_*`` table name; the table is dropped afterwards."""
    name = f'vx_l2_{uuid.uuid4().hex[:10]}'
    yield name
    _drop(admin, name)


@pytest.fixture()
def stores():
    """Track opened stores and close their pools at teardown."""
    opened = []
    yield opened
    for store in opened:
        try:
            store.close()
        except Exception:
            pass


def _drop(admin, name: str) -> None:
    with admin.cursor() as cur:
        cur.execute("SET lock_timeout = '10s'")
        cur.execute(f'DROP TABLE IF EXISTS "{name}"')


def _schema():
    from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText

    return types.SimpleNamespace(Doc=Doc, DocFilter=DocFilter, DocMetadata=DocMetadata, QuestionText=QuestionText)


def _filter(**kw):
    """A DocFilter that also carries ``deleted`` and ``minScore`` (the explorer fields)."""
    from ai.common.schema import DocFilter

    class _Filter(DocFilter):
        deleted: Optional[str] = None
        minScore: Optional[float] = None

    return _Filter(**kw)


def _open(dsn: str, table: str, stores, **kw):
    from ai.common.store.pgvector import PgVectorStore

    store = PgVectorStore('postgres', {}, {}, connect_args={'dsn': dsn}, table=table, **kw)
    stores.append(store)
    return store


def _unit(rng, dim: int = DIM):
    v = rng.standard_normal(dim)
    return (v / np.linalg.norm(v)).tolist()


def _doc(
    object_id: str, chunk_id: int, embedding, *, content: Optional[str] = None, parent: Optional[str] = None, **extra
):
    s = _schema()
    meta = s.DocMetadata(
        objectId=object_id,
        chunkId=chunk_id,
        nodeId='chunk_1',
        parent=parent if parent is not None else f'C:/demo/{object_id}.md',
        permissionId=0,
        isDeleted=False,
        isTable=False,
        tableId=0,
        signature='component-signature',
        **extra,
    )
    return s.Doc(
        page_content=content if content is not None else f'{object_id} chunk {chunk_id}',
        metadata=meta,
        embedding=list(embedding),
        embedding_model=MODEL,
    )


def _ingest(store, rng, object_id: str, n_chunks: int, *, batch: int = 64, **extra):
    """Ingest one document the way the embedding node does: batches of ``batch`` chunks."""
    docs = [_doc(object_id, i, _unit(rng), **extra) for i in range(n_chunks)]
    for start in range(0, n_chunks, batch):
        store.addChunks(docs[start : start + batch])
    return docs


def _rows(admin, table: str, where: str = 'TRUE', params=()):
    with admin.cursor() as cur:
        cur.execute(
            f'SELECT objectid, chunkid, content FROM "{table}" WHERE {where} ORDER BY objectid, chunkid', params
        )
        return cur.fetchall()


def _columns(admin, table: str):
    with admin.cursor() as cur:
        cur.execute(
            'SELECT attname FROM pg_attribute WHERE attrelid = to_regclass(%s) AND attnum > 0 AND NOT attisdropped',
            (f'"{table}"',),
        )
        return {r[0] for r in cur.fetchall()}


def _idle_in_transaction(admin, table: str) -> int:
    with admin.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%%' AND query LIKE %s",
            (f'%{table}%',),
        )
        return cur.fetchone()[0]


# ---------------------------------------------------------------------------
# Ingest (D1, D3), re-ingest (AC-19), extras
# ---------------------------------------------------------------------------


class TestIngest:
    def test_real_doc_with_signature_and_extras_is_stored(self, dsn, table, stores, admin):
        rng = np.random.default_rng(1)
        store = _open(dsn, table, stores)
        store.addChunks(
            [
                _doc(
                    'doc-a', 0, _unit(rng), parentId='p-1', chunk_index=0, size=7419, ingestedAt='2026-10-08T18:20:11Z'
                ),
                _doc(
                    'doc-a', 1, _unit(rng), parentId='p-1', chunk_index=1, size=7419, ingestedAt='2026-10-08T18:20:11Z'
                ),
            ]
        )
        with admin.cursor() as cur:
            cur.execute(
                f'SELECT chunkid, signature, meta FROM "{table}" WHERE objectid = %s ORDER BY chunkid', ('doc-a',)
            )
            rows = cur.fetchall()
            cur.execute(
                f'SELECT count(*), max(modelname), max(vectorsize) FROM "{table}" WHERE objectid = %s', ('schema',)
            )
            control = cur.fetchone()
        assert [r[0] for r in rows] == [0, 1]
        assert all(r[1] == 'component-signature' for r in rows)
        assert rows[0][2]['parentId'] == 'p-1'
        assert rows[0][2]['size'] == 7419
        assert rows[0][2]['ingestedAt'] == '2026-10-08T18:20:11Z'
        assert rows[1][2]['chunk_index'] == 1
        # Exactly one control record, carrying the model and the dimension.
        assert control == (1, MODEL, DIM)
        assert store.describe().meta_column is True

    def test_new_table_gets_hnsw_and_key_indexes(self, dsn, table, stores, admin):
        rng = np.random.default_rng(2)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc-a', 3)
        with admin.cursor() as cur:
            cur.execute('SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s', (table,))
            indexes = dict(cur.fetchall())
        hnsw = indexes[f'{table}_embedding_hnsw']
        assert 'USING hnsw (embedding vector_cosine_ops)' in hnsw
        assert "m='16'" in hnsw and "ef_construction='64'" in hnsw
        assert any('(objectid, chunkid)' in ddl for ddl in indexes.values())

    def test_long_table_names_get_two_distinct_indexes(self, dsn, table, stores, admin):
        """62- and 63-character names (the identifier limit) still get both indexes, named apart from the table."""
        rng = np.random.default_rng(7)
        names = [(table + '_' + 'x' * 63)[:63], (table + '_' + 'x' * 63)[:62], (table + '_' + 'y' * 63)[:63]]
        try:
            for name in names:
                store = _open(dsn, name, stores)
                _ingest(store, rng, 'doc', 2)
            with admin.cursor() as cur:
                cur.execute('SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY(%s)', (names,))
                found = cur.fetchall()
            by_table = {}
            for tablename, indexname, indexdef in found:
                by_table.setdefault(tablename, {})[indexname] = indexdef
            assert set(by_table) == set(names)
            for name, indexes in by_table.items():
                assert name not in indexes and all(len(n) <= 63 for n in indexes)
                assert any('USING hnsw' in d for d in indexes.values())
                assert any('(objectid, chunkid)' in d for d in indexes.values())
            assert len({n for indexes in by_table.values() for n in indexes}) == 3 * 3  # pkey, key, hnsw each
        finally:
            for name in names:
                _drop(admin, name)

    def test_two_batch_reingest_keeps_both_batches(self, dsn, table, stores, admin):
        """A document flushed in two batches (chunk 0 in the first) keeps every chunk (AC-19)."""
        rng = np.random.default_rng(3)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'long', 81, batch=64)
        assert [r[1] for r in _rows(admin, table, 'objectid = %s', ('long',))] == list(range(81))

        # Re-ingesting the document replaces every chunk, including the second batch's.
        _ingest(store, rng, 'long', 70, batch=64)
        assert [r[1] for r in _rows(admin, table, 'objectid = %s', ('long',))] == list(range(70))

    def test_batch_without_chunk_zero_replaces_only_its_own_keys(self, dsn, table, stores, admin):
        rng = np.random.default_rng(4)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 4)
        store.addChunks(
            [_doc('doc', 2, _unit(rng), content='replaced two'), _doc('doc', 5, _unit(rng), content='new five')]
        )
        rows = _rows(admin, table, 'objectid = %s', ('doc',))
        assert [(r[1], r[2]) for r in rows] == [
            (0, 'doc chunk 0'),
            (1, 'doc chunk 1'),
            (2, 'replaced two'),
            (3, 'doc chunk 3'),
            (5, 'new five'),
        ]

    def test_content_with_nul_bytes_is_stored(self, dsn, table, stores, admin):
        rng = np.random.default_rng(5)
        store = _open(dsn, table, stores)
        store.addChunks([_doc('nul', 0, _unit(rng), content='a\x00b')])
        assert _rows(admin, table, 'objectid = %s', ('nul',))[0][2] == 'ab'

    def test_concurrent_first_writes_create_one_control_record(self, dsn, table, stores, admin):
        """Four tasks writing to a new table at once: every write succeeds and there is one control record."""
        rng = np.random.default_rng(6)
        writers = [_open(dsn, table, stores) for _ in range(4)]
        batches = [[_doc(f'd{w}', i, _unit(rng)) for i in range(3)] for w in range(len(writers))]
        start = threading.Barrier(len(writers))
        errors = []

        def write(store, docs):
            start.wait(10)
            try:
                store.addChunks(docs)
            except Exception as e:  # noqa: BLE001 - asserted below
                errors.append(repr(e))

        threads = [threading.Thread(target=write, args=pair) for pair in zip(writers, batches)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert not any(t.is_alive() for t in threads)
        assert errors == []
        with admin.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{table}" WHERE objectid = %s', ('schema',))
            assert cur.fetchone()[0] == 1
        assert len(_rows(admin, table, 'objectid <> %s', ('schema',))) == 12


# ---------------------------------------------------------------------------
# Connection hygiene (D2, D5, AC-18), pooling, failures
# ---------------------------------------------------------------------------


class TestConnections:
    def test_failed_statement_does_not_poison_later_calls(self, dsn, table, stores, admin):
        rng = np.random.default_rng(10)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 3)
        s = _schema()

        bad = s.QuestionText(text='wrong width')
        bad.embedding = _unit(rng, DIM + 3)
        with pytest.raises(Exception) as err:
            store.searchSemantic(bad, s.DocFilter(limit=3))
        assert 'dimension' in str(err.value).lower()

        good = s.QuestionText(text='right width')
        good.embedding = _unit(rng)
        assert len(store.searchSemantic(good, _filter(limit=3, minScore=-math.inf))) == 3

        # A failed write (a vector of the wrong width) leaves the store writable.
        with pytest.raises(Exception):
            store.addChunks([_doc('bad', 0, _unit(rng, DIM + 1))], checkCollection=False)
        store.addChunks([_doc('after', 0, _unit(rng))])
        assert store.countChunks(_filter(objectIds=['after'])) == 1

    def test_reads_leave_no_session_in_transaction_and_drop_is_not_blocked(self, dsn, table, stores, admin):
        """AC-18: after reads, nothing is idle in transaction, and DROP TABLE runs at once."""
        rng = np.random.default_rng(11)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 5)
        s = _schema()
        q = s.QuestionText(text='q')
        q.embedding = _unit(rng)
        store.searchSemantic(q, s.DocFilter(limit=3))
        store.countChunks(_filter())
        store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
        store.count_documents()
        store.get(s.DocFilter(objectIds=['doc'], limit=10))
        assert store._db.pool_size >= 1  # the pool kept a connection open
        assert _idle_in_transaction(admin, table) == 0
        with admin.cursor() as cur:
            cur.execute("SET lock_timeout = '5s'")
            cur.execute(f'DROP TABLE "{table}"')

    def test_parallel_reads_with_an_ingest(self, dsn, table, stores, admin):
        """20 parallel readers and one writer for SOAK_S seconds: no errors, nothing left in a transaction."""
        rng = np.random.default_rng(12)
        store = _open(dsn, table, stores)
        for i in range(10):
            _ingest(store, rng, f'seed-{i:02d}', 4)
        s = _schema()
        stop = time.monotonic() + SOAK_S
        errors: list = []
        counts = {'reads': 0, 'writes': 0}
        lock = threading.Lock()

        def reader(i):
            local = np.random.default_rng(100 + i)
            while time.monotonic() < stop:
                try:
                    kind = i % 5
                    if kind == 0:
                        q = s.QuestionText(text='q')
                        q.embedding = _unit(local)
                        store.searchSemantic(q, s.DocFilter(objectIds=['seed-01', 'seed-02'], limit=4))
                    elif kind == 1:
                        store.countChunks(_filter())
                    elif kind == 2:
                        store.listDocumentPage(cursor=None, limit=50, object_ids=None, deleted='active', sort='path')
                    elif kind == 3:
                        store.get(s.DocFilter(objectIds=['seed-03'], limit=10))
                    else:
                        store.describe()
                    with lock:
                        counts['reads'] += 1
                except Exception as e:  # noqa: BLE001 - reported below
                    errors.append(('read', i, repr(e)))

        def writer():
            n = 0
            local = np.random.default_rng(99)
            while time.monotonic() < stop:
                try:
                    _ingest(store, local, f'live-{n:05d}', 3)
                    n += 1
                    with lock:
                        counts['writes'] += 1
                except Exception as e:  # noqa: BLE001 - reported below
                    errors.append(('write', n, repr(e)))

        threads = [threading.Thread(target=reader, args=(i,)) for i in range(20)] + [threading.Thread(target=writer)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(SOAK_S + 60)
        assert not any(t.is_alive() for t in threads), 'a worker hung'
        assert errors == []
        assert counts['reads'] > 20 and counts['writes'] > 0
        assert store.countDocumentsWhere(_filter()) == 10 + counts['writes']
        assert store._db.pool_size <= 4
        assert _idle_in_transaction(admin, table) == 0

    def test_idle_connections_are_released(self, dsn, table, stores, admin):
        """The pool opens connections on demand and closes them after the idle timeout (60 s by default)."""
        import inspect

        from ai.common.store.pgvector import PgVectorStore

        assert inspect.signature(PgVectorStore).parameters['idle_timeout_s'].default == 60.0
        rng = np.random.default_rng(13)
        idle_s = 2.0  # the production 60 s is asserted above; the release itself is what is measured here
        store = _open(dsn, table, stores, idle_timeout_s=idle_s)
        _ingest(store, rng, 'doc', 3)
        s = _schema()
        threads = [
            threading.Thread(target=lambda: [store.get(s.DocFilter(objectIds=['doc'], limit=5)) for _ in range(20)])
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        assert 1 <= store._db.pool_size <= 4
        deadline = time.monotonic() + idle_s + 15
        while store._db.pool_size and time.monotonic() < deadline:
            time.sleep(0.5)
        assert store._db.pool_size == 0
        if dsn == POOLER_DSN:
            # Server connections the pooler keeps for this database stay within its pool size.
            conn = psycopg2.connect(POOLER_DSN, connect_timeout=5)
            try:
                with conn.cursor() as cur:
                    cur.execute('SELECT inet_client_addr()')
                    pooler_addr = cur.fetchone()[0]
                conn.rollback()
            finally:
                conn.close()
            with admin.cursor() as cur:
                cur.execute(
                    'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND client_addr = %s',
                    (pooler_addr,),
                )
                assert cur.fetchone()[0] <= 6

    def test_unreachable_server_reports_no_host(self, table, stores):
        from ai.common.store.errors import StoreError
        from ai.common.store.pgvector import PgVectorStore

        with pytest.raises(StoreError) as err:
            PgVectorStore(
                'postgres', {}, {}, connect_args={'dsn': 'postgresql://rruser:rrpass@127.0.0.1:1/rrtenant'}, table=table
            )
        text = str(err.value)
        assert '127.0.0.1' not in text and 'rrpass' not in text and 'rrtenant' not in text


# ---------------------------------------------------------------------------
# Search: HNSW iterative scan under the pooler, floor, keyword
# ---------------------------------------------------------------------------


def _bulk_table(store, admin, table, rng, *, objects=1000, chunks=5):
    """Create the table through the driver, then bulk-load objects x chunks rows."""
    store.addChunks([_doc('seed', 0, _unit(rng))])
    with admin.cursor() as cur:
        cur.execute(
            f'INSERT INTO "{table}" (content, objectid, nodeid, parent, permissionid, isdeleted, chunkid, istable, tableid, vectorsize, modelname, embedding) '
            f"SELECT 'bulk ' || o || '/' || c, 'bulk-' || lpad(o::text, 4, '0'), 'chunk_1', 'C:/bulk/' || o || '.md', 0, false, c, false, 0, {DIM}, '', "
            f"(SELECT ('[' || string_agg((random() * 2 - 1)::text, ',') || ']')::vector FROM generate_series(1, {DIM}) WHERE o = o AND c = c) "
            f'FROM generate_series(1, {objects}) o, generate_series(0, {chunks - 1}) c'
        )
        cur.execute(f'ANALYZE "{table}"')


class TestSearch:
    def test_iterative_scan_is_set_in_the_search_transaction(self, dsn, table, stores, admin):
        """``hnsw.iterative_scan`` is ``strict_order`` inside the very transaction a filtered search runs in."""
        rng = np.random.default_rng(20)
        store = _open(dsn, table, stores)
        _bulk_table(store, admin, table, rng, objects=200, chunks=5)
        ids = [f'bulk-{i:04d}' for i in range(1, 201, 10)]
        q = _unit(rng)

        def in_one_transaction(cur):
            rows = store._search_semantic_in(cur, q, _filter(objectIds=ids, limit=10, minScore=-math.inf))
            cur.execute('SHOW hnsw.iterative_scan')
            setting = cur.fetchone()[0]
            cur.execute('SHOW transaction_read_only')
            read_only = cur.fetchone()[0]
            return rows, setting, read_only

        rows, setting, read_only = store._db.run_read(in_one_transaction)
        assert setting == 'strict_order'
        assert read_only == 'on'
        assert len(rows) == 10

    def test_filtered_search_on_5000_row_hnsw_table_returns_k(self, dsn, table, stores, admin):
        rng = np.random.default_rng(21)
        store = _open(dsn, table, stores)
        _bulk_table(store, admin, table, rng, objects=1000, chunks=5)
        s = _schema()
        ids = [f'bulk-{i:04d}' for i in range(1, 1001, 20)]  # 50 documents, 250 of 5,001 rows
        q = s.QuestionText(text='q')
        q.embedding = _unit(rng)
        results = store.searchSemantic(q, _filter(objectIds=ids, limit=10, minScore=-math.inf))
        assert len(results) == 10
        assert {d.metadata.objectId for d in results} <= set(ids)
        assert [d.score for d in results] == sorted((d.score for d in results), reverse=True)

        # Forced onto the HNSW index, the same filter needs the iterative scan to reach k rows.
        with admin.cursor() as cur:
            cur.execute(f'DROP INDEX IF EXISTS "{table}_objectid_chunkid"')

        def forced(cur, scan):
            cur.execute('SET LOCAL enable_seqscan = off')
            cur.execute(f'SET LOCAL hnsw.iterative_scan = {scan}')
            rows = store._search_semantic_in(cur, q.embedding, _filter(objectIds=ids, limit=10, minScore=-math.inf))
            return len(rows)

        assert store._db.run_read(lambda cur: forced(cur, 'strict_order')) == 10
        assert store._db.run_read(lambda cur: forced(cur, 'off')) < 10

    def test_floor_drops_low_scores_unless_min_score_is_set(self, dsn, table, stores):
        rng = np.random.default_rng(22)
        store = _open(dsn, table, stores)
        target = _unit(rng)
        opposite = [-x for x in target]
        store.addChunks([_doc('near', 0, target), _doc('far', 0, opposite)])
        s = _schema()
        q = s.QuestionText(text='q')
        q.embedding = target
        legacy = store.searchSemantic(q, s.DocFilter(limit=5))
        assert [d.metadata.objectId for d in legacy] == ['near']
        everything = store.searchSemantic(q, _filter(limit=5, minScore=-math.inf))
        assert [d.metadata.objectId for d in everything] == ['near', 'far']
        assert everything[1].score < 0.2

    def test_keyword_search_matches_the_question_text(self, dsn, table, stores):
        rng = np.random.default_rng(23)
        store = _open(dsn, table, stores)
        store.addChunks([_doc('kestrel', 0, _unit(rng), content='The Kestrel hovers over 50% of fields')])
        store.addChunks([_doc('owl', 0, _unit(rng), content='The owl hunts at night')])
        s = _schema()
        found = store.searchKeyword(s.QuestionText(text='kestrel'), s.DocFilter(limit=5))
        assert [d.metadata.objectId for d in found] == ['kestrel']
        # dialect.keyword_match 'substring': a fragment inside a word matches, whatever its case.
        assert type(store).VX_KEYWORD_MATCH == 'substring'
        fragment = store.searchKeyword(s.QuestionText(text='ESTREL HOV'), s.DocFilter(limit=5))
        assert [d.metadata.objectId for d in fragment] == ['kestrel']
        assert store.searchKeyword(s.QuestionText(text='50%'), s.DocFilter(limit=5))[0].metadata.objectId == 'kestrel'
        assert store.searchKeyword(s.QuestionText(text='5_%'), s.DocFilter(limit=5)) == []

    def test_semantic_search_returns_nearest_with_metadata(self, dsn, table, stores):
        rng = np.random.default_rng(24)
        store = _open(dsn, table, stores)
        vectors = [_unit(rng) for _ in range(30)]
        store.addChunks([_doc(f'd{i:02d}', 0, v, size=i) for i, v in enumerate(vectors)])
        s = _schema()
        q = s.QuestionText(text='q')
        q.embedding = vectors[17]
        top = store.searchSemantic(q, s.DocFilter(limit=3))
        assert top[0].metadata.objectId == 'd17'
        assert top[0].score > 0.99
        assert top[0].metadata.signature == 'component-signature'
        assert top[0].metadata.size == 17
        assert top[0].metadata.pointId


# ---------------------------------------------------------------------------
# Legacy reads (get, getPaths, render, count) and the explorer hooks
# ---------------------------------------------------------------------------


class TestReads:
    def test_get_pages_in_chunk_order(self, dsn, table, stores):
        rng = np.random.default_rng(30)
        store = _open(dsn, table, stores)
        docs = [_doc('doc', i, _unit(rng)) for i in range(30)]
        order = list(rng.permutation(30))
        store.addChunks([docs[0]])
        store.addChunks([docs[i] for i in order if i != 0])
        s = _schema()
        page = store.get(s.DocFilter(objectIds=['doc'], offset=10, limit=10))
        assert [d.metadata.chunkId for d in page] == list(range(10, 20))

    def test_get_reads_the_control_record_for_the_base_check(self, dsn, table, stores):
        rng = np.random.default_rng(31)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 2)
        assert store.doesCollectionExist() is True
        assert (store.modelName, store.vectorSize) == (MODEL, DIM)

    def test_get_paths_excludes_control_and_deleted_and_is_ordered(self, dsn, table, stores):
        rng = np.random.default_rng(32)
        store = _open(dsn, table, stores)
        for name in ('c', 'a', 'b', 'gone'):
            _ingest(store, rng, name, 2)
        store.markDeleted(['gone'])
        paths = store.getPaths()
        assert list(paths.items()) == [('C:/demo/a.md', 'a'), ('C:/demo/b.md', 'b'), ('C:/demo/c.md', 'c')]

    def test_render_joins_chunks_in_order(self, dsn, table, stores):
        rng = np.random.default_rng(33)
        store = _open(dsn, table, stores)
        store.addChunks([_doc('doc', 0, _unit(rng), content='A')])
        store.addChunks([_doc('doc', 3, _unit(rng), content='D'), _doc('doc', 1, _unit(rng), content='B')])
        out: list = []
        store.render('doc', out.append)
        assert ''.join(out) == 'ABD'

    def test_count_documents_keeps_raw_semantics_and_loads_the_control_record(self, dsn, table, stores):
        rng = np.random.default_rng(34)
        writer = _open(dsn, table, stores)
        _ingest(writer, rng, 'doc', 3)
        reader = _open(dsn, table, stores)  # a fresh task: nothing written by this instance
        assert reader.count_documents() == 4  # three chunks plus the control record
        assert (reader.modelName, reader.vectorSize) == (MODEL, DIM)

    def test_missing_table_answers_empty(self, dsn, table, stores):
        store = _open(dsn, table, stores)
        s = _schema()
        q = s.QuestionText(text='q')
        q.embedding = [0.1] * DIM
        assert store.count_documents() == 0
        assert store.searchSemantic(q, s.DocFilter(limit=3)) == []
        assert store.get(s.DocFilter(limit=3)) == []
        assert store.getPaths() == {}
        assert store.countChunks(_filter()) == 0
        assert store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path').items == []
        info = store.describe()
        assert info.collection_exists is False and info.control_record is None


class TestHooks:
    def test_describe_reports_the_catalog_and_no_connection_details(self, dsn, table, stores):
        rng = np.random.default_rng(40)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 3)
        info = store.describe()
        assert info.backend == 'pgvector'
        assert info.backend_version and info.backend_version[0].isdigit()
        assert info.collection == table
        assert info.collection_exists is True and info.control_record is True
        assert info.meta_column is True
        assert (info.metric, info.dimension, info.model) == ('cosine', DIM, MODEL)
        assert info.index == {'type': 'hnsw', 'params': {'m': 16, 'ef_construction': 64}}
        assert info.size_bytes and info.size_bytes > 0
        # The live server has pgvector >= 0.8 (iterative scan), so filtered searches fill k.
        assert 'filtered_search_may_underfill' not in info.caveats and info.caveats == []
        dumped = json.dumps(dataclasses.asdict(info))
        for secret in ('rruser', 'rrpass', 'rrtenant', '55432', '56434', 'localhost', '127.0.0.1'):
            assert secret not in dumped

    def test_capabilities_and_score_info(self, dsn, table, stores):
        store = _open(dsn, table, stores)
        caps = store.capabilities()
        for hook in (
            'describe',
            'countChunks',
            'countDocumentsWhere',
            'listDocumentPage',
            'scrollChunks',
            'sampleChunks',
            'getVectors',
            'removeCounted',
        ):
            assert hook in caps
        assert {
            'sample_stratified_native',
            'documents_distinct',
            'documents_sorted',
            'search_keyword',
            'documents_filter',
        } <= caps
        assert 'knnGraph' not in caps and 'knn_native' not in caps
        info = store.scoreInfo()
        assert info['formula'] == '1 - cosine_distance' and info['floor'] == 0.2 and info['higher_is_better'] is True

    def test_counts_by_deleted_mode_exclude_the_control_record(self, dsn, table, stores):
        rng = np.random.default_rng(41)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'a', 3)
        _ingest(store, rng, 'b', 2)
        store.markDeleted(['b'])
        assert store.countChunks(_filter()) == 3
        assert store.countChunks(_filter(deleted='deleted')) == 2
        assert store.countChunks(_filter(deleted='all')) == 5
        assert store.countChunks(_filter(isDeleted=True)) == 5
        assert store.countChunks(_filter(chunkIds=[0], deleted='all')) == 2
        assert store.countDocumentsWhere(_filter()) == 1
        assert store.countDocumentsWhere(_filter(deleted='all')) == 2
        store.markActive(['b'])
        assert store.countDocumentsWhere(_filter()) == 2

    def test_list_documents_pages_by_path_with_counts_and_extras(self, dsn, table, stores):
        rng = np.random.default_rng(42)
        store = _open(dsn, table, stores)
        for i, name in enumerate(['delta', 'alpha', 'charlie', 'bravo', 'echo']):
            _ingest(store, rng, name, i + 1, size=100 + i, ingestedAt='2026-10-08T18:20:11Z')
        first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
        assert [r.objectId for r in first.items] == ['alpha', 'bravo']
        assert (first.total, first.counts_exact, first.distinct, first.sorted) == (5, True, True, True)
        assert first.next_cursor
        alpha = first.items[0]
        assert (alpha.path, alpha.chunks, alpha.has_first_chunk, alpha.deleted, alpha.tables) == (
            'C:/demo/alpha.md',
            2,
            True,
            False,
            0,
        )
        assert (alpha.size, alpha.ingestedAt, alpha.nodeId) == (101, '2026-10-08T18:20:11Z', 'chunk_1')
        assert alpha.pointId
        second = store.listDocumentPage(
            cursor=first.next_cursor, limit=2, object_ids=None, deleted='active', sort='path'
        )
        assert [r.objectId for r in second.items] == ['charlie', 'delta']
        third = store.listDocumentPage(
            cursor=second.next_cursor, limit=2, object_ids=None, deleted='active', sort='path'
        )
        assert [r.objectId for r in third.items] == ['echo'] and third.next_cursor is None
        only = store.listDocumentPage(cursor=None, limit=10, object_ids=['echo', 'schema'], deleted='all', sort='path')
        assert [r.objectId for r in only.items] == ['echo'] and only.total == 1

    def test_list_documents_counts_once_and_aggregates_only_the_page(self, dsn, table, stores, monkeypatch):
        """A page aggregates its own documents only, and the total is counted once, on the first page."""
        rng = np.random.default_rng(49)
        store = _open(dsn, table, stores)
        for i in range(7):
            _ingest(store, rng, f'doc{i}', 3)
        _ingest(store, rng, 'gone', 2)
        store.markDeleted(['gone'])
        counted, aggregated = [], []
        count_documents, list_documents = store._sql.count_documents, store._sql.list_documents

        def spy_count(where):
            counted.append(where)
            return count_documents(where)

        def spy_list(columns, where):
            aggregated.append(list(where.object_ids or []))
            return list_documents(columns, where)

        monkeypatch.setattr(store._sql, 'count_documents', spy_count)
        monkeypatch.setattr(store._sql, 'list_documents', spy_list)
        pages, cursor = [], None
        while True:
            page = store.listDocumentPage(cursor=cursor, limit=3, object_ids=None, deleted='active', sort='path')
            pages.append(page)
            cursor = page.next_cursor
            if cursor is None:
                break
        assert [[r.objectId for r in p.items] for p in pages] == [
            ['doc0', 'doc1', 'doc2'],
            ['doc3', 'doc4', 'doc5'],
            ['doc6'],
        ]
        assert [p.total for p in pages] == [7, 7, 7]
        assert all(r.chunks == 3 for p in pages for r in p.items)
        assert counted == []
        assert aggregated == [[r.objectId for r in p.items] for p in pages]

    def test_list_documents_rejects_a_bad_cursor(self, dsn, table, stores):
        from ai.common.store.errors import ToolRefusal

        rng = np.random.default_rng(43)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'a', 1)
        with pytest.raises(ToolRefusal) as err:
            store.listDocumentPage(cursor='not-a-cursor', limit=2, object_ids=None, deleted='active', sort='path')
        assert err.value.code == 'INVALID_INPUT'

    def test_scroll_chunks_pages_without_embeddings(self, dsn, table, stores):
        rng = np.random.default_rng(44)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 7)
        page = store.scrollChunks('doc', after_chunk=-1, limit=3, deleted='active')
        assert [d.metadata.chunkId for d in page.docs] == [0, 1, 2]
        assert page.has_more is True and page.next_after == 2
        assert all(d.embedding is None for d in page.docs)
        rest = store.scrollChunks('doc', after_chunk=page.next_after, limit=10, deleted='active')
        assert [d.metadata.chunkId for d in rest.docs] == [3, 4, 5, 6] and rest.has_more is False
        assert store.scrollChunks('schema', after_chunk=-1, limit=5, deleted='all').docs == []

    def test_get_vectors_pairs_keys_exactly(self, dsn, table, stores):
        rng = np.random.default_rng(45)
        store = _open(dsn, table, stores)
        docs_a = _ingest(store, rng, 'a', 3)
        _ingest(store, rng, 'b', 3)
        got = store.getVectors([('a', 2), ('b', 0), ('a', 9), ('schema', 0)])
        assert [(d.metadata.objectId, d.metadata.chunkId) for d in got] == [('a', 2), ('b', 0)]
        assert len(got[0].embedding) == DIM
        assert got[0].embedding == pytest.approx(docs_a[2].embedding, abs=1e-6)
        assert all(isinstance(x, float) for x in got[0].embedding)
        assert got[0].metadata.pointId

    def test_sample_chunks_native_strategies(self, dsn, table, stores):
        rng = np.random.default_rng(46)
        store = _open(dsn, table, stores)
        for i in range(6):
            _ingest(store, rng, f'doc{i}', 5)
        s = _schema()
        docs, used = store.sampleChunks(n=6, seed=7, strategy='stratified', docFilter=s.DocFilter(), include_keys=[])
        assert used == 'stratified'
        assert sorted(d.metadata.objectId for d in docs) == [f'doc{i}' for i in range(6)]
        assert all(d.metadata.chunkId == 0 for d in docs)  # chunk 0 is each document's first pick
        assert all(len(d.embedding) == DIM for d in docs)

        more, _ = store.sampleChunks(
            n=12, seed=7, strategy='stratified', docFilter=s.DocFilter(), include_keys=[('doc0', 0)]
        )
        keys = [(d.metadata.objectId, d.metadata.chunkId) for d in more]
        assert len(keys) == 12 and len(set(keys)) == 12 and ('doc0', 0) not in keys
        per_doc = {}
        for oid, _cid in keys:
            per_doc[oid] = per_doc.get(oid, 0) + 1
        assert max(per_doc.values()) - min(per_doc.values()) <= 1

        r1, used_r = store.sampleChunks(n=10, seed=3, strategy='random', docFilter=s.DocFilter(), include_keys=[])
        r2, _ = store.sampleChunks(n=10, seed=3, strategy='random', docFilter=s.DocFilter(), include_keys=[])
        assert used_r == 'random'
        assert [(d.metadata.objectId, d.metadata.chunkId) for d in r1] == [
            (d.metadata.objectId, d.metadata.chunkId) for d in r2
        ]
        assert all(d.metadata.objectId != 'schema' for d in r1)

        first, used_f = store.sampleChunks(
            n=3, seed=0, strategy='first', docFilter=s.DocFilter(objectIds=['doc2']), include_keys=[]
        )
        assert used_f == 'first' and [d.metadata.chunkId for d in first] == [0, 1, 2]

    def test_seeded_samples_depend_on_the_seed_and_leave_no_seed_in_the_session(self, dsn, table, stores):
        """A seed orders the sample without seeding the session: behind a pooler that session serves others next."""
        rng = np.random.default_rng(48)
        store = _open(dsn, table, stores)
        for i in range(8):
            _ingest(store, rng, f'doc{i}', 6)
        s = _schema()

        def keys(seed, strategy, n=10):
            docs, _ = store.sampleChunks(n=n, seed=seed, strategy=strategy, docFilter=s.DocFilter(), include_keys=[])
            return [(d.metadata.objectId, d.metadata.chunkId) for d in docs]

        def session_random(cur):
            cur.execute('SELECT random()')
            return cur.fetchone()[0]

        for strategy in ('random', 'stratified'):
            assert keys(5, strategy, 20) == keys(5, strategy, 20)
            assert {tuple(keys(seed, strategy, 20)) for seed in (5, 6, 7)} != {tuple(keys(5, strategy, 20))}
        # Stratified: every document is picked once before any is picked twice.
        per_doc = {}
        for oid, _cid in keys(9, 'stratified', 12):
            per_doc[oid] = per_doc.get(oid, 0) + 1
        assert len(per_doc) == 8 and set(per_doc.values()) <= {1, 2}

        after = []
        for _ in range(3):
            keys(42, 'random')
            after.append(store._db.run_read(session_random))
        assert len(set(after)) == 3, after

    def test_remove_counted_reports_rows_and_never_removes_the_control_record(self, dsn, table, stores, admin):
        rng = np.random.default_rng(47)
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'a', 4)
        _ingest(store, rng, 'b', 2)
        assert store.removeCounted(['a', 'missing']) == 4
        assert store.removeCounted(['schema']) == 0
        store.remove(['schema'])
        with admin.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{table}" WHERE objectid = %s', ('schema',))
            assert cur.fetchone()[0] == 1
        assert store.countChunks(_filter()) == 2


# ---------------------------------------------------------------------------
# The documents filter and the per-document health fields (contract section 4.4-A, 4.4-F)
# ---------------------------------------------------------------------------

#: objectId -> (path, chunk ids, ingestedAt or None, table chunk ids).
FILTER_LIBRARY = {
    'falcon': ('C:/demo/handbooks/falcon_handbook.md', [0, 1, 2], '2026-10-01T09:00:00Z', []),
    'osprey': ('C:/demo/handbooks/osprey_station.PDF', [0, 1], '2026-10-02T00:00:00Z', []),
    'orphan': ('C:/demo/handbooks/orphan.md', [5, 6, 7], '2026-10-03T00:00:00Z', []),
    'notes': ('C:/demo/handbooks_old/notes.md', [0], '2026-09-30T23:59:59Z', []),
    'pct': ('C:/demo/100%_done/report.md', [0, 1], None, []),
    'under': ('C:/demo/a_b/table.html', [0, 1, 2, 3], '2026-10-05T12:00:00Z', [2]),
    'axb': ('C:/demo/axb/file.txt', [0], '2026-10-05T12:00:00Z', []),
    'win': ('C:\\demo\\win\\Readme.MD', [0, 1], '2026-10-04T00:00:00Z', []),
    'mdx': ('C:/demo/x/page.mdx', [0], '2026-10-04T00:00:00Z', []),
    'bak': ('C:/demo/x/file.md.bak', [0], '2026-10-04T00:00:00Z', []),
    'bare': ('README', [0, 1, 2, 3, 4], None, []),
}


def _ingest_library(store, rng, library=FILTER_LIBRARY) -> None:
    for oid, (path, chunk_ids, ingested, tables) in library.items():
        extra = {'ingestedAt': ingested} if ingested else {}
        docs = [_doc(oid, c, _unit(rng), parent=path, **extra) for c in chunk_ids]
        for doc in docs:
            doc.metadata.isTable = doc.metadata.chunkId in tables
        store.addChunks(docs)


def _doc_filter(**kw):
    from ai.common.store.vx_types import parse_doc_list_filter

    return parse_doc_list_filter(kw)


def _selected(flt, library=FILTER_LIBRARY, *, dates: bool = True) -> set:
    """The objectIds the contract's words select (the order is the database's collation, so a set)."""
    out = set()
    for oid, (path, chunk_ids, ingested, tables) in library.items():
        checks = [
            flt.path_prefix is None or path.startswith(flt.path_prefix),
            not flt.file_types or any(path.lower().endswith('.' + t) for t in flt.file_types),
            flt.path_contains is None or flt.path_contains.lower() in path.lower(),
            not dates or flt.ingested_after is None or (ingested is not None and ingested >= flt.ingested_after),
            not dates or flt.ingested_before is None or (ingested is not None and ingested < flt.ingested_before),
            flt.min_chunks is None or len(chunk_ids) >= flt.min_chunks,
            flt.max_chunks is None or len(chunk_ids) <= flt.max_chunks,
            flt.has_first_chunk is None or (0 in chunk_ids) == flt.has_first_chunk,
            flt.has_tables is None or bool(tables) == flt.has_tables,
        ]
        if all(checks):
            out.add(oid)
    return out


def _listed(store, flt, *, limit: int = 3, deleted: str = 'active'):
    """Every page of a listing: (objectIds in the store's order, the pages)."""
    pages, cursor = [], None
    while True:
        page = store.listDocumentPage(
            cursor=cursor, limit=limit, object_ids=None, deleted=deleted, sort='path', filter=flt
        )
        pages.append(page)
        cursor = page.next_cursor
        if cursor is None:
            return [r.objectId for p in pages for r in p.items], pages


_FILTER_CASES = [
    ({'path_prefix': 'C:/demo/handbooks/'}, {'falcon', 'orphan', 'osprey'}),
    ({'path_prefix': 'C:/demo/a_b/'}, {'under'}),
    ({'path_prefix': '%'}, set()),
    ({'path_prefix': 'C:\\demo\\win\\'}, {'win'}),
    ({'file_types': ['md']}, {'pct', 'falcon', 'orphan', 'notes', 'win'}),
    ({'file_types': ['.PDF', 'html']}, {'under', 'osprey'}),
    ({'path_contains': 'HANDBOOK'}, {'falcon', 'orphan', 'osprey', 'notes'}),
    ({'path_contains': '%'}, {'pct'}),
    ({'ingested_after': '2026-10-01T09:00:00Z'}, {'falcon', 'orphan', 'osprey', 'under', 'axb', 'win', 'bak', 'mdx'}),
    ({'ingested_before': '2026-10-02'}, {'falcon', 'notes'}),
    ({'min_chunks': 4}, {'under', 'bare'}),
    ({'max_chunks': 1}, {'notes', 'axb', 'bak', 'mdx'}),
    ({'has_first_chunk': False}, {'orphan'}),
    ({'has_tables': True}, {'under'}),
    ({'path_prefix': 'C:/demo/', 'file_types': ['md'], 'has_first_chunk': True, 'min_chunks': 2}, {'pct', 'falcon'}),
]


class TestDocumentsFilter:
    def test_every_key_is_applied_by_the_store(self, dsn, table, stores):
        rng = np.random.default_rng(70)
        store = _open(dsn, table, stores)
        _ingest_library(store, rng)
        for given, expected in _FILTER_CASES:
            flt = _doc_filter(**given)
            assert _selected(flt) == expected, given  # the reference agrees with the hand-checked answer
            listed, pages = _listed(store, flt, limit=50)
            assert set(listed) == expected and len(listed) == len(expected), given
            assert pages[0].total == len(expected) and pages[0].filter_ignored == (), given

    def test_filtered_pages_follow_one_another_and_carry_the_filtered_total(self, dsn, table, stores):
        rng = np.random.default_rng(71)
        store = _open(dsn, table, stores)
        _ingest_library(store, rng)
        for given in (
            {'has_first_chunk': True},
            {'path_contains': '_'},
            {'file_types': ['md', 'txt'], 'max_chunks': 3},
        ):
            flt = _doc_filter(**given)
            whole, _ = _listed(store, flt, limit=100)
            paged, pages = _listed(store, flt, limit=2)
            assert paged == whole and set(whole) == _selected(flt), given
            assert all(p.total == len(whole) for p in pages), given
            assert all((p.counts_exact, p.distinct, p.sorted) == (True, True, True) for p in pages)

    def test_a_cursor_is_bound_to_its_filter(self, dsn, table, stores):
        from ai.common.store.errors import ToolRefusal

        rng = np.random.default_rng(72)
        store = _open(dsn, table, stores)
        _ingest_library(store, rng)
        md = _doc_filter(file_types=['md'])
        plain = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path')
        first = store.listDocumentPage(cursor=None, limit=2, object_ids=None, deleted='active', sort='path', filter=md)
        for cursor, flt in ((plain.next_cursor, md), (first.next_cursor, None)):
            with pytest.raises(ToolRefusal) as err:
                store.listDocumentPage(
                    cursor=cursor, limit=2, object_ids=None, deleted='active', sort='path', filter=flt
                )
            assert err.value.code == 'INVALID_INPUT'
        rest = store.listDocumentPage(
            cursor=first.next_cursor, limit=50, object_ids=None, deleted='active', sort='path', filter=md
        )
        assert {r.objectId for r in first.items + rest.items} == _selected(md) and rest.total == 5

    def test_filter_and_deleted_mode_combine(self, dsn, table, stores):
        rng = np.random.default_rng(73)
        store = _open(dsn, table, stores)
        _ingest_library(store, rng)
        store.markDeleted(['falcon'])
        flt = _doc_filter(path_prefix='C:/demo/handbooks/')
        assert set(_listed(store, flt)[0]) == {'orphan', 'osprey'}
        assert _listed(store, flt, deleted='deleted')[0] == ['falcon']
        assert set(_listed(store, flt, deleted='all')[0]) == {'falcon', 'orphan', 'osprey'}

    def test_documents_tool_answers_server(self, dsn, table, stores):
        from .test_vectordb_tool_mixin import node

        rng = np.random.default_rng(74)
        store = _open(dsn, table, stores)
        _ingest_library(store, rng)
        answer = node(store).list_documents({'filter': {'path_prefix': 'C:/demo/handbooks/', 'file_types': ['md']}})
        assert answer['success'] is True
        assert {item['objectId'] for item in answer['items']} == {'falcon', 'orphan'}
        assert (answer['filter_applied'], answer['filter_ignored'], answer['total']) == ('server', [], 2)
        assert not {'documents_filter_partial', 'documents_filter_client'} & set(answer['caveats'])

    def test_rows_report_the_last_chunk_and_the_soft_deleted_rows(self, dsn, table, stores, admin):
        rng = np.random.default_rng(75)
        store = _open(dsn, table, stores)
        library = {
            'whole': ('C:/h/whole.md', [0, 1, 2], None, []),
            'gappy': ('C:/h/gappy.md', [0, 1, 3, 4], None, []),
            'tail': ('C:/h/tail.md', [3, 4], None, []),
        }
        _ingest_library(store, rng, library)
        with admin.cursor() as cur:
            cur.execute(
                f'UPDATE "{table}" SET isdeleted = true WHERE (objectid, chunkid) IN ((%s, 4), (%s, 3), (%s, 4))',
                ('gappy', 'tail', 'tail'),
            )

        def health(deleted):
            rows = [r for p in _listed(store, None, deleted=deleted)[1] for r in p.items]
            return {
                r.objectId: (r.chunks, r.max_chunk_id, r.deleted_chunks, r.has_first_chunk, r.deleted) for r in rows
            }

        # (chunks, max_chunk_id, deleted_chunks, has_first_chunk, deleted)
        assert health('active') == {'whole': (3, 2, 0, True, False), 'gappy': (3, 3, 1, True, False)}
        assert health('deleted') == {'gappy': (1, 4, 1, False, True), 'tail': (2, 4, 2, False, True)}
        assert health('all') == {
            'whole': (3, 2, 0, True, False),
            'gappy': (4, 4, 1, True, True),
            'tail': (2, 4, 2, False, True),
        }


# ---------------------------------------------------------------------------
# Legacy tables: the meta column, a document without chunk 0
# ---------------------------------------------------------------------------

LEGACY_DDL = (
    'CREATE TABLE "{t}" (id bigserial PRIMARY KEY, content text, objectId text, nodeId text, parent text, '
    'permissionId int, isDeleted boolean, chunkId int, isTable boolean, tableId int, vectorSize int, '
    'modelName text, embedding vector({dim}), signature text)'
)


def _legacy_synthetic(admin, name: str, rng) -> None:
    """A table in the shape the replaced drivers wrote: no meta, one document without chunk 0."""
    with admin.cursor() as cur:
        cur.execute(LEGACY_DDL.format(t=name, dim=DIM))
        cur.execute(
            f'INSERT INTO "{name}" (content, objectId, chunkId, isDeleted, vectorSize, modelName, embedding) '
            "VALUES ('', 'schema', 0, true, %s, %s, %s::vector)",
            (DIM, MODEL, '[' + ','.join(['0'] * DIM) + ']'),
        )
        for oid, chunk_ids in (('whole', range(0, 3)), ('orphan', range(64, 70))):
            for cid in chunk_ids:
                vec = '[' + ','.join(repr(x) for x in _unit(rng)) + ']'
                cur.execute(
                    f'INSERT INTO "{name}" (content, objectId, nodeId, parent, permissionId, isDeleted, chunkId, '
                    'isTable, tableId, vectorSize, modelName, embedding, signature) '
                    "VALUES (%s, %s, 'chunk_1', %s, 0, false, %s, false, 0, %s, '', %s::vector, 'sig')",
                    (f'{oid} {cid}', oid, f'C:/legacy/{oid}.md', cid, DIM, vec),
                )


def _legacy_copy(admin, source: str, name: str) -> None:
    """Copy the shared legacy table into a private one with the same legacy shape."""
    with admin.cursor() as cur:
        cur.execute(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass(%s) AND attname = 'embedding'",
            (source,),
        )
        dim = int(cur.fetchone()[0].split('(')[1].rstrip(')'))
        cur.execute(LEGACY_DDL.format(t=name, dim=dim))
        cols = 'content, objectid, nodeid, parent, permissionid, isdeleted, chunkid, istable, tableid, vectorsize, modelname, embedding, signature'
        cur.execute(f'INSERT INTO "{name}" ({cols}) SELECT {cols} FROM {source} ORDER BY id')


def _legacy_source_exists(admin) -> bool:
    with admin.cursor() as cur:
        cur.execute('SELECT to_regclass(%s) IS NOT NULL', (LEGACY_TABLE,))
        return bool(cur.fetchone()[0])


class TestLegacy:
    def test_synthetic_legacy_table_lists_its_document_without_chunk_zero(self, dsn, table, stores, admin):
        rng = np.random.default_rng(50)
        _legacy_synthetic(admin, table, rng)
        store = _open(dsn, table, stores)
        page = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
        rows = {r.objectId: r for r in page.items}
        assert set(rows) == {'whole', 'orphan'}
        assert rows['orphan'].has_first_chunk is False and rows['orphan'].chunks == 6
        assert rows['whole'].has_first_chunk is True and rows['whole'].chunks == 3
        assert rows['whole'].size is None and rows['whole'].ingestedAt is None
        assert (store.modelName, store.vectorSize) == (MODEL, DIM)
        assert store.countChunks(_filter(chunkIds=[0])) == 1
        assert store.describe().control_record is True

    def test_rows_with_null_flags_read_as_active(self, dsn, table, stores, admin):
        """Hand-written or foreign rows with a NULL isDeleted count, list and search as active, never as 'all' only."""
        rng = np.random.default_rng(54)
        _legacy_synthetic(admin, table, rng)
        target = _unit(rng)
        with admin.cursor() as cur:
            for cid in range(3):
                vec = '[' + ','.join(repr(x) for x in (target if cid == 1 else _unit(rng))) + ']'
                cur.execute(
                    f'INSERT INTO "{table}" (content, objectId, chunkId, embedding, parent) VALUES (%s, %s, %s, %s::vector, %s)',
                    (f'nullflags {cid}', 'nullflags', cid, vec, 'C:/legacy/nullflags.md'),
                )  # isDeleted, permissionId, isTable, tableId and nodeId stay NULL
        store = _open(dsn, table, stores)
        s = _schema()

        listed = store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='active', sort='path')
        rows = {r.objectId: r for r in listed.items}
        assert set(rows) == {'whole', 'orphan', 'nullflags'} and listed.total == 3
        assert (rows['nullflags'].chunks, rows['nullflags'].deleted) == (3, False)
        assert (
            store.listDocumentPage(cursor=None, limit=10, object_ids=None, deleted='deleted', sort='path').items == []
        )
        got = store.get(s.DocFilter(objectIds=['nullflags'], limit=10))
        assert [d.metadata.chunkId for d in got] == [0, 1, 2]
        assert all(d.metadata.isDeleted is False for d in got)
        q = s.QuestionText(text='q')
        q.embedding = target
        assert store.searchSemantic(q, s.DocFilter(limit=1))[0].page_content == 'nullflags 1'
        assert 'C:/legacy/nullflags.md' in store.getPaths()
        active, deleted, every = (store.countChunks(_filter(deleted=m)) for m in ('active', 'deleted', 'all'))
        assert (active, deleted, every) == (12, 0, 12)
        assert store.countDocumentsWhere(_filter()) == 3

        store.markDeleted(['nullflags'])
        assert store.countChunks(_filter(deleted='deleted')) == 3
        assert store.countChunks(_filter()) + store.countChunks(_filter(deleted='deleted')) == store.countChunks(
            _filter(deleted='all')
        )

    def test_table_left_empty_by_a_failed_first_write_is_reused(self, dsn, table, stores, admin):
        """D3: an old-shape table with no row at all (no control record) is completed, not refused."""
        rng = np.random.default_rng(53)
        with admin.cursor() as cur:
            cur.execute(LEGACY_DDL.replace(', signature text)', ')').format(t=table, dim=DIM))
        store = _open(dsn, table, stores)
        _ingest(store, rng, 'doc', 2, size=3)
        with admin.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{table}" WHERE objectid = %s', ('schema',))
            assert cur.fetchone()[0] == 1
            cur.execute(f'SELECT meta FROM "{table}" WHERE objectid = %s AND chunkid = 0', ('doc',))
            meta = cur.fetchone()[0]
        # The table had no signature column: the signature is kept in meta instead.
        assert meta == {'signature': 'component-signature', 'size': 3}
        assert store.describe().index['type'] == 'hnsw'

    def test_meta_column_added_at_open(self, dsn, table, stores, admin):
        rng = np.random.default_rng(51)
        _legacy_synthetic(admin, table, rng)
        assert 'meta' not in _columns(admin, table)
        store = _open(dsn, table, stores)
        assert 'meta' in _columns(admin, table)
        assert store.describe().meta_column is True

    def test_blocked_meta_alter_falls_back_and_a_later_write_adds_it(self, dsn, table, stores, admin):
        """A session idle in transaction on the table: the first ingest still completes within 5 s, without meta."""
        rng = np.random.default_rng(52)
        _legacy_synthetic(admin, table, rng)
        holder = psycopg2.connect(ADMIN_DSN, connect_timeout=5)
        try:
            with holder.cursor() as cur:
                cur.execute(f'SELECT count(*) FROM "{table}"')  # holds ACCESS SHARE until the transaction ends
            started = time.monotonic()
            store = _open(dsn, table, stores)
            store.addChunks([_doc('new', 0, _unit(rng), size=5)])
            assert time.monotonic() - started < 5.0
            info = store.describe()
            assert info.meta_column is False
            assert 'extras_not_stored' in info.caveats and 'meta_column_pending' in info.caveats
            assert 'meta' not in _columns(admin, table)
            assert _rows(admin, table, 'objectid = %s', ('new',)) == [('new', 0, 'new chunk 0')]
        finally:
            holder.rollback()
            holder.close()
        store.META_RETRY_S = 0.0  # the retry interval (60 s in production) is not what this case measures
        store.addChunks([_doc('later', 0, _unit(rng), size=9)])
        assert 'meta' in _columns(admin, table)
        assert store.describe().meta_column is True
        with admin.cursor() as cur:
            cur.execute(f'SELECT meta FROM "{table}" WHERE objectid = %s', ('later',))
            assert cur.fetchone()[0]['size'] == 9

    def test_shared_legacy_table_lists_its_document_without_chunk_zero(self, dsn, table, stores, admin):
        if not _legacy_source_exists(admin):
            pytest.skip(f'NOT RUN: legacy table {LEGACY_TABLE} is not seeded in this database')
        _legacy_copy(admin, LEGACY_TABLE, table)
        store = _open(dsn, table, stores)
        rows = []
        cursor = None
        while True:
            page = store.listDocumentPage(cursor=cursor, limit=200, object_ids=None, deleted='active', sort='path')
            rows.extend(page.items)
            cursor = page.next_cursor
            if cursor is None:
                break
        assert rows, 'the legacy table lists no documents'
        assert len([r for r in rows if not r.has_first_chunk]) == 1
        assert all(r.objectId != 'schema' for r in rows)
        assert store.describe().control_record is True
        assert store.modelName and store.vectorSize

    def test_shared_legacy_table_reports_its_soft_deleted_row_under_active(self, dsn, table, stores, admin):
        """The seed soft-deletes one row of one document; the copy plants one the same way when the seed predates it."""
        if not _legacy_source_exists(admin):
            pytest.skip(f'NOT RUN: legacy table {LEGACY_TABLE} is not seeded in this database')
        _legacy_copy(admin, LEGACY_TABLE, table)
        with admin.cursor() as cur:
            cur.execute(f'SELECT count(*) FROM "{table}" WHERE objectid <> %s AND isdeleted IS TRUE', ('schema',))
            if cur.fetchone()[0] == 0:
                cur.execute(
                    f'UPDATE "{table}" SET isdeleted = true WHERE id = (SELECT min(id) FROM "{table}" '
                    'WHERE objectid <> %s AND chunkid = 1)',
                    ('schema',),
                )
            cur.execute(
                f'SELECT objectid, chunkid FROM "{table}" WHERE objectid <> %s AND isdeleted IS TRUE', ('schema',)
            )
            ((soft_object, soft_chunk),) = cur.fetchall()
            cur.execute(
                f'SELECT count(*), max(chunkid) FROM "{table}" WHERE objectid = %s AND isdeleted IS NOT TRUE',
                (soft_object,),
            )
            active_rows, active_max = cur.fetchone()
        store = _open(dsn, table, stores)
        active = {r.objectId: r for p in _listed(store, None, limit=200)[1] for r in p.items}
        flagged = [r for r in active.values() if r.deleted_chunks]
        assert [r.objectId for r in flagged] == [soft_object]
        assert (flagged[0].deleted_chunks, flagged[0].chunks, flagged[0].max_chunk_id) == (1, active_rows, active_max)
        assert len([r for r in active.values() if not r.has_first_chunk]) == 1
        assert all(r.deleted_chunks == 0 for r in active.values() if r.objectId != soft_object)
        deleted = {r.objectId: r for p in _listed(store, None, limit=200, deleted='deleted')[1] for r in p.items}
        assert list(deleted) == [soft_object] and deleted[soft_object].chunks == 1
        assert deleted[soft_object].max_chunk_id == soft_chunk

    def test_legacy_table_without_meta_leaves_the_ingest_keys_to_the_app(self, dsn, table, stores, admin):
        rng = np.random.default_rng(55)
        _legacy_synthetic(admin, table, rng)
        holder = psycopg2.connect(ADMIN_DSN, connect_timeout=5)
        try:
            with holder.cursor() as cur:
                cur.execute(f'SELECT count(*) FROM "{table}"')  # holds ACCESS SHARE: the meta ALTER gives up
            store = _open(dsn, table, stores)
            assert store.describe().meta_column is False
            flt = _doc_filter(ingested_after='2026-10-01', path_contains='ORPHAN')
            page = store.listDocumentPage(
                cursor=None, limit=10, object_ids=None, deleted='active', sort='path', filter=flt
            )
            assert [r.objectId for r in page.items] == ['orphan'] and page.total == 1
            assert page.filter_ignored == ('ingested_after',)
            from .test_vectordb_tool_mixin import node

            answer = node(store).list_documents({'filter': {'ingested_before': '2026-10-01', 'has_first_chunk': True}})
            assert (answer['filter_applied'], answer['filter_ignored']) == ('partial', ['ingested_before'])
            assert [item['objectId'] for item in answer['items']] == ['whole']
            assert 'documents_filter_partial' in answer['caveats']
        finally:
            holder.rollback()
            holder.close()


# ---------------------------------------------------------------------------
# The node classes over the shared driver
# ---------------------------------------------------------------------------


@pytest.fixture()
def node_env(monkeypatch):
    """Import the node modules with ``depends`` stubbed and the config read as given."""
    import depends as real_depends

    depends = types.ModuleType('depends')
    depends.__dict__.update(real_depends.__dict__)
    depends.depends = lambda *a, **kw: None  # the requirements are installed; never resolve them in a test
    monkeypatch.setitem(sys.modules, 'depends', depends)
    from ai.common.config import Config

    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, connConfig: dict(connConfig)))
    return monkeypatch


def _dsn_fields(dsn: str) -> dict:
    from ai.common.rocketride_db import parse_dsn_fields

    return parse_dsn_fields(dsn)


class TestNodes:
    def test_store_postgres_writes_through_the_shared_driver(self, node_env, dsn, table, stores, admin):
        rng = np.random.default_rng(60)
        postgres = importlib.import_module('nodes.store_postgres.postgres')
        f = _dsn_fields(dsn)
        store = postgres.Store(
            'postgres',
            {
                'host': f['host'],
                'port': f['port'],
                'user': f['user'],
                'password': f['password'],
                'database': f['database'],
                'collection': table,
                'similarity': 'cosine',
                'score': 0.5,
            },
            {},
        )
        stores.append(store)
        from ai.common.store.pgvector import PgVectorStore

        assert isinstance(store, PgVectorStore)
        assert store.collection == table and store.host == f['host']
        _ingest(store, rng, 'doc', 2)
        assert len(_rows(admin, table, 'objectid = %s', ('doc',))) == 2
        assert store.describe().caveats == []

    def test_rocketride_vector_writes_through_the_shared_driver(self, node_env, dsn, table, stores, admin):
        rng = np.random.default_rng(61)
        node_env.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': dsn}))
        rv = importlib.import_module('nodes.rocketride_vector.rocketride_vector')
        store = rv.Store(
            'rocketride_vector', {'collection': table, 'similarity': 'l2', 'hnsw_m': 8, 'hnsw_ef_construction': 32}, {}
        )
        stores.append(store)
        _ingest(store, rng, 'doc', 2)
        with admin.cursor() as cur:
            cur.execute('SELECT indexdef FROM pg_indexes WHERE indexname = %s', (f'{table}_embedding_hnsw',))
            ddl = cur.fetchone()[0]
        assert 'vector_l2_ops' in ddl and "m='8'" in ddl and "ef_construction='32'" in ddl
        info = store.describe()
        assert info.metric == 'l2' and 'shared_org_table' in info.caveats
        assert store.database == _dsn_fields(dsn)['database']
