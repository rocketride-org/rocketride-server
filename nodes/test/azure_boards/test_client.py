# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for azure_boards_client.py (no network).

azure_boards_client.py has no rocketlib/engine dependency, so it's loaded
directly by file path rather than through the nodes.azure_boards package
(whose __init__ pulls in the engine via IEndpoint.py) — the same approach
nodes/test/confluence/test_client.py uses for confluence_client.py.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

_CLIENT_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'azure_boards' / 'azure_boards_client.py'

_spec = importlib.util.spec_from_file_location('azure_boards_client_under_test', _CLIENT_PATH)
client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(client)


class _FakeResponse:
    def __init__(self, payload, status_code=200, headers=None):
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} error')

    def json(self):
        return self._payload


def test_build_session_uses_empty_username_basic_auth():
    session = client.build_session('my-pat')
    assert isinstance(session, requests.Session)
    assert session.auth.username == ''
    assert session.auth.password == 'my-pat'
    assert session.headers['Accept'] == 'application/json'


# ---------------------------------------------------------------------------
# _request_with_retry: 429 + Retry-After handling (shared with confluence_client)
# ---------------------------------------------------------------------------


def test_request_with_retry_returns_immediately_on_success():
    fake_session = MagicMock()
    fake_session.request.return_value = _FakeResponse({'ok': True})

    response = client._request_with_retry(fake_session, 'POST', 'https://x/wiql', json={'query': 'x'})

    assert response.status_code == 200
    fake_session.request.assert_called_once()


def test_request_with_retry_retries_on_429_honoring_retry_after(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: sleeps.append(seconds))

    responses = [
        _FakeResponse({}, status_code=429, headers={'Retry-After': '2'}),
        _FakeResponse({'ok': True}, status_code=200),
    ]
    fake_session = MagicMock()
    fake_session.request.side_effect = lambda *a, **kw: responses.pop(0)

    response = client._request_with_retry(fake_session, 'POST', 'https://x/wiql')

    assert response.status_code == 200
    assert sleeps == [2.0]


def test_request_with_retry_floors_a_negative_retry_after(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: sleeps.append(seconds))

    responses = [
        _FakeResponse({}, status_code=429, headers={'Retry-After': '-5'}),
        _FakeResponse({'ok': True}, status_code=200),
    ]
    fake_session = MagicMock()
    fake_session.request.side_effect = lambda *a, **kw: responses.pop(0)

    client._request_with_retry(fake_session, 'POST', 'https://x/wiql')

    assert sleeps == [0.0]


def test_request_with_retry_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: None)

    fake_session = MagicMock()
    fake_session.request.return_value = _FakeResponse({}, status_code=429, headers={'Retry-After': '1'})

    response = client._request_with_retry(fake_session, 'POST', 'https://x/wiql')

    assert response.status_code == 429
    assert fake_session.request.call_count == client.MAX_RETRY_ATTEMPTS


# ---------------------------------------------------------------------------
# query_work_item_ids
# ---------------------------------------------------------------------------


def test_query_work_item_ids_returns_ids_only():
    fake_session = MagicMock()
    fake_session.request.return_value = _FakeResponse({'workItems': [{'id': 1, 'url': 'x'}, {'id': 2, 'url': 'y'}]})

    ids = client.query_work_item_ids(fake_session, 'myorg', 'myproj', 'SELECT [System.Id] FROM WorkItems')

    assert ids == [1, 2]
    _, kwargs = fake_session.request.call_args
    assert kwargs['json'] == {'query': 'SELECT [System.Id] FROM WorkItems'}
    method, url = fake_session.request.call_args[0][:2]
    assert method == 'POST'
    assert url == 'https://dev.azure.com/myorg/myproj/_apis/wit/wiql'


def test_query_work_item_ids_raises_on_error():
    fake_session = MagicMock()
    fake_session.request.return_value = _FakeResponse({}, status_code=500)

    with pytest.raises(requests.HTTPError):
        client.query_work_item_ids(fake_session, 'myorg', 'myproj', 'SELECT [System.Id] FROM WorkItems')


# ---------------------------------------------------------------------------
# fetch_work_items_batch
# ---------------------------------------------------------------------------


def test_fetch_work_items_batch_chunks_at_batch_size(monkeypatch):
    monkeypatch.setattr(client, 'BATCH_SIZE', 2)

    calls = []

    def _fake_request(method, url, **kwargs):
        calls.append(kwargs['json']['ids'])
        return _FakeResponse({'value': [{'id': i} for i in kwargs['json']['ids']]})

    fake_session = MagicMock()
    fake_session.request.side_effect = _fake_request

    items = list(client.fetch_work_items_batch(fake_session, 'myorg', [1, 2, 3, 4, 5]))

    assert calls == [[1, 2], [3, 4], [5]]
    assert [item['id'] for item in items] == [1, 2, 3, 4, 5]


def test_fetch_work_items_batch_empty_ids_makes_no_request():
    fake_session = MagicMock()

    items = list(client.fetch_work_items_batch(fake_session, 'myorg', []))

    assert items == []
    fake_session.request.assert_not_called()


# ---------------------------------------------------------------------------
# iter_work_items
# ---------------------------------------------------------------------------


def test_iter_work_items_queries_then_fetches():
    responses = [
        _FakeResponse({'workItems': [{'id': 1}, {'id': 2}, {'id': 3}]}),
        _FakeResponse({'value': [{'id': 1, 'fields': {}}, {'id': 2, 'fields': {}}, {'id': 3, 'fields': {}}]}),
    ]
    fake_session = MagicMock()
    fake_session.request.side_effect = lambda *a, **kw: responses.pop(0)

    items = list(client.iter_work_items(fake_session, 'myorg', 'myproj', 'SELECT [System.Id] FROM WorkItems'))

    assert [item['id'] for item in items] == [1, 2, 3]


def test_iter_work_items_caps_at_max_records():
    responses = [
        _FakeResponse({'workItems': [{'id': 1}, {'id': 2}, {'id': 3}]}),
        _FakeResponse({'value': [{'id': 1, 'fields': {}}]}),
    ]
    fake_session = MagicMock()
    fake_session.request.side_effect = lambda *a, **kw: responses.pop(0)

    items = list(
        client.iter_work_items(fake_session, 'myorg', 'myproj', 'SELECT [System.Id] FROM WorkItems', max_records=1)
    )

    assert [item['id'] for item in items] == [1]
    # The batch fetch itself should only have been asked for the capped ID list
    _, kwargs = fake_session.request.call_args
    assert kwargs['json']['ids'] == [1]
