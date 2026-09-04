"""
Unit tests for ai.common.store.document_store.DocumentStoreBase.createCollection.

Regression coverage for issue #1495: createCollection() must not silently proceed
to index documents when the driver's _createCollection() reports failure via a
bare `return False` (as opposed to raising).
"""

from unittest.mock import MagicMock

import pytest

from ai.common.schema import Doc, DocMetadata
from ai.common.store import DocumentStoreBase


class _FakeStore(DocumentStoreBase):
    """Minimal concrete DocumentStoreBase for exercising createCollection() in isolation."""

    def __init__(self, create_result):
        super().__init__('fake', {}, {})
        self._create_result = create_result
        # Shadow the concrete addChunks below with a mock so tests can assert on
        # the calls. The class-level definition is what satisfies the ABC.
        self.addChunks = MagicMock()

    def _doesCollectionExist(self):
        return False

    def _createCollection(self, vectorSize):
        if isinstance(self._create_result, Exception):
            raise self._create_result
        return self._create_result

    def addChunks(self, chunks, checkCollection=True):
        # Concrete implementation so the ABC is instantiable; each instance
        # replaces this with a MagicMock in __init__.
        return None

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

    def remove(self, objectIds):
        return None

    def markDeleted(self, objectIds):
        return None

    def markActive(self, objectIds):
        return None

    def render(self, objectId, callback):
        return None


def _make_docs():
    metadata = DocMetadata(objectId='obj', chunkId=0)
    doc = Doc(page_content='hello', metadata=metadata, embedding=[0.1, 0.2, 0.3], score=0.0)
    doc.embedding_model = 'test-model'
    return [doc]


def test_create_collection_raises_when_driver_returns_false():
    store = _FakeStore(create_result=False)

    with pytest.raises(Exception):
        store.createCollection(_make_docs())

    store.addChunks.assert_not_called()


def test_create_collection_succeeds_when_driver_returns_true():
    store = _FakeStore(create_result=True)

    assert store.createCollection(_make_docs()) is True
    store.addChunks.assert_called_once()


def test_create_collection_propagates_driver_exception():
    store = _FakeStore(create_result=RuntimeError('boom'))

    with pytest.raises(RuntimeError, match='boom'):
        store.createCollection(_make_docs())

    store.addChunks.assert_not_called()
