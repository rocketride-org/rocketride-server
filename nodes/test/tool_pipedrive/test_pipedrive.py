"""
Unit tests for tool_pipedrive.

Covers the HTTP client (auth, envelope handling, error mapping, rate-limit
retries), the tool-group publication filter, and read-only enforcement. No
credentials and no network access are needed — see test_tools.py for the
env-gated live suite.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import traceback
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))
# `zone_audit` is loaded by path, not by import. `nodes/test/` cannot go on
# sys.path: the test packages under it are named `tool_pipedrive` and
# `tool_gohighlevel`, so putting that directory ahead of `src/nodes` makes them
# shadow the very nodes these tests import.
_ZONE_AUDIT_SPEC = importlib.util.spec_from_file_location(
    'zone_audit', Path(__file__).resolve().parents[1] / 'zone_audit.py'
)
zone_audit = importlib.util.module_from_spec(_ZONE_AUDIT_SPEC)
_ZONE_AUDIT_SPEC.loader.exec_module(zone_audit)
audit_time_fields = zone_audit.audit_time_fields


_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')

# Obviously fake. A real personal token is 40 hex characters, but a literal one
# here trips secret scanners, so use a placeholder of the same shape class:
# short, dot-free and under 64 characters, which is what selects api_token auth.
TEST_TOKEN = 'pipedrive-test-not-a-real-token'
PERSONAL_TOKEN = 'pipedrive-personal-token-placeholder'


def _install_stubs() -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        def _collect_tool_methods(self):
            methods = {}
            for name in dir(type(self)):
                attr = getattr(type(self), name, None)
                if attr is not None and hasattr(attr, '__tool_meta__'):
                    methods[name] = getattr(self, name)
            return methods

    class IGlobalBase:
        pass

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = Mock()
    mod_rl.warning = Mock()
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

    def require_str(args, key, **kwargs):
        value = args.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f'{key} is required')
        return value.strip()

    def require_int(args, key, **kwargs):
        value = args.get(key)
        if isinstance(value, bool) or value is None:
            raise ValueError(f'{key} is required')
        return int(value)

    mod_utils.normalize_tool_input = normalize_tool_input
    mod_utils.require_str = require_str
    mod_utils.require_int = require_int
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
    from tool_pipedrive.IInstance import IInstance
    from tool_pipedrive.pipedrive_client import (
        BASE_URL,
        BASE_URL_V2,
        MAX_LIMIT,
        PipedriveAPIError,
        _auth,
        _use_bearer,
        base_url_for,
        base_url_v2_for,
        call,
        call_envelope,
        clean_deal,
        clean_person,
        paginated,
        paginated_v2,
        split_custom_fields,
    )
    from tool_pipedrive.IGlobal import _oversized_warning
    from tool_pipedrive.tool_groups import (
        ALL_GROUPS,
        DEFAULT_GROUPS,
        RECOMMENDED_TOOL_LIMIT,
        normalize_groups,
        pipedrive_tool,
        published_tool_count,
        tool_counts_by_group,
        wants_all_groups,
    )
    from tool_pipedrive.tools._base import PAGING, PAGING_V2, body_from, paging_params, paging_params_v2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None, headers=None, text='', content=b'{}', ok=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = (200 <= status < 300) if ok is None else ok
    resp.headers = headers or {}
    resp.text = text
    resp.content = content
    resp.reason = 'reason'
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


def _ok(data, *, additional=None):
    payload = {'success': True, 'data': data}
    if additional is not None:
        payload['additional_data'] = additional
    return _resp(200, json_data=payload, content=b'{"success": true}')


def _instance(**overrides):
    """Build an IInstance without running the engine lifecycle."""
    inst = IInstance.__new__(IInstance)
    glob = Mock()
    glob.token = TEST_TOKEN
    glob.base_url = BASE_URL
    glob.base_url_v2 = BASE_URL_V2
    glob.read_only = False
    glob.tool_groups = DEFAULT_GROUPS
    glob.allow_raw_request = True
    for key, value in overrides.items():
        setattr(glob, key, value)
    inst.IGlobal = glob
    return inst


# ---------------------------------------------------------------------------
# Base URL and auth
# ---------------------------------------------------------------------------


class TestBaseUrl:
    def test_default(self):
        assert base_url_for('') == BASE_URL
        assert base_url_for(None) == BASE_URL

    @pytest.mark.parametrize(
        'domain',
        ['acme', 'acme.pipedrive.com', 'https://acme.pipedrive.com', 'https://acme.pipedrive.com/', 'ACME', ' Acme '],
    )
    def test_company_domain_forms(self, domain):
        assert base_url_for(domain) == 'https://acme.pipedrive.com/api/v1'

    def test_garbage_domain_falls_back(self):
        assert base_url_for('https://') == BASE_URL

    @pytest.mark.parametrize(
        'domain',
        [
            'evil.example#',  # fragment: requests would send this to evil.example
            'evil.example?',
            'evil.example/',
            'acme@evil.example',
            'acme:8080',
            'evil.example',  # a company domain is one label, never a dotted host
            'acme_corp',
            '-acme',
            'acme.pipedrive.com.evil.example',
        ],
    )
    def test_domain_that_could_retarget_the_request_falls_back(self, domain):
        assert base_url_for(domain) == BASE_URL
        assert base_url_v2_for(domain) == BASE_URL_V2


class TestAuth:
    def test_personal_token_uses_query_param(self):
        headers, params = _auth(PERSONAL_TOKEN)
        assert headers == {}
        assert params == {'api_token': PERSONAL_TOKEN}
        assert _use_bearer(PERSONAL_TOKEN) is False

    def test_jwt_uses_bearer_header(self):
        token = 'header.payload.signature'
        headers, params = _auth(token)
        assert headers == {'Authorization': f'Bearer {token}'}
        assert params == {}

    def test_explicit_bearer_prefix_is_stripped(self):
        headers, params = _auth('Bearer abc123')
        assert headers == {'Authorization': 'Bearer abc123'}
        assert params == {}

    def test_long_opaque_token_uses_bearer(self):
        token = 'x' * 70
        assert _use_bearer(token) is True


# ---------------------------------------------------------------------------
# Envelope handling
# ---------------------------------------------------------------------------


class TestEnvelope:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_call_unwraps_data(self, mock_request):
        mock_request.return_value = _ok({'id': 7, 'title': 'Deal'})
        assert call(TEST_TOKEN, 'GET', '/deals/7') == {'id': 7, 'title': 'Deal'}

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_null_data_becomes_empty_dict(self, mock_request):
        mock_request.return_value = _ok(None)
        assert call(TEST_TOKEN, 'DELETE', '/deals/7') == {}

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_204_returns_success_envelope(self, mock_request):
        mock_request.return_value = _resp(204, content=b'')
        assert call_envelope(TEST_TOKEN, 'DELETE', '/deals/7') == {'success': True, 'data': {}}

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_raw_returns_bytes(self, mock_request):
        mock_request.return_value = _resp(200, json_data={'success': True}, content=b'binary-bytes')
        assert call(TEST_TOKEN, 'GET', '/files/1/download', raw=True) == b'binary-bytes'

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_path_and_params_are_built(self, mock_request):
        mock_request.return_value = _ok([])
        call(TEST_TOKEN, 'GET', 'deals', params={'limit': 10, 'start': None})
        _, kwargs = mock_request.call_args
        assert mock_request.call_args[0] == ('GET', f'{BASE_URL}/deals')
        assert kwargs['params'] == {'limit': 10, 'api_token': TEST_TOKEN}

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_custom_base_url_is_used(self, mock_request):
        mock_request.return_value = _ok([])
        call(TEST_TOKEN, 'GET', '/deals', base_url='https://acme.pipedrive.com/api/v1')
        assert mock_request.call_args[0][1] == 'https://acme.pipedrive.com/api/v1/deals'

    def test_paginated_wraps_items(self):
        envelope = {
            'data': [],
            'additional_data': {'pagination': {'more_items_in_collection': True, 'next_start': 100}},
        }
        assert paginated(envelope, [{'id': 1}]) == {
            'items': [{'id': 1}],
            'count': 1,
            'more_items_in_collection': True,
            'next_start': 100,
        }

    def test_paginated_without_pagination_block(self):
        assert paginated({'data': []}, [])['more_items_in_collection'] is False


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TestErrors:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_error_message_includes_info_and_code(self, mock_request):
        mock_request.return_value = _resp(
            403,
            json_data={
                'success': False,
                'error': 'Deal limit reached',
                'error_info': 'Upgrade your plan',
                'code': 'feature_capping_deals_limit',
            },
            text='Deal limit reached',
        )
        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'POST', '/deals', body={'title': 'x'})
        assert exc.value.status_code == 403
        assert 'Deal limit reached' in exc.value.message
        assert 'Upgrade your plan' in exc.value.message
        assert exc.value.code == 'feature_capping_deals_limit'
        assert mock_request.call_count == 1  # a plain 403 is not retried

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_success_false_on_200_is_an_error(self, mock_request):
        mock_request.return_value = _resp(
            200, json_data={'success': False, 'error': 'Invalid filter'}, text='Invalid filter'
        )
        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'GET', '/deals')
        assert 'Invalid filter' in exc.value.message

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_non_json_error_falls_back_to_text(self, mock_request):
        mock_request.return_value = _resp(500, text='<html>boom</html>')
        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'GET', '/deals')
        assert 'boom' in exc.value.message

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_transport_failure_raises_value_error(self, mock_request):
        mock_request.side_effect = requests.ConnectionError('dns failure')
        with pytest.raises(ValueError, match='Pipedrive request failed'):
            call(TEST_TOKEN, 'GET', '/deals')

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_transport_failure_names_the_failure_and_the_call(self, mock_request):
        """The message has to stay useful once the exception text is dropped."""
        mock_request.side_effect = requests.ConnectTimeout('timed out')
        with pytest.raises(ValueError) as exc:
            call(TEST_TOKEN, 'GET', '/deals/1')
        assert 'ConnectTimeout' in str(exc.value)
        assert 'GET /deals/1' in str(exc.value)

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_api_token_is_not_in_the_transport_error_or_its_traceback(self, mock_request):
        """A personal token rides in the query string, so requests' exception text
        carries it. Neither the raised message nor a printed traceback may repeat it.
        """
        leaky_url = f'https://api.pipedrive.com/api/v1/deals?api_token={PERSONAL_TOKEN}'
        mock_request.side_effect = requests.ConnectionError(
            f"HTTPSConnectionPool(host='api.pipedrive.com', port=443): "
            f'Max retries exceeded with url: {leaky_url} (Caused by NameResolutionError)'
        )

        with pytest.raises(ValueError) as exc:
            call(PERSONAL_TOKEN, 'GET', '/deals')

        assert PERSONAL_TOKEN not in str(exc.value)
        # `from None` is what this half pins: a chained cause would put the same URL
        # back into any traceback the agent framework logs.
        rendered = ''.join(traceback.format_exception(type(exc.value), exc.value, exc.value.__traceback__))
        assert PERSONAL_TOKEN not in rendered


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


class TestRateLimit:
    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_429_retry_after_is_honoured(self, mock_request, mock_sleep):
        limited = _resp(
            429, json_data={'success': False, 'error': 'rate limit'}, headers={'Retry-After': '5'}, text='rate limit'
        )
        mock_request.side_effect = [limited, limited, _ok({'id': 1})]

        assert call(TEST_TOKEN, 'GET', '/deals/1') == {'id': 1}
        assert mock_request.call_count == 3
        assert mock_sleep.call_count == 2
        mock_sleep.assert_called_with(5.0)

    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_ratelimit_reset_is_seconds_remaining_not_epoch(self, mock_request, mock_sleep):
        """Pipedrive's x-ratelimit-reset counts down; it is not a GitHub-style epoch."""
        limited = _resp(
            429,
            json_data={'success': False, 'error': 'rate limit'},
            headers={'x-ratelimit-reset': '10', 'x-ratelimit-remaining': '0'},
            text='rate limit',
        )
        mock_request.side_effect = [limited, _ok({'id': 1})]

        assert call(TEST_TOKEN, 'GET', '/deals/1') == {'id': 1}
        mock_sleep.assert_called_once_with(10.0)

    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_403_with_rate_limit_markers_is_retried(self, mock_request, mock_sleep):
        limited = _resp(
            403,
            json_data={'success': False, 'error': 'rate limit exceeded'},
            headers={'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2'},
            text='rate limit exceeded',
        )
        mock_request.side_effect = [limited, limited, limited]

        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'GET', '/deals')
        assert exc.value.status_code == 403
        assert mock_request.call_count == 3
        assert mock_sleep.call_count == 2

    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    @pytest.mark.parametrize('bad_value', ['malformed', '-5', 'NaN', 'Inf'])
    def test_malformed_retry_after_falls_back_to_backoff(self, mock_request, mock_sleep, bad_value):
        limited = _resp(
            429,
            json_data={'success': False, 'error': 'rate limit'},
            headers={'Retry-After': bad_value},
            text='rate limit',
        )
        mock_request.side_effect = [limited, _ok({'id': 1})]

        assert call(TEST_TOKEN, 'GET', '/deals/1') == {'id': 1}
        assert mock_sleep.call_count == 1
        assert mock_sleep.call_args[0][0] >= 2.0

    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_excessive_wait_fails_fast_with_hint(self, mock_request, mock_sleep):
        limited = _resp(
            429,
            json_data={'success': False, 'error': 'rate limit'},
            headers={'Retry-After': '3600'},
            text='rate limit',
        )
        mock_request.return_value = limited

        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'GET', '/deals')
        assert exc.value.status_code == 429
        assert 'retry after 3600s' in exc.value.message
        assert mock_request.call_count == 1
        assert mock_sleep.call_count == 0

    @patch('time.sleep')
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_daily_budget_hint(self, mock_request, mock_sleep):
        limited = _resp(
            429,
            json_data={'success': False, 'error': 'rate limit'},
            headers={'x-ratelimit-reset': '99999', 'x-daily-requests-left': '0'},
            text='rate limit',
        )
        mock_request.return_value = limited

        with pytest.raises(PipedriveAPIError) as exc:
            call(TEST_TOKEN, 'GET', '/deals')
        assert 'daily API token budget exhausted' in exc.value.message
        assert mock_sleep.call_count == 0


