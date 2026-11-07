"""
Unit tests for the write switch on ai.common.store.document_store.VectorStoreToolMixin.

Coverage for issue #2587: every tool honours ``IGlobal.expose_tools``, the write
tools (upsert, delete, soft_delete, restore) also ``IGlobal.allow_write``.
A node that never sets it keeps writing (every existing store node); a node that
sets it off (rocketride_vector, whose table lives in the team's managed database)
gets a readable refusal instead of a write, and the read tools are not affected
either way.
"""

from types import SimpleNamespace

import pytest

from ._vectordb_tool_harness import DOC, Tools, make_store

# The stand-ins live in _vectordb_tool_harness, shared with the per-change test files.
_Tools = Tools
_store = make_store
_DOCS = [DOC]


def test_writes_stay_allowed_when_the_node_sets_nothing():
    store = _store()
    tools = _Tools(store)

    assert tools.upsert({'documents': _DOCS})['success'] is True
    store.addChunks.assert_called_once()
    assert tools.delete({'object_ids': ['obj-1']}) == {'success': True, 'deleted_count': 1, 'object_ids': ['obj-1']}
    store.remove.assert_called_once_with(['obj-1'])


def test_writes_allowed_when_the_node_turns_them_on():
    store = _store()
    tools = _Tools(store, allow_write=True)

    assert tools.upsert({'documents': _DOCS})['success'] is True
    assert tools.delete({'object_ids': ['obj-1']})['success'] is True
    store.addChunks.assert_called_once()
    store.remove.assert_called_once()


@pytest.mark.parametrize('tool, args', [('upsert', {'documents': _DOCS}), ('delete', {'object_ids': ['obj-1']})])
def test_write_tools_refuse_when_writes_are_off(tool, args):
    store = _store()
    tools = _Tools(store, allow_write=False)

    result = getattr(tools, tool)(args)

    assert result['success'] is False
    # The refusal names the tool and the switch, so an agent or app knows what to change.
    assert result['error'].startswith(f'rrvector.{tool} is disabled for this node')
    assert 'allow_write=true' in result['error']
    store.addChunks.assert_not_called()
    store.remove.assert_not_called()


# An unrecognised string falls back to the mixin's default (allowed); a managed node never
# reaches this path with one, because StoreGlobalBase resolves the switch to a bool first.
@pytest.mark.parametrize(
    'value, allowed', [('true', True), ('1', True), ('false', False), ('0', False), ('maybe', True)]
)
def test_a_string_switch_is_parsed_like_a_config_value(value, allowed):
    store = _store()
    tools = _Tools(store, allow_write=value)

    assert tools.delete({'object_ids': ['obj-1']})['success'] is allowed


@pytest.mark.parametrize('allow_write, advertised', [(None, 8), (True, 8), (False, 4)])
def test_write_tools_are_left_out_of_discovery_while_writes_are_off(allow_write, advertised):
    # list_documents is never among them here: the MagicMock store does not list documents.
    tools = _Tools(_store(), allow_write=allow_write)

    names = set(tools._collect_tool_methods())

    assert len(names) == advertised
    assert {'search', 'objdir', 'get', 'stats'} <= names
    assert ({'upsert', 'delete', 'soft_delete', 'restore'} <= names) is (allow_write is not False)


def test_the_refusal_comes_before_input_validation():
    # Writes are off: even a malformed call is refused for that reason, never acted on.
    store = _store()
    tools = _Tools(store, allow_write=False)

    assert 'disabled' in tools.upsert({})['error']
    assert 'disabled' in tools.delete({'object_ids': []})['error']


def test_search_needs_an_embedder_and_names_the_node():
    store = _store()
    tools = _Tools(store, allow_write=False)

    result = tools.search({'query': 'hello'})

    assert result['success'] is False
    assert 'rrvector' in result['error'] and 'embedding' in result['error']
    store.searchSemantic.assert_not_called()


