# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""store_chroma soft delete and restore (#2587).

markDeleted and markActive iterated the dict a Chroma ``get`` returns as if it
were a list of records and called an ``update(where=..., new_metadata=...)``
that chromadb does not have, so both raised on the first document. The shared
soft_delete and restore tools made that reachable from an agent.

The engine ships the http-only chromadb client, so there is no in-process
Chroma to run against; the collection is a fake with the client's ``get`` and
``update`` signatures, and one test pins those signatures to the installed
client so the fake cannot drift from it.
"""

from __future__ import annotations

import inspect
import types

import pytest

from .test_convert_filter_explicit_none import _load_store_class


class _FakeCollection:
    """A chromadb Collection reduced to what markDeleted/markActive and count_documents call.

    ``get`` answers like the client: one dict of parallel lists. ``update``
    takes ids with their new metadatas; there is no update by filter.
    ``count`` returns the number of records, as the server does.
    """

    def __init__(self, rows):
        self.rows = {row_id: dict(meta) for row_id, meta in rows.items()}
        self.get_calls = []
        self.update_calls = []

    def get(self, ids=None, where=None, limit=None, offset=None, where_document=None, include=None):
        self.get_calls.append(where)

        def matches(meta, clause):
            if clause is None:
                return True
            if '$and' in clause:
                return all(matches(meta, child) for child in clause['$and'])
            assert len(clause) == 1  # Chroma requires one field per clause.
            field, condition = next(iter(clause.items()))
            if '$in' in condition:
                return meta.get(field) in condition['$in']
            if '$ne' in condition:
                return meta.get(field) != condition['$ne']  # an absent key is not equal, as in Chroma
            return meta.get(field) == condition['$eq']

        hits = [(row_id, meta) for row_id, meta in self.rows.items() if matches(meta, where)]
        hits = hits[offset or 0 :]
        if limit is not None:
            hits = hits[:limit]
        return {
            'ids': [row_id for row_id, _ in hits],
            'metadatas': [dict(meta) for _, meta in hits] if include is None or 'metadatas' in include else None,
            'embeddings': None,
            'documents': None,
            'uris': None,
            'data': None,
            'included': list(include or []),
        }

    def update(self, ids, embeddings=None, metadatas=None, documents=None, images=None, uris=None):
        assert isinstance(ids, list) and len(ids) == len(metadatas)
        self.update_calls.append(list(ids))
        for row_id, meta in zip(ids, metadatas):
            self.rows[row_id] = dict(meta)

    def count(self, read_level=None):
        return len(self.rows)


def _rows(object_id, count, deleted=False):
    return {
        f'{object_id}-{i}': {'objectId': object_id, 'chunkId': i, 'parent': f'/{object_id}', 'isDeleted': deleted}
        for i in range(count)
    }


@pytest.fixture()
def store():
    """The driver on a fake collection holding a (2 chunks) and b (1 chunk)."""
    store_cls = _load_store_class()
    driver = store_cls.__new__(store_cls)  # no connection: these methods use the collection object only
    driver.client = None
    driver.collectionObj = _FakeCollection({**_rows('a', 2), **_rows('b', 1)})
    driver.doesCollectionExist = lambda modelName=None: True
    return driver


def _deleted_flags(collection):
    return {row_id: meta['isDeleted'] for row_id, meta in collection.rows.items()}


def test_the_fake_matches_the_installed_client():
    """Pins the three calls the driver makes to the real client's API."""
    chromadb = pytest.importorskip('chromadb')
    from chromadb.api.models.Collection import Collection
    from chromadb.api.types import GetResult

    get_params = inspect.signature(Collection.get).parameters
    update_params = inspect.signature(Collection.update).parameters
    count_params = inspect.signature(Collection.count).parameters
    assert {'where', 'include'} <= set(get_params)
    assert {'ids', 'metadatas'} <= set(update_params)
    assert not {'where', 'new_metadata'} & set(update_params), chromadb.__version__
    assert {'ids', 'metadatas'} <= set(GetResult.__annotations__)
    assert set(inspect.signature(_FakeCollection.get).parameters) == set(get_params)
    assert set(inspect.signature(_FakeCollection.update).parameters) == set(update_params)
    assert set(inspect.signature(_FakeCollection.count).parameters) == set(count_params)


def test_mark_deleted_flips_every_chunk_of_the_named_documents_in_one_update(store):
    collection = store.collectionObj

    assert store.markDeleted(['a', 'never-stored']) == 2

    assert _deleted_flags(collection) == {'a-0': True, 'a-1': True, 'b-0': False}
    assert collection.get_calls == [{'objectId': {'$in': ['a', 'never-stored']}}]
    assert collection.update_calls == [['a-0', 'a-1']]
    # The other metadata survives the update.
    assert collection.rows['a-1'] == {'objectId': 'a', 'chunkId': 1, 'parent': '/a', 'isDeleted': True}