# ---------------------------------------------------------------------------
# Cleaners
# ---------------------------------------------------------------------------


class TestCleaners:
    def test_clean_deal_flattens_references_and_splits_custom_fields(self):
        custom_key = 'a' * 40
        cleaned = clean_deal(
            {
                'id': 1,
                'title': 'Big deal',
                'value': 1000,
                'person_id': {'value': 5, 'name': 'Ada'},
                'org_id': {'value': 9, 'name': 'Acme'},
                'user_id': {'id': 3, 'name': 'Rep'},
                'creator_user_id': {'id': 3, 'name': 'Rep'},
                custom_key: 'custom value',
                'noise_field': 'dropped',
            }
        )
        assert cleaned['id'] == 1
        assert cleaned['person'] == {'id': 5, 'name': 'Ada'}
        assert cleaned['organization'] == {'id': 9, 'name': 'Acme'}
        assert cleaned['custom_fields'] == {custom_key: 'custom value'}
        assert 'noise_field' not in cleaned

    def test_clean_person_flattens_contacts(self):
        cleaned = clean_person(
            {
                'id': 2,
                'name': 'Ada',
                'email': [{'value': 'ada@example.com', 'primary': True}],
                'phone': [{'value': '+123', 'primary': True}],
                'org_id': {'value': 9, 'name': 'Acme'},
            }
        )
        assert cleaned['emails'] == ['ada@example.com']
        assert cleaned['phones'] == ['+123']
        assert cleaned['organization'] == {'id': 9, 'name': 'Acme'}

    def test_split_custom_fields_only_matches_hex_keys(self):
        assert split_custom_fields({'a' * 40: 1, 'title': 2, 'z' * 40: 3}) == {'a' * 40: 1}


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


