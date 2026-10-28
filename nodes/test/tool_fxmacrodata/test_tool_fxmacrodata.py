# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for tool_fxmacrodata (no network, no engine runtime).

Bootstrap mirrors test_crustdata.py: inject lightweight stubs for the engine
runtime modules, import the module under test, then drop the stubs so they
never leak into a shared pytest session. `requests` is real; only
`requests.get` is mocked per test, so redirect handling and error mapping run
against real exception types. `get_with_retry`, `normalize_tool_input` and
`optional_int` are loaded from their source files so the node exercises the
production retry policy and argument validators.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))

_REPO_ROOT = Path(__file__).resolve().parents[3]
_UTILS_DIR = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')

TEST_KEY = 'test-key-123'


def _load_source(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _UTILS_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _install_stubs() -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    class IInstanceBase:
        pass

    class IGlobalBase:
        pass

    mod_rl.tool_function = mock_tool_function
    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = Mock()
    mod_rl.debug = Mock()
    mod_rl.warning = Mock()
    mod_rl.error = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_config = types.ModuleType('ai.common.config')

    class Config:
        pass

    mod_config.Config = Config
    sys.modules['ai.common.config'] = mod_config

    tool_args = _load_source('_real_ai_common_utils_tool_args', 'tool_args.py')
    http_retry = _load_source('_real_ai_common_utils_http_retry', 'http_retry.py')
    mod_utils = types.ModuleType('ai.common.utils')
    mod_utils.normalize_tool_input = tool_args.normalize_tool_input
    mod_utils.optional_int = tool_args.optional_int
    mod_utils.get_with_retry = http_retry.get_with_retry
    sys.modules['ai.common.utils'] = mod_utils


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


with _scoped_stubs():
    from tool_fxmacrodata.fxmacrodata_client import (
        ApiKey,
        FXMacroDataClient,
        FXMacroDataError,
        collect_notices,
        parse_pagination,
        validate_currency,
        validate_date,
        validate_date_range,
        validate_slug,
    )
    from tool_fxmacrodata.IGlobal import FXMACRODATA_API_KEY_ENV, resolve_api_key
    from tool_fxmacrodata.IInstance import IInstance


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None, not_json=False):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    if not_json:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    if status >= 400:
        resp.raise_for_status.side_effect = requests.HTTPError(response=resp)
    else:
        resp.raise_for_status.side_effect = None
    return resp


def _instance(key=''):
    inst = IInstance.__new__(IInstance)
    glob = Mock()
    glob.api_key = ApiKey(key)
    inst.IGlobal = glob
    return inst


def _patch_get(*responses):
    return patch('requests.get', side_effect=list(responses))


_DELAY = {
    'applied': True,
    'delay_minutes': 15,
    'withheld_count': 0,
    'message': 'Free access is delayed by 15 minutes.',
}
_WINDOW = {'applied': True, 'max_days': 90, 'message': 'Anonymous access returns the most recent 90 days.'}

_LATEST_BODY = {
    'currency': 'USD',
    'as_of': '2026-10-02',
    'data': [
        {
            'indicator': 'inflation',
            'name': 'Inflation (CPI)',
            'unit': '%YoY',
            'frequency': 'Monthly',
            'provenance': {'publisher': 'BLS'},
            'latest': {'date': '2026-08-31', 'val': 3.4, 'announcement_datetime': 1789648200},
            'previous': {'date': '2026-07-31', 'val': 3.4},
            'pct_change_yoy': None,
        }
    ],
    'freemium_delay': _DELAY,
}


def _history_body(rows, *, offset, has_more, next_offset=None):
    pagination = {'limit': len(rows), 'offset': offset, 'total_count': 3, 'has_more': has_more}
    if next_offset is not None:
        pagination['next_offset'] = next_offset
    return {
        'currency': 'USD',
        'indicator': 'non_farm_payrolls',
        'name': 'Non-Farm Payrolls',
        'pagination': pagination,
        'freemium_window': _WINDOW,
        'freemium_delay': _DELAY,
        'data': rows,
    }


def _row(day, val):
    return {'date': day, 'val': val, 'announcement_datetime': 1790857800, 'observed_at_ns': 1, 'vintage_status': 'x'}


