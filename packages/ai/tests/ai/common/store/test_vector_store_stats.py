"""stats on VectorStoreToolMixin: document_count and the control-row refresh (#2587, #2704).

count is the row (chunk) count as the store counts it, which on the Postgres
drivers includes the control row and soft-deleted chunks. document_count is
#2704's name for the figure the explorer's answer carries as ``documents``: the
number of active documents, null where the store cannot count them. The model
name and vector size come from the control row, which a task that only reads
through tools may not have loaded yet.
"""

from ._vectordb_tool_harness import FakeDriver, Tools


class _CountingDriver(FakeDriver):
    """A driver with native filtered counts: seven active documents in nine chunks."""

    def count_documents(self):
        return 10  # rows, the control row and a trashed chunk included

    def countDocumentsWhere(self, docFilter):
        return 7 if self.resolveDeleted(docFilter) == 'active' else 0

    def countChunks(self, docFilter):
        return 9 if self.resolveDeleted(docFilter) == 'active' else 0


def test_document_count_is_the_active_documents_figure_of_the_answer():
    result = Tools(_CountingDriver()).stats({})

    assert result['success'] is True
    assert (result['count'], result['document_count'], result['documents']) == (10, 7, 7)
    assert (result['model'], result['vector_size']) == ('test-model', 3)


def test_document_count_is_null_where_the_store_cannot_count_documents():
    result = Tools(FakeDriver()).stats({})

    assert result['success'] is True and result['count'] == 0
    assert result['document_count'] is None and result['documents'] is None


def test_the_control_row_is_read_when_the_model_is_not_loaded_yet():
    class Unloaded(FakeDriver):
        def __init__(self):
            super().__init__()
            self.modelName, self.vectorSize = '', 0

        def doesCollectionExist(self, modelName=None):
            self.modelName, self.vectorSize = 'loaded-model', 384
            return True

    result = Tools(Unloaded()).stats({})

    assert (result['model'], result['vector_size']) == ('loaded-model', 384)


def test_a_collection_the_base_refuses_still_gets_its_counts():
    """The base raises on a collection without exactly one control row; stats answers anyway."""

    class Refused(_CountingDriver):
        def __init__(self):
            super().__init__()
            self.modelName, self.vectorSize = '', 0

        def doesCollectionExist(self, modelName=None):
            raise Exception('Error checking collection: found 0')

    result = Tools(Refused()).stats({})

    assert result['success'] is True and result['count'] == 10 and result['document_count'] == 7
    assert (result['model'], result['vector_size']) == ('', 0)


def test_an_empty_store_reports_empty_values_without_failing():
    class Missing(FakeDriver):
        def _doesCollectionExist(self):
            return False

    result = Tools(Missing()).stats({})

    assert result['success'] is True and result['collection_exists'] is False
    assert (result['count'], result['document_count'], result['model'], result['vector_size']) == (0, None, '', 0)


def test_refused_while_tools_are_off():
    driver = FakeDriver()

    result = Tools(driver, expose_tools=False).stats({})

    assert result['success'] is False and 'expose_tools=true' in result['error']
