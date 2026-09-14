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

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_notion'


def _load_modules():
    """Import tool_notion's submodules standalone, stubbing engine-only deps.

    Stubs are scoped to this import and removed afterward so they never leak
    into sibling tests running under the full engine (where rocketlib/ai.common
    are real and shared across the pytest session).
    """
    _core = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')
    _saved = {name: sys.modules.get(name) for name in _core}

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})

    def _tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    rocketlib.tool_function = _tool_function
    rocketlib.warning = Mock()
    rocketlib.error = Mock()
    sys.modules['rocketlib'] = rocketlib

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai'].__path__ = []
    sys.modules['ai.common'] = types.ModuleType('ai.common')
    sys.modules['ai.common'].__path__ = []

    ai_cfg = types.ModuleType('ai.common.config')
    ai_cfg.Config = type('Config', (), {'getNodeConfig': staticmethod(lambda *a, **k: {})})
    sys.modules['ai.common.config'] = ai_cfg

    ai_utils = types.ModuleType('ai.common.utils')

    def normalize_tool_input(value, **kwargs):
        return value if isinstance(value, dict) else {}

    ai_utils.normalize_tool_input = normalize_tool_input
    sys.modules['ai.common.utils'] = ai_utils

    # The `from . import ...` / `from .X import Y` statements inside IGlobal.py
    # and IInstance.py resolve their references at exec time, so the returned
    # module objects stay fully usable for the rest of this file even after
    # sys.modules is cleaned up below -- nothing here re-resolves through the
    # cache later.
    submodule_names = ('tool_notion.notion_client', 'tool_notion.IGlobal', 'tool_notion.IInstance')
    pkg = types.ModuleType('tool_notion')
    pkg.__path__ = [str(_DIR)]
    sys.modules['tool_notion'] = pkg
    try:
        for name in ('notion_client', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(f'tool_notion.{name}', _DIR / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[f'tool_notion.{name}'] = module
            spec.loader.exec_module(module)
        return (
            sys.modules['tool_notion.notion_client'],
            sys.modules['tool_notion.IGlobal'],
            sys.modules['tool_notion.IInstance'],
        )
    finally:
        sys.modules.pop('tool_notion', None)
        for name in submodule_names:
            sys.modules.pop(name, None)
        for name, mod in _saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


_nc, _ig, _ii = _load_modules()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None, text='', headers=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    resp.content = b'x' if json_data is not None else b''
    resp.text = text
    resp.reason = 'error'
    resp.headers = headers or {}
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


@pytest.fixture
def mock_requests(monkeypatch):
    """Stand in for the real `requests` package (see module docstring)."""
    fake = Mock()
    fake.exceptions = requests.exceptions
    monkeypatch.setitem(sys.modules, 'requests', fake)
    return fake


def _instance(apikey='test-key'):
    """Build an IInstance without running the engine lifecycle."""
    inst = _ii.IInstance.__new__(_ii.IInstance)
    glob = Mock()
    glob.apikey = apikey
    inst.IGlobal = glob
    return inst


# ---------------------------------------------------------------------------
# notion_client._headers
# ---------------------------------------------------------------------------


def test_headers_carry_bearer_auth_and_the_pinned_notion_version():
    headers = _nc._headers('secret_abc123')
    assert headers['Authorization'] == 'Bearer secret_abc123'
    assert headers['Notion-Version'] == _nc.NOTION_VERSION
    assert headers['Content-Type'] == 'application/json'


# ---------------------------------------------------------------------------
# notion_client.request — retry/error handling
# ---------------------------------------------------------------------------


class TestRequest:
    def test_success_returns_the_parsed_json_body(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={'ok': True})
        out = _nc.request('GET', '/search', api_key='k')
        assert out == {'ok': True}
        call = mock_requests.request.call_args
        assert call.args == ('GET', 'https://api.notion.com/v1/search')
        assert call.kwargs['headers']['Authorization'] == 'Bearer k'

    def test_success_with_no_body_returns_empty_dict(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data=None)
        out = _nc.request('PATCH', '/pages/x', api_key='k')
        assert out == {}

    def test_json_body_and_params_are_forwarded(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={})
        _nc.request('POST', '/search', api_key='k', json_body={'query': 'x'}, params={'a': 1})
        call = mock_requests.request.call_args
        assert call.kwargs['json'] == {'query': 'x'}
        assert call.kwargs['params'] == {'a': 1}

    def test_error_response_raises_notion_api_error_with_code_and_message(self, mock_requests):
        mock_requests.request.return_value = _resp(
            404, json_data={'code': 'object_not_found', 'message': 'Could not find page'}
        )
        with pytest.raises(_nc.NotionAPIError) as exc_info:
            _nc.request('GET', '/pages/bad-id', api_key='k')
        assert exc_info.value.status_code == 404
        assert exc_info.value.code == 'object_not_found'
        assert 'Could not find page' in str(exc_info.value)

    def test_error_response_with_non_json_body_falls_back_to_text(self, mock_requests):
        resp = _resp(500, json_data=None, text='internal error')
        mock_requests.request.return_value = resp
        with pytest.raises(_nc.NotionAPIError, match='internal error'):
            _nc.request('GET', '/x', api_key='k', max_retries=0)

    def test_retries_on_429_then_succeeds(self, mock_requests, monkeypatch):
        monkeypatch.setattr(_nc.time, 'sleep', lambda *_: None)
        mock_requests.request.side_effect = [_resp(429), _resp(200, json_data={'ok': True})]
        out = _nc.request('GET', '/search', api_key='k')
        assert out == {'ok': True}
        assert mock_requests.request.call_count == 2

    def test_429_honors_retry_after_header_when_longer_than_backoff(self, mock_requests, monkeypatch):
        sleeps = []
        monkeypatch.setattr(_nc.time, 'sleep', lambda s: sleeps.append(s))
        mock_requests.request.side_effect = [
            _resp(429, headers={'Retry-After': '30'}),
            _resp(200, json_data={'ok': True}),
        ]
        _nc.request('GET', '/search', api_key='k', base_delay=2.0)
        assert sleeps == [30.0]

    def test_429_ignores_unparseable_retry_after_header(self, mock_requests, monkeypatch):
        sleeps = []
        monkeypatch.setattr(_nc.time, 'sleep', lambda s: sleeps.append(s))
        mock_requests.request.side_effect = [
            _resp(429, headers={'Retry-After': 'not-a-number'}),
            _resp(200, json_data={'ok': True}),
        ]
        _nc.request('GET', '/search', api_key='k', base_delay=2.0)
        assert sleeps == [2.0]

    def test_retries_on_5xx_then_gives_up_after_max_retries(self, mock_requests, monkeypatch):
        monkeypatch.setattr(_nc.time, 'sleep', lambda *_: None)
        mock_requests.request.return_value = _resp(503, text='unavailable')
        with pytest.raises(_nc.NotionAPIError):
            _nc.request('GET', '/search', api_key='k', max_retries=3)
        assert mock_requests.request.call_count == 4  # initial + 3 retries

    def test_connection_error_retries_then_raises_notion_api_error(self, mock_requests, monkeypatch):
        monkeypatch.setattr(_nc.time, 'sleep', lambda *_: None)
        mock_requests.request.side_effect = requests.exceptions.ConnectionError('dns failure')
        with pytest.raises(_nc.NotionAPIError, match='connection_error'):
            _nc.request('GET', '/search', api_key='k', max_retries=2)
        assert mock_requests.request.call_count == 3

    def test_connection_error_recovers_on_retry(self, mock_requests, monkeypatch):
        monkeypatch.setattr(_nc.time, 'sleep', lambda *_: None)
        mock_requests.request.side_effect = [
            requests.exceptions.Timeout('timed out'),
            _resp(200, json_data={'ok': True}),
        ]
        out = _nc.request('GET', '/search', api_key='k')
        assert out == {'ok': True}


# ---------------------------------------------------------------------------
# notion_client.resolve_data_source_id
# ---------------------------------------------------------------------------


class TestResolveDataSourceId:
    def test_explicit_data_source_id_short_circuits_without_a_request(self, mock_requests):
        out = _nc.resolve_data_source_id('db-1', api_key='k', data_source_id='ds-explicit')
        assert out == 'ds-explicit'
        mock_requests.request.assert_not_called()

    def test_single_data_source_resolves(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={'data_sources': [{'id': 'ds-1', 'name': 'Main'}]})
        out = _nc.resolve_data_source_id('db-1', api_key='k')
        assert out == 'ds-1'

    def test_no_data_source_raises(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={'data_sources': []})
        with pytest.raises(_nc.NotionAPIError, match='no data sources'):
            _nc.resolve_data_source_id('db-1', api_key='k')

    def test_multiple_data_sources_without_disambiguation_raises(self, mock_requests):
        mock_requests.request.return_value = _resp(
            200, json_data={'data_sources': [{'id': 'ds-1', 'name': 'A'}, {'id': 'ds-2', 'name': 'B'}]}
        )
        with pytest.raises(_nc.NotionAPIError, match='ambiguous'):
            _nc.resolve_data_source_id('db-1', api_key='k')


class TestGetTitlePropertyName:
    def test_finds_the_property_whose_type_is_title(self, mock_requests):
        mock_requests.request.return_value = _resp(
            200,
            json_data={
                'properties': {
                    'Status': {'type': 'select'},
                    'Task': {'type': 'title'},
                }
            },
        )
        out = _nc.get_title_property_name('ds-1', api_key='k')
        assert out == 'Task'
        assert mock_requests.request.call_args.args == ('GET', 'https://api.notion.com/v1/data_sources/ds-1')

    def test_raises_when_no_title_property_exists(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={'properties': {'Status': {'type': 'select'}}})
        with pytest.raises(_nc.NotionAPIError, match='no title property'):
            _nc.get_title_property_name('ds-1', api_key='k')


# ---------------------------------------------------------------------------
# notion_client block-tree flattening
# ---------------------------------------------------------------------------


class TestBlockPlainText:
    def test_extracts_text_for_known_block_types(self):
        block = {'type': 'paragraph', 'paragraph': {'rich_text': [{'plain_text': 'hello '}, {'plain_text': 'world'}]}}
        assert _nc._block_plain_text(block) == 'hello world'

    def test_unrecognized_block_type_returns_empty(self):
        assert _nc._block_plain_text({'type': 'divider', 'divider': {}}) == ''

    def test_missing_rich_text_returns_empty(self):
        assert _nc._block_plain_text({'type': 'paragraph', 'paragraph': {}}) == ''


class TestGetPageContent:
    def test_flattens_a_single_page_of_blocks(self, mock_requests):
        mock_requests.request.return_value = _resp(
            200,
            json_data={
                'results': [
                    {'type': 'heading_1', 'heading_1': {'rich_text': [{'plain_text': 'Title'}]}, 'has_children': False},
                    {
                        'type': 'paragraph',
                        'paragraph': {'rich_text': [{'plain_text': 'Body text'}]},
                        'has_children': False,
                    },
                    {'type': 'divider', 'divider': {}, 'has_children': False},
                ],
                'has_more': False,
                'next_cursor': None,
            },
        )
        text = _nc.get_page_content('page-1', api_key='k')
        assert text == 'Title\nBody text'

    def test_paginates_across_multiple_result_pages(self, mock_requests):
        mock_requests.request.side_effect = [
            _resp(
                200,
                json_data={
                    'results': [
                        {
                            'type': 'paragraph',
                            'paragraph': {'rich_text': [{'plain_text': 'first'}]},
                            'has_children': False,
                        }
                    ],
                    'has_more': True,
                    'next_cursor': 'cursor-2',
                },
            ),
            _resp(
                200,
                json_data={
                    'results': [
                        {
                            'type': 'paragraph',
                            'paragraph': {'rich_text': [{'plain_text': 'second'}]},
                            'has_children': False,
                        }
                    ],
                    'has_more': False,
                    'next_cursor': None,
                },
            ),
        ]
        text = _nc.get_page_content('page-1', api_key='k')
        assert text == 'first\nsecond'
        assert mock_requests.request.call_args_list[1].kwargs['params']['start_cursor'] == 'cursor-2'

    def test_nested_children_are_indented_and_recursed_into(self, mock_requests):
        mock_requests.request.side_effect = [
            _resp(
                200,
                json_data={
                    'results': [
                        {
                            'id': 'toggle-1',
                            'type': 'toggle',
                            'toggle': {'rich_text': [{'plain_text': 'Toggle'}]},
                            'has_children': True,
                        }
                    ],
                    'has_more': False,
                    'next_cursor': None,
                },
            ),
            _resp(
                200,
                json_data={
                    'results': [
                        {
                            'type': 'paragraph',
                            'paragraph': {'rich_text': [{'plain_text': 'nested'}]},
                            'has_children': False,
                        }
                    ],
                    'has_more': False,
                    'next_cursor': None,
                },
            ),
        ]
        text = _nc.get_page_content('page-1', api_key='k')
        assert text == 'Toggle\n  nested'

    def test_recursion_stops_at_max_depth(self, mock_requests):
        mock_requests.request.return_value = _resp(
            200,
            json_data={
                'results': [
                    {
                        'id': 'x',
                        'type': 'toggle',
                        'toggle': {'rich_text': [{'plain_text': 'deep'}]},
                        'has_children': True,
                    }
                ],
                'has_more': False,
                'next_cursor': None,
            },
        )
        text = _nc.get_page_content('page-1', api_key='k', max_depth=0)
        assert text == 'deep'
        assert mock_requests.request.call_count == 1


# ---------------------------------------------------------------------------
# notion_client write helpers
# ---------------------------------------------------------------------------


def test_title_property_shape():
    assert _nc.title_property('My Title') == {'title': [{'type': 'text', 'text': {'content': 'My Title'}}]}


class TestParagraphBlocks:
    def test_one_block_per_non_empty_line(self):
        blocks = _nc.paragraph_blocks('line one\n\nline two')
        assert len(blocks) == 2
        assert blocks[0]['paragraph']['rich_text'][0]['text']['content'] == 'line one'
        assert blocks[1]['paragraph']['rich_text'][0]['text']['content'] == 'line two'

    def test_blank_only_text_yields_no_blocks(self):
        assert _nc.paragraph_blocks('   \n\n  ') == []

    def test_line_at_the_limit_is_accepted(self):
        line = 'x' * _nc.MAX_RICH_TEXT_LENGTH
        blocks = _nc.paragraph_blocks(line)
        assert len(blocks) == 1

    def test_line_over_the_limit_raises(self):
        line = 'x' * (_nc.MAX_RICH_TEXT_LENGTH + 1)
        with pytest.raises(_nc.NotionAPIError, match='rich-text limit'):
            _nc.paragraph_blocks(line)


class TestAppendBlockChildren:
    def _blocks(self, n):
        return _nc.paragraph_blocks('\n'.join(f'line {i}' for i in range(n)))

    def test_single_batch_for_under_the_limit(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={})
        appended = _nc.append_block_children('b1', self._blocks(5), api_key='k')
        assert appended == 5
        assert mock_requests.request.call_count == 1

    def test_batches_into_groups_of_at_most_100(self, mock_requests):
        mock_requests.request.return_value = _resp(200, json_data={})
        appended = _nc.append_block_children('b1', self._blocks(250), api_key='k')
        assert appended == 250
        assert mock_requests.request.call_count == 3
        sizes = [len(call.kwargs['json']['children']) for call in mock_requests.request.call_args_list]
        assert sizes == [100, 100, 50]

    def test_each_batch_is_sent_without_retries(self, mock_requests):
        mock_requests.request.return_value = _resp(503)
        with pytest.raises(_nc.NotionAPIError):
            _nc.append_block_children('b1', self._blocks(1), api_key='k')
        assert mock_requests.request.call_count == 1


# ---------------------------------------------------------------------------
# IInstance.notion_search
# ---------------------------------------------------------------------------


class TestNotionSearch:
    def test_builds_query_filter_and_page_size(self, monkeypatch):
        mock_request = Mock(return_value={'results': [{'id': 'p1'}], 'has_more': True, 'next_cursor': 'c1'})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_search({'query': 'roadmap', 'filter_type': 'page', 'page_size': 5})

        assert out == {'success': True, 'results': [{'id': 'p1'}], 'has_more': True, 'next_cursor': 'c1'}
        call = mock_request.call_args
        assert call.args == ('POST', '/search')
        assert call.kwargs['json_body'] == {
            'query': 'roadmap',
            'filter': {'property': 'object', 'value': 'page'},
            'page_size': 5,
        }

    def test_page_size_is_clamped_to_100(self, monkeypatch):
        mock_request = Mock(return_value={'results': []})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        inst.notion_search({'page_size': 500})

        assert mock_request.call_args.kwargs['json_body']['page_size'] == 100

    def test_error_is_wrapped_in_the_standard_envelope(self, monkeypatch):
        monkeypatch.setattr(
            _ii.notion_client, 'request', Mock(side_effect=_nc.NotionAPIError(401, 'unauthorized', 'bad key'))
        )
        inst = _instance()

        out = inst.notion_search({'query': 'x'})

        assert out['success'] is False
        assert 'bad key' in out['error']


# ---------------------------------------------------------------------------
# IInstance.notion_get_database
# ---------------------------------------------------------------------------


class TestNotionGetDatabase:
    def test_missing_database_id_is_rejected_before_any_request(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_get_database({})

        assert out['success'] is False
        mock_request.assert_not_called()

    def test_flattens_the_title_and_returns_data_sources(self, monkeypatch):
        mock_request = Mock(
            return_value={
                'title': [{'plain_text': 'Sales '}, {'plain_text': 'Pipeline'}],
                'data_sources': [{'id': 'ds-1', 'name': 'Main'}],
            }
        )
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_get_database({'database_id': 'db-1'})

        assert out == {'success': True, 'title': 'Sales Pipeline', 'data_sources': [{'id': 'ds-1', 'name': 'Main'}]}
        assert mock_request.call_args.args == ('GET', '/databases/db-1')


# ---------------------------------------------------------------------------
# IInstance.notion_query_database
# ---------------------------------------------------------------------------


class TestNotionQueryDatabase:
    def test_missing_database_id_is_rejected(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_query_database({})

        assert out['success'] is False
        mock_request.assert_not_called()

    def test_resolves_data_source_then_queries_it(self, monkeypatch):
        mock_resolve = Mock(return_value='ds-1')
        mock_request = Mock(return_value={'results': [{'id': 'row-1'}], 'has_more': False, 'next_cursor': None})
        monkeypatch.setattr(_ii.notion_client, 'resolve_data_source_id', mock_resolve)
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_query_database(
            {
                'database_id': 'db-1',
                'filter': {'property': 'Status', 'select': {'equals': 'Done'}},
                'sorts': [{'property': 'Name', 'direction': 'ascending'}],
                'page_size': 10,
                'start_cursor': 'c0',
            }
        )

        assert out['success'] is True
        assert out['results'] == [{'id': 'row-1'}]
        mock_resolve.assert_called_once_with('db-1', api_key='test-key', data_source_id=None)
        call = mock_request.call_args
        assert call.args == ('POST', '/data_sources/ds-1/query')
        assert call.kwargs['json_body'] == {
            'filter': {'property': 'Status', 'select': {'equals': 'Done'}},
            'sorts': [{'property': 'Name', 'direction': 'ascending'}],
            'page_size': 10,
            'start_cursor': 'c0',
        }

    def test_explicit_data_source_id_is_forwarded_to_resolve(self, monkeypatch):
        mock_resolve = Mock(return_value='ds-explicit')
        monkeypatch.setattr(_ii.notion_client, 'resolve_data_source_id', mock_resolve)
        monkeypatch.setattr(_ii.notion_client, 'request', Mock(return_value={'results': []}))
        inst = _instance()

        inst.notion_query_database({'database_id': 'db-1', 'data_source_id': 'ds-explicit'})

        mock_resolve.assert_called_once_with('db-1', api_key='test-key', data_source_id='ds-explicit')

    def test_ambiguous_data_source_error_is_wrapped(self, monkeypatch):
        monkeypatch.setattr(
            _ii.notion_client,
            'resolve_data_source_id',
            Mock(side_effect=_nc.NotionAPIError(0, 'ambiguous_data_source', 'has 2 data sources')),
        )
        inst = _instance()

        out = inst.notion_query_database({'database_id': 'db-1'})

        assert out['success'] is False
        assert 'ambiguous' in out['error']


# ---------------------------------------------------------------------------
# IInstance.notion_get_page
# ---------------------------------------------------------------------------


class TestNotionGetPage:
    def test_missing_page_id_is_rejected(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_get_page({})

        assert out['success'] is False
        mock_request.assert_not_called()

    def test_returns_properties_url_and_in_trash(self, monkeypatch):
        mock_request = Mock(
            return_value={'properties': {'Name': {'title': []}}, 'url': 'https://notion.so/p1', 'in_trash': True}
        )
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_get_page({'page_id': 'p1'})

        assert out == {
            'success': True,
            'properties': {'Name': {'title': []}},
            'url': 'https://notion.so/p1',
            'in_trash': True,
        }

    def test_missing_in_trash_defaults_to_false(self, monkeypatch):
        mock_request = Mock(return_value={'properties': {}, 'url': ''})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_get_page({'page_id': 'p1'})

        assert out['in_trash'] is False


# ---------------------------------------------------------------------------
# IInstance.notion_get_page_content
# ---------------------------------------------------------------------------


class TestNotionGetPageContent:
    def test_missing_page_id_is_rejected(self, monkeypatch):
        mock_get = Mock()
        monkeypatch.setattr(_ii.notion_client, 'get_page_content', mock_get)
        inst = _instance()

        out = inst.notion_get_page_content({})

        assert out['success'] is False
        mock_get.assert_not_called()

    def test_forwards_max_depth_and_returns_text(self, monkeypatch):
        mock_get = Mock(return_value='flattened text')
        monkeypatch.setattr(_ii.notion_client, 'get_page_content', mock_get)
        inst = _instance()

        out = inst.notion_get_page_content({'page_id': 'p1', 'max_depth': 2})

        assert out == {'success': True, 'text': 'flattened text'}
        mock_get.assert_called_once_with('p1', api_key='test-key', max_depth=2)

    def test_invalid_max_depth_falls_back_to_default(self, monkeypatch):
        mock_get = Mock(return_value='text')
        monkeypatch.setattr(_ii.notion_client, 'get_page_content', mock_get)
        inst = _instance()

        inst.notion_get_page_content({'page_id': 'p1', 'max_depth': 'not-an-int'})

        assert mock_get.call_args.kwargs['max_depth'] == 4


# ---------------------------------------------------------------------------
# IInstance.notion_create_page
# ---------------------------------------------------------------------------


class TestNotionCreatePage:
    def test_missing_parent_id_or_type_is_rejected(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        assert inst.notion_create_page({'parent_id': 'x'})['success'] is False
        assert inst.notion_create_page({'parent_type': 'page'})['success'] is False
        assert inst.notion_create_page({'parent_id': 'x', 'parent_type': 'bogus'})['success'] is False
        mock_request.assert_not_called()

    def test_page_parent_uses_page_id_type_and_title_property(self, monkeypatch):
        mock_request = Mock(return_value={'id': 'new-page', 'url': 'https://notion.so/new-page'})
        mock_title_lookup = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        monkeypatch.setattr(_ii.notion_client, 'get_title_property_name', mock_title_lookup)
        inst = _instance()

        out = inst.notion_create_page({'parent_id': 'parent-1', 'parent_type': 'page', 'title': 'New Page'})

        assert out == {'success': True, 'page_id': 'new-page', 'url': 'https://notion.so/new-page'}
        call = mock_request.call_args
        assert call.args == ('POST', '/pages')
        assert call.kwargs['max_retries'] == 0
        body = call.kwargs['json_body']
        assert body['parent'] == {'type': 'page_id', 'page_id': 'parent-1'}
        assert body['properties']['title'] == _nc.title_property('New Page')
        # A page parent's title key is always literally 'title' -- no schema lookup needed.
        mock_title_lookup.assert_not_called()

    def test_data_source_parent_uses_data_source_id_type_and_resolved_title_property(self, monkeypatch):
        mock_request = Mock(return_value={'id': 'row-1', 'url': ''})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        monkeypatch.setattr(_ii.notion_client, 'get_title_property_name', Mock(return_value='Task'))
        inst = _instance()

        inst.notion_create_page({'parent_id': 'ds-1', 'parent_type': 'data_source', 'title': 'New Row'})

        body = mock_request.call_args.kwargs['json_body']
        assert body['parent'] == {'type': 'data_source_id', 'data_source_id': 'ds-1'}
        assert body['properties']['Task'] == _nc.title_property('New Row')

    def test_title_property_lookup_uses_the_data_sources_own_schema(self, monkeypatch):
        """A database's title column isn't always called "Name" -- the key must
        come from the data source's schema, not a guessed default.
        """
        mock_lookup = Mock(return_value='Task')
        monkeypatch.setattr(_ii.notion_client, 'request', Mock(return_value={'id': 'row-1', 'url': ''}))
        monkeypatch.setattr(_ii.notion_client, 'get_title_property_name', mock_lookup)
        inst = _instance()

        inst.notion_create_page({'parent_id': 'ds-1', 'parent_type': 'data_source', 'title': 'New Row'})

        mock_lookup.assert_called_once_with('ds-1', api_key='test-key')

    def test_explicit_title_property_in_properties_is_not_overridden(self, monkeypatch):
        mock_request = Mock(return_value={'id': 'row-1', 'url': ''})
        mock_title_lookup = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        monkeypatch.setattr(_ii.notion_client, 'get_title_property_name', mock_title_lookup)
        inst = _instance()

        custom_title = {'title': [{'type': 'text', 'text': {'content': 'Custom'}}]}
        inst.notion_create_page(
            {
                'parent_id': 'ds-1',
                'parent_type': 'data_source',
                'title': 'Ignored',
                'properties': {'Task Name': custom_title},
            }
        )

        body = mock_request.call_args.kwargs['json_body']
        assert body['properties'] == {'Task Name': custom_title}
        # No schema lookup needed -- the caller already supplied the title property.
        mock_title_lookup.assert_not_called()

    def test_content_is_converted_to_paragraph_blocks(self, monkeypatch):
        mock_request = Mock(return_value={'id': 'p1', 'url': ''})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        inst.notion_create_page(
            {'parent_id': 'p0', 'parent_type': 'page', 'title': 'X', 'content': 'line one\nline two'}
        )

        body = mock_request.call_args.kwargs['json_body']
        assert len(body['children']) == 2

    def test_no_content_omits_children(self, monkeypatch):
        mock_request = Mock(return_value={'id': 'p1', 'url': ''})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        inst.notion_create_page({'parent_id': 'p0', 'parent_type': 'page', 'title': 'X'})

        assert 'children' not in mock_request.call_args.kwargs['json_body']


# ---------------------------------------------------------------------------
# IInstance.notion_update_page
# ---------------------------------------------------------------------------


class TestNotionUpdatePage:
    def test_missing_page_id_is_rejected(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_update_page({'in_trash': True})

        assert out['success'] is False
        mock_request.assert_not_called()

    def test_neither_properties_nor_in_trash_is_rejected(self, monkeypatch):
        mock_request = Mock()
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_update_page({'page_id': 'p1'})

        assert out['success'] is False
        mock_request.assert_not_called()

    def test_updates_properties_and_in_trash(self, monkeypatch):
        mock_request = Mock(return_value={})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        out = inst.notion_update_page(
            {'page_id': 'p1', 'properties': {'Status': {'select': {'name': 'Done'}}}, 'in_trash': True}
        )

        assert out == {'success': True, 'page_id': 'p1'}
        call = mock_request.call_args
        assert call.args == ('PATCH', '/pages/p1')
        assert call.kwargs['json_body'] == {'properties': {'Status': {'select': {'name': 'Done'}}}, 'in_trash': True}
        assert call.kwargs['max_retries'] == 0

    def test_in_trash_false_is_sent_not_omitted(self, monkeypatch):
        mock_request = Mock(return_value={})
        monkeypatch.setattr(_ii.notion_client, 'request', mock_request)
        inst = _instance()

        inst.notion_update_page({'page_id': 'p1', 'in_trash': False})

        assert mock_request.call_args.kwargs['json_body'] == {'in_trash': False}


# ---------------------------------------------------------------------------
# IInstance.notion_append_content
# ---------------------------------------------------------------------------


class TestNotionAppendContent:
    def test_missing_block_id_or_text_is_rejected(self, monkeypatch):
        mock_append = Mock()
        monkeypatch.setattr(_ii.notion_client, 'append_block_children', mock_append)
        inst = _instance()

        assert inst.notion_append_content({'text': 'x'})['success'] is False
        assert inst.notion_append_content({'block_id': 'b1'})['success'] is False
        assert inst.notion_append_content({'block_id': 'b1', 'text': '   '})['success'] is False
        mock_append.assert_not_called()

    def test_appends_one_block_per_line_and_reports_the_count(self, monkeypatch):
        mock_append = Mock(return_value=3)
        monkeypatch.setattr(_ii.notion_client, 'append_block_children', mock_append)
        inst = _instance()

        out = inst.notion_append_content({'block_id': 'b1', 'text': 'first\nsecond\nthird'})

        assert out == {'success': True, 'appended': 3}
        call = mock_append.call_args
        assert call.args[0] == 'b1'
        assert len(call.args[1]) == 3
        assert call.kwargs['api_key'] == 'test-key'

    def test_error_is_wrapped(self, monkeypatch):
        monkeypatch.setattr(
            _ii.notion_client,
            'append_block_children',
            Mock(side_effect=_nc.NotionAPIError(404, 'not_found', 'block missing')),
        )
        inst = _instance()

        out = inst.notion_append_content({'block_id': 'bad', 'text': 'x'})

        assert out['success'] is False
        assert 'block missing' in out['error']

    def test_line_over_the_rich_text_limit_is_rejected_before_any_request(self, monkeypatch):
        mock_append = Mock()
        monkeypatch.setattr(_ii.notion_client, 'append_block_children', mock_append)
        inst = _instance()

        out = inst.notion_append_content({'block_id': 'b1', 'text': 'x' * 2001})

        assert out['success'] is False
        mock_append.assert_not_called()


# ---------------------------------------------------------------------------
# IGlobal.beginGlobal / validateConfig
# ---------------------------------------------------------------------------


class TestIGlobal:
    def _glob(self, config, env=None, monkeypatch=None, open_mode='invoke'):
        glob = _ig.IGlobal.__new__(_ig.IGlobal)
        glob.glb = Mock(logicalType='tool_notion://x', connConfig={})
        glob.IEndpoint = Mock()
        glob.IEndpoint.endpoint.openMode = open_mode
        if monkeypatch is not None:
            monkeypatch.setattr(_ig.Config, 'getNodeConfig', staticmethod(lambda *a, **k: config))
            monkeypatch.delenv('NOTION_API_KEY', raising=False)
            for key, value in (env or {}).items():
                monkeypatch.setenv(key, value)
        return glob

    def test_begin_global_skips_when_open_mode_is_config(self, monkeypatch):
        glob = self._glob({}, monkeypatch=monkeypatch, open_mode=_ig.OPEN_MODE.CONFIG)
        glob.beginGlobal()
        assert glob.apikey == ''

    def test_begin_global_reads_apikey_from_config(self, monkeypatch):
        glob = self._glob({'apikey': 'from-config'}, monkeypatch=monkeypatch, open_mode='invoke')
        glob.beginGlobal()
        assert glob.apikey == 'from-config'

    def test_begin_global_falls_back_to_env_var(self, monkeypatch):
        glob = self._glob({}, env={'NOTION_API_KEY': 'from-env'}, monkeypatch=monkeypatch, open_mode='invoke')
        glob.beginGlobal()
        assert glob.apikey == 'from-env'

    def test_begin_global_raises_when_no_apikey_anywhere(self, monkeypatch):
        glob = self._glob({}, monkeypatch=monkeypatch, open_mode='invoke')
        with pytest.raises(ValueError):
            glob.beginGlobal()

    def test_end_global_clears_the_apikey(self):
        glob = _ig.IGlobal.__new__(_ig.IGlobal)
        glob.apikey = 'secret'
        glob.endGlobal()
        assert glob.apikey == ''