class TestArgHelpers:
    def test_paging_clamps_limit(self):
        assert paging_params({'limit': 10_000})['limit'] == MAX_LIMIT
        assert paging_params({'limit': 0})['limit'] == 1
        assert paging_params({'start': -5})['start'] == 0
        assert paging_params({}) == {}

    def test_body_from_omits_missing_and_merges_extra(self):
        custom_key = 'b' * 40
        body = body_from({'title': 'x', 'value': None, 'extra': {custom_key: 'v'}}, ('title', 'value', 'currency'))
        assert body == {'title': 'x', custom_key: 'v'}


# ---------------------------------------------------------------------------
# Tool groups
# ---------------------------------------------------------------------------


class TestToolGroups:
    def test_defaults_when_empty_or_invalid(self):
        assert normalize_groups(None) == DEFAULT_GROUPS
        assert normalize_groups([]) == DEFAULT_GROUPS
        assert normalize_groups(['nonsense']) == DEFAULT_GROUPS
        assert normalize_groups(42) == DEFAULT_GROUPS

    def test_all_sentinel(self):
        assert normalize_groups(['all']) == ALL_GROUPS
        assert normalize_groups('all') == ALL_GROUPS

    def test_comma_separated_string(self):
        assert normalize_groups('deals, leads') == frozenset({'deals', 'leads'})

    def test_unknown_names_are_dropped(self):
        assert normalize_groups(['deals', 'nope']) == frozenset({'deals'})

    def test_pipedrive_tool_rejects_unknown_group(self):
        with pytest.raises(ValueError, match='unknown group'):
            pipedrive_tool(group='not_a_group')


