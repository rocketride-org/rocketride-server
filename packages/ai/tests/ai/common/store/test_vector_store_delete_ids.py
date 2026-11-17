"""delete on VectorStoreToolMixin: ID clean-up shared with the trash tools (#2587).

delete now cleans its object IDs the way soft_delete and restore do: stripped,
de-duplicated in order, the store's control row refused, and the distinct IDs
echoed in the reply beside deleted_count.
"""

import pytest

from ._vectordb_tool_harness import Tools, make_store


def test_the_reply_echoes_the_distinct_ids_and_counts_them():
    store = make_store()

    result = Tools(store).delete({'object_ids': [' a ', 'a', 'b', '']})

    assert result == {'success': True, 'deleted_count': 2, 'object_ids': ['a', 'b']}
    store.remove.assert_called_once_with(['a', 'b'])


def test_the_control_row_cannot_be_deleted():
    store = make_store()

    result = Tools(store).delete({'object_ids': ['a', 'schema']})

    assert result['success'] is False
    assert result['error'] == "delete: object_id 'schema' is reserved for the store's control row"
    store.remove.assert_not_called()


@pytest.mark.parametrize(
    'object_ids, message',
    [
        (None, 'delete requires a non-empty "object_ids" array'),
        ([], 'delete requires a non-empty "object_ids" array'),
        ('a', 'delete requires a non-empty "object_ids" array'),
        (['', '  '], 'delete: no valid object IDs provided'),
    ],
    ids=['missing', 'empty', 'string', 'blank-ids'],
)
def test_the_messages_are_unchanged(object_ids, message):
    """The two messages callers may already match on read as before."""
    store = make_store()
    args = {} if object_ids is None else {'object_ids': object_ids}

    result = Tools(store).delete(args)

    assert result == {'success': False, 'error': message}
    store.remove.assert_not_called()


def test_the_switches_come_first():
    store = make_store()

    assert 'allow_write=true' in Tools(store, allow_write=False).delete({'object_ids': ['schema']})['error']
    assert 'expose_tools=true' in Tools(store, expose_tools=False).delete({'object_ids': ['schema']})['error']
    store.remove.assert_not_called()