# ---------------------------------------------------------------------------
# ApiKey and config
# ---------------------------------------------------------------------------


class TestApiKey:
    def test_repr_and_str_never_show_the_value(self):
        key = ApiKey(TEST_KEY)
        assert TEST_KEY not in repr(key)
        assert TEST_KEY not in str(key)
        assert TEST_KEY not in f'{key}'
        assert repr(ApiKey('')) == 'ApiKey(<empty>)'

    def test_trims_surrounding_whitespace(self):
        assert ApiKey(f'  {TEST_KEY}\n').reveal() == TEST_KEY

    @pytest.mark.parametrize('bad', ['abc def', 'abc\ndef', 'abc\tdef', 'abc\x00def', 'clé'])
    def test_rejects_header_invalid_characters_without_echoing(self, bad):
        with pytest.raises(ValueError) as excinfo:
            ApiKey(bad)
        assert bad not in str(excinfo.value)

    def test_rejects_non_string(self):
        with pytest.raises(ValueError):
            ApiKey(12345)

    def test_empty_means_keyless(self):
        assert not ApiKey('')
        assert not ApiKey(None)
        assert ApiKey(TEST_KEY)


class TestResolveApiKey:
    def test_config_value_wins_over_env(self, monkeypatch):
        monkeypatch.setenv(FXMACRODATA_API_KEY_ENV, 'env-key')
        assert resolve_api_key({'apikey': TEST_KEY}).reveal() == TEST_KEY

    def test_env_fallback(self, monkeypatch):
        monkeypatch.setenv(FXMACRODATA_API_KEY_ENV, 'env-key')
        assert resolve_api_key({'apikey': ''}).reveal() == 'env-key'

    def test_no_key_is_keyless_not_an_error(self, monkeypatch):
        monkeypatch.delenv(FXMACRODATA_API_KEY_ENV, raising=False)
        assert not resolve_api_key({})

    def test_invalid_key_is_rejected_without_echo(self, monkeypatch):
        monkeypatch.delenv(FXMACRODATA_API_KEY_ENV, raising=False)
        with pytest.raises(ValueError) as excinfo:
            resolve_api_key({'apikey': 'bad key value'})
        assert 'bad key value' not in str(excinfo.value)


class TestClientConfig:
    @pytest.mark.parametrize('url', ['http://api.fxmacrodata.com/v1', 'https://', 'api.fxmacrodata.com/v1', ''])
    def test_base_url_must_be_https_with_host(self, url):
        with pytest.raises(ValueError):
            FXMacroDataClient(ApiKey(''), base_url=url)

    def test_requires_an_api_key_object(self):
        with pytest.raises(TypeError):
            FXMacroDataClient(TEST_KEY)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


class TestValidation:
    def test_currency(self):
        assert validate_currency(' usd ') == 'usd'
        assert validate_currency('EUR') == 'eur'
        for bad in ['US', 'USDX', 'U$D', '', None, 840, '../x']:
            with pytest.raises(FXMacroDataError):
                validate_currency(bad)

    def test_slug(self):
        assert validate_slug(' Non_Farm_Payrolls ') == 'non_farm_payrolls'
        for bad in ['', '   ', None, 'cpi/../x', 'cpi?x=1', '_leading']:
            with pytest.raises(FXMacroDataError):
                validate_slug(bad)

    def test_dates(self):
        assert validate_date('2026-02-28', 'start_date') == '2026-02-28'
        assert validate_date(None, 'start_date') is None
        for bad in ['2026-02-30', '2026-13-01', '2026/01/01', '20260101', 'yesterday', 20260101]:
            with pytest.raises(FXMacroDataError):
                validate_date(bad, 'start_date')

    def test_date_range_order(self):
        assert validate_date_range({'start_date': '2026-01-01', 'end_date': '2026-01-01'}) == {
            'start_date': '2026-01-01',
            'end_date': '2026-01-01',
        }
        with pytest.raises(FXMacroDataError, match='on or before'):
            validate_date_range({'start_date': '2026-02-01', 'end_date': '2026-01-01'})


# ---------------------------------------------------------------------------
# Pagination and notices
# ---------------------------------------------------------------------------


