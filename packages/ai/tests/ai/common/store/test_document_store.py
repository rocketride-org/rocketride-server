"""
Unit tests for ai.common.store.document_store.DocumentStoreBase.createCollection.

Regression coverage for issue #1495: createCollection() must not silently proceed
to index documents when the driver's _createCollection() reports failure via a
bare `return False` (as opposed to raising).

Also checks concise setup and model-name errors for pipeline lanes and agent tools (#2476).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.common.schema import Doc, DocMetadata, Question, QuestionType
from ai.common.store import DocumentStoreBase
from ai.common.store.document_store import VectorStoreToolMixin


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

    # The whole point of #1495 is that the failure is *named*: the old behaviour
    # surfaced as a cryptic AttributeError from deep inside addChunks (e.g.
    # Chroma's "'NoneType' object has no attribute 'delete'"), far from the
    # driver that actually failed. Assert the message identifies the store, not
    # merely that something was raised.
    with pytest.raises(Exception, match='_FakeStore failed to create the vector collection'):
        store.createCollection(_make_docs())

    store.addChunks.assert_not_called()


def test_create_collection_succeeds_when_driver_returns_true():
    store = _FakeStore(create_result=True)

    assert store.createCollection(_make_docs()) is True
    store.addChunks.assert_called_once()


def test_create_collection_treats_none_as_success():
    # The check is deliberately `is False`, not falsy: store_weaviate,
    # store_postgres and rocketride_vector return nothing on success, and
    # treating their None as failure would break every one of them.
    store = _FakeStore(create_result=None)

    assert store.createCollection(_make_docs()) is True
    store.addChunks.assert_called_once()


def test_create_collection_propagates_driver_exception():
    store = _FakeStore(create_result=RuntimeError('boom'))

    with pytest.raises(RuntimeError, match='boom'):
        store.createCollection(_make_docs())

    store.addChunks.assert_not_called()


class _SwallowingStore(_FakeStore):
    """
    A driver shaped like store_astra: it catches every exception from the
    provider client, warns, and reports failure by returning False.

    nodes/src/nodes/store_astra/astra_db.py does exactly this, so the real
    provider error never reaches the base at all -- `is False` is the only
    signal left that anything went wrong.
    """

    def __init__(self):
        super().__init__(create_result=None)

    def _createCollection(self, vectorSize):
        try:
            raise RuntimeError('provider rejected the collection definition')
        except Exception:
            # Swallowed and downgraded to a bool, exactly as the driver does.
            return False


def test_create_collection_catches_a_driver_that_swallows_its_own_error():
    store = _SwallowingStore()

    with pytest.raises(Exception, match='_SwallowingStore failed to create the vector collection'):
        store.createCollection(_make_docs())

    store.addChunks.assert_not_called()


# ---------------------------------------------------------------------------
# Refusals say what is wrong and what to do (#2476)
# ---------------------------------------------------------------------------


class _ExistingCollectionStore(_FakeStore):
    """A store whose collection already exists, holding ``control_docs`` setup records."""

    def __init__(self, control_docs):
        super().__init__(create_result=True)
        self._control_docs = control_docs

    def _doesCollectionExist(self):
        return True

    def get(self, docFilter, checkCollection=True):
        return self._control_docs


def _control_doc():
    """The setup record createCollection writes: model name and vector size."""
    return Doc(
        page_content='',
        metadata=DocMetadata(objectId='schema', chunkId=0, vectorSize=3, modelName='test-model', isDeleted=True),
    )


@pytest.mark.parametrize('found', [[], [_control_doc(), _control_doc()]], ids=['missing', 'duplicated'])
def test_a_collection_without_one_setup_record_says_how_to_recover(found):
    store = _ExistingCollectionStore(control_docs=found)
    with pytest.raises(Exception) as excinfo:
        store.doesCollectionExist()
    assert str(excinfo.value) == (
        f'Error checking collection: Collection setup record is missing or invalid (found {len(found)}, expected 1). '
        'Choose a new collection or table name.'
    )


def test_a_document_with_a_vector_but_no_model_name_is_refused_when_the_collection_exists():
    store = _ExistingCollectionStore(control_docs=[_control_doc()])
    docs = _make_docs()
    docs[0].embedding_model = None
    with pytest.raises(Exception) as excinfo:
        store.createCollection(docs)
    assert str(excinfo.value) == (
        'Documents are missing an embedding model name. Check the embedding configuration '
        'or supply vectors with their model name.'
    )
    store.addChunks.assert_not_called()


def test_a_question_without_a_model_name_identifies_the_missing_metadata():
    store = _FakeStore(create_result=True)
    store.searchSemantic = MagicMock()
    question = Question(type=QuestionType.SEMANTIC)
    question.addQuestion('what is in the documents?')
    with pytest.raises(Exception) as excinfo:
        store.dispatchSearch(MagicMock(), question)
    assert str(excinfo.value) == (
        'Question has no embedding model name. Embed questions with the same model as the stored documents.'
    )
    store.searchSemantic.assert_not_called()


def test_tool_upsert_missing_model_name_does_not_prescribe_lane_wiring():
    # Tool calls compute their own embeddings; an embedder that omits its model
    # name reaches the same base error as a pipeline write. Preserve the tool's
    # failure response and give guidance that applies to both entry points.
    store = _ExistingCollectionStore(control_docs=[_control_doc()])
    store.addChunks.side_effect = store.createCollection
    tools = VectorStoreToolMixin()
    tools.IGlobal = SimpleNamespace(
        store=store, serverName='test', embed_query=lambda text: [0.1, 0.2, 0.3], embed_model_name=None
    )
    result = tools.upsert({'documents': [{'content': 'hello', 'object_id': 'obj'}]})
    assert result['success'] is False
    assert result['error'] == (
        'Documents are missing an embedding model name. Check the embedding configuration '
        'or supply vectors with their model name.'
    )
