"""list_documents on VectorStoreToolMixin (#2587, #2704), as the Vector Explorer's tool answers it.

objdir keys its result by parent path, so documents that share a path collapse
into one entry. list_documents returns one row per document with its chunk
count. The tool is offered by every driver and pages by ``cursor`` over the
driver's ``listDocumentPage``; #2704's answer keys (``documents``, ``total``,
``offset``, ``has_more``) are kept beside the explorer's (``items``,
``next_cursor``) so its callers read the same answer, and an ``offset`` other
than 0 is refused, naming ``cursor``.
"""

from types import SimpleNamespace

import pytest

from ai.common.store.vx_types import DocPage, DocumentRow

from ._vectordb_tool_harness import EVERY_TOOL_NAME, Tools, make_store


def _row(i):
    return DocumentRow(
        objectId=f'obj-{i:03d}',
        path=f'/p{i}',
        chunks=i + 1,
        has_first_chunk=True,
        deleted=False,
        tables=0,
        nodeId=None,
        size=None,
        modifyTime=None,
        ingestedAt=None,
        pointId=None,
    )


def _rows(n, start=0):
    """#2704's row shape for ``n`` documents."""
    return [{'object_id': f'obj-{i:03d}', 'parent': f'/p{i}', 'chunk_count': i + 1} for i in range(start, start + n)]


def _page(n, *, next_cursor=None, total=None):
    return DocPage(
        items=[_row(i) for i in range(n)],
        next_cursor=next_cursor,
        total=total,
        counts_exact=total is not None,
        distinct=True,
        sorted=True,
        caveats=[],
    )


def _store(page=None):
    store = make_store()
    store.listDocumentPage.return_value = page if page is not None else _page(0, total=0)
    return store


def test_it_is_offered_by_every_driver_whatever_the_write_switch_says():
    """No capability flag: the base lists documents through get when a driver has no listing of its own."""
    for allow_write in (None, True, False):
        assert 'list_documents' in Tools(make_store(), allow_write=allow_write)._collect_tool_methods()


def test_discovery_survives_an_unbound_store():
    tools = Tools(None)

    assert 'list_documents' in tools._collect_tool_methods()
    assert 'search' in tools._collect_tool_methods()


def test_a_page_with_more_to_follow_answers_both_key_sets():
    store = _store(_page(2, next_cursor='next-page', total=10))

    result = Tools(store).list_documents({'limit': 2})

    assert result['success'] is True
    # #2704's keys
    assert result['documents'] == _rows(2)
    assert (result['total'], result['offset'], result['has_more']) == (10, 0, True)
    # the explorer's
    assert [item['objectId'] for item in result['items']] == ['obj-000', 'obj-001']
    assert result['next_cursor'] == 'next-page'
    assert store.listDocumentPage.call_args.kwargs['limit'] == 2


@pytest.mark.parametrize('returned', [2, 1, 0])
def test_a_last_page_has_no_more(returned):
    store = _store(_page(returned, total=returned))

    result = Tools(store).list_documents({'limit': 2})

    assert result['documents'] == _rows(returned)
    assert result['has_more'] is False and result['next_cursor'] is None


def test_parent_and_deleted_reach_the_driver_and_the_answer_keeps_one_exact_path():
    store = _store(_page(0, total=0))

    Tools(store).list_documents({'parent': '/reports', 'deleted': True})

    kwargs = store.listDocumentPage.call_args.kwargs
    assert kwargs['deleted'] == 'deleted'


def test_the_deleted_flag_takes_the_explorers_names_too():
    store = _store()
    tools = Tools(store)

    tools.list_documents({'deleted': 'deleted'})
    assert store.listDocumentPage.call_args.kwargs['deleted'] == 'deleted'
    tools.list_documents({'deleted': False})
    assert store.listDocumentPage.call_args.kwargs['deleted'] == 'active'


def test_a_null_deleted_means_active():
    store = _store()

    Tools(store).list_documents({'deleted': None})

    assert store.listDocumentPage.call_args.kwargs['deleted'] == 'active'


@pytest.mark.parametrize('offset', [None, 0])
def test_an_offset_of_zero_is_accepted(offset):
    store = _store()

    result = Tools(store).list_documents({'offset': offset})

    assert result['success'] is True and result['offset'] == 0


@pytest.mark.parametrize('offset', [4, 1, '7', -1, True])
def test_an_offset_past_zero_is_refused_naming_the_cursor(offset):
    """The listing pages with cursor; an offset would make a page boundary depend on writes."""
    store = _store()

    result = Tools(store).list_documents({'offset': offset})

    assert result['success'] is False and result['code'] == 'INVALID_INPUT'
    assert 'cursor' in result['error']
    store.listDocumentPage.assert_not_called()


@pytest.mark.parametrize(
    'args, message',
    [
        ({'parent': 5}, 'parent must be a string'),
        ({'deleted': 'yes'}, 'deleted must be'),
        ({'deleted': 1}, 'deleted must be'),
        ({'limit': 0}, 'limit must be 1 or more'),
        ({'limit': -3}, 'limit must be 1 or more'),
        ({'limit': True}, 'limit must be an integer'),
        ({'limit': 2.5}, 'limit must be an integer'),
        ({'limit': 'many'}, 'limit must be an integer'),
    ],
    ids=[
        'parent-type',
        'deleted-string',
        'deleted-int',
        'limit-zero',
        'limit-negative',
        'limit-bool',
        'limit-float',
        'limit-text',
    ],
)
def test_bad_arguments_fail_without_reading_the_store(args, message):
    store = _store()

    result = Tools(store).list_documents(args)

    assert result['success'] is False and result['code'] == 'INVALID_INPUT'
    assert message in result['error']
    store.listDocumentPage.assert_not_called()


def test_defaults_and_cap():
    """#2704's page size: 100 by default, at most 1,000 (an app that needs another sends its own limit)."""
    store = _store()
    tools = Tools(store)

    assert tools.list_documents({})['offset'] == 0
    assert store.listDocumentPage.call_args.kwargs['limit'] == 100

    above = tools.list_documents({'limit': 5000})
    assert store.listDocumentPage.call_args.kwargs['limit'] == 1000 and 'limit_clamped' in above['warnings']
    tools.list_documents({'limit': '7'})
    assert store.listDocumentPage.call_args.kwargs['limit'] == 7


def test_payloads_are_normalized_like_the_other_tools():
    store = _store()
    tools = Tools(store)

    assert tools.list_documents('{"limit": 1}')['success'] is True
    assert tools.list_documents({'input': {'limit': 1}})['success'] is True
    assert store.listDocumentPage.call_args.kwargs['limit'] == 1


def test_refused_while_tools_are_off():
    store = _store()
    tools = Tools(store, expose_tools=False)

    result = tools.list_documents({})

    assert result['success'] is False and 'expose_tools=true' in result['error']
    store.listDocumentPage.assert_not_called()


def test_the_listing_is_offered_on_the_real_instance_base():
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

    assert {'search', 'objdir', 'get', 'stats', 'list_documents'} <= set(inst._collect_tool_methods())
    assert not {'upsert', 'delete', 'soft_delete', 'restore'} & set(inst._collect_tool_methods())
    inst.IGlobal.allow_write = True
    assert set(EVERY_TOOL_NAME) <= set(inst._collect_tool_methods())
