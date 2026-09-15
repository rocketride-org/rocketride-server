# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for tool_crustdata (no network, no engine runtime).

Bootstrap mirrors test_pipedrive.py: inject lightweight stubs for the engine
runtime modules ONLY if absent, import the module under test, then drop the
stubs so they never leak into a shared pytest session. `requests` is real —
only its `.post` call is mocked per test, so the retry/error-mapping logic
runs against real exception types. `post_with_retry` is loaded directly from
its source file (bypassing the stubbed `ai`/`ai.common` packages) so the node
exercises the same tenacity-based retry policy production uses, rather than a
re-implementation of it.
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
_HTTP_RETRY_PATH = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'http_retry.py'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')


def _load_real_post_with_retry():
    """Load the real ``post_with_retry`` straight from its source file.

    Independent of the ``ai``/``ai.common`` package stubs below — http_retry.py
    only imports ``requests`` and ``tenacity``, both real — so retry/backoff
    behavior under test is the actual production implementation.
    """
    spec = importlib.util.spec_from_file_location('_real_ai_common_utils_http_retry', _HTTP_RETRY_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.post_with_retry


def _install_stubs() -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        pass

    class IGlobalBase:
        pass

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

    mod_utils = types.ModuleType('ai.common.utils')

    def normalize_tool_input(value, **kwargs):
        return value if isinstance(value, dict) else {}

    mod_utils.normalize_tool_input = normalize_tool_input
    mod_utils.post_with_retry = _load_real_post_with_retry()
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
    from tool_crustdata.IGlobal import _coerce_limit
    from tool_crustdata.IInstance import (
        COMPANY_SEARCH_URL,
        CRUSTDATA_API_VERSION,
        PERSON_SEARCH_URL,
        IInstance,
        _crustdata_headers,
        _extract_records,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = 200 <= status < 300
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    if not resp.ok:
        resp.raise_for_status.side_effect = requests.HTTPError(response=resp)
    else:
        resp.raise_for_status.side_effect = None
    return resp


def _instance(apikey='test-key', default_limit=10):
    """Build an IInstance without running the engine lifecycle."""
    inst = IInstance.__new__(IInstance)
    glob = Mock()
    glob.apikey = apikey
    glob.default_limit = default_limit
    inst.IGlobal = glob
    return inst


_A_CONDITION = {'field': 'basic_info.primary_domain', 'type': '=', 'value': 'acme.com'}


# ---------------------------------------------------------------------------
# _extract_records — response-envelope parsing
# ---------------------------------------------------------------------------


class TestExtractRecords:
    def test_finds_the_verified_key_for_the_endpoint_that_was_called(self):
        assert _extract_records({'companies': [{'name': 'Acme'}]}, 'companies') == [{'name': 'Acme'}]
        assert _extract_records({'profiles': [{'name': 'Jane'}]}, 'profiles') == [{'name': 'Jane'}]

    @pytest.mark.parametrize('key', ['results', 'data'])
    def test_falls_back_to_other_plausible_keys(self, key):
        body = {key: [{'name': 'Acme'}]}
        assert _extract_records(body, 'companies') == [{'name': 'Acme'}]

    def test_verified_key_wins_over_fallback_keys(self):
        body = {'results': [{'name': 'wrong'}], 'companies': [{'name': 'right'}]}
        assert _extract_records(body, 'companies') == [{'name': 'right'}]

    def test_accepts_a_bare_top_level_list(self):
        assert _extract_records([{'name': 'Acme'}], 'companies') == [{'name': 'Acme'}]

    def test_drops_non_dict_items_rather_than_raising(self):
        body = {'companies': ['oops', None, 42, {'name': 'Acme'}]}
        assert _extract_records(body, 'companies') == [{'name': 'Acme'}]

    def test_unrecognized_shape_returns_empty_not_an_error(self):
        assert _extract_records({'totally_unexpected_key': [{'name': 'Acme'}]}, 'companies') == []
        assert _extract_records('not even a dict or list', 'companies') == []
        assert _extract_records(None, 'companies') == []


# ---------------------------------------------------------------------------
# _coerce_limit — defaultLimit must degrade gracefully, not raise out of beginGlobal
# ---------------------------------------------------------------------------


class TestCoerceLimit:
    def test_valid_int_within_range_passes_through(self):
        assert _coerce_limit(50) == 50

    def test_none_falls_back_to_the_default(self):
        assert _coerce_limit(None) == 10
        assert _coerce_limit(None, default=25) == 25

    def test_empty_string_falls_back_to_the_default(self):
        """A hand-edited .pipe or SDK caller can send '' where the UI would send an int."""
        assert _coerce_limit('') == 10

    def test_non_numeric_string_falls_back_to_the_default(self):
        assert _coerce_limit('not-a-number') == 10

    def test_bool_does_not_become_1_or_0(self):
        assert _coerce_limit(True) == 10
        assert _coerce_limit(False) == 10

    def test_numeric_string_is_coerced(self):
        assert _coerce_limit('42') == 42

    def test_out_of_range_values_are_clamped(self):
        assert _coerce_limit(5000) == 1000
        assert _coerce_limit(0) == 1
        assert _coerce_limit(-5) == 1


# ---------------------------------------------------------------------------
# _crustdata_headers
# ---------------------------------------------------------------------------


def test_headers_carry_bearer_auth_and_the_pinned_api_version():
    headers = _crustdata_headers('sk-live-abc123')
    assert headers['authorization'] == 'Bearer sk-live-abc123'
    assert headers['x-api-version'] == CRUSTDATA_API_VERSION
    assert headers['content-type'] == 'application/json'


# ---------------------------------------------------------------------------
# company_search / person_search — request construction and error handling
# ---------------------------------------------------------------------------


class TestSearchValidation:
    def test_missing_filters_is_rejected_before_any_request(self):
        inst = _instance()
        out = inst.company_search({})
        assert out['success'] is False
        assert out['results'] == []
        assert 'filters' in out['error']

    def test_empty_filters_list_is_rejected(self):
        inst = _instance()
        out = inst.person_search({'filters': []})
        assert out['success'] is False
        assert 'filters' in out['error']

    def test_non_list_filters_is_rejected(self):
        inst = _instance()
        out = inst.company_search({'filters': 'not-a-list'})
        assert out['success'] is False


class TestSearchRequests:
    @patch('tool_crustdata.IInstance.requests.post')
    def test_company_search_hits_the_company_endpoint_and_wraps_filters_in_the_op_group(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': [{'name': 'Acme'}], 'total_count': 1})
        inst = _instance()

        out = inst.company_search({'filters': [_A_CONDITION]})

        assert out == {
            'success': True,
            'filters': [_A_CONDITION],
            'count': 1,
            'results': [{'name': 'Acme'}],
            'total_count': 1,
        }
        call_kwargs = mock_post.call_args
        assert call_kwargs.args[0] == COMPANY_SEARCH_URL
        assert call_kwargs.kwargs['json'] == {
            'filters': {'op': 'and', 'conditions': [_A_CONDITION]},
            'limit': 10,
        }
        assert call_kwargs.kwargs['headers']['authorization'] == 'Bearer test-key'

    @patch('tool_crustdata.IInstance.requests.post')
    def test_person_search_hits_the_person_endpoint(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'profiles': []})
        inst = _instance()

        out = inst.person_search({'filters': [_A_CONDITION]})

        assert out['success'] is True
        assert mock_post.call_args.args[0] == PERSON_SEARCH_URL

    @patch('tool_crustdata.IInstance.requests.post')
    def test_match_selects_the_op_and_defaults_to_and(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance()

        inst.company_search({'filters': [_A_CONDITION], 'match': 'or'})
        assert mock_post.call_args.kwargs['json']['filters']['op'] == 'or'

        inst.company_search({'filters': [_A_CONDITION], 'match': 'not-a-real-op'})
        assert mock_post.call_args.kwargs['json']['filters']['op'] == 'and'

    @patch('tool_crustdata.IInstance.requests.post')
    def test_all_of_is_never_sent_as_the_top_level_op(self, mock_post):
        """all_of is a person-search-only nested-array operator (constrained to one
        employment/education field path, no negation, no further nesting) -- not a
        generic combinator. Company search's op enum doesn't have it at all. Treat
        it like any other invalid match value: fall back to 'and'.
        """
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance()

        inst.company_search({'filters': [_A_CONDITION], 'match': 'all_of'})

        assert mock_post.call_args.kwargs['json']['filters']['op'] == 'and'

    @patch('tool_crustdata.IInstance.requests.post')
    def test_sorts_and_cursor_are_forwarded_when_provided(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance()

        inst.company_search(
            {
                'filters': [_A_CONDITION],
                'sorts': [{'field': 'crustdata_company_id', 'order': 'asc'}],
                'cursor': 'abc123',
            }
        )

        sent = mock_post.call_args.kwargs['json']
        assert sent['sorts'] == [{'field': 'crustdata_company_id', 'order': 'asc'}]
        assert sent['cursor'] == 'abc123'

    @patch('tool_crustdata.IInstance.requests.post')
    def test_cursor_and_sorts_are_omitted_when_not_provided(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance()

        inst.company_search({'filters': [_A_CONDITION]})

        sent = mock_post.call_args.kwargs['json']
        assert 'cursor' not in sent
        assert 'sorts' not in sent

    @patch('tool_crustdata.IInstance.requests.post')
    def test_next_cursor_is_surfaced_when_the_response_has_more_pages(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': [], 'next_cursor': 'xyz789', 'total_count': 500})
        inst = _instance()

        out = inst.company_search({'filters': [_A_CONDITION]})

        assert out['next_cursor'] == 'xyz789'
        assert out['total_count'] == 500

    @patch('tool_crustdata.IInstance.requests.post')
    def test_limit_is_clamped_to_the_documented_range(self, mock_post):
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance()

        inst.company_search({'filters': [_A_CONDITION], 'limit': 5000})
        assert mock_post.call_args.kwargs['json']['limit'] == 1000

        inst.company_search({'filters': [_A_CONDITION], 'limit': 0})
        assert mock_post.call_args.kwargs['json']['limit'] == 1

    @patch('tool_crustdata.IInstance.requests.post')
    def test_bool_limit_does_not_become_1_or_0(self, mock_post):
        """Bool is a subclass of int in Python; {'limit': True} must not silently become 1."""
        mock_post.return_value = _resp(200, json_data={'companies': []})
        inst = _instance(default_limit=25)

        inst.company_search({'filters': [_A_CONDITION], 'limit': True})
        assert mock_post.call_args.kwargs['json']['limit'] == 25

    @patch('tenacity.nap.time.sleep', return_value=None)
    @patch('tool_crustdata.IInstance.requests.post')
    def test_retries_on_429_then_succeeds(self, mock_post, _sleep):
        mock_post.side_effect = [_resp(429), _resp(200, json_data={'companies': [{'name': 'Acme'}]})]
        inst = _instance()

        out = inst.company_search({'filters': [_A_CONDITION]})

        assert out['success'] is True
        assert mock_post.call_count == 2

    @patch('tenacity.nap.time.sleep', return_value=None)
    @patch('tool_crustdata.IInstance.requests.post')
    def test_retries_on_5xx_then_gives_up_after_max_retries(self, mock_post, _sleep):
        mock_post.return_value = _resp(503)
        inst = _instance()

        out = inst.company_search({'filters': [_A_CONDITION]})

        assert out['success'] is False
        assert mock_post.call_count == 4  # initial attempt + 3 retries (post_with_retry's max_attempts=4)

    @patch('tenacity.nap.time.sleep', return_value=None)
    @patch('tool_crustdata.IInstance.requests.post')
    def test_timeout_is_reported_as_a_structured_error_not_raised(self, mock_post, _sleep):
        mock_post.side_effect = requests.exceptions.Timeout('timed out')
        inst = _instance()

        out = inst.company_search({'filters': [_A_CONDITION]})

        assert out['success'] is False
        assert 'Timeout' in out['error']
        assert mock_post.call_count == 4

    @patch('tenacity.nap.time.sleep', return_value=None)
    @patch('tool_crustdata.IInstance.requests.post')
    def test_connection_error_is_reported_as_a_structured_error(self, mock_post, _sleep):
        """A connection error is transient transport failure, not a hard fail on the
        first attempt — post_with_retry must retry it like it retries Timeout, so this
        asserts the retry actually happened rather than asserting immediate failure.
        """
        mock_post.side_effect = requests.exceptions.ConnectionError('dns failure')
        inst = _instance()

        out = inst.person_search({'filters': [_A_CONDITION]})

        assert out['success'] is False
        assert out['results'] == []
        assert mock_post.call_count == 4
