# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Real PostgreSQL tests for the vector-store trash and listing tools on both Postgres drivers (#2587).

Covers what the unit tests cannot: the listing and counting SQL, the matched
row counts of markDeleted and markActive, objdir pages that count paths, and
the tools (list_documents, soft_delete, restore, get, upsert, stats) on a real
store. Runs with the built engine and RR_TEST_PG_DSN like
test_vector_store_writes_full.py, whose fixture it shares; set
RR_REQUIRE_DB_TESTS=1 to fail instead of skip. Each test uses a unique table.
"""

import types

from .test_vector_store_writes_full import _doc
from .test_vector_store_writes_full import store_env as _shared_store_env

# pytest registers a fixture under the name it is bound to in the module, so the
# shared two-driver fixture serves this file as store_env too.
store_env = _shared_store_env

_EMBEDDING = [1.0, 0.0, 0.0]


def _tools(store, allow_write=True):
    """The store instance base on the real store, the way StoreGlobalBase leaves a node after beginGlobal.

    The engine's IInstanceBase supplies _collect_tool_methods, so discovery is
    the real thing; no engine wiring beyond IGlobal, as in test_store_base.
    """
    from ai.common.store.store_instance_base import StoreInstanceBase

    tool = StoreInstanceBase.__new__(StoreInstanceBase)
    tool.IGlobal = types.SimpleNamespace(
        serverName='rrvector',
        store=store,
        embed_query=None,
        embed_model_name=None,
        expose_tools=True,
        allow_write=allow_write,
    )
    return tool


def _tool_doc(object_id, content, **metadata):
    doc = {'content': content, 'object_id': object_id, 'embedding': _EMBEDDING, 'embedding_model': 'test-model'}
    if metadata:
        doc['metadata'] = metadata
    return doc


def _seed(store):
    """Three documents: a (1 chunk) and b (2 chunks) under /test, c under /other."""
    other = _doc('c', content='c0')
    other.metadata.parent = '/other'
    store.addChunks([_doc('b', 1, 'b1'), _doc('a', content='a0'), _doc('b', 0, 'b0'), other])


# ---------------------------------------------------------------------------
# Driver contract: listDocuments / countDocuments
# ---------------------------------------------------------------------------


def test_the_drivers_opt_into_the_listing(store_env):
    store, _, _ = store_env
    assert store.supports_document_listing is True
    # Before any write there is no collection: empty, not an error.
    assert store.listDocuments() == []
    assert store.countDocuments() == 0


def test_listing_has_one_row_per_document_in_object_id_order(store_env):
    store, _, _ = store_env
    _seed(store)

    assert store.listDocuments() == [
        {'object_id': 'a', 'parent': '/test', 'chunk_count': 1},
        {'object_id': 'b', 'parent': '/test', 'chunk_count': 2},
        {'object_id': 'c', 'parent': '/other', 'chunk_count': 1},
    ]
    assert store.countDocuments() == 3


def test_listing_filters_on_the_exact_parent(store_env):
    store, _, _ = store_env
    _seed(store)

    assert [row['object_id'] for row in store.listDocuments(parent='/test')] == ['a', 'b']
    assert store.countDocuments(parent='/test') == 2
    assert store.listDocuments(parent='/tes') == []
    assert store.countDocuments(parent='/absent') == 0


def test_listing_pages_in_order_and_never_lists_the_control_row(store_env):
    store, _, _ = store_env
    store.addChunks([_doc(f'doc-{i:02d}', content=f'd{i}') for i in reversed(range(5))])

    pages = [store.listDocuments(offset=offset, limit=2) for offset in (0, 2, 4, 6)]

    assert [[row['object_id'] for row in page] for page in pages] == [
        ['doc-00', 'doc-01'],
        ['doc-02', 'doc-03'],
        ['doc-04'],
        [],
    ]
    assert store.countDocuments() == 5
    # The control row carries isDeleted, like a trashed document; neither list has it.
    assert 'schema' not in {row['object_id'] for row in store.listDocuments(deleted=True)}
    assert store.countDocuments(deleted=True) == 0


def test_documents_move_between_the_active_list_and_the_trash(store_env):
    store, _, _ = store_env
    _seed(store)

    # The matched count is chunk rows: b has two.
    assert store.markDeleted(['b', 'never-stored']) == 2
    assert [row['object_id'] for row in store.listDocuments()] == ['a', 'c']
    assert store.listDocuments(deleted=True) == [{'object_id': 'b', 'parent': '/test', 'chunk_count': 2}]
    assert (store.countDocuments(), store.countDocuments(deleted=True)) == (2, 1)

    assert store.markActive(['b']) == 2
    assert store.countDocuments(deleted=True) == 0
    assert [row['object_id'] for row in store.listDocuments()] == ['a', 'b', 'c']
    assert store.markDeleted(['never-stored']) == 0


def test_mark_counts_are_zero_without_a_collection(store_env):
    store, _, _ = store_env

    assert store.markDeleted(['a']) == 0
    assert store.markActive(['a']) == 0


# ---------------------------------------------------------------------------
# objdir pages count paths (#2668 item 2)
# ---------------------------------------------------------------------------


def test_path_pages_count_paths_not_documents(store_env):
    store, _, _ = store_env
    docs = []
    for name, parent in (('x1', '/aa'), ('x2', '/aa'), ('x3', '/aa'), ('y', '/b'), ('z', '/c')):
        doc = _doc(name, content=name)
        doc.metadata.parent = parent
        docs.append(doc)
    store.addChunks(docs)

    # Before: the first page held rows x1 and x2, so one entry; now two paths per page.
    assert store.getPaths(limit=2) == {'/aa': 'x1', '/b': 'y'}
    assert store.getPaths(offset=2, limit=2) == {'/c': 'z'}
    assert store.getPaths(offset=4, limit=2) == {}

    tool = _tools(store)
    assert tool.objdir({'limit': 2}) == {'success': True, 'paths': {'/aa': 'x1', '/b': 'y'}}
    assert tool.objdir({'offset': 2, 'limit': 2})['paths'] == {'/c': 'z'}

    # The parent filter narrows the distinct paths the same way.
    assert store.getPaths(parent='/aa') == {'/aa': 'x1'}
    assert store.getPaths(parent='/aa', offset=1) == {}
    assert store.getPaths(parent='/none') == {}


def test_paths_list_a_document_whatever_its_chunk_ids(store_env):
    """A document whose chunks start at 1 (explicit chunkId through upsert) is listed too."""
    store, _, _ = store_env
    tool = _tools(store)
    assert tool.upsert({'documents': [_tool_doc('late', 'one', parent='/late', chunkId=1)]})['count'] == 1
    store.addChunks([_doc('early', content='zero')])

    assert store.getPaths() == {'/late': 'late', '/test': 'early'}
    assert tool.list_documents({})['documents'] == [
        {'object_id': 'early', 'parent': '/test', 'chunk_count': 1},
        {'object_id': 'late', 'parent': '/late', 'chunk_count': 1},
    ]


# ---------------------------------------------------------------------------
# The tools on the real store
# ---------------------------------------------------------------------------


def test_list_documents_tool_pages_with_total_and_has_more(store_env):
    store, _, _ = store_env
    tool = _tools(store, allow_write=False)
    assert 'list_documents' in tool._collect_tool_methods()
    assert tool.list_documents({}) == {'success': True, 'documents': [], 'total': 0, 'offset': 0, 'has_more': False}

    _seed(store)
    first = tool.list_documents({'limit': 2})
    assert first == {
        'success': True,
        'documents': [
            {'object_id': 'a', 'parent': '/test', 'chunk_count': 1},
            {'object_id': 'b', 'parent': '/test', 'chunk_count': 2},
        ],
        'total': 3,
        'offset': 0,
        'has_more': True,
    }
    second = tool.list_documents({'limit': 2, 'offset': 2})
    assert [row['object_id'] for row in second['documents']] == ['c']
    assert (second['total'], second['has_more']) == (3, False)
    assert tool.list_documents({'parent': '/other'})['documents'] == [
        {'object_id': 'c', 'parent': '/other', 'chunk_count': 1}
    ]


def test_soft_delete_and_restore_tools_round_trip(store_env):
    store, _, _ = store_env
    _seed(store)
    tool = _tools(store)

    assert tool.soft_delete({'object_ids': ['b', 'b', 'ghost']}) == {
        'success': True,
        'object_ids': ['b', 'ghost'],
        'matched_chunks': 2,
    }
    assert [row['object_id'] for row in tool.list_documents({})['documents']] == ['a', 'c']
    assert [row['object_id'] for row in tool.list_documents({'deleted': True})['documents']] == ['b']
    assert tool.objdir({})['paths'] == {'/other': 'c', '/test': 'a'}
    assert tool.get({'object_id': 'b'}) == {
        'success': False,
        'error': "get: document 'b' is soft-deleted; restore it to read it",
        'object_id': 'b',
    }
    stats = tool.stats({})
    assert (stats['count'], stats['document_count']) == (5, 2)  # four chunks and the control row; two documents

    assert tool.restore({'object_ids': ['b']}) == {'success': True, 'object_ids': ['b'], 'matched_chunks': 2}
    assert tool.get({'object_id': 'b'})['total'] == 2
    assert tool.list_documents({'deleted': True})['documents'] == []
    assert tool.stats({})['document_count'] == 3

    # Delete is final: restore afterwards matches nothing.
    assert tool.delete({'object_ids': ['b']})['success'] is True
    assert tool.restore({'object_ids': ['b']})['matched_chunks'] == 0
    assert tool.get({'object_id': 'b'})['error'] == "get: no document with object_id 'b'"


def test_write_tools_stay_behind_the_write_switch_on_the_real_store(store_env):
    store, _, _ = store_env
    _seed(store)
    tool = _tools(store, allow_write=False)

    assert set(tool._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats', 'list_documents'}
    for name in ('soft_delete', 'restore'):
        assert getattr(tool, name)({'object_ids': ['a']})['success'] is False
    assert store.countDocuments() == 3


def test_upsert_tool_numbers_the_chunks_of_one_document(store_env):
    store, _, _ = store_env
    tool = _tools(store)

    result = tool.upsert(
        {
            'documents': [
                _tool_doc('long', 'first', parent='/long.pdf'),
                _tool_doc('long', 'second', parent='/long.pdf'),
                _tool_doc('long', 'third', parent='/long.pdf'),
                _tool_doc('short', 'only'),
            ]
        }
    )

    assert result == {'success': True, 'count': 4, 'skipped': 0}
    page = tool.get({'object_id': 'long'})
    assert [(chunk['chunkId'], chunk['content']) for chunk in page['chunks']] == [
        (0, 'first'),
        (1, 'second'),
        (2, 'third'),
    ]
    assert tool.list_documents({})['documents'] == [
        {'object_id': 'long', 'parent': '/long.pdf', 'chunk_count': 3},
        {'object_id': 'short', 'parent': '/', 'chunk_count': 1},
    ]
    # Replacing the document through upsert replaces every chunk, as before.
    assert tool.upsert({'documents': [_tool_doc('long', 'rewritten')]})['count'] == 1
    assert tool.list_documents({})['documents'][0]['chunk_count'] == 1


def test_stats_tool_loads_the_control_row_for_a_reader_that_never_wrote(store_env):
    store, _, _ = store_env
    _seed(store)
    # A second store on the same table, never written through: model unknown until stats checks.
    reader = type(store)(store.node if store.node != 'rocketride' else 'rocketride_vector', _reader_config(store), {})
    try:
        assert (reader.modelName, reader.vectorSize) == ('', 0)
        stats = _tools(reader, allow_write=False).stats({})
        assert stats == {'success': True, 'count': 5, 'document_count': 3, 'model': 'test-model', 'vector_size': 3}
    finally:
        if reader.client is not None:
            reader.client.close()
            reader.client = None


def _reader_config(store):
    """The connection config a second Store needs to open the same table."""
    config = {'collection': store.collection, 'similarity': 'cosine'}
    if store.node == 'postgres':
        config.update(
            host=store.host,
            port=store.port,
            user=getattr(store, 'user', None),
            password=getattr(store, 'password', None),
            database=getattr(store, 'database', None),
        )
    return config
