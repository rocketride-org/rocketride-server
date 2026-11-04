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

import contextlib
import importlib.util
import json
import re
import sys
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
        self.stored: list[tuple[str, int]] = []

    def delete(self, object_ids) -> None:
        """Record a delete and drop the stored chunks of its objects.

        Args:
            object_ids: The object IDs the delete targets.
        """
        ids = list(object_ids)
        self.deleted.append(ids)
        self.stored = [(object_id, chunk_id) for object_id, chunk_id in self.stored if object_id not in ids]


class _Cursor:
    """A psycopg2 cursor stand-in that logs the driver's DELETE and INSERT statements."""

    def __init__(self, log: _Log) -> None:
        """Log into ``log``.

        Args:
            log: Receives the deletes and inserts.
        """
        self.log = log

    def execute(self, sql: str, params=()) -> None:
        """Log a DELETE by object IDs or an INSERT of one chunk.

        Args:
            sql: The statement the driver built.
            params: Its bound values.
        """
        if sql.startswith('DELETE'):
            self.log.delete(params[0])
        elif sql.startswith('INSERT'):
            columns = [column.strip() for column in re.search(r'\(([^)]*)\)\s*VALUES', sql).group(1).split(',')]
            row = dict(zip(columns, params))
            self.log.stored.append((row['objectId'], row['chunkId']))


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
    store.client.Index.return_value.upsert.side_effect = lambda vectors: log.stored.extend(
        (vector['metadata']['objectId'], vector['metadata']['chunkId']) for vector in vectors
    )
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
    store.client.delete.side_effect = lambda collection_name, filter: log.delete(
        json.loads(re.search(r'in (\[.*\])$', filter).group(1))
    )
    store.client.upsert.side_effect = lambda collection_name, data: log.stored.extend(
        (row['meta'].objectId, row['meta'].chunkId) for row in data
    )
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
    batch.add_object.side_effect = lambda properties, uuid, vector: log.stored.append(
        (properties['objectId'], properties['chunkId'])
    )
    return store, log


def _postgres(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a store_postgres store whose transaction's statements are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    module = _load_driver(
        monkeypatch, 'store_postgres', 'postgres', ('psycopg2', 'pgvector', 'pgvector.psycopg2'), with_iglobal=True
    )
    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collection = 'test'

    def transaction() -> contextlib.AbstractContextManager[_Cursor]:
        """Open a transaction whose cursor logs into ``log``."""
        return contextlib.nullcontext(_Cursor(log))

    store._transaction = transaction
    return store, log


def _rocketride_vector(monkeypatch: pytest.MonkeyPatch) -> tuple[object, _Log]:
    """Build a rocketride_vector store whose transaction's statements are logged.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store and its log.
    """
    module = _load_driver(
        monkeypatch,
        'rocketride_vector',
        'rocketride_vector',
        ('psycopg2', 'pgvector', 'pgvector.psycopg2'),
        with_iglobal=True,
    )
    log = _Log()
    store = module.Store.__new__(module.Store)
    store.collection = 'test'

    def transaction() -> contextlib.AbstractContextManager[_Cursor]:
        """Open a transaction whose cursor logs into ``log``."""
        return contextlib.nullcontext(_Cursor(log))

    store._transaction = transaction
    return store, log


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
