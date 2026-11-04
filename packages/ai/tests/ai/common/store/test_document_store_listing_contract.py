"""The document listing on DocumentStoreBase, and the mutation counts (#2587, #2704).

#2704 made a driver opt into list_documents by implementing listDocuments and
countDocuments and setting supports_document_listing. Here the base lists
documents for every driver: its default ``listDocumentPage`` reads the first chunk of
each document through ``get``, so a driver that implements nothing is listed, and
one that has a native listing overrides it. markDeleted and markActive may
return the chunks they moved, and may still return nothing (the answer says null).
"""

from ai.common.schema import Doc, DocMetadata
from ai.common.store.document_store import DocumentStoreBase

from ._vectordb_tool_harness import FakeDriver, Tools


def _chunk(object_id, parent, chunk_id=0):
    return Doc(
        page_content=f'{object_id}#{chunk_id}',
        metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, parent=parent, isDeleted=False),
    )


class _StoredDriver(FakeDriver):
    """A driver that stores two documents and reports no count from markDeleted / markActive."""

    ROWS = {'a': '/a', 'b': '/b'}

    def get(self, docFilter, checkCollection=True):
        wanted = docFilter.objectIds or list(self.ROWS)
        return [_chunk(oid, self.ROWS[oid]) for oid in wanted if oid in self.ROWS]


def test_the_base_has_no_listing_flag_and_no_listing_methods_to_implement():
    """#2704's opt-in (supports_document_listing, listDocuments, countDocuments) is gone: nothing calls it."""
    for name in ('supports_document_listing', 'listDocuments', 'countDocuments'):
        assert not hasattr(DocumentStoreBase, name)


def test_a_driver_that_implements_nothing_is_listed_through_get():
    tools = Tools(_StoredDriver())

    assert 'list_documents' in tools._collect_tool_methods()
    result = tools.list_documents({})
    assert result['success'] is True
    assert result['documents'] == [
        {'object_id': 'a', 'parent': '/a', 'chunk_count': None},
        {'object_id': 'b', 'parent': '/b', 'chunk_count': None},
    ]
    assert (result['offset'], result['has_more']) == (0, False)


def test_a_driver_that_reports_no_count_still_serves_the_trash_tools():
    driver = _StoredDriver()
    tools = Tools(driver)

    soft = tools.soft_delete({'object_ids': ['a']})
    restored = tools.restore({'object_ids': ['a']})

    for answer in (soft, restored):
        assert answer['success'] is True and answer['object_ids'] == ['a']
        assert answer['matched_chunks'] is None and answer['moved_chunks'] is None
    assert driver.marked == [('deleted', ['a']), ('active', ['a'])]