def test_mark_active_brings_the_chunks_back(store):
    collection = store.collectionObj
    store.markDeleted(['a', 'b'])

    assert store.markActive(['a']) == 2

    assert _deleted_flags(collection) == {'a-0': False, 'a-1': False, 'b-0': True}


def test_unknown_ids_and_empty_lists_match_nothing(store):
    collection = store.collectionObj

    assert store.markDeleted(['never-stored']) == 0
    assert store.markActive([]) == 0

    assert collection.update_calls == []
    assert collection.get_calls == [{'objectId': {'$in': ['never-stored']}}]  # the empty list never reads
    assert _deleted_flags(collection) == {'a-0': False, 'a-1': False, 'b-0': False}


def test_updates_are_sliced_to_the_servers_batch_limit(store):
    """The HTTP client refuses a request above the limit the server reports."""
    store.client = types.SimpleNamespace(get_max_batch_size=lambda: 2)

    assert store.markDeleted(['a', 'b']) == 3

    assert store.collectionObj.update_calls == [['a-0', 'a-1'], ['b-0']]
    assert _deleted_flags(store.collectionObj) == {'a-0': True, 'a-1': True, 'b-0': True}


def test_without_a_client_limit_the_update_is_one_call(store):
    store.client = None

    assert store.markDeleted(['a', 'b']) == 3
    assert store.collectionObj.update_calls == [['a-0', 'a-1', 'b-0']]


def test_a_missing_collection_matches_nothing(store):
    store.doesCollectionExist = lambda modelName=None: False

    assert store.markDeleted(['a']) == 0
    assert store.collectionObj.get_calls == []


def test_the_trash_tools_work_on_this_driver(store):
    """What an agent reaches: soft_delete and restore through the shared mixin."""
    from ai.common.store.document_store import VectorStoreToolMixin

    tool = VectorStoreToolMixin()
    tool.IGlobal = types.SimpleNamespace(
        serverName='chroma', store=store, embed_query=None, embed_model_name=None, expose_tools=True, allow_write=True
    )

    assert tool.soft_delete({'object_ids': ['b']}) == {'success': True, 'object_ids': ['b'], 'matched_chunks': 1}
    assert _deleted_flags(store.collectionObj)['b-0'] is True
    assert tool.restore({'object_ids': ['b']}) == {'success': True, 'object_ids': ['b'], 'matched_chunks': 1}
    assert _deleted_flags(store.collectionObj)['b-0'] is False


def test_stats_count_asks_the_server_instead_of_reading_every_id(store):
    """The stats count is every record, trashed ones included, from Collection.count rather than one ID per row."""
    from ai.common.store.document_store import VectorStoreToolMixin

    collection = store.collectionObj
    store.markDeleted(['b'])
    collection.get_calls.clear()
    store.modelName, store.vectorSize = 'test-model', 2
    tool = VectorStoreToolMixin()
    tool.IGlobal = types.SimpleNamespace(serverName='chroma', store=store, expose_tools=True)

    assert store.count_documents() == 3
    assert tool.stats({})['count'] == 3
    assert collection.get_calls == []


def test_paths_list_records_without_a_deleted_flag_and_hide_trashed_ones(store):
    """The client strips None metadata, so a chunk-0 record may lack isDeleted; objdir must agree with get."""
    collection = store.collectionObj
    collection.rows['c-0'] = {'objectId': 'c', 'chunkId': 0, 'parent': '/c'}  # no isDeleted key

    assert store.getPaths() == {'/a': 'a', '/b': 'b', '/c': 'c'}
    assert collection.get_calls[-1] == {'$and': [{'chunkId': {'$eq': 0}}, {'isDeleted': {'$ne': True}}]}

    store.markDeleted(['c'])
    assert store.getPaths() == {'/a': 'a', '/b': 'b'}
    assert store.getPaths(parent='/c') == {}


def test_trash_round_trip_filters_paths_before_paging(store):
    store.collectionObj.rows.update(_rows('schema', 1, deleted=True))
    assert store.getPaths(offset=1, limit=1) == {'/b': 'b'}

    store.markDeleted(['a'])
    assert store.getPaths(limit=1) == {'/b': 'b'}
    assert store.getPaths(parent='/a') == {}
    assert store.getPaths(offset=1, limit=1) == {}

    store.markActive(['a'])
    assert store.getPaths(parent='/a') == {'/a': 'a'}
    assert store.getPaths() == {'/a': 'a', '/b': 'b'}