class TestToolPublication:
    def test_defaults_publish_core_groups_only(self):
        published = _instance()._collect_tool_methods()
        assert 'deal_list' in published
        assert 'person_search' in published
        assert 'lead_list' not in published
        assert 'project_task_create' not in published

    def test_all_groups_publish_everything(self):
        published = _instance(tool_groups=ALL_GROUPS)._collect_tool_methods()
        assert 'lead_list' in published
        assert 'webhook_create' in published
        assert 'currency_list' in published

    def test_request_tool_follows_its_own_switch(self):
        assert 'request' in _instance()._collect_tool_methods()
        assert 'request' not in _instance(allow_raw_request=False)._collect_tool_methods()

    def test_every_tool_belongs_to_a_known_group(self):
        untagged = []
        for name in dir(IInstance):
            attr = getattr(IInstance, name, None)
            if attr is None or not hasattr(attr, '__tool_meta__') or name == 'request':
                continue
            group = getattr(attr, '__pipedrive_group__', None)
            if group not in ALL_GROUPS:
                untagged.append(name)
        assert untagged == []

    def test_full_surface_is_large(self):
        """Guards against a mixin silently dropping out of the composition."""
        published = _instance(tool_groups=ALL_GROUPS)._collect_tool_methods()
        assert len(published) > 150


# ---------------------------------------------------------------------------
# Read-only mode
# ---------------------------------------------------------------------------


class TestReadOnly:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_reads_are_allowed(self, mock_request):
        mock_request.return_value = _ok({'id': 1, 'title': 'Deal'})
        assert _instance(read_only=True).deal_get({'deal_id': 1})['id'] == 1

    @pytest.mark.parametrize(
        'tool,args',
        [
            ('deal_create', {'title': 'x'}),
            ('deal_update', {'deal_id': 1, 'title': 'x'}),
            ('deal_delete', {'deal_id': 1}),
            ('person_create', {'name': 'Ada'}),
            ('organization_delete', {'org_id': 1}),
            ('activity_create', {'subject': 'call'}),
            ('note_create', {'content': 'hi'}),
            ('lead_create', {'title': 'x'}),
            ('product_create', {'name': 'x'}),
            ('webhook_delete', {'webhook_id': 1}),
            ('field_delete', {'entity': 'deal', 'field_id': 1}),
            ('project_task_delete', {'task_id': 1}),
        ],
    )
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_writes_are_blocked(self, mock_request, tool, args):
        inst = _instance(read_only=True)
        with pytest.raises(ValueError, match='read-only mode'):
            getattr(inst, tool)(args)
        mock_request.assert_not_called()

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_bulk_delete_is_blocked(self, mock_request):
        with pytest.raises(ValueError, match='read-only mode'):
            _instance(read_only=True).deal_delete_bulk({'ids': [1, 2]})
        mock_request.assert_not_called()

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_bulk_delete_reports_read_only_before_argument_problems(self, mock_request):
        """The write gate runs first: a read-only node has nothing to say about ids."""
        with pytest.raises(ValueError, match='read-only mode'):
            _instance(read_only=True).deal_delete_bulk({})
        mock_request.assert_not_called()


# ---------------------------------------------------------------------------
# Path building
# ---------------------------------------------------------------------------