class TestPagination:
    def test_absent_or_null_means_unpaginated(self):
        assert parse_pagination({}, 0) is None
        assert parse_pagination({'pagination': None}, 0) is None

    def test_last_page(self):
        page = parse_pagination({'pagination': {'has_more': False, 'total_count': 2}}, 0)
        assert page == {'has_more': False, 'next_offset': None, 'total_count': 2}

    def test_more_pages(self):
        page = parse_pagination({'pagination': {'has_more': True, 'next_offset': 20}}, 0)
        assert page['next_offset'] == 20

    @pytest.mark.parametrize(
        'pagination',
        [
            [],
            'yes',
            {'has_more': 'true', 'next_offset': 20},
            {'has_more': 1, 'next_offset': 20},
            {'has_more': True},
            {'has_more': True, 'next_offset': '20'},
            {'has_more': True, 'next_offset': True},
            {'has_more': True, 'next_offset': 20.0},
            {'has_more': True, 'next_offset': 0},
            {'has_more': False, 'total_count': 'many'},
        ],
    )
    def test_malformed_pagination_is_rejected(self, pagination):
        with pytest.raises(FXMacroDataError):
            parse_pagination({'pagination': pagination}, 0)

    def test_next_offset_must_advance_past_current_offset(self):
        with pytest.raises(FXMacroDataError, match='did not advance'):
            parse_pagination({'pagination': {'has_more': True, 'next_offset': 40}}, 40)


class TestNotices:
    def test_window_and_delay_messages(self):
        notices = collect_notices({'freemium_window': _WINDOW, 'freemium_delay': _DELAY})
        assert notices == [_WINDOW['message'], _DELAY['message']]

    def test_withheld_releases_are_called_out(self):
        notices = collect_notices({'freemium_delay': {**_DELAY, 'withheld_count': 2}})
        assert any('2 recently published release(s) are withheld' in notice for notice in notices)

    def test_not_applied_or_malformed_blocks_are_ignored(self):
        assert collect_notices({'freemium_delay': {**_DELAY, 'applied': False}}) == []
        assert collect_notices({'freemium_delay': 'delayed', 'freemium_window': None}) == []


# ---------------------------------------------------------------------------
# Requests: headers, redirects and error mapping
# ---------------------------------------------------------------------------


