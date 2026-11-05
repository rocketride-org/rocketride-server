# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""One object written in several batches keeps every batch (#1986).

A producer hands a large object to its store in several ``addChunks`` calls:
embedding_transformer flushes every 64 chunks. Only the batch that holds the
object's chunk 0 starts the object over and may delete what was stored before;
a later batch adds to it. Before the fix these five drivers deleted every
object of every batch, so only the last flush survived.

Each driver is loaded from source with its client library stubbed. The stub
keeps what a backend would store: an insert adds chunks, a delete removes the
chunks of its objects, so the tests check what a write order leaves stored. The
real round trip on pgvector is in ``test_vector_store_writes_full.py``.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import threading
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from ai.common.schema import Doc, DocMetadata
from ai.common.store import CONTROL_OBJECT_ID

_NODES = Path(__file__).resolve().parents[1] / 'src' / 'nodes'


def _load_driver(
    monkeypatch: pytest.MonkeyPatch, node: str, driver: str, stubbed: tuple[str, ...], *, with_iglobal: bool = False
) -> types.ModuleType:
    """Load a store driver from source, with its client library and ``depends`` stubbed.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.
        node: The node folder under ``nodes/src/nodes``.
        driver: The driver module's file name, without ``.py``.
        stubbed: Module names to replace with ``MagicMock``.
        with_iglobal: Load the node's IGlobal first, for a driver that imports from it.

    Returns:
        The loaded driver module.
    """
    for name in ('depends', *stubbed):
        monkeypatch.setitem(sys.modules, name, MagicMock())
    package = f'_object_batches_{node}'
    package_module = types.ModuleType(package)
    package_module.__path__ = [str(_NODES / node)]
    monkeypatch.setitem(sys.modules, package, package_module)
    module = None
    for name in ('IGlobal', driver) if with_iglobal else (driver,):
        spec = importlib.util.spec_from_file_location(f'{package}.{name}', _NODES / node / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
    return module


class _Log:
    """What the stubbed backend holds: the object IDs of each delete, and the chunks still stored.

    A delete removes the stored chunks of its objects, as the backend would, so a test sees what a
    write order leaves behind, not only which deletes were sent.
    """

    def __init__(self) -> None:
        """Start empty."""
        self.deleted: list[list[str]] = []
        self.key_deleted: list[tuple[str, tuple[int, ...]]] = []
        self.stored: list[tuple[str, int]] = []

    def delete(self, object_ids) -> None:
        """Record a delete and drop the stored chunks of its objects.

        Args:
            object_ids: The object IDs the delete targets.
        """
        ids = list(object_ids)
        self.deleted.append(ids)
        self.stored = [(object_id, chunk_id) for object_id, chunk_id in self.stored if object_id not in ids]

    def delete_keys(self, keys) -> None:
        """Record a delete of single chunks and drop them.

        The port's stores write a batch that lacks an object's chunk 0 by replacing the chunks with the same
        ``(objectId, chunkId)`` key, so a retried batch never stores a chunk twice. That is not a delete of the object.

        Args:
            keys: The ``(object_id, chunk_id)`` pairs the delete targets.
        """
        keys = {(object_id, int(chunk_id)) for object_id, chunk_id in keys}
        self.key_deleted.extend(sorted(keys))
        self.stored = [key for key in self.stored if key not in keys]

    def put(self, key: tuple[str, int], row_id: str) -> None:
        """Store a chunk under a row id: writing the same id again replaces the row, as a keyed upsert does.

        Args:
            key: The ``(object_id, chunk_id)`` of the chunk.
            row_id: The id the store keys the row by.
        """
        self.rows = getattr(self, 'rows', {})
        if row_id in self.rows and self.rows[row_id] in self.stored:
            self.stored.remove(self.rows[row_id])
        self.rows[row_id] = key
        self.stored.append(key)


class _SqlProbe:
    """Stands in for the shared pgvector driver's SQL builder: the statements come back as plain markers."""

    def delete(self, where):
        """Return a DELETE marker and the filter it would run with.

        Args:
            where: The ``Where`` the driver built.

        Returns:
            ``('DELETE', where)``.
        """
        return 'DELETE', where

    def insert(self, columns, rows):
        """Return an INSERT marker that carries the column list.

        Args:
            columns: The columns written.
            rows: How many rows the statement holds.

        Returns:
            A tuple the cursor reads.
        """
        return ('INSERT', list(columns))


class _Cursor:
    """A cursor stand-in that logs the shared pgvector driver's DELETE and INSERT markers."""

    def __init__(self, log: _Log) -> None:
        """Log into ``log``.

        Args:
            log: Receives the deletes and inserts.
        """
        self.log = log

    def execute(self, statement, params=()) -> None:
        """Log a DELETE (by object IDs or by chunk keys) or an INSERT of rows.

        Args:
            statement: The marker the probe returned.
            params: The ``Where`` of a DELETE, or the flat row values of an INSERT.
        """
        if statement == 'DELETE':
            if params.keys:
                self.log.delete_keys(params.keys)
            else:
                self.log.delete(params.object_ids)
        elif statement[0] == 'INSERT':
            columns = statement[1]
            width = len(columns)
            for start in range(0, len(params), width):
                row = dict(zip(columns, params[start : start + width]))
                self.log.put((row['objectid'], row['chunkid']), f'{row["objectid"]}#{row["chunkid"]}')


def _pinecone(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a Pinecone store whose ``remove`` and index ``upsert`` are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    module = _load_driver(monkeypatch, 'store_pinecone', 'pinecone', ('pinecone', 'pinecone.grpc'))
    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collection = 'test-index'
    store.payload_limit = 1 << 30
    store.client = MagicMock()
    store.remove = log.delete

    def upsert(vectors) -> None:
        """Store the vectors by id: an id written again replaces its row."""
        for vector in vectors:
            log.put((vector['metadata']['objectId'], vector['metadata']['chunkId']), vector['id'])

    store.client.Index.return_value.upsert.side_effect = upsert
    return store, log


def _milvus(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a Milvus store whose client ``delete`` and ``upsert`` are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    # The driver imports its local-vs-cloud helper through the nodes package
    spec = importlib.util.spec_from_file_location('nodes.store_milvus.mode', _NODES / 'store_milvus' / 'mode.py')
    mode = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mode)
    monkeypatch.setitem(sys.modules, 'nodes.store_milvus.mode', mode)
    module = _load_driver(monkeypatch, 'store_milvus', 'milvus', ('pymilvus',))
    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collection = 'test'
    store.bulkInsertBatchSize = 50
    store.client = MagicMock()

    def delete(collection_name, filter) -> None:
        """Read the two filters the driver sends: every chunk of some objects, or single chunks of one object."""
        keyed = re.search(r"meta\['objectId'\] == '([^']*)' and meta\['chunkId'\] in \[([^\]]*)\]", filter)
        if keyed:
            log.delete_keys((keyed.group(1), int(c)) for c in keyed.group(2).split(','))
        else:
            ids = re.search(r'in \[(.*)\]$', filter).group(1)
            log.delete([value.strip().strip("'") for value in ids.split(', ')])

    def upsert(collection_name, data) -> None:
        """Store the rows; the meta of a row is a dict, or the metadata object."""
        for row in data:
            meta = row['meta']
            object_id, chunk_id = (
                (meta['objectId'], meta['chunkId']) if isinstance(meta, dict) else (meta.objectId, meta.chunkId)
            )
            log.put((object_id, chunk_id), f'{object_id}#{chunk_id}')

    store.client.delete.side_effect = delete
    store.client.upsert.side_effect = upsert
    return store, log


class _WeaviateFilter:
    """Stands in for ``weaviate.classes.query.Filter``: builds plain tuples the test can read."""

    @staticmethod
    def by_property(name: str) -> types.SimpleNamespace:
        """Return a property filter builder.

        Args:
            name: The property name.

        Returns:
            An object whose ``equal(value)`` returns ``(name, value)``.
        """
        return types.SimpleNamespace(equal=lambda value: (name, value))

    @staticmethod
    def any_of(filters: list) -> list:
        """Return the filters unchanged.

        Args:
            filters: The ``(name, value)`` tuples.

        Returns:
            The same list.
        """
        return filters


def _weaviate(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a Weaviate store whose ``delete_many`` and batch ``add_object`` are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    stubbed = (
        'weaviate',
        'weaviate.client',
        'weaviate.classes',
        'weaviate.classes.init',
        'weaviate.classes.query',
        'weaviate.classes.config',
        'weaviate.classes.aggregate',
        'weaviate.collections',
        'weaviate.collections.collection',
        'weaviate.util',
        'weaviate.exceptions',
    )
    module = _load_driver(monkeypatch, 'store_weaviate', 'weaviate', stubbed)
    monkeypatch.setattr(module, 'Filter', _WeaviateFilter)
    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collectionObj = MagicMock()
    store.collectionObj.batch.failed_objects = []
    store.collectionObj.data.delete_many.side_effect = lambda where: log.delete([value for _, value in where])
    batch = store.collectionObj.batch.dynamic.return_value.__enter__.return_value
    batch.add_object.side_effect = lambda properties, uuid, vector: log.put(
        (properties['objectId'], properties['chunkId']), str(uuid)
    )
    return store, log


def _pgvector_store(
    monkeypatch: pytest.MonkeyPatch, node: str, driver: str, *, with_iglobal: bool
) -> tuple[object, _Log]:
    """Build a pgvector-backed store whose write transaction's statements are logged.

    The port's two Postgres nodes share one driver (``ai.common.store.pgvector``); the node only wires it up.
    The write runs against a probe in place of the SQL builder and a cursor that logs into the test's log.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.
        node: The node folder under ``nodes/src/nodes``.
        driver: The node's driver module.
        with_iglobal: Load the node's IGlobal first.

    Returns:
        The store and its log.
    """
    module = _load_driver(monkeypatch, node, driver, (), with_iglobal=with_iglobal)
    from ai.common.store.pgvector import sql as pgsql

    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collection = 'test'
    store._write_lock = threading.RLock()
    store._state_lock = threading.RLock()
    store._exists = True
    store._sql = _SqlProbe()
    store._meta_column = lambda: True
    store._columns_now = lambda: list(pgsql.WRITE_COLUMNS)
    store._row = lambda chunk, columns: [
        getattr(chunk.metadata, {'objectid': 'objectId', 'chunkid': 'chunkId'}.get(name, name), None)
        for name in columns
    ]
    store.INSERT_BATCH = 100
    store._db = types.SimpleNamespace(run_write=lambda work: work(_Cursor(log)))
    return store, log


def _postgres(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a store_postgres store whose transaction's statements are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    return _pgvector_store(monkeypatch, 'store_postgres', 'postgres', with_iglobal=True)


def _rocketride_vector(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a rocketride_vector store whose transaction's statements are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    return _pgvector_store(monkeypatch, 'rocketride_vector', 'rocketride_vector', with_iglobal=True)


_DRIVERS = {
    'store_pinecone': _pinecone,
    'store_milvus': _milvus,
    'store_weaviate': _weaviate,
    'store_postgres': _postgres,
    'rocketride_vector': _rocketride_vector,
}


@pytest.fixture(params=sorted(_DRIVERS))
def store_log(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> tuple[object, _Log]:
    """Yield each of the five drivers with its logging backend.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.
        request: Carries the node name.

    Returns:
        The store and its log.
    """
    return _DRIVERS[request.param](monkeypatch)


def _chunks(object_id: str, chunk_ids) -> list[Doc]:
    """Build one chunk per id, as an embedding node hands them to the store.

    Args:
        object_id: The object every chunk belongs to.
        chunk_ids: The chunk numbers.

    Returns:
        The documents.
    """
    return [
        Doc(
            page_content=f'{object_id} chunk {chunk_id}',
            metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, parent=f'/{object_id}', isDeleted=False),
            embedding=[1.0, 0.0, 0.0],
        )
        for chunk_id in chunk_ids
    ]


def test_every_flush_of_one_object_is_kept(store_log):
    """153 chunks in flushes of 64: only the first flush, which holds chunk 0, deletes anything."""
    store, log = store_log
    for flush in (range(0, 64), range(64, 128), range(128, 153)):
        store.addChunks(_chunks('big', flush), checkCollection=False)
    assert log.deleted == [['big']]
    assert sorted(chunk_id for _, chunk_id in log.stored) == list(range(153))


def test_chunk_zero_replaces_only_its_own_object(store_log):
    """One batch can start one object and continue another: only the started one is deleted."""
    store, log = store_log
    store.addChunks(_chunks('a', [0, 1]) + _chunks('b', [5]), checkCollection=False)
    assert log.deleted == [['a']]
    assert sorted(log.stored) == [('a', 0), ('a', 1), ('b', 5)]


def test_a_reingest_replaces_the_stored_object(store_log):
    """Writing an object's chunk 0 again removes its old chunks and leaves other objects alone."""
    store, log = store_log
    store.addChunks(_chunks('a', range(0, 5)) + _chunks('b', [0]), checkCollection=False)
    store.addChunks(_chunks('a', [0, 1]), checkCollection=False)
    assert sorted(log.stored) == [('a', 0), ('a', 1), ('b', 0)]


def test_a_batch_without_chunk_zero_deletes_nothing(store_log):
    """A batch that only continues objects sends no delete at all."""
    store, log = store_log
    store.addChunks(_chunks('a', [3, 4]), checkCollection=False)
    assert log.deleted == []
    assert sorted(log.stored) == [('a', 3), ('a', 4)]


def test_pinecone_never_deletes_the_control_row(monkeypatch):
    """Pinecone kept the schema row out of its delete before; chunk 0 of that row must not change it."""
    store, log = _pinecone(monkeypatch)
    store.addChunks(_chunks(CONTROL_OBJECT_ID, [0]) + _chunks('a', [0]), checkCollection=False)
    assert log.deleted == [['a']]


def test_a_repeated_chunk_without_chunk_zero_replaces_the_stored_one(store_log):
    """The port's stores key a chunk by (objectId, chunkId): sending a stored chunk again replaces it.

    Develop's #2962 keeps both copies of a chunk number a batch without chunk 0 repeats (its rows get generated
    ids). Here the retried or corrected chunk takes the place of the stored one, so an object never holds two
    chunks with one key, and the chunks around it stay. A batch that holds chunk 0 still replaces the whole object.
    """
    store, log = store_log
    store.addChunks(_chunks('a', [0, 1, 2]), checkCollection=False)
    store.addChunks(_chunks('a', [1]), checkCollection=False)
    assert sorted(log.stored) == [('a', 0), ('a', 1), ('a', 2)]
    assert log.deleted == [['a']], 'only the first batch, which holds chunk 0, deletes the object'


def test_a_repeated_chunk_does_not_touch_other_objects_or_chunks(store_log):
    """Replacing one chunk of an object leaves its other chunks and other objects as they are."""
    store, log = store_log
    store.addChunks(_chunks('a', [0, 1, 2]) + _chunks('b', [0, 1]), checkCollection=False)
    store.addChunks(_chunks('a', [2]) + _chunks('b', [1]), checkCollection=False)
    assert sorted(log.stored) == [('a', 0), ('a', 1), ('a', 2), ('b', 0), ('b', 1)]