class TestPathSegments:
    @pytest.mark.parametrize(
        'tool,args,expected',
        [
            ('lead_get', {'lead_id': '../deals/1'}, '/leads/..%2Fdeals%2F1'),
            ('call_log_get', {'call_log_id': 'a/b'}, '/callLogs/a%2Fb'),
            ('permission_set_get', {'permission_set_id': 'x?y=1'}, '/permissionSets/x%3Fy%3D1'),
            ('lead_get', {'lead_id': 'plain-uuid'}, '/leads/plain-uuid'),
        ],
    )
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_string_ids_are_encoded_into_one_segment(self, mock_request, tool, args, expected):
        """An agent-supplied id must not be able to re-target the request."""
        mock_request.return_value = _ok({'id': 1})
        getattr(_instance(), tool)(args)
        assert mock_request.call_args[0][1] == f'{BASE_URL}{expected}'

    @pytest.mark.parametrize('bad_id', ['.', '..', ' .. '])
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_dot_segments_are_rejected_not_encoded(self, mock_request, bad_id):
        """quote() escapes nothing in ".."; it would reach the API and walk up a level."""
        with pytest.raises(ValueError, match='another resource'):
            _instance().lead_get({'lead_id': bad_id})
        mock_request.assert_not_called()


class TestBulkDeleteParams:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_extra_cannot_override_the_validated_ids(self, mock_request):
        """A pass-through "ids" must not replace the list that was validated."""
        mock_request.return_value = _ok({'success': True})
        _instance().deal_delete_bulk({'ids': [1], 'extra': {'ids': '2,3'}})
        assert mock_request.call_args[1]['params']['ids'] == '1'

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_extra_still_passes_other_params_through(self, mock_request):
        mock_request.return_value = _ok({'success': True})
        _instance().deal_delete_bulk({'ids': [1, 2], 'extra': {'force': 1}})
        params = mock_request.call_args[1]['params']
        assert params['ids'] == '1,2'
        assert params['force'] == 1


# ---------------------------------------------------------------------------
# The raw request escape hatch
# ---------------------------------------------------------------------------


class TestRawRequest:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_get_passes_through_and_returns_envelope(self, mock_request):
        mock_request.return_value = _ok([{'id': 1}], additional={'pagination': {'next_start': 10}})
        result = _instance().request({'method': 'get', 'path': '/goals', 'params': {'limit': 1}})
        assert result['data'] == [{'id': 1}]
        assert result['additional_data']['pagination']['next_start'] == 10
        assert mock_request.call_args[0] == ('GET', f'{BASE_URL}/goals')

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_write_blocked_in_read_only(self, mock_request):
        with pytest.raises(ValueError, match='read-only mode'):
            _instance(read_only=True).request({'method': 'POST', 'path': '/goals', 'body': {}})
        mock_request.assert_not_called()

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_get_allowed_in_read_only(self, mock_request):
        mock_request.return_value = _ok({'ok': True})
        assert _instance(read_only=True).request({'method': 'GET', 'path': '/currencies'})['data'] == {'ok': True}

    def test_rejects_full_url(self):
        with pytest.raises(ValueError, match='must be a path'):
            _instance().request({'method': 'GET', 'path': 'https://api.pipedrive.com/api/v1/deals'})

    def test_rejects_unknown_method(self):
        with pytest.raises(ValueError, match='method must be one of'):
            _instance().request({'method': 'TRACE', 'path': '/deals'})

    def test_rejects_non_object_body(self):
        with pytest.raises(ValueError, match='"body" must be an object'):
            _instance().request({'method': 'POST', 'path': '/deals', 'body': 'oops'})


# ---------------------------------------------------------------------------
# A few representative request shapes
# ---------------------------------------------------------------------------


