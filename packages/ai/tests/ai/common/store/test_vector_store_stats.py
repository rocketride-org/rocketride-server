"""stats on VectorStoreToolMixin: document_count and the control-row refresh (#2587).

count is the row (chunk) count as the store counts it, which on the Postgres
drivers includes the control row and soft-deleted chunks. document_count is the
number of active documents on a driver that lists documents, null elsewhere.
The model name and vector size come from the control row, which a task that
only reads through tools may not have loaded yet.
"""

from ._vectordb_tool_harness import Tools, make_store


def test_document_count_is_null_on_a_store_without_the_listing():
    store = make_store()

    result = Tools(store).stats({})

    assert result == {'success': True, 'count': 3, 'document_count': None, 'model': 'test-model', 'vector_size': 2}
    store.countDocuments.assert_not_called()


def test_document_count_comes_from_the_driver_when_it_lists():
    store = make_store(lists_documents=True)
    store.countDocuments.return_value = 7

    result = Tools(store).stats({})

    assert (result['count'], result['document_count']) == (3, 7)
    store.countDocuments.assert_called_once_with()  # active documents, every parent


def test_the_control_row_is_read_when_the_model_is_not_loaded_yet():
    store = make_store()
    store.modelName = ''
    store.vectorSize = 0

    def load():
        store.modelName = 'loaded-model'
        store.vectorSize = 384
        return True

    store.doesCollectionExist.side_effect = load

    result = Tools(store).stats({})

    assert (result['model'], result['vector_size']) == ('loaded-model', 384)
    store.doesCollectionExist.assert_called_once_with()


def test_a_collection_the_base_refuses_still_gets_its_counts(monkeypatch):
    """The base raises on a collection without exactly one control row; stats answers anyway."""
    from ai.common.store import document_store

    logged = []
    monkeypatch.setattr(document_store, 'warning', logged.append)
    store = make_store()
    store.modelName = ''
    store.vectorSize = 0
    store.doesCollectionExist.side_effect = Exception('Error checking collection: found 0')

    result = Tools(store).stats({})

    assert result == {'success': True, 'count': 3, 'document_count': None, 'model': '', 'vector_size': 0}
    assert len(logged) == 1 and 'rrvector.stats' in logged[0] and 'found 0' in logged[0]


def test_no_collection_check_when_the_model_is_known():
    store = make_store()

    Tools(store).stats({})

    store.doesCollectionExist.assert_not_called()


def test_an_empty_store_reports_empty_values_without_failing():
    store = make_store()
    store.modelName = ''
    store.vectorSize = 0
    store.count_documents.return_value = 0
    store.doesCollectionExist.return_value = False

    assert Tools(store).stats({}) == {
        'success': True,
        'count': 0,
        'document_count': None,
        'model': '',
        'vector_size': 0,
    }


def test_refused_while_tools_are_off():
    store = make_store()

    result = Tools(store, expose_tools=False).stats({})

    assert result['success'] is False and 'expose_tools=true' in result['error']
    store.count_documents.assert_not_called()
