"""list_documents on VectorStoreToolMixin: an optional capability of the driver (#2587).

objdir keys its result by parent path, so documents that share a path collapse
into one entry. list_documents returns one row per document with its chunk
count, but only a driver that implements DocumentStoreBase.listDocuments and
countDocuments and sets supports_document_listing offers it; every other driver
keeps its tool surface as it was.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ._vectordb_tool_harness import EVERY_TOOL_NAME, Tools, make_store


def _rows(n, start=0):
    return [{'object_id': f'obj-{i:03d}', 'parent': f'/p{i}', 'chunk_count': i + 1} for i in range(start, start + n)]


def test_not_offered_and_not_available_on_a_driver_without_the_capability():
    store = make_store()
    tools = Tools(store)

    assert set(tools._collect_tool_methods()) == set(EVERY_TOOL_NAME) - {'list_documents'}
    result = tools.list_documents({})
    assert result == {
        'success': False,
        'error': 'rrvector.list_documents is not available: this store does not list documents',
    }
    store.listDocuments.assert_not_called()
    store.countDocuments.assert_not_called()


def test_a_mock_that_answers_every_attribute_does_not_opt_in():
    """Only the real True counts, so a stand-in driver cannot advertise a listing it lacks."""
    tools = Tools(MagicMock())

    assert 'list_documents' not in tools._collect_tool_methods()


def test_discovery_survives_an_unbound_store():
    tools = Tools(None)

    assert 'list_documents' not in tools._collect_tool_methods()
    assert 'search' in tools._collect_tool_methods()


@pytest.mark.parametrize('allow_write', [None, True, False])
def test_offered_when_the_driver_sets_the_flag_whatever_the_write_switch_says(allow_write):
    tools = Tools(make_store(lists_documents=True), allow_write=allow_write)

    assert 'list_documents' in tools._collect_tool_methods()


def test_a_page_with_more_to_follow():
    store = make_store(lists_documents=True)
    store.listDocuments.return_value = _rows(3)  # one more than the page asked for
    store.countDocuments.return_value = 10

    result = Tools(store).list_documents({'limit': 2, 'offset': 4})

    assert result == {'success': True, 'documents': _rows(2), 'total': 10, 'offset': 4, 'has_more': True}
    store.listDocuments.assert_called_once_with(parent=None, offset=4, limit=3, deleted=False)
    store.countDocuments.assert_called_once_with(parent=None, deleted=False)


@pytest.mark.parametrize('returned', [2, 1, 0])
def test_a_last_page_has_no_more(returned):
    store = make_store(lists_documents=True)
    store.listDocuments.return_value = _rows(returned)
    store.countDocuments.return_value = returned

    result = Tools(store).list_documents({'limit': 2})

    assert result['documents'] == _rows(returned)
    assert result['has_more'] is False


@pytest.mark.parametrize(
    'rows, total, has_more',
    [(3, 2, True), (2, 3, False)],
    ids=['count-says-fewer-than-the-page-read', 'count-says-more-than-the-page-read'],
)
def test_has_more_follows_the_page_when_the_count_disagrees(rows, total, has_more):
    """Under concurrent writes the count and the page can disagree; the extra row decides, not total."""
    store = make_store(lists_documents=True)
    store.listDocuments.return_value = _rows(rows)
    store.countDocuments.return_value = total

    result = Tools(store).list_documents({'limit': 2})

    assert result['has_more'] is has_more
    assert result['total'] == total
    assert result['documents'] == _rows(min(rows, 2))


def test_defaults_and_cap():
    store = make_store(lists_documents=True)
    tools = Tools(store)

    assert tools.list_documents({})['offset'] == 0
    store.listDocuments.assert_called_with(parent=None, offset=0, limit=101, deleted=False)

    tools.list_documents({'limit': 5000, 'offset': '7'})
    store.listDocuments.assert_called_with(parent=None, offset=7, limit=1001, deleted=False)


def test_parent_and_deleted_reach_both_driver_calls():
    store = make_store(lists_documents=True)

    Tools(store).list_documents({'parent': '/reports', 'deleted': True})

    store.listDocuments.assert_called_once_with(parent='/reports', offset=0, limit=101, deleted=True)
    store.countDocuments.assert_called_once_with(parent='/reports', deleted=True)


def test_a_null_deleted_means_active():
    store = make_store(lists_documents=True)

    Tools(store).list_documents({'deleted': None})

    store.listDocuments.assert_called_once_with(parent=None, offset=0, limit=101, deleted=False)


@pytest.mark.parametrize(
    'args, message',
    [
        ({'parent': 5}, 'parent must be a string'),
        ({'deleted': 'true'}, 'deleted must be a boolean'),
        ({'deleted': 1}, 'deleted must be a boolean'),
        ({'offset': -1}, 'offset'),
        ({'offset': True}, 'offset'),
        ({'limit': 0}, 'limit'),
        ({'limit': 2.5}, 'limit'),
        ({'limit': 'many'}, 'limit'),
    ],
    ids=[
        'parent-type',
        'deleted-string',
        'deleted-int',
        'offset-negative',
        'offset-bool',
        'limit-zero',
        'limit-float',
        'limit-text',
    ],
)
def test_bad_arguments_fail_without_reading_the_store(args, message):
    store = make_store(lists_documents=True)

    result = Tools(store).list_documents(args)

    assert result['success'] is False
    assert result['error'].startswith('list_documents') and message in result['error']
    store.listDocuments.assert_not_called()
    store.countDocuments.assert_not_called()


def test_payloads_are_normalized_like_the_other_tools():
    store = make_store(lists_documents=True)
    tools = Tools(store)

    assert tools.list_documents('{"limit": 1}')['success'] is True
    assert tools.list_documents({'input': {'limit': 1}})['success'] is True
    assert store.listDocuments.call_args.kwargs['limit'] == 2


def test_refused_while_tools_are_off_before_the_capability_is_checked():
    store = make_store()
    tools = Tools(store, expose_tools=False)

    result = tools.list_documents({})

    assert result['success'] is False and 'expose_tools=true' in result['error']


def test_hiding_holds_on_the_real_instance_base():
    """The engine lists and dispatches tools through IInstanceBase._collect_tool_methods.

    Under the built engine this runs on the real rocketlib; a stand-in without
    the collector (a plain venv) skips it.
    """
    from rocketlib import IInstanceBase

    from ai.common.store.store_instance_base import StoreInstanceBase

    if not hasattr(IInstanceBase, '_collect_tool_methods') or not hasattr(StoreInstanceBase.search, '__tool_meta__'):
        pytest.skip('needs the engine rocketlib')

    inst = StoreInstanceBase.__new__(StoreInstanceBase)  # no engine wiring, as in test_store_base
    inst.IGlobal = SimpleNamespace(
        serverName='rrvector',
        store=make_store(),
        embed_query=None,
        embed_model_name=None,
        expose_tools=True,
        allow_write=False,
    )

    assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats'}
    inst.IGlobal.store.supports_document_listing = True
    assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats', 'list_documents'}
    inst.IGlobal.allow_write = True
    assert set(inst._collect_tool_methods()) == set(EVERY_TOOL_NAME)