class TestRequestShapes:
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_deal_list_sends_filters_and_paging(self, mock_request):
        mock_request.return_value = _ok(
            [{'id': 1, 'title': 'Deal'}],
            additional={'pagination': {'more_items_in_collection': True, 'next_start': 50}},
        )
        result = _instance().deal_list({'status': 'open', 'limit': 50, 'start': 0, 'user_id': 3})

        params = mock_request.call_args[1]['params']
        assert params['status'] == 'open'
        assert params['limit'] == 50
        assert params['start'] == 0
        assert params['user_id'] == 3
        assert result['items'][0]['title'] == 'Deal'
        assert result['next_start'] == 50

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_person_create_expands_plain_email_strings(self, mock_request):
        mock_request.return_value = _ok({'id': 2, 'name': 'Ada'})
        _instance().person_create({'name': 'Ada', 'email': ['ada@example.com', 'a2@example.com']})

        body = mock_request.call_args[1]['json']
        assert body['email'] == [
            {'value': 'ada@example.com', 'primary': True},
            {'value': 'a2@example.com', 'primary': False},
        ]

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_search_unwraps_items(self, mock_request):
        mock_request.return_value = _ok({'items': [{'result_score': 0.9, 'item': {'id': 4, 'title': 'Acme deal'}}]})
        result = _instance().deal_search({'term': 'acme'})
        assert result['items'] == [{'id': 4, 'title': 'Acme deal', 'result_score': 0.9}]

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_field_entity_selects_the_endpoint(self, mock_request):
        mock_request.return_value = _ok([])
        _instance(tool_groups=ALL_GROUPS).field_list({'entity': 'organization'})
        assert mock_request.call_args[0][1] == f'{BASE_URL}/organizationFields'

    def test_field_entity_is_validated(self):
        with pytest.raises(ValueError, match='must be one of'):
            _instance(tool_groups=ALL_GROUPS).field_list({'entity': 'spaceship'})

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_goal_find_uses_dotted_query_keys(self, mock_request):
        mock_request.return_value = _ok({'goals': []})
        _instance(tool_groups=ALL_GROUPS).goal_find({'assignee_id': 1, 'assignee_type': 'person'})
        params = mock_request.call_args[1]['params']
        assert params['assignee.id'] == 1
        assert params['assignee.type'] == 'person'
        assert 'assignee_id' not in params

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_project_list_uses_cursor_pagination(self, mock_request):
        mock_request.return_value = _ok([{'id': 1, 'title': 'P'}], additional={'next_cursor': 'abc'})
        result = _instance(tool_groups=ALL_GROUPS).project_list({'limit': 10})
        assert result['next_cursor'] == 'abc'
        assert mock_request.call_args[1]['params']['limit'] == 10

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_file_download_returns_base64(self, mock_request):
        mock_request.return_value = _resp(200, json_data={'success': True}, content=b'hello')
        result = _instance(tool_groups=ALL_GROUPS).file_download({'file_id': 1})
        assert result['content_base64'] == 'aGVsbG8='
        assert result['size'] == 5

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_file_create_rejects_bad_base64(self, mock_request):
        with pytest.raises(ValueError, match='not valid base64'):
            _instance(tool_groups=ALL_GROUPS).file_create({'file_name': 'a.txt', 'content_base64': 'not base64!!'})
        mock_request.assert_not_called()


class TestNonDictPayloads:
    """Some endpoints answer with a bare list; the cleaner must not assume a dict."""

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_team_user_add_accepts_list_payload(self, mock_request):
        mock_request.return_value = _ok([1, 2, 3])
        result = _instance(tool_groups=ALL_GROUPS).team_user_add({'team_id': 1, 'users': [2]})
        assert result == [1, 2, 3]

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_note_comment_create_accepts_list_payload(self, mock_request):
        mock_request.return_value = _ok([{'uuid': 'x'}])
        assert _instance().note_comment_create({'note_id': 1, 'content': 'hi'}) == [{'uuid': 'x'}]

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_team_user_delete_sends_form_not_json(self, mock_request):
        mock_request.return_value = _ok(True)
        _instance(tool_groups=ALL_GROUPS).team_user_delete({'team_id': 1, 'users': [2]})
        kwargs = mock_request.call_args[1]
        assert kwargs['data'] == {'users': [2]}
        assert kwargs['json'] is None

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_role_assignment_delete_sends_form_not_json(self, mock_request):
        mock_request.return_value = _ok(True)
        _instance(tool_groups=ALL_GROUPS).role_assignment_delete({'role_id': 1, 'user_id': 2})
        kwargs = mock_request.call_args[1]
        assert kwargs['data'] == {'user_id': 2}
        assert kwargs['json'] is None

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_file_create_sends_multipart(self, mock_request):
        mock_request.return_value = _ok({'id': 5, 'name': 'a.txt'})
        _instance(tool_groups=ALL_GROUPS).file_create(
            {'file_name': 'a.txt', 'content_base64': 'aGVsbG8=', 'deal_id': 3}
        )
        kwargs = mock_request.call_args[1]
        assert kwargs['files']['file'][0] == 'a.txt'
        assert kwargs['files']['file'][1] == b'hello'
        assert kwargs['data'] == {'deal_id': 3}


class TestToolCountGuardRail:
    """The cap counts published tools, warns rather than blocks, and exempts `all`."""

    def test_every_group_has_a_count(self):
        counts = tool_counts_by_group()
        assert set(counts) == ALL_GROUPS
        assert counts['deals'] > counts['permission_sets']  # sizes really are uneven

    def test_published_count_sums_only_selected_groups(self):
        counts = tool_counts_by_group()
        selection = {'deals', 'persons'}
        assert published_tool_count(selection) == counts['deals'] + counts['persons']

    def test_defaults_stay_under_the_limit(self):
        assert published_tool_count(DEFAULT_GROUPS) <= RECOMMENDED_TOOL_LIMIT

    def test_full_surface_exceeds_the_limit(self):
        assert published_tool_count(ALL_GROUPS) > RECOMMENDED_TOOL_LIMIT

    def test_no_warning_for_the_defaults(self):
        assert _oversized_warning(sorted(DEFAULT_GROUPS), DEFAULT_GROUPS) == ''

    def test_warns_when_an_explicit_selection_is_too_large(self):
        msg = _oversized_warning(sorted(ALL_GROUPS), ALL_GROUPS)
        assert str(published_tool_count(ALL_GROUPS)) in msg
        assert str(RECOMMENDED_TOOL_LIMIT) in msg

    @pytest.mark.parametrize('raw', [['all'], 'all', ['*'], ['deals', 'all']])
    def test_all_is_exempt(self, raw):
        assert wants_all_groups(raw) is True
        assert _oversized_warning(raw, ALL_GROUPS) == ''

    def test_listing_every_group_by_name_is_not_exempt(self):
        assert wants_all_groups(sorted(ALL_GROUPS)) is False
        assert _oversized_warning(sorted(ALL_GROUPS), ALL_GROUPS) != ''

    def test_warning_never_reduces_the_published_tools(self):
        """The guard rail is advisory: an oversized selection still publishes everything."""
        published = _instance(tool_groups=ALL_GROUPS)._collect_tool_methods()
        assert len(published) > RECOMMENDED_TOOL_LIMIT


