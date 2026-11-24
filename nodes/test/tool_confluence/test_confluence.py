# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for tool_notion (no network, no engine runtime).

Bootstrap mirrors test_cloud_stt.py: stub the engine-only modules (rocketlib,
ai.common.*), load the node's submodules standalone via a synthetic package,
then restore sys.modules so the stubs never leak into a shared pytest session.

notion_client.request() does `import requests` *inside* the function (lazy,
matching elevenlabs_tts.py's / deepgram_stt.py's pattern), so there's no
module-level `notion_client.requests` attribute to @patch -- tests stand a
fake module in for it via sys.modules instead.
"""

from __future__ import annotations


"""Offline tests for tool_confluence (HTTP is faked; no live Confluence site)."""

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_confluence'


def _load_modules():
    """Import tool_confluence submodules standalone, stubbing engine-only deps,
    and remove the stubs afterwards so they never leak into sibling tests.
    """
    _core = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')
    _saved = {name: sys.modules.get(name) for name in _core}
    names = (
        'tool_confluence',
        'tool_confluence.confluence_client',
        'tool_confluence.IGlobal',
        'tool_confluence.IInstance',
    )
    _saved.update({n: sys.modules.get(n) for n in names})

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    rocketlib.tool_function = lambda *a, **k: lambda fn: fn
    rocketlib.warning = Mock()
    rocketlib.error = Mock()
    sys.modules['rocketlib'] = rocketlib
    for n in ('ai', 'ai.common'):
        sys.modules[n] = types.ModuleType(n)
        sys.modules[n].__path__ = []
    cfg = types.ModuleType('ai.common.config')
    cfg.Config = type('Config', (), {'getNodeConfig': staticmethod(lambda *a, **k: {})})
    sys.modules['ai.common.config'] = cfg
    utils = types.ModuleType('ai.common.utils')
    utils.normalize_tool_input = lambda value, **kw: value if isinstance(value, dict) else {}
    sys.modules['ai.common.utils'] = utils

    pkg = types.ModuleType('tool_confluence')
    pkg.__path__ = [str(_DIR)]
    sys.modules['tool_confluence'] = pkg
    try:
        mods = []
        for name in ('confluence_client', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'tool_confluence.{name}', _DIR / f'{name}.py')
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'tool_confluence.{name}'] = mod
            spec.loader.exec_module(mod)
            mods.append(mod)
        return mods
    finally:
        for k, v in _saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


client, iglobal, iinstance = _load_modules()


def _resp(status=200, body=None, headers=None):
    r = Mock()
    r.status_code = status
    r.ok = 200 <= status < 300
    r.headers = headers or {}
    r.json = Mock(return_value=body if body is not None else {})
    r.content = b'{}'
    r.text = str(body)
    r.reason = 'x'
    return r


def _instance():
    inst = iinstance.IInstance()
    inst.IGlobal = types.SimpleNamespace(base_url='https://s.atlassian.net/wiki', email='a@b.c', apikey='tok')
    return inst


@pytest.fixture
def http(monkeypatch):
    calls = []
    queue = []

    def fake(method, url, **kw):
        calls.append((method, url, kw))
        return queue.pop(0)

    monkeypatch.setattr(requests, 'request', fake)
    monkeypatch.setattr(client.time, 'sleep', lambda s: None)
    return types.SimpleNamespace(calls=calls, queue=queue)


def test_storage_to_text_flattens_blocks():
    assert client.storage_to_text('<h1>T</h1><p>a &amp; b</p><ul><li>x</li><li>y</li></ul>') == 'T\n\na & b\n\nx\n\ny'


def test_text_to_storage_escapes_and_splits():
    assert client.text_to_storage('a <b>\nc\n\nd') == '<p>a &lt;b&gt;<br/>c</p><p>d</p>'


def test_search_maps_results_and_uses_basic_auth(http):
    http.queue.append(
        _resp(
            body={
                'totalSize': 1,
                'results': [
                    {
                        'title': 'Doc',
                        'url': '/x',
                        'excerpt': 'e',
                        'content': {'id': '7', 'type': 'page'},
                        'resultGlobalContainer': {'title': 'Eng'},
                    }
                ],
            }
        )
    )
    out = _instance().confluence_search({'cql': 'type = page', 'limit': 500})
    assert out['success'] and out['results'][0] == {
        'id': '7',
        'type': 'page',
        'title': 'Doc',
        'space': 'Eng',
        'url': '/x',
        'excerpt': 'e',
    }
    method, url, kw = http.calls[0]
    assert url == 'https://s.atlassian.net/wiki/rest/api/search' and kw['auth'] == ('a@b.c', 'tok')
    assert kw['params']['limit'] == 100


def test_search_requires_cql(http):
    out = _instance().confluence_search({})
    assert out['success'] is False and 'cql' in out['error']
    assert not http.calls


def test_get_page_returns_plain_text(http):
    http.queue.append(
        _resp(
            body={
                'id': '1',
                'title': 'T',
                'spaceId': '9',
                'version': {'number': 3},
                'body': {'storage': {'value': '<p>hi</p>'}},
            }
        )
    )
    out = _instance().confluence_get_page({'page_id': '1'})
    assert out == {'success': True, 'page_id': '1', 'title': 'T', 'space_id': '9', 'version': 3, 'text': 'hi'}
    assert http.calls[0][2]['params'] == {'body-format': 'storage'}


def test_create_page_resolves_space_key(http):
    http.queue.append(_resp(body={'results': [{'id': '42'}]}))
    http.queue.append(_resp(body={'id': '5', '_links': {'webui': '/spaces/ENG/pages/5'}}))
    out = _instance().confluence_create_page({'title': 'New', 'space_key': 'ENG', 'parent_id': '2', 'content': 'hello'})
    assert out == {'success': True, 'page_id': '5', 'url': 'https://s.atlassian.net/wiki/spaces/ENG/pages/5'}
    body = http.calls[1][2]['json']
    assert body['spaceId'] == '42' and body['parentId'] == '2' and body['body']['value'] == '<p>hello</p>'


def test_create_page_requires_space(http):
    out = _instance().confluence_create_page({'title': 'x'})
    assert out['success'] is False and 'space' in out['error']


def test_update_page_bumps_version_and_keeps_body(http):
    http.queue.append(
        _resp(
            body={
                'id': '1',
                'title': 'Old',
                'status': 'current',
                'version': {'number': 3},
                'body': {'storage': {'value': '<p>keep</p>'}},
            }
        )
    )
    http.queue.append(_resp(body={}))
    out = _instance().confluence_update_page({'page_id': '1', 'title': 'Newer'})
    assert out == {'success': True, 'page_id': '1', 'version': 4}
    body = http.calls[1][2]['json']
    assert (
        http.calls[1][0] == 'PUT'
        and body['title'] == 'Newer'
        and body['version'] == {'number': 4}
        and body['body']['value'] == '<p>keep</p>'
    )


def test_update_page_requires_a_change(http):
    out = _instance().confluence_update_page({'page_id': '1'})
    assert out['success'] is False and not http.calls


def test_api_error_becomes_envelope(http):
    http.queue.append(_resp(status=404, body={'message': 'No page'}))
    out = _instance().confluence_get_page({'page_id': '1'})
    assert out == {'success': False, 'error': 'Confluence API 404: No page'}


def test_retries_on_429_then_succeeds(http):
    http.queue.extend([_resp(status=429, headers={'Retry-After': '1'}), _resp(body={'ok': 1})])
    assert client.request('GET', '/x', base_url='https://h', email='e', api_key='k') == {'ok': 1}
    assert len(http.calls) == 2


def test_connection_error_is_normalized(monkeypatch):
    def boom(*a, **k):
        raise requests.exceptions.ConnectionError('down')

    monkeypatch.setattr(requests, 'request', boom)
    monkeypatch.setattr(client.time, 'sleep', lambda s: None)
    with pytest.raises(client.ConfluenceAPIError):
        client.request('GET', '/x', base_url='https://h', email='e', api_key='k')
