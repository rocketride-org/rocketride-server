# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Real PostgreSQL tests for the vector-store trash and listing tools on both Postgres drivers (#2587, #2704).

Covers what the unit tests cannot: the listing and counting SQL, the row counts of markDeleted and
markActive, objdir pages that count paths, and the tools (list_documents, soft_delete, restore, get,
upsert, stats) on a real store. Runs with the built engine and RR_TEST_PG_DSN like
test_vector_store_writes_full.py, whose fixture it shares; set RR_REQUIRE_DB_TESTS=1 to fail instead
of skip. Each test uses a unique table.

#2704's driver contract (``listDocuments`` / ``countDocuments`` / ``supports_document_listing``) is
gone: every driver lists through ``listDocumentPage`` and pages with a cursor. The tools answer
#2704's keys (``documents``, ``total``, ``offset``, ``has_more``) beside the explorer's.
"""

import types

from .test_vector_store_writes_full import _doc
from .test_vector_store_writes_full import store_env as _shared_store_env

# pytest registers a fixture under the name it is bound to in the module, so the
# shared two-driver fixture serves this file as store_env too.
store_env = _shared_store_env

_EMBEDDING = [1.0, 0.0, 0.0]


class _AgentTools:
    """The store instance base on a real store, every tool called as an agent's (the write gate fails closed otherwise)."""

    def __init__(self, tool):
        self._tool = tool

    def __getattr__(self, name):
        attr = getattr(self._tool, name)
        if not callable(attr) or name.startswith('_'):
            return attr

        def call(*args, **kwargs):
            from ai.common.tool_context import ToolCallContext, tool_call

            context = ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})
            with tool_call(context):
                return attr(*args, **kwargs)

        return call

    def _collect_tool_methods(self):
        return self._tool._collect_tool_methods()


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
    return _AgentTools(tool)


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


def _page(store, deleted='active', limit=100, cursor=None):
    return store.listDocumentPage(cursor=cursor, limit=limit, object_ids=None, deleted=deleted, sort='path')


def _rows(page):
    return [(row.objectId, row.path, row.chunks) for row in page.items]


# ---------------------------------------------------------------------------
# Driver contract: listDocumentPage
# ---------------------------------------------------------------------------


def test_the_drivers_list_documents_natively(store_env):
    store, _, _ = store_env
    # Before any write there is no collection: empty, not an error.
    assert _page(store).items == []
    assert not hasattr(store, 'supports_document_listing')


def test_listing_has_one_row_per_document_in_path_order(store_env):
    store, _, _ = store_env
    _seed(store)

    page = _page(store)

    # Ordered by (path, objectId); the control row is never listed.
    assert _rows(page) == [('c', '/other', 1), ('a', '/test', 1), ('b', '/test', 2)]
    assert (page.total, page.next_cursor, page.distinct, page.sorted) == (3, None, True, True)


def test_listing_filters_on_the_exact_parent(store_env):
    store, _, _ = store_env
    _seed(store)
    tool = _tools(store, allow_write=False)

    assert [row['object_id'] for row in tool.list_documents({'parent': '/test'})['documents']] == ['a', 'b']
    assert tool.list_documents({'parent': '/tes'})['documents'] == []
    assert tool.list_documents({'parent': '/absent'})['documents'] == []


def test_listing_pages_by_cursor_and_never_lists_the_control_row(store_env):
    store, _, _ = store_env
    store.addChunks([_doc(f'doc-{i:02d}', content=f'd{i}') for i in reversed(range(5))])

    seen, cursor = [], None
    for _ in range(4):
        page = _page(store, limit=2, cursor=cursor)
        seen.append([row.objectId for row in page.items])
        cursor = page.next_cursor
        if cursor is None:
            break

    assert seen == [['doc-00', 'doc-01'], ['doc-02', 'doc-03'], ['doc-04']]
    # The control row carries isDeleted, like a trashed document; neither list has it.
    assert 'schema' not in {row.objectId for row in _page(store, deleted='deleted').items}
    assert _page(store, deleted='deleted').items == []


def test_documents_move_between_the_active_list_and_the_trash(store_env):
    store, _, _ = store_env
    _seed(store)

    # The count is the chunk rows the call moved: b has two.
    assert store.markDeleted(['b', 'never-stored']) == 2
    assert [row.objectId for row in _page(store).items] == ['c', 'a']
    assert _rows(_page(store, deleted='deleted')) == [('b', '/test', 2)]

    assert store.markActive(['b']) == 2
    assert _page(store, deleted='deleted').items == []
    assert [row.objectId for row in _page(store).items] == ['c', 'a', 'b']
    assert store.markDeleted(['never-stored']) == 0
    # Documents already in the other state move nothing.
    assert store.markActive(['b']) == 0


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

    # #2668 at the tool: a page counts distinct paths (each mapped to its lowest object id); `entries` lists
    # every document under the page's paths.
    tool = _tools(store)
    objdir = tool.objdir({'limit': 2})
    assert objdir['success'] is True and objdir['paths'] == {'/aa': 'x1', '/b': 'y'}
    assert [(entry['path'], entry['objectId']) for entry in objdir['entries']] == [
        ('/aa', 'x1'),
        ('/aa', 'x2'),
        ('/aa', 'x3'),
        ('/b', 'y'),
    ]
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
        {'object_id': 'late', 'parent': '/late', 'chunk_count': 1},
        {'object_id': 'early', 'parent': '/test', 'chunk_count': 1},
    ]


# ---------------------------------------------------------------------------
# The tools on the real store
# ---------------------------------------------------------------------------


