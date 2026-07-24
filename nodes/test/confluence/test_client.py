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
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


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


def test_iter_space_pages_follows_cursor_until_exhausted():
    page1 = {
        'results': [{'id': '1', 'title': 'Page One'}],
        '_links': {'next': '/wiki/api/v2/pages?cursor=next-token&limit=25'},
    }
    page2 = {'results': [{'id': '2', 'title': 'Page Two'}], '_links': {}}

    responses = [_FakeResponse(page1), _FakeResponse(page2)]
    fake_session = MagicMock()
    fake_session.get.side_effect = lambda *a, **kw: responses.pop(0)

    pages = list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))

    assert [p['id'] for p in pages] == ['1', '2']
    assert fake_session.get.call_count == 2
    _, second_kwargs = fake_session.get.call_args_list[1]
    assert second_kwargs['params']['cursor'] == 'next-token'
    assert second_kwargs['params']['space-key'] == 'ENG'


def test_iter_space_pages_raises_on_request_error():
    fake_session = MagicMock()
    fake_session.get.side_effect = RuntimeError('network down')

    with pytest.raises(RuntimeError, match='network down'):
        list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))


def test_iter_space_pages_stops_when_no_results_and_no_next():
    fake_session = MagicMock()
    fake_session.get.return_value = _FakeResponse({'results': [], '_links': {}})

    pages = list(client.iter_space_pages(fake_session, 'https://example.atlassian.net/wiki', 'ENG', 25))

    assert pages == []
    assert fake_session.get.call_count == 1
