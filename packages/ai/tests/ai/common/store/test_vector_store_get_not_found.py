"""get on VectorStoreToolMixin: an unknown document is a failure, not an empty page (#2587).

Before this change get answered an object ID the store has never seen with
success and no chunks, the same reply as a page past the end of a real
document. A dashboard or an agent could not tell the two apart. A document in
the trash is told apart as well, since restore makes it readable again.
"""

from types import SimpleNamespace

import pytest

from ._vectordb_tool_harness import Tools, make_store


def _chunk(chunk_id=0, content='chunk'):
    return SimpleNamespace(page_content=content, metadata={'chunkId': chunk_id, 'objectId': 'obj-1'})


def test_an_unknown_object_id_is_a_failure():
    store = make_store()
    store.get.return_value = []

    result = Tools(store).get({'object_id': 'obj-9'})

    assert result == {'success': False, 'error': "get: no document with object_id 'obj-9'", 'object_id': 'obj-9'}
    # Two reads: the active chunks, then one row with the trash included.
    assert store.get.call_count == 2
    probe = store.get.call_args_list[1].args[0]
    assert (probe.objectIds, probe.isDeleted, probe.offset, probe.limit) == (['obj-9'], True, 0, 1)


def test_a_soft_deleted_document_is_told_apart_from_an_unknown_one():
    store = make_store()
    store.get.side_effect = [[], [_chunk()]]

    result = Tools(store).get({'object_id': 'obj-1'})

    assert result['success'] is False and result['object_id'] == 'obj-1'
    assert result['error'] == "get: document 'obj-1' is soft-deleted; restore it to read it"


def test_the_trash_message_points_to_restore_only_where_it_is_offered():
    """The restore tool is a write tool, hidden while writes are off; the message then says so instead."""
    store = make_store()
    store.get.side_effect = [[], [_chunk()]]

    result = Tools(store, allow_write=False).get({'object_id': 'obj-1'})

    assert result == {
        'success': False,
        'error': "get: document 'obj-1' is soft-deleted; this node does not offer restore while writes through tools are off",
        'object_id': 'obj-1',
    }
    assert 'restore' not in Tools(store, allow_write=False)._collect_tool_methods()


def test_a_page_past_the_end_of_an_existing_document_is_still_a_page():
    store = make_store()
    store.get.return_value = [_chunk(0), _chunk(1)]

    result = Tools(store).get({'object_id': 'obj-1', 'offset': 5})

    assert result['success'] is True
    assert (result['chunks'], result['total'], result['offset'], result['has_more']) == ([], 2, 5, False)
    assert store.get.call_count == 1  # no trash probe for a document that exists


def test_a_found_document_reads_as_before():
    store = make_store()
    store.get.return_value = [_chunk(1, 'second'), _chunk(0, 'first')]

    result = Tools(store).get({'object_id': 'obj-1'})

    assert result['success'] is True
    assert [chunk['content'] for chunk in result['chunks']] == ['first', 'second']
    assert (result['total'], result['has_more'], result['truncated']) == (2, False, False)


def test_the_control_row_cannot_be_read():
    store = make_store()

    result = Tools(store).get({'object_id': 'schema'})

    assert result['success'] is False and 'reserved' in result['error'] and result['object_id'] == 'schema'
    store.get.assert_not_called()


@pytest.mark.parametrize(
    'args', [{}, {'object_id': '  '}, {'object_id': 'obj-1', 'limit': 0}, {'object_id': 'obj-1', 'offset': -1}]
)
def test_input_validation_still_comes_first(args):
    store = make_store()

    result = Tools(store).get(args)

    assert result['success'] is False and 'object_id' not in result
    store.get.assert_not_called()


def test_the_write_switch_does_not_matter_and_the_tools_switch_does():
    store = make_store()
    store.get.return_value = [_chunk()]

    assert Tools(store, allow_write=False).get({'object_id': 'obj-1'})['success'] is True
    refused = Tools(store, expose_tools=False).get({'object_id': 'obj-1'})
    assert refused['success'] is False and 'expose_tools=true' in refused['error']