class TestRequests:
    def test_keyless_request_sends_no_key_header_and_disables_redirects(self):
        with _patch_get(_resp(json_data=_LATEST_BODY)) as get:
            out = _instance().latest_announcements({'currency': 'usd'})
        assert out['success'] is True
        url = get.call_args.args[0]
        kwargs = get.call_args.kwargs
        assert url == 'https://api.fxmacrodata.com/v1/announcements/usd/latest'
        assert 'X-API-Key' not in kwargs['headers']
        assert kwargs['allow_redirects'] is False

    def test_keyed_request_sends_x_api_key(self):
        with _patch_get(_resp(json_data=_LATEST_BODY)) as get:
            _instance(TEST_KEY).latest_announcements({'currency': 'USD'})
        assert get.call_args.kwargs['headers']['X-API-Key'] == TEST_KEY
        assert TEST_KEY not in get.call_args.args[0]

    @pytest.mark.parametrize('status', [301, 302, 307, 308])
    def test_redirect_is_an_error_and_not_followed(self, status):
        with _patch_get(_resp(status, json_data={})) as get:
            out = _instance(TEST_KEY).latest_announcements({'currency': 'USD'})
        assert out['success'] is False
        assert 'redirect' in out['error']
        assert get.call_count == 1

    def test_http_200_with_key_required_error_body(self):
        body = {'error': 'api_key_required', 'code': 'api_key_required', 'detail': 'needs a key'}
        with _patch_get(_resp(json_data=body)):
            out = _instance().latest_announcements({'currency': 'EUR'})
        assert out['success'] is False
        assert 'needs an FXMacroData API key' in out['error']
        assert 'https://fxmacrodata.com/subscribe' in out['error']

    def test_http_200_with_other_error_body(self):
        with _patch_get(_resp(json_data={'error': 'internal', 'detail': 'something broke'})):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out == {'success': False, 'error': 'FXMacroData returned an error: something broke'}

    def test_non_json_body(self):
        with _patch_get(_resp(not_json=True)):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out == {'success': False, 'error': 'FXMacroData returned a non-JSON response body'}

    @pytest.mark.parametrize(
        'body', [[{'indicator': 'x'}], 'text', None, {'data': {'not': 'a list'}}, {'currency': 'USD'}]
    )
    def test_unexpected_shape(self, body):
        with _patch_get(_resp(json_data=body)):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out['success'] is False
        assert 'unexpected FXMacroData response' in out['error']

    def test_401_keyless_explains_the_free_scope(self):
        with _patch_get(_resp(401, json_data={'error': 'api_key_required'})):
            out = _instance().latest_announcements({'currency': 'EUR'})
        assert out['success'] is False
        assert 'Without a key, USD announcements' in out['error']

    def test_401_with_key_never_echoes_the_key(self):
        body = {'detail': f'Invalid API key {TEST_KEY}'}
        with _patch_get(_resp(401, json_data=body)):
            out = _instance(TEST_KEY).latest_announcements({'currency': 'EUR'})
        assert out['success'] is False
        assert 'did not accept the configured API key' in out['error']
        assert TEST_KEY not in out['error']

    def test_404_detail_is_surfaced_and_scrubbed(self):
        body = {'detail': f'Unsupported indicator for key {TEST_KEY}'}
        with _patch_get(_resp(404, json_data=body)):
            out = _instance(TEST_KEY).indicator_history({'currency': 'USD', 'indicator': 'nope'})
        assert out['success'] is False
        assert 'HTTP 404' in out['error']
        assert TEST_KEY not in out['error']
        assert '***' in out['error']

    def test_200_error_body_echoing_the_key_is_scrubbed(self):
        with _patch_get(_resp(json_data={'error': 'bad', 'detail': f'key {TEST_KEY} is odd'})):
            out = _instance(TEST_KEY).latest_announcements({'currency': 'USD'})
        assert TEST_KEY not in out['error']

    def test_successful_output_echoing_the_key_is_scrubbed(self):
        body = {**_LATEST_BODY, 'data': [{**_LATEST_BODY['data'][0], 'name': f'echo {TEST_KEY}'}]}
        with _patch_get(_resp(json_data=body)):
            out = _instance(TEST_KEY).latest_announcements({'currency': 'USD'})
        assert out['success'] is True
        assert TEST_KEY not in repr(out)

    def test_timeout_and_connection_errors_are_clean(self):
        with (
            patch('requests.get', side_effect=requests.exceptions.ConnectionError(f'boom {TEST_KEY}')),
            patch('tenacity.nap.time.sleep'),
        ):
            out = _instance(TEST_KEY).latest_announcements({'currency': 'USD'})
        assert out == {'success': False, 'error': 'FXMacroData request failed: ConnectionError'}
        with patch('requests.get', side_effect=requests.exceptions.Timeout()), patch('tenacity.nap.time.sleep'):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out == {'success': False, 'error': 'FXMacroData request timed out'}

    def test_5xx_is_retried(self):
        with _patch_get(_resp(503), _resp(json_data=_LATEST_BODY)) as get, patch('tenacity.nap.time.sleep'):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out['success'] is True
        assert get.call_count == 2

    def test_429_after_retries_is_a_clean_error(self):
        with _patch_get(_resp(429), _resp(429), _resp(429)), patch('tenacity.nap.time.sleep'):
            out = _instance().latest_announcements({'currency': 'USD'})
        assert out['success'] is False
        assert 'HTTP 429' in out['error']


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class TestLatestAnnouncements:
    def test_happy_path_projects_rows_and_surfaces_notices(self):
        with _patch_get(_resp(json_data=_LATEST_BODY)):
            out = _instance().latest_announcements({'currency': 'usd'})
        assert out['success'] is True
        assert out['currency'] == 'USD'
        assert out['as_of'] == '2026-10-02'
        assert out['count'] == 1
        row = out['data'][0]
        assert row['indicator'] == 'inflation'
        assert row['latest']['announcement_datetime'] == 1789648200
        assert 'provenance' not in row
        assert 'pct_change_yoy' not in row
        assert out['notices'] == [_DELAY['message']]

    def test_invalid_currency_makes_no_request(self):
        with patch('requests.get') as get:
            out = _instance().latest_announcements({'currency': 'dollars'})
        assert out['success'] is False
        get.assert_not_called()

    def test_json_string_input_is_accepted(self):
        with _patch_get(_resp(json_data=_LATEST_BODY)):
            out = _instance().latest_announcements('{"currency": "USD"}')
        assert out['success'] is True


