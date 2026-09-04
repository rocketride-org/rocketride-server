# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for confluence_client.py (no network).

confluence_client.py has no rocketlib/engine dependency, so it's loaded
directly by file path rather than through the nodes.confluence package
(whose __init__ pulls in the engine via IEndpoint.py) — the same approach
nodes/test/tool_oura/test_live.py uses for oura_client.py.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

_CLIENT_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'confluence' / 'confluence_client.py'

_spec = importlib.util.spec_from_file_location('confluence_client_under_test', _CLIENT_PATH)
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


def _space_lookup_response(space_id='999'):
    return _FakeResponse({'results': [{'id': space_id, 'key': 'ENG'}]})


def test_build_session_sets_basic_auth_and_accept_header():
    session = client.build_session('a@b.com', 'tok123')
    assert isinstance(session, requests.Session)
    assert session.auth.username == 'a@b.com'
    assert session.auth.password == 'tok123'
    assert session.headers['Accept'] == 'application/json'


def test_extract_cursor_from_next_link():
    link = 'https://example.atlassian.net/wiki/api/v2/pages?cursor=abc123&limit=25'
    assert client.extract_cursor(link) == 'abc123'


def test_extract_cursor_missing_returns_empty():
    assert client.extract_cursor('https://example.atlassian.net/wiki/api/v2/pages?limit=25') == ''


# ---------------------------------------------------------------------------
# _get_with_retry: 429 + Retry-After handling
# ---------------------------------------------------------------------------


def test_get_with_retry_returns_immediately_on_success():
    fake_session = MagicMock()
    fake_session.get.return_value = _FakeResponse({'ok': True})

    response = client._get_with_retry(fake_session, 'https://x/pages', {})

    assert response.status_code == 200
    fake_session.get.assert_called_once()


def test_get_with_retry_retries_on_429_honoring_retry_after(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: sleeps.append(seconds))

    responses = [
        _FakeResponse({}, status_code=429, headers={'Retry-After': '2'}),
        _FakeResponse({'ok': True}, status_code=200),
    ]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    response = client._get_with_retry(fake_session, 'https://x/pages', {})

    assert response.status_code == 200
    assert sleeps == [2.0]
    assert fake_session.get.call_count == 2


def test_get_with_retry_caps_backoff_at_max_retry_after(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: sleeps.append(seconds))

    responses = [
        _FakeResponse({}, status_code=429, headers={'Retry-After': '9999'}),
        _FakeResponse({'ok': True}, status_code=200),
    ]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    client._get_with_retry(fake_session, 'https://x/pages', {})

    assert sleeps == [client.MAX_RETRY_AFTER_SECONDS]


def test_get_with_retry_floors_a_negative_retry_after(monkeypatch):
    sleeps = []
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: sleeps.append(seconds))

    responses = [
        _FakeResponse({}, status_code=429, headers={'Retry-After': '-5'}),
        _FakeResponse({'ok': True}, status_code=200),
    ]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    client._get_with_retry(fake_session, 'https://x/pages', {})

    assert sleeps == [0.0]


def test_get_with_retry_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr(client.time, 'sleep', lambda seconds: None)

    fake_session = MagicMock()
    fake_session.get.return_value = _FakeResponse({}, status_code=429, headers={'Retry-After': '1'})

    response = client._get_with_retry(fake_session, 'https://x/pages', {})

    assert response.status_code == 429
    assert fake_session.get.call_count == client.MAX_RETRY_ATTEMPTS


# ---------------------------------------------------------------------------
# resolve_space_id
# ---------------------------------------------------------------------------


def test_resolve_space_id_returns_id_from_key():
    fake_session = MagicMock()
    fake_session.get.return_value = _space_lookup_response(space_id='42')

    space_id = client.resolve_space_id(fake_session, 'https://example.atlassian.net/wiki', 'ENG')

    assert space_id == '42'
    _, kwargs = fake_session.get.call_args
    assert kwargs['params'] == {'keys': 'ENG'}
    assert fake_session.get.call_args[0][0].endswith('/api/v2/spaces')


def test_resolve_space_id_raises_when_key_not_found():
    fake_session = MagicMock()
    fake_session.get.return_value = _FakeResponse({'results': []})

    with pytest.raises(ValueError, match='ENG'):
        client.resolve_space_id(fake_session, 'https://example.atlassian.net/wiki', 'ENG')


# ---------------------------------------------------------------------------
# iter_space_pages
# ---------------------------------------------------------------------------


def test_iter_space_pages_follows_cursor_until_exhausted():
    page1 = {
        'results': [{'id': '1', 'title': 'Page One'}],
        '_links': {'next': '/wiki/api/v2/spaces/999/pages?cursor=next-token&limit=25'},
    }
    page2 = {'results': [{'id': '2', 'title': 'Page Two'}], '_links': {}}

    responses = [_space_lookup_response(space_id='999'), _FakeResponse(page1), _FakeResponse(page2)]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    pages = list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))

    assert [p['id'] for p in pages] == ['1', '2']
    assert fake_session.get.call_count == 3  # resolve + 2 page calls

    first_url = fake_session.get.call_args_list[0][0][0]
    assert first_url.endswith('/api/v2/spaces')

    second_url = fake_session.get.call_args_list[1][0][0]
    assert second_url.endswith('/api/v2/spaces/999/pages')

    _, third_kwargs = fake_session.get.call_args_list[2]
    assert third_kwargs['params']['cursor'] == 'next-token'
    assert 'space-key' not in third_kwargs['params']


def test_iter_space_pages_stops_at_max_pages_cap():
    page1 = {
        'results': [{'id': '1'}, {'id': '2'}],
        '_links': {'next': '/wiki/api/v2/spaces/999/pages?cursor=next-token&limit=25'},
    }
    page2 = {'results': [{'id': '3'}], '_links': {}}

    responses = [_space_lookup_response(space_id='999'), _FakeResponse(page1), _FakeResponse(page2)]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    pages = list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25, max_pages=1))

    assert [p['id'] for p in pages] == ['1']
    # Must not fetch the second page of results once the cap is hit mid-batch
    assert fake_session.get.call_count == 2


def test_iter_space_pages_raises_when_space_key_unresolvable():
    fake_session = MagicMock()
    fake_session.get.return_value = _FakeResponse({'results': []})

    with pytest.raises(ValueError):
        list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))


def test_iter_space_pages_raises_on_request_error():
    responses = [_space_lookup_response()]
    fake_session = MagicMock()

    def _get(*_a, **_kw):
        if responses:
            return responses.pop(0)
        raise RuntimeError('network down')

    fake_session.get.side_effect = _get

    with pytest.raises(RuntimeError, match='network down'):
        list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))


def test_iter_space_pages_stops_when_no_results_and_no_next():
    responses = [_space_lookup_response(), _FakeResponse({'results': [], '_links': {}})]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    pages = list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))

    assert pages == []
    assert fake_session.get.call_count == 2  # resolve + one empty page call