def test_search_runs_semantic_search_through_the_bound_embedder():
    store = _store()
    store.searchSemantic.return_value = []
    tools = _Tools(store, allow_write=False)
    tools.IGlobal.embed_query = lambda text: [0.1, 0.2]
    tools.IGlobal.embed_model_name = 'test-model'

    result = tools.search({'query': 'hello', 'top_k': 3})

    # A successful search carries the results and the total, no success flag.
    assert result == {'results': [], 'total': 0}
    question, doc_filter = store.searchSemantic.call_args.args
    assert question.text == 'hello' and question.embedding == [0.1, 0.2] and question.embedding_model == 'test-model'
    assert doc_filter.limit == 3


def test_read_tools_ignore_the_write_switch():
    store = _store()
    tools = _Tools(store, allow_write=False)

    assert tools.objdir({}) == {'success': True, 'paths': {'/docs': 'obj-1'}}
    assert tools.get({'object_id': 'obj-1'})['success'] is True
    assert tools.stats({}) == {
        'success': True,
        'count': 3,
        'document_count': None,
        'model': 'test-model',
        'vector_size': 2,
    }


@pytest.mark.parametrize('tool_name, backend', [('get', 'get'), ('objdir', 'getPaths')])
@pytest.mark.parametrize('field', ['offset', 'limit'])
@pytest.mark.parametrize('value', ['invalid', {}, [], True, False, 2.7, 2.0, -1])
def test_read_tools_reject_malformed_pagination_without_reading_store(tool_name, backend, field, value):
    """Reject malformed types and negative bounds before querying the collection."""
    store = _store()
    tools = _Tools(store, allow_write=False, expose_tools=True)

    result = getattr(tools, tool_name)({'object_id': 'obj-1', field: value})

    lower_bound = 0 if field == 'offset' else 1
    assert result == {'success': False, 'error': f'{tool_name}: "{field}" must be an integer >= {lower_bound}'}
    getattr(store, backend).assert_not_called()


@pytest.mark.parametrize('tool_name, backend', [('get', 'get'), ('objdir', 'getPaths')])
def test_read_tools_reject_zero_limit_without_reading_store(tool_name, backend):
    store = _store()
    tools = _Tools(store, allow_write=False, expose_tools=True)

    result = getattr(tools, tool_name)({'object_id': 'obj-1', 'limit': 0})

    assert result == {'success': False, 'error': f'{tool_name}: "limit" must be an integer >= 1'}
    getattr(store, backend).assert_not_called()


def _chunks(n, shuffled=False):
    """Fake driver output: n chunks of one document, optionally out of order."""
    ids = list(range(n))
    if shuffled:
        ids = ids[1::2] + ids[::2]
    return [SimpleNamespace(page_content=f'chunk {i}', metadata={'chunkId': i, 'objectId': 'obj-1'}) for i in ids]


@pytest.mark.parametrize(
    'pagination, offset, limit',
    [
        ({}, 0, 100),
        ({'offset': None, 'limit': None}, 0, 100),
        ({'offset': 2, 'limit': 3}, 2, 3),
        ({'offset': '2', 'limit': '3'}, 2, 3),
        ({'offset': 0, 'limit': 1}, 0, 1),
        ({'limit': 100}, 0, 100),
        ({'limit': 101}, 0, 100),
        ({'limit': '1000000000'}, 0, 100),
    ],
)
def test_get_validates_and_caps_pagination(pagination, offset, limit):
    """Defaults, valid values and capped limits select the page; the driver is asked for the document."""
    store = _store()
    store.get.return_value = _chunks(205, shuffled=True)
    tools = _Tools(store, allow_write=False, expose_tools=True)

    result = tools.get({'object_id': 'obj-1', **pagination})

    assert result['success'] is True
    assert [c['chunkId'] for c in result['chunks']] == list(range(205))[offset : offset + limit]
    assert (result['total'], result['offset'], result['has_more']) == (205, offset, offset + limit < 205)
    assert result['truncated'] is False
    store.get.assert_called_once()
    doc_filter = store.get.call_args.args[0]
    assert doc_filter.objectIds == ['obj-1']
    # Paging happens in the tool, so every driver sees the same filter.
    assert (doc_filter.offset, doc_filter.limit) == (0, 10_000)
    assert doc_filter.isDeleted is False


