"""The optional document listing on DocumentStoreBase, and the mutation counts (#2587).

A driver opts into list_documents by implementing listDocuments and
countDocuments and setting supports_document_listing; the base itself does
neither, so every existing driver is unchanged. markDeleted and markActive may
now return the matched chunk rows, and may still return nothing.
"""

import pytest

from ai.common.store.document_store import DocumentStoreBase

from ._vectordb_tool_harness import Tools


class _Driver(DocumentStoreBase):
    """The smallest driver the abstract base accepts; reads answer empty, writes do nothing."""

    def __init__(self):
        super().__init__('fake', {}, {})
        # Known model and width, so stats has no control row to look up.
        self.modelName = 'test-model'
        self.vectorSize = 3
        self.marked = []

    def _doesCollectionExist(self):
        return True

    def _createCollection(self):
        return True

    def count_documents(self):
        return 0

    def searchKeyword(self, query, docFilter):
        return []

    def searchSemantic(self, query, docFilter):
        return []

    def get(self, docFilter, checkCollection=True):
        return []

    def getPaths(self, parent=None, offset=0, limit=1000):
        return {}

    def addChunks(self, chunks):
        return None

    def remove(self, objectIds):
        return None

    def markDeleted(self, objectIds):
        self.marked.append(('deleted', objectIds))

    def markActive(self, objectIds):
        self.marked.append(('active', objectIds))

    def render(self, objectId, callback):
        return None


class _ListingDriver(_Driver):
    supports_document_listing = True

    def listDocuments(self, parent=None, offset=0, limit=100, deleted=False):
        rows = [
            {'object_id': 'a', 'parent': '/a', 'chunk_count': 2},
            {'object_id': 'b', 'parent': '/b', 'chunk_count': 1},
        ]
        return rows[offset : offset + limit]

    def countDocuments(self, parent=None, deleted=False):
        return 2


def test_the_base_does_not_list_documents():
    driver = _Driver()

    assert DocumentStoreBase.supports_document_listing is False
    assert driver.supports_document_listing is False
    with pytest.raises(NotImplementedError, match='_Driver does not list documents'):
        driver.listDocuments()
    with pytest.raises(NotImplementedError, match='_Driver does not count documents'):
        driver.countDocuments()


def test_a_driver_opts_in_by_implementing_both_and_setting_the_flag():
    tools = Tools(_ListingDriver())

    assert 'list_documents' in tools._collect_tool_methods()
    assert tools.list_documents({'limit': 1}) == {
        'success': True,
        'documents': [{'object_id': 'a', 'parent': '/a', 'chunk_count': 2}],
        'total': 2,
        'offset': 0,
        'has_more': True,
    }
    assert tools.stats({})['document_count'] == 2


def test_a_driver_that_reports_no_count_still_serves_the_trash_tools():
    driver = _Driver()
    tools = Tools(driver)

    assert tools.soft_delete({'object_ids': ['a']}) == {'success': True, 'object_ids': ['a'], 'matched_chunks': None}
    assert tools.restore({'object_ids': ['a']}) == {'success': True, 'object_ids': ['a'], 'matched_chunks': None}
    assert driver.marked == [('deleted', ['a']), ('active', ['a'])]