class TestIndicatorHistory:
    def test_single_page_with_pagination_fields(self):
        body = _history_body([_row('2026-09-26', 1.0), _row('2026-09-19', 2.0)], offset=0, has_more=True, next_offset=2)
        with _patch_get(_resp(json_data=body)) as get:
            out = _instance().indicator_history({'currency': 'USD', 'indicator': 'Non_Farm_Payrolls', 'limit': 2})
        assert out['success'] is True
        assert out['indicator'] == 'non_farm_payrolls'
        assert out['name'] == 'Non-Farm Payrolls'
        assert out['count'] == 2
        assert out['data'][0] == {'date': '2026-09-26', 'val': 1.0, 'announcement_datetime': 1790857800}
        assert out['has_more'] is True
        assert out['next_offset'] == 2
        assert out['total_count'] == 3
        assert out['notices'] == [_WINDOW['message'], _DELAY['message']]
        assert get.call_args.kwargs['params'] == {'limit': 2, 'offset': 0}
        assert get.call_args.args[0].endswith('/announcements/usd/non_farm_payrolls')

    def test_follows_next_offset_across_pages(self):
        first = _history_body(
            [_row('2026-09-26', 1.0), _row('2026-09-19', 2.0)], offset=0, has_more=True, next_offset=2
        )
        second = _history_body([_row('2026-09-12', 3.0)], offset=2, has_more=False)
        with _patch_get(_resp(json_data=first), _resp(json_data=second)) as get:
            out = _instance().indicator_history(
                {'currency': 'USD', 'indicator': 'non_farm_payrolls', 'limit': 2, 'max_pages': 3}
            )
        assert out['success'] is True
        assert [row['val'] for row in out['data']] == [1.0, 2.0, 3.0]
        assert out['has_more'] is False
        assert out['next_offset'] is None
        assert [call.kwargs['params']['offset'] for call in get.call_args_list] == [0, 2]
        assert out['notices'] == [_WINDOW['message'], _DELAY['message']]

    def test_non_advancing_next_offset_stops_with_an_error(self):
        first = _history_body([_row('2026-09-26', 1.0)], offset=5, has_more=True, next_offset=5)
        with _patch_get(_resp(json_data=first)):
            out = _instance().indicator_history(
                {'currency': 'USD', 'indicator': 'non_farm_payrolls', 'offset': 5, 'max_pages': 3}
            )
        assert out['success'] is False
        assert 'did not advance' in out['error']

    def test_dates_are_passed_through(self):
        body = _history_body([], offset=0, has_more=False)
        with _patch_get(_resp(json_data=body)) as get:
            _instance().indicator_history(
                {'currency': 'USD', 'indicator': 'inflation', 'start_date': '2026-01-01', 'end_date': '2026-06-30'}
            )
        assert get.call_args.kwargs['params'] == {
            'start_date': '2026-01-01',
            'end_date': '2026-06-30',
            'limit': 20,
            'offset': 0,
        }

    @pytest.mark.parametrize(
        'extra',
        [
            {'limit': 101},
            {'limit': 0},
            {'limit': True},
            {'limit': 2.5},
            {'offset': -1},
            {'max_pages': 6},
            {'max_pages': 0},
            {'start_date': '2026-02-30'},
            {'start_date': '2026-03-01', 'end_date': '2026-02-01'},
            {'indicator': ''},
            {'indicator': 'cpi/../../admin'},
        ],
    )
    def test_invalid_arguments_make_no_request(self, extra):
        args = {'currency': 'USD', 'indicator': 'inflation', **extra}
        with patch('requests.get') as get:
            out = _instance().indicator_history(args)
        assert out['success'] is False
        get.assert_not_called()


