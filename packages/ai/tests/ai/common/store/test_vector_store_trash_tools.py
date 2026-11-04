"""soft_delete and restore on VectorStoreToolMixin (#2587).

Both ride on the driver contract every store already implements (markDeleted and
markActive), sit behind the same two switches as upsert and delete, clean their
object IDs the same way, and report the matched chunk rows only when the driver
reports them.
"""

import pytest

from ai.common.store.errors import StoreUnsupported

from ._vectordb_tool_harness import Tools, core, make_store

TRASH_TOOLS = [('soft_delete', 'markDeleted'), ('restore', 'markActive')]


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_the_tool_calls_the_driver_once_with_clean_distinct_ids(tool, method):
    store = make_store()
    getattr(store, method).return_value = 5

    result = getattr(Tools(store), tool)({'object_ids': [' a ', 'a', 'b', '', '  ']})

    # The explorer's answer adds not_found and the audit block; matched_chunks (a store that cannot count answers
    # what its driver reported) and moved_chunks (always the driver's report) are 5 here.
    assert core(result) == {'success': True, 'object_ids': ['a', 'b'], 'matched_chunks': 5}
    assert result['moved_chunks'] == 5
    getattr(store, method).assert_called_once_with(['a', 'b'])


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
@pytest.mark.parametrize(
    'reported, expected',
    [(None, None), (0, 0), (2, 2), (-1, None), (True, None), ('3', None)],
    ids=['none', 'zero', 'two', 'unknown', 'bool', 'string'],
)
def test_matched_chunks_is_only_what_the_driver_reports(tool, method, reported, expected):
    """A driver that returns nothing (every store before this change) yields null, never a made-up count."""
    store = make_store()
    store.countChunks.side_effect = StoreUnsupported('no filtered count')  # this store cannot count
    getattr(store, method).return_value = reported

    answer = getattr(Tools(store), tool)({'object_ids': ['a']})
    assert answer['matched_chunks'] == expected and answer['moved_chunks'] == expected


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_a_store_that_counts_answers_the_rows_it_holds_and_the_rows_it_moved(tool, method):
    """matched_chunks is every chunk row stored for the ids, in either state; moved_chunks is what changed."""
    store = make_store()
    store.countChunks.return_value = 5  # five rows for the ids ...
    getattr(store, method).return_value = 2  # ... of which two changed state

    answer = getattr(Tools(store), tool)({'object_ids': ['a']})

    assert (answer['matched_chunks'], answer['moved_chunks']) == (5, 2)


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_hidden_from_discovery_and_refused_while_writes_are_off(tool, method):
    store = make_store()
    tools = Tools(store, allow_write=False)

    assert tool not in tools._collect_tool_methods()
    result = getattr(tools, tool)({'object_ids': ['a']})
    assert result['success'] is False
    assert f'rrvector.{tool}' in result['error'] and 'allow_write=true' in result['error']
    getattr(store, method).assert_not_called()

    tools.IGlobal.allow_write = True
    assert tool in tools._collect_tool_methods()
    assert getattr(tools, tool)({'object_ids': ['a']})['success'] is True


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_refused_while_tools_are_off_even_with_writes_allowed(tool, method):
    store = make_store()
    tools = Tools(store, allow_write=True, expose_tools=False)

    assert tools._collect_tool_methods() == {}
    result = getattr(tools, tool)({'object_ids': ['a']})
    assert result['success'] is False and 'expose_tools=true' in result['error']
    getattr(store, method).assert_not_called()


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_the_refusal_comes_before_input_validation(tool, method):
    tools = Tools(make_store(), allow_write=False)

    assert 'disabled' in getattr(tools, tool)({})['error']


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
@pytest.mark.parametrize(
    'object_ids, message',
    [
        (None, 'requires a non-empty "object_ids" array'),
        ([], 'requires a non-empty "object_ids" array'),
        ('a', 'requires a non-empty "object_ids" array'),
        ({'id': 'a'}, 'requires a non-empty "object_ids" array'),
        (['', '  '], 'no valid object IDs provided'),
        (['a', 'schema'], "object_id 'schema' is reserved"),
    ],
    ids=['missing', 'empty', 'string', 'object', 'blank-ids', 'control-row'],
)
def test_bad_ids_fail_without_reaching_the_driver(tool, method, object_ids, message):
    store = make_store()
    args = {} if object_ids is None else {'object_ids': object_ids}

    result = getattr(Tools(store), tool)(args)

    assert result['success'] is False
    if message.startswith("object_id 'schema'"):
        # The control record is refused with the contract's code and its own sentence.
        assert result['code'] == 'RESERVED_ID' and "'schema' is the collection's control record" in result['error']
    else:
        assert result['code'] == 'INVALID_INPUT'
        assert result['error'].startswith(f'{tool}') and message in result['error']
    getattr(store, method).assert_not_called()


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_non_string_ids_are_stringified_like_delete(tool, method):
    store = make_store()

    assert getattr(Tools(store), tool)({'object_ids': [12, 'a']})['object_ids'] == ['12', 'a']
    getattr(store, method).assert_called_once_with(['12', 'a'])


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_a_json_string_payload_is_normalized(tool, method):
    store = make_store()

    assert getattr(Tools(store), tool)('{"object_ids": ["a"]}')['success'] is True
    getattr(store, method).assert_called_once_with(['a'])


@pytest.mark.parametrize('tool, method', TRASH_TOOLS)
def test_an_unbound_store_is_a_failure_like_the_other_tools(tool, method):
    """The tool boundary answers a store that is not open with STORE_ERROR instead of raising."""
    result = getattr(Tools(None), tool)({'object_ids': ['a']})

    assert result['success'] is False and result['code'] == 'STORE_ERROR'
    assert Tools(None).delete({'object_ids': ['a']})['code'] == 'STORE_ERROR'