_MANIFEST = json.loads(
    (Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_pipedrive' / 'services.json').read_text(
        encoding='utf-8'
    )
)


class TestToolGroupsField:
    """The manifest drives the config panel; it must not drift from the code.

    The field renders as a multi-select dropdown only when it is an array with
    `uniqueItems: true` and an `items.enum` — RJSF falls back to free-text
    add/remove inputs without them. It must also carry no `ui:widget` override,
    since `checkboxes` would switch the same schema to a checkbox list.
    """

    field = _MANIFEST['fields']['pipedrive.toolGroups']

    def test_renders_as_a_multi_select_dropdown(self):
        assert self.field['type'] == 'array'
        assert self.field['uniqueItems'] is True
        assert self.field['items']['type'] == 'string'

    def test_no_widget_override(self):
        """RJSF defaults an enum array to SelectWidget; any override changes the control."""
        assert 'ui' not in self.field

    def test_every_implemented_group_is_selectable(self):
        values = {option[0] for option in self.field['items']['enum']}
        assert ALL_GROUPS <= values

    def test_no_option_is_an_unknown_group(self):
        values = {option[0] for option in self.field['items']['enum']}
        assert values - ALL_GROUPS == {'all'}, 'only the "all" sentinel may sit outside ALL_GROUPS'

    def test_options_are_unique(self):
        values = [option[0] for option in self.field['items']['enum']]
        assert len(values) == len(set(values))

    def test_labels_carry_the_real_tool_counts(self):
        labels = {option[0]: option[1] for option in self.field['items']['enum']}
        for group, count in tool_counts_by_group().items():
            assert f'({count})' in labels[group], f'{group} label is stale: {labels[group]}'

    def test_default_selection_matches_the_code_default(self):
        assert set(self.field['default']) == DEFAULT_GROUPS

    def test_all_option_advertises_the_full_surface(self):
        labels = {option[0]: option[1] for option in self.field['items']['enum']}
        total = sum(tool_counts_by_group().values()) + 1  # + the request escape hatch
        assert str(total) in labels['all']


class TestSearchUsesApiV2:
    """Pipedrive retired the v1 search routes, and only those routes.

    v1 answered ``/persons/search`` and its siblings with 404 ``Unknown method .``
    (the resource still exists, the action does not) and ``/itemSearch`` with a
    plain 404 ``Not Found``. Every non-search v1 endpoint kept working, so the fix
    is scoped to search — a blanket swap would break the many endpoints that have
    no v2 equivalent.
    """

    @pytest.mark.parametrize(
        ('tool', 'args', 'path'),
        [
            ('person_search', {'term': 'ada'}, '/persons/search'),
            ('organization_search', {'term': 'acme'}, '/organizations/search'),
            ('deal_search', {'term': 'acme'}, '/deals/search'),
            ('lead_search', {'term': 'acme'}, '/leads/search'),
            ('product_search', {'term': 'widget'}, '/products/search'),
            ('item_search', {'term': 'acme'}, '/itemSearch'),
            ('lookup', {'term': 'acme'}, '/itemSearch'),
        ],
    )
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_search_tools_target_v2(self, mock_request, tool, args, path):
        mock_request.return_value = _ok({'items': []})
        getattr(_instance(tool_groups=ALL_GROUPS), tool)(args)
        assert mock_request.call_args[0][1] == f'{BASE_URL_V2}{path}'

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_item_search_by_field_targets_v2(self, mock_request):
        mock_request.return_value = _ok([])
        _instance(tool_groups=ALL_GROUPS).item_search_by_field(
            {'term': 'acme', 'entity_type': 'person', 'field_key': 'name'}
        )
        assert mock_request.call_args[0][1] == f'{BASE_URL_V2}/itemSearch/field'

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_item_search_by_field_uses_the_v2_parameter_names(self, mock_request):
        """v2 renamed ``field_type`` to ``entity_type`` and replaced the ``exact_match`` flag with ``match``."""
        mock_request.return_value = _ok([])
        _instance(tool_groups=ALL_GROUPS).item_search_by_field(
            {'term': 'acme', 'entity_type': 'person', 'field_key': 'name', 'match': 'beginning'}
        )
        params = mock_request.call_args[1]['params']
        assert params['entity_type'] == 'person'
        assert params['field_key'] == 'name'
        assert params['match'] == 'beginning'
        assert 'field_type' not in params
        assert 'exact_match' not in params

    @pytest.mark.parametrize(
        ('tool', 'args', 'path'),
        [
            ('organization_list', {}, '/organizations'),
            ('person_list', {}, '/persons'),
            ('deal_list', {}, '/deals'),
            ('recents_list', {'since_timestamp': '2026-07-16 00:00:00'}, '/recents'),
        ],
    )
    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_non_search_tools_stay_on_v1(self, mock_request, tool, args, path):
        """Guards against an accidental global version swap."""
        mock_request.return_value = _ok([])
        getattr(_instance(tool_groups=ALL_GROUPS), tool)(args)
        assert mock_request.call_args[0][1] == f'{BASE_URL}{path}'

    def test_v2_base_url_defaults_to_the_generic_host(self):
        assert base_url_v2_for('') == BASE_URL_V2
        assert base_url_v2_for(None) == BASE_URL_V2

    @pytest.mark.parametrize('domain', ['acme', 'acme.pipedrive.com', 'https://acme.pipedrive.com/'])
    def test_v2_base_url_normalises_the_company_domain(self, domain):
        assert base_url_v2_for(domain) == 'https://acme.pipedrive.com/api/v2'

    def test_both_versions_address_the_same_company(self):
        """A domain that resolves differently per version would split one account in two."""
        assert base_url_for('acme').rsplit('/', 1)[0] == base_url_v2_for('acme').rsplit('/', 1)[0]