class TestReleaseCalendar:
    _BODY = {
        'currency': 'USD',
        'timezone': 'America/New_York',
        'data': [
            {
                'release': 'inflation',
                'name': 'CPI',
                'date': '2026-09-30',
                'announcement_datetime': 1791462600,
                'announcement_datetime_utc': '2026-10-08T12:30:00+00:00',
                'source_url': 'https://example.test',
            },
            {'release': 'trade_balance', 'name': 'Trade Balance', 'announcement_datetime': 1791289800},
        ],
    }

    def test_reference_period_is_not_presented_as_the_release_date(self):
        with _patch_get(_resp(json_data=self._BODY)):
            out = _instance().release_calendar({'currency': 'USD'})
        assert out['success'] is True
        first = out['data'][0]
        assert first['reference_period'] == '2026-09-30'
        assert 'date' not in first
        assert first['announcement_datetime'] == 1791462600
        assert 'reference_period' not in out['data'][1]
        assert out['truncated'] is False

    def test_limit_truncates_client_side(self):
        with _patch_get(_resp(json_data=self._BODY)):
            out = _instance().release_calendar({'currency': 'USD', 'limit': 1})
        assert out['count'] == 1
        assert out['total_events'] == 2
        assert out['truncated'] is True

    def test_indicator_and_window_are_sent(self):
        with _patch_get(_resp(json_data=self._BODY)) as get:
            _instance().release_calendar(
                {'currency': 'usd', 'indicator': 'Inflation', 'start_date': '2026-10-01', 'end_date': '2026-10-31'}
            )
        assert get.call_args.kwargs['params'] == {
            'start_date': '2026-10-01',
            'end_date': '2026-10-31',
            'indicator': 'inflation',
        }

    def test_calendar_limit_over_100_is_rejected(self):
        with patch('requests.get') as get:
            out = _instance().release_calendar({'currency': 'USD', 'limit': 500})
        assert out['success'] is False
        get.assert_not_called()


class TestDataCatalogue:
    def test_lists_indicators(self):
        body = {
            'inflation': {'name': 'Inflation (CPI)', 'unit': '%YoY', 'frequency': 'Monthly', 'series_variants': []},
            'policy_rate': {'name': 'Policy Rate', 'unit': '%', 'frequency': 'Irregular'},
        }
        with _patch_get(_resp(json_data=body)) as get:
            out = _instance().data_catalogue({'currency': 'EUR'})
        assert out['success'] is True
        assert out['count'] == 2
        assert out['indicators'][0] == {
            'indicator': 'inflation',
            'name': 'Inflation (CPI)',
            'unit': '%YoY',
            'frequency': 'Monthly',
        }
        assert get.call_args.args[0].endswith('/data_catalogue/eur')

    def test_empty_catalogue_is_an_error(self):
        with _patch_get(_resp(json_data={'detail': 'nothing here'})):
            out = _instance().data_catalogue({'currency': 'EUR'})
        assert out['success'] is False


class TestFxRates:
    _BODY = {
        'base': 'EUR',
        'quote': 'USD',
        'pagination': {'has_more': False, 'total_count': 1},
        'data': [{'date': '2026-10-02', 'val': 1.1, 'observation_datetime': 1, 'source': {'source_pair': 'EUR/USD'}}],
    }

    def test_keyless_returns_a_clean_error_without_a_request(self):
        with patch('requests.get') as get:
            out = _instance().fx_rates({'base': 'EUR', 'quote': 'USD'})
        assert out['success'] is False
        assert 'needs an FXMacroData API key' in out['error']
        get.assert_not_called()

    def test_with_key(self):
        with _patch_get(_resp(json_data=self._BODY)) as get:
            out = _instance(TEST_KEY).fx_rates({'base': 'eur', 'quote': 'usd', 'limit': 5})
        assert out['success'] is True
        assert out['pair'] == 'EUR/USD'
        assert out['data'] == [{'date': '2026-10-02', 'val': 1.1}]
        assert get.call_args.args[0].endswith('/forex/eur/usd')
        assert get.call_args.kwargs['headers']['X-API-Key'] == TEST_KEY

    def test_same_currency_is_rejected(self):
        out = _instance(TEST_KEY).fx_rates({'base': 'USD', 'quote': 'usd'})
        assert out['success'] is False