def test_get_pages_the_whole_document_regardless_of_the_driver():
    """A driver that ignores offset (Astra, Weaviate, Pinecone) still yields distinct, complete pages."""
    store = _store()
    store.get.return_value = _chunks(205, shuffled=True)  # the driver's order does not matter
    tools = _Tools(store, allow_write=False, expose_tools=True)

    pages = [tools.get({'object_id': 'obj-1', 'offset': o, 'limit': 1_000_000}) for o in (0, 100, 200, 205)]

    assert [len(p['chunks']) for p in pages] == [100, 100, 5, 0]
    assert [p['has_more'] for p in pages] == [True, True, False, False]
    assert {p['total'] for p in pages} == {205}
    seen = [c['chunkId'] for p in pages for c in p['chunks']]
    assert seen == list(range(205))
    assert [c['content'] for c in pages[2]['chunks']] == [f'chunk {i}' for i in range(200, 205)]


def test_get_on_an_unknown_document_is_a_failure_not_an_empty_page():
    """An object ID the store never returns a chunk for is reported, whatever the offset (#2587)."""
    store = _store()
    store.get.return_value = []
    tools = _Tools(store, allow_write=False, expose_tools=True)

    result = tools.get({'object_id': 'obj-1', 'offset': 7})

    assert result['success'] is False and result['object_id'] == 'obj-1'
    assert 'no document' in result['error']


def test_get_pages_are_stable_when_chunk_ids_repeat_and_the_store_reorders():
    """Ties on chunkId are broken by content and metadata, so a store that returns the
    same chunks in a different order per call cannot drop or repeat a chunk across pages.
    """
    chunks = [SimpleNamespace(page_content=c, metadata={'chunkId': 1, 'objectId': 'obj-1'}) for c in 'abcd']
    orders = iter([[0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0]])
    store = _store()
    store.get.side_effect = lambda _f: [chunks[i] for i in next(orders)]
    tools = _Tools(store, allow_write=False, expose_tools=True)

    pages = [tools.get({'object_id': 'obj-1', 'offset': o, 'limit': 2}) for o in (0, 2, 4)]

    assert [[c['content'] for c in p['chunks']] for p in pages] == [['a', 'b'], ['c', 'd'], []]
    assert [p['has_more'] for p in pages] == [True, False, False]


def test_get_reports_when_the_read_ceiling_was_hit():
    store = _store()
    store.get.return_value = _chunks(10_000)
    tools = _Tools(store, allow_write=False, expose_tools=True)

    last = tools.get({'object_id': 'obj-1', 'offset': 9_900})

    assert (len(last['chunks']), last['total'], last['has_more']) == (100, 10_000, False)
    assert last['truncated'] is True  # the document may go on past what the tool can read


@pytest.mark.parametrize(
    'pagination, offset, limit',
    [
        ({}, 0, 1000),
        ({'offset': None, 'limit': None}, 0, 1000),
        ({'offset': 2, 'limit': 3}, 2, 3),
        ({'offset': '2', 'limit': '3'}, 2, 3),
        ({'offset': 0, 'limit': 1}, 0, 1),
        ({'limit': 1000}, 0, 1000),
        ({'limit': 1001}, 0, 1000),
        ({'limit': '1000000000'}, 0, 1000),
    ],
)
def test_objdir_validates_and_caps_pagination(pagination, offset, limit):
    store = _store()
    tools = _Tools(store, allow_write=False, expose_tools=True)

    assert tools.objdir({'parent': '/docs', **pagination}) == {'success': True, 'paths': {'/docs': 'obj-1'}}

    store.getPaths.assert_called_once_with(parent='/docs', offset=offset, limit=limit)