class TestCursorPagination:
    """v2 replaced v1's numeric offset with an opaque cursor.

    Running a v2 response through the v1 :func:`paginated` would read the absent
    ``additional_data.pagination`` key, report a single page, and silently hide
    every result after the first — hence the separate helpers.
    """

    def test_paging_params_v2_never_sends_start(self):
        assert 'start' not in paging_params_v2({'start': 40, 'limit': 10})

    def test_paging_params_v2_passes_the_cursor_through_trimmed(self):
        assert paging_params_v2({'cursor': ' abc123 '})['cursor'] == 'abc123'

    def test_paging_params_v2_omits_a_blank_cursor(self):
        assert 'cursor' not in paging_params_v2({'cursor': '   '})
        assert 'cursor' not in paging_params_v2({})

    def test_paging_params_v2_clamps_limit(self):
        assert paging_params_v2({'limit': MAX_LIMIT + 1})['limit'] == MAX_LIMIT
        assert paging_params_v2({'limit': 0})['limit'] == 1

    def test_paginated_v2_surfaces_next_cursor(self):
        out = paginated_v2({'additional_data': {'next_cursor': 'abc'}}, [1, 2])
        assert out['next_cursor'] == 'abc'
        assert out['count'] == 2
        assert out['more_items_in_collection'] is True
        assert 'next_start' not in out

    def test_paginated_v2_reports_the_last_page(self):
        out = paginated_v2({'additional_data': {'next_cursor': None}}, [1])
        assert out['next_cursor'] is None
        assert out['more_items_in_collection'] is False

    def test_paginated_v2_tolerates_a_missing_envelope(self):
        out = paginated_v2(None, [])
        assert out == {'items': [], 'count': 0, 'more_items_in_collection': False, 'next_cursor': None}

    def test_v2_schema_advertises_cursor_and_v1_still_advertises_start(self):
        """The schema is rendered verbatim into the agent prompt, so the wrong key invites dead calls."""
        assert 'cursor' in PAGING_V2()
        assert 'start' not in PAGING_V2()
        assert 'start' in PAGING()
        assert 'cursor' not in PAGING()

    @patch('tool_pipedrive.pipedrive_client.requests.request')
    def test_a_search_round_trips_the_cursor(self, mock_request):
        mock_request.return_value = _ok({'items': []}, additional={'next_cursor': 'page2'})
        result = _instance().person_search({'term': 'ada', 'cursor': 'page1'})
        assert mock_request.call_args[1]['params']['cursor'] == 'page1'
        assert result['next_cursor'] == 'page2'


# ---------------------------------------------------------------------------
# Every field that carries a time of day names its zone
# ---------------------------------------------------------------------------
# THE BUG THIS PINS. `due_time` was documented as 'Due time, HH:MM.' and nothing
# more. Pipedrive stores it as UTC and renders it in each viewer's own zone, so a
# meeting asked for at 12:30 in California was written as "12:30" and shown back
# to the person who asked for it as 05:30. Nothing rejected it — a wrong hour
# looks exactly like a right one.
#
# A model cannot infer a field's zone. It reads the description, and where the
# description is silent it writes the words the person said.
#
# The same audit runs against `tool_gohighlevel`, which was already keeping this
# rule when Pipedrive was not. Two CRMs, two different correct answers, one
# obligation — which is what makes this the CRM-agnostic half of the fix.


class TestEveryTimeFieldNamesItsZone:
    #: A LENGTH, not an instant. "A two-hour meeting" is 02:00 in every zone
    #: there is, and converting it would turn a duration into a wrong duration.
    #: Exempt by decision rather than by the matcher missing it.
    ALLOWED = ('duration',)

    def test_no_published_parameter_describes_a_time_without_saying_which_zone(self):
        assert audit_time_fields(IInstance, self.ALLOWED) == []

    def test_the_audit_can_actually_fail(self):
        """
        The guard on the guard.

        A matcher that silently stopped matching would leave the test above
        passing for ever while saying nothing, which is the failure mode of
        every audit written against a live surface.
        """

        class Silent:
            def book(self):
                pass

            book.__tool_meta__ = {'input_schema': {'properties': {'due_time': {'description': 'Due time, HH:MM.'}}}}

        assert audit_time_fields(Silent) == ['book.due_time']