def test_list_documents_tool_pages_with_both_key_sets(store_env):
    store, _, _ = store_env
    tool = _tools(store, allow_write=False)
    assert 'list_documents' in tool._collect_tool_methods()
    empty = tool.list_documents({})
    assert (empty['success'], empty['documents'], empty['total'], empty['offset'], empty['has_more']) == (
        True,
        [],
        0,
        0,
        False,
    )

    _seed(store)
    first = tool.list_documents({'limit': 2})
    # #2704's keys (rows are in path order now: /other before /test) ...
    assert first['documents'] == [
        {'object_id': 'c', 'parent': '/other', 'chunk_count': 1},
        {'object_id': 'a', 'parent': '/test', 'chunk_count': 1},
    ]
    assert (first['total'], first['offset'], first['has_more']) == (3, 0, True)
    # ... and the explorer's.
    assert [item['objectId'] for item in first['items']] == ['c', 'a'] and first['next_cursor']

    second = tool.list_documents({'limit': 2, 'cursor': first['next_cursor']})
    assert [row['object_id'] for row in second['documents']] == ['b']
    assert (second['total'], second['has_more'], second['next_cursor']) == (3, False, None)
    assert tool.list_documents({'parent': '/other'})['documents'] == [
        {'object_id': 'c', 'parent': '/other', 'chunk_count': 1}
    ]
    # An offset past 0 is refused, naming the cursor.
    refused = tool.list_documents({'offset': 2})
    assert refused['success'] is False and refused['code'] == 'INVALID_INPUT' and 'cursor' in refused['error']


def test_soft_delete_and_restore_tools_round_trip(store_env):
    store, _, _ = store_env
    _seed(store)
    tool = _tools(store)

    soft = tool.soft_delete({'object_ids': ['b', 'b', 'ghost']})
    assert (soft['success'], soft['object_ids'], soft['matched_chunks'], soft['moved_chunks']) == (
        True,
        ['b', 'ghost'],
        2,
        2,
    )
    assert soft['not_found'] == ['ghost']
    assert [row['object_id'] for row in tool.list_documents({})['documents']] == ['c', 'a']
    assert [row['object_id'] for row in tool.list_documents({'deleted': True})['documents']] == ['b']
    assert tool.objdir({})['paths'] == {'/other': 'c', '/test': 'a'}
    trashed = tool.get({'object_id': 'b'})
    assert (trashed['success'], trashed['code'], trashed['object_id']) == (False, 'IN_TRASH', 'b')
    assert trashed['error'] == "get: document 'b' is soft-deleted; restore it to read it"
    stats = tool.stats({})
    assert (stats['count'], stats['document_count']) == (5, 2)  # four chunks and the control row; two documents

    restored = tool.restore({'object_ids': ['b']})
    assert (restored['success'], restored['object_ids'], restored['matched_chunks'], restored['moved_chunks']) == (
        True,
        ['b'],
        2,
        2,
    )
    assert tool.get({'object_id': 'b'})['total'] == 2
    assert tool.list_documents({'deleted': True})['documents'] == []
    assert tool.stats({})['document_count'] == 3

    # Restoring a live document matches its rows and moves none.
    again = tool.restore({'object_ids': ['b']})
    assert (again['matched_chunks'], again['moved_chunks']) == (2, 0)

    # Delete is final: restore afterwards finds nothing.
    assert tool.delete({'object_ids': ['b']})['success'] is True
    gone = tool.restore({'object_ids': ['b']})
    assert (gone['matched_chunks'], gone['moved_chunks'], gone['not_found']) == (0, 0, ['b'])
    unknown = tool.get({'object_id': 'b'})
    assert (unknown['code'], unknown['error']) == ('NOT_FOUND', "get: no document with object_id 'b'")


def test_write_tools_stay_behind_the_write_switch_on_the_real_store(store_env):
    store, _, _ = store_env
    _seed(store)
    tool = _tools(store, allow_write=False)

    offered = set(tool._collect_tool_methods())
    assert {'search', 'objdir', 'get', 'stats', 'list_documents'} <= offered
    assert not offered & {'upsert', 'delete', 'soft_delete', 'restore'}
    for name in ('soft_delete', 'restore'):
        assert getattr(tool, name)({'object_ids': ['a']})['success'] is False
    assert _page(store).total == 3


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

    assert (result['success'], result['count'], result['skipped']) == (True, 4, 0)
    page = tool.get({'object_id': 'long'})
    assert [(chunk['chunkId'], chunk['content']) for chunk in page['chunks']] == [
        (0, 'first'),
        (1, 'second'),
        (2, 'third'),
    ]
    assert tool.list_documents({})['documents'] == [
        {'object_id': 'short', 'parent': '/', 'chunk_count': 1},
        {'object_id': 'long', 'parent': '/long.pdf', 'chunk_count': 3},
    ]
    # Replacing the document through upsert replaces every chunk, as before.
    assert tool.upsert({'documents': [_tool_doc('long', 'rewritten')]})['count'] == 1
    assert {row['object_id']: row['chunk_count'] for row in tool.list_documents({})['documents']}['long'] == 1


def test_stats_tool_loads_the_control_row_for_a_reader_that_never_wrote(store_env):
    store, _, _ = store_env
    _seed(store)
    # A second store on the same table, never written through.
    reader = type(store)(store.node if store.node != 'rocketride' else 'rocketride_vector', _reader_config(store), {})
    try:
        # The driver reads the table's control record when it opens, so a reader knows the model at once.
        assert (reader.modelName, reader.vectorSize) == ('test-model', 3)
        stats = _tools(reader, allow_write=False).stats({})
        assert (stats['success'], stats['count'], stats['document_count']) == (True, 5, 3)
        assert (stats['model'], stats['vector_size']) == ('test-model', 3)
    finally:
        reader.close()


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
