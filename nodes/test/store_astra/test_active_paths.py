"""Exercise Astra's real SDK signatures and cursors with only HTTP mocked.

Run with the astrapy version in constraints.lock; no Astra account is needed.
Protocol mocks deliberately cannot substitute for the SDK in these regressions.
"""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from astrapy import DataAPIClient

from nodes.store_astra.astra_db import Store


@pytest.fixture
def astra(monkeypatch):
    collection = (
        DataAPIClient('test-token')
        .get_database('https://00000000-0000-0000-0000-000000000000-us-east1.apps.astra.datastax.com')
        .get_collection('docs')
    )
    request = Mock()
    monkeypatch.setattr(collection._api_commander, 'request', request)
    store = Store.__new__(Store)
    store.collection_name = 'docs'
    store._doesCollectionExist = lambda: True
    store.database = SimpleNamespace(get_collection=lambda name: collection)
    return store, request


def page(documents, next_page=None):
    return {'data': {'documents': documents, 'nextPageState': next_page}}


def header(parent, object_id):
    return {'meta': {'parent': parent, 'objectId': object_id}}


@pytest.mark.parametrize('parent', [None, '/documents', '/literal.*"path'])
def test_paths_follow_sdk_pages_and_group_before_offset(astra, parent):
    store, request = astra
    request.side_effect = [
        page([header('/z', 'last'), header('/b', 'z-doc'), header('/a', 'first')], 'page-two'),
        page([header('/b', 'a-doc'), header('/c', 'third')]),
    ]
    assert store.getPaths(parent=parent, offset=1, limit=2) == {'/b': 'a-doc', '/c': 'third'}
    expected_filter = {'meta.chunkId': 0, 'meta.isDeleted': False}
    if parent is not None:
        expected_filter['meta.parent'] = parent
    assert request.call_count == 2
    for index, call in enumerate(request.call_args_list):
        payload = call.kwargs['payload']['find']
        assert payload['filter'] == expected_filter
        assert payload['projection'] == {'meta.parent': True, 'meta.objectId': True, '_id': False}
        assert 'sort' not in payload
        assert payload['options'] == ({} if index == 0 else {'pageState': 'page-two'})


@pytest.mark.parametrize('reverse', [False, True])
def test_paths_are_stable_and_exclude_invalid_headers_and_control_row(astra, reverse):
    store, request = astra
    rows = [
        header('/b', 'z'),
        header('/b', 'a'),
        header('/a', 'doc'),
        header('/internal', 'schema'),
        header('', 'doc'),
        header(None, 'doc'),
        header('/bad', None),
        header('/bad', 7),
        {'meta': None},
        {'meta': 'bad'},
        {},
    ]
    request.return_value = page(list(reversed(rows)) if reverse else rows)
    assert list(store.getPaths().items()) == [('/a', 'doc'), ('/b', 'a')]
    assert store.getPaths(offset=2) == {}


def test_absent_collection_does_not_request_data(astra):
    store, request = astra
    store._doesCollectionExist = lambda: False
    assert store.getPaths() == {}
    assert store.count_documents() == 0
    request.assert_not_called()


def test_count_uses_sdk_required_bound_and_counts_all_rows(astra):
    store, request = astra
    request.return_value = {'status': {'count': 42}}
    assert store.count_documents() == 42
    assert request.call_count == 1
    assert request.call_args.kwargs['payload'] == {'countDocuments': {'filter': {}}}


@pytest.mark.parametrize('status', [{'count': 10001}, {'count': 1000, 'moreData': True}])
def test_count_limit_falls_back_to_all_cursor_pages(astra, status):
    store, request = astra
    request.side_effect = [
        {'status': status},
        page([{'_id': str(i)} for i in range(10000)], 'last'),
        page([{'_id': 'trashed'}, {'_id': 'schema'}]),
    ]
    assert store.count_documents() == 10002
    for call in request.call_args_list[1:]:
        payload = call.kwargs['payload']['find']
        assert payload['filter'] == {}
        assert payload['projection'] == {'_id': True}
        assert 'sort' not in payload
        assert 'limit' not in payload['options']
    assert request.call_args.kwargs['payload']['find']['options']['pageState'] == 'last'


@pytest.mark.parametrize('operation', ['getPaths', 'count_documents'])
def test_service_errors_are_not_reported_as_empty_results(astra, operation):
    store, request = astra
    request.side_effect = RuntimeError('service unavailable')
    with pytest.raises(RuntimeError, match='service unavailable'):
        getattr(store, operation)()


def test_count_fallback_errors_are_not_reported_as_partial_counts(astra):
    store, request = astra
    request.side_effect = [
        {'status': {'count': 1000, 'moreData': True}},
        page([{'_id': 'one'}], 'last'),
        RuntimeError('page unavailable'),
    ]
    with pytest.raises(RuntimeError, match='page unavailable'):
        store.count_documents()
