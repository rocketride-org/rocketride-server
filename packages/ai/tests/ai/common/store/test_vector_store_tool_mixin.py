"""
Unit tests for the write switch on ai.common.store.document_store.VectorStoreToolMixin.

Coverage for issue #2587: every tool honours ``IGlobal.expose_tools``, the upsert and delete tools also ``IGlobal.allow_write``.
A node that never sets it keeps writing (every existing store node); a node that
sets it off (rocketride_vector, whose table lives in the team's managed database)
gets a readable refusal instead of a write, and the read tools are not affected
either way.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.common.store.document_store import VectorStoreToolMixin


class _Discoverable:
    """Stand-in for the engine base whose _collect_tool_methods lists every tool."""

    def _collect_tool_methods(self):
        return {name: getattr(self, name) for name in ('search', 'upsert', 'delete', 'objdir', 'get', 'stats')}


class _Tools(VectorStoreToolMixin, _Discoverable):
    """The mixin on a bare object, the way an IInstance carries it."""

    def __init__(self, store, allow_write=None, expose_tools=None):
        glb = SimpleNamespace(serverName='rrvector', store=store, embed_query=None, embed_model_name=None)
        if allow_write is not None:
            glb.allow_write = allow_write
        if expose_tools is not None:
            glb.expose_tools = expose_tools
        self.IGlobal = glb


_DOCS = [{'content': 'hello', 'object_id': 'obj-1', 'embedding': [0.1, 0.2], 'embedding_model': 'test-model'}]


def _store():
    store = MagicMock()
    store.getPaths.return_value = {'/docs': ['obj-1']}
    store.get.return_value = []
    store.count_documents.return_value = 3
    store.modelName = 'test-model'
    store.vectorSize = 2
    return store


def test_writes_stay_allowed_when_the_node_sets_nothing():
    store = _store()
    tools = _Tools(store)

    assert tools.upsert({'documents': _DOCS})['success'] is True
    store.addChunks.assert_called_once()
    assert tools.delete({'object_ids': ['obj-1']}) == {'success': True, 'deleted_count': 1}
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


@pytest.mark.parametrize('allow_write, advertised', [(None, 6), (True, 6), (False, 4)])
def test_write_tools_are_left_out_of_discovery_while_writes_are_off(allow_write, advertised):
    tools = _Tools(_store(), allow_write=allow_write)

    names = set(tools._collect_tool_methods())

    assert len(names) == advertised
    assert {'search', 'objdir', 'get', 'stats'} <= names
    assert ({'upsert', 'delete'} <= names) is (allow_write is not False)


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

    assert tools.objdir({}) == {'success': True, 'paths': {'/docs': ['obj-1']}}
    assert tools.get({'object_id': 'obj-1'})['success'] is True
    assert tools.stats({}) == {'success': True, 'count': 3, 'model': 'test-model', 'vector_size': 2}


@pytest.mark.parametrize('field', ['offset', 'limit'])
@pytest.mark.parametrize('value', ['invalid', None, {}, []])
def test_get_rejects_malformed_pagination_without_reading_store(field, value):
    """Bad pagination returns a tool failure without querying the collection."""
    store = _store()
    tools = _Tools(store, allow_write=False, expose_tools=True)

    result = tools.get({'object_id': 'obj-1', field: value})

    assert result == {'success': False, 'error': 'offset and limit must be valid integers'}
    store.get.assert_not_called()


@pytest.mark.parametrize(
    'pagination, offset, limit',
    [({}, 0, 100), ({'offset': 2, 'limit': 3}, 2, 3), ({'offset': '2', 'limit': '3'}, 2, 3)],
)
def test_get_preserves_valid_pagination(pagination, offset, limit):
    """Defaults, integers and integer strings still reach the driver's filter."""
    store = _store()
    tools = _Tools(store, allow_write=False, expose_tools=True)

    assert tools.get({'object_id': 'obj-1', **pagination}) == {'success': True, 'chunks': [], 'total': 0}

    store.get.assert_called_once()
    doc_filter = store.get.call_args.args[0]
    assert doc_filter.objectIds == ['obj-1']
    assert doc_filter.offset == offset
    assert doc_filter.limit == limit
    assert doc_filter.isDeleted is False


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
    assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats', 'upsert', 'delete'}


# ---------------------------------------------------------------------------
# expose_tools: the whole tool surface is opt-in on a managed store (#2631 review)
# ---------------------------------------------------------------------------


_EVERY_TOOL = [
    ('search', {'query': 'hello'}),
    ('upsert', {'documents': _DOCS}),
    ('delete', {'object_ids': ['obj-1']}),
    ('objdir', {}),
    ('get', {'object_id': 'obj-1'}),
    ('stats', {}),
]


def test_tools_stay_exposed_when_the_node_sets_nothing():
    """A store node that never defines expose_tools keeps every tool, as before."""
    tools = _Tools(_store())
    assert set(tools._collect_tool_methods()) == {'search', 'upsert', 'delete', 'objdir', 'get', 'stats'}


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
    for method in ('addChunks', 'remove', 'getPaths', 'get', 'count_documents', 'searchSemantic', 'searchKeyword'):
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