def test_hiding_holds_on_the_real_instance_base():
    """The engine lists and dispatches tools through IInstanceBase._collect_tool_methods.

    Under the built engine this runs on the real rocketlib; a stand-in without
    the collector (a plain venv) skips it.
    """
    from rocketlib import IInstanceBase

    from ai.common.store.store_instance_base import StoreInstanceBase

    # The engine's tool_function stamps __tool_meta__, which its collector reads;
    # a stand-in decorator does neither.
    if not hasattr(IInstanceBase, '_collect_tool_methods') or not hasattr(StoreInstanceBase.search, '__tool_meta__'):
        pytest.skip('needs the engine rocketlib')

    inst = StoreInstanceBase.__new__(StoreInstanceBase)  # no engine wiring, as in test_store_base
    inst.IGlobal = SimpleNamespace(
        serverName='rrvector',
        store=_store(),
        embed_query=None,
        embed_model_name=None,
        expose_tools=False,
        allow_write=False,
    )

    assert set(inst._collect_tool_methods()) == set()
    inst.IGlobal.expose_tools = True
    assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats'}
    inst.IGlobal.allow_write = True
    assert set(inst._collect_tool_methods()) == {
        'search',
        'objdir',
        'get',
        'stats',
        'upsert',
        'delete',
        'soft_delete',
        'restore',
    }


# ---------------------------------------------------------------------------
# expose_tools: the whole tool surface is opt-in on a managed store (#2631 review)
# ---------------------------------------------------------------------------


_EVERY_TOOL = [
    ('search', {'query': 'hello'}),
    ('upsert', {'documents': _DOCS}),
    ('delete', {'object_ids': ['obj-1']}),
    ('soft_delete', {'object_ids': ['obj-1']}),
    ('restore', {'object_ids': ['obj-1']}),
    ('list_documents', {}),
    ('objdir', {}),
    ('get', {'object_id': 'obj-1'}),
    ('stats', {}),
]


def test_tools_stay_exposed_when_the_node_sets_nothing():
    """A store node that never defines expose_tools keeps every tool, as before."""
    tools = _Tools(_store())
    assert set(tools._collect_tool_methods()) == {
        'search',
        'upsert',
        'delete',
        'soft_delete',
        'restore',
        'objdir',
        'get',
        'stats',
    }


def test_no_tool_is_advertised_while_tools_are_off():
    """With expose_tools off nothing is listed, whatever allow_write says."""
    tools = _Tools(_store(), allow_write=True, expose_tools=False)
    assert tools._collect_tool_methods() == {}


@pytest.mark.parametrize('tool, args', _EVERY_TOOL)
def test_every_tool_refuses_when_the_node_does_not_expose_tools(tool, args):
    """A direct call while tools are off returns the failure object and never reaches the store."""
    store = _store()
    tools = _Tools(store, allow_write=True, expose_tools=False)

    result = getattr(tools, tool)(args)

    assert result['success'] is False
    assert 'expose_tools=true' in result['error']
    assert f'rrvector.{tool}' in result['error']
    for method in (
        'addChunks',
        'remove',
        'markDeleted',
        'markActive',
        'listDocuments',
        'getPaths',
        'get',
        'count_documents',
        'searchSemantic',
        'searchKeyword',
    ):
        getattr(store, method).assert_not_called()


def test_the_tools_switch_is_checked_before_the_write_switch():
    """With both switches off a write names the tools switch, the one the owner has to flip first."""
    tools = _Tools(_store(), allow_write=False, expose_tools=False)

    result = tools.upsert({'documents': _DOCS})

    assert 'expose_tools=true' in result['error']
    assert 'allow_write' not in result['error']


@pytest.mark.parametrize('value, exposed', [('false', False), ('0', False), ('true', True), ('yes', True)])
def test_a_string_tools_switch_is_parsed_like_a_config_value(value, exposed):
    tools = _Tools(_store(), expose_tools=value)
    assert bool(tools._collect_tool_methods()) is exposed
