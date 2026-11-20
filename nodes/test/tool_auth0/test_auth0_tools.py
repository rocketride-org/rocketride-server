# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the read-only agent-tool contracts and denied writes."""

import json
import importlib.util
import sys
import types
from unittest.mock import Mock

import pytest

import test_configuration

node = test_configuration.node


@pytest.fixture
def tool(node):
    package, _, _, _ = node
    client = Mock()
    instance = package.IInstance()
    instance.IGlobal = types.SimpleNamespace(client=client)
    return instance, client, sys.modules[package.__name__ + '.auth0_client']


@pytest.fixture
def dispatched_tool(tool, monkeypatch):
    """Use RocketRide's actual dispatch implementation with isolated engine types."""
    instance, client, _ = tool
    root = test_configuration.NODE.parents[3]
    path = root / 'packages/server/engine-lib/rocketlib-python/lib/rocketlib/filters.py'
    package = types.ModuleType('auth0_dispatch_rocketlib')
    package.__path__ = [str(path.parent)]
    fake_types = types.ModuleType(package.__name__ + '.types')
    for name in ('AVI_ACTION', 'OPEN_MODE', 'ENDPOINT_MODE', 'SERVICE_MODE', 'Entry', 'IControl', 'IInvoke', 'IJson'):
        setattr(fake_types, name, type(name, (), {}))
    fake_error = types.ModuleType(package.__name__ + '.error')
    fake_error.APERR = type('APERR', (Exception,), {})
    fake_error.Ec = types.SimpleNamespace(PreventDefault='PreventDefault', InvalidParam='InvalidParam')
    engine = types.ModuleType('engLib')
    engine.IFilterInstance = type('IFilterInstance', (), {})
    monkeypatch.setitem(sys.modules, 'engLib', engine)
    for module in (package, fake_types, fake_error):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    spec = importlib.util.spec_from_file_location(package.__name__ + '.filters', path)
    filters = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, filters)
    spec.loader.exec_module(filters)

    class DispatchInstance(type(instance), filters.IInstanceBase):
        """Combine the node with the actual RocketRide dispatcher."""

    combined = DispatchInstance()
    combined.IGlobal = instance.IGlobal
    return combined, client


@pytest.mark.parametrize(
    'method',
    [
        'search_users',
        'get_user',
        'get_user_logs',
        'get_log_event',
        'get_user_blocks',
    ],
)
@pytest.mark.parametrize('payload', ['not-json', '[]', 'null', [], 1, None, {'input': []}, {'unexpected': 1}])
def test_dispatch_rejects_invalid_input_without_api(dispatched_tool, method, payload):
    """Reject invalid tool.invoke payloads before any client call."""
    instance, client = dispatched_tool
    result = instance._dispatch_tool({'tool_name': method, 'input': payload}, 'tool.invoke')
    assert result['output']['error_code'] == 'INVALID_INPUT'
    client.request.assert_not_called()


@pytest.mark.parametrize(
    'payload',
    [
        {'user_id': 'id'},
        '{"user_id": "id"}',
        {'input': {'user_id': 'id'}},
        {'input': {'user_id': 'id'}, 'security_context': {}},
    ],
)
def test_dispatch_accepts_valid_input_forms(dispatched_tool, payload):
    """Accept plain objects, JSON objects, and dispatcher envelopes."""
    instance, client = dispatched_tool
    client.request.return_value = []
    result = instance._dispatch_tool({'tool_name': 'get_user_logs', 'input': payload}, 'tool.invoke')
    assert result['output'] == {'success': True, 'events': [], 'count': 0}


def test_dispatch_accepts_model_input(dispatched_tool):
    """Accept dispatcher objects that expose model_dump."""
    instance, client = dispatched_tool
    client.request.return_value = []
    model = types.SimpleNamespace(model_dump=lambda: {'user_id': 'id', 'limit': 1})
    result = instance._dispatch_tool({'tool_name': 'get_user_logs', 'input': model}, 'tool.invoke')
    assert result['output']['success'] is True
    client.request.assert_called_once_with(
        'get_user_logs', identifier='id', params={'page': 0, 'per_page': 1, 'sort': 'date:-1'}
    )


@pytest.mark.parametrize(
    'method,args',
    [
        ('search_users', {'email': 'a@example.com'}),
        ('get_user', {'user_id': 'id'}),
        ('get_user_logs', {'user_id': 'id'}),
        ('get_log_event', {'log_id': 'id'}),
        ('get_user_blocks', {'user_id': 'id'}),
    ],
)
def test_dispatch_rejects_extra_fields(dispatched_tool, method, args):
    """Enforce closed schemas even with otherwise valid arguments."""
    instance, client = dispatched_tool
    result = instance._dispatch_tool({'tool_name': method, 'input': {**args, 'extra': True}}, 'tool.invoke')
    assert result['output']['error_code'] == 'INVALID_INPUT'
    client.request.assert_not_called()


def test_registered_schemas(tool):
    instance, _, _ = tool
    names = {
        'search_users',
        'get_user',
        'get_user_logs',
        'get_log_event',
        'get_user_blocks',
    }
    registered = {name for name in dir(instance) if hasattr(getattr(instance, name), '__tool_meta__')}
    assert registered == names
    for name in names:
        meta = getattr(instance, name).__tool_meta__
        assert meta['input_schema']['required'] and meta['output_schema']['properties']['success']
        assert meta['description']


@pytest.mark.parametrize(
    'identities',
    [
        [{}] * 101,
        {},
        [None],
        [{'connection': 'x' * 301}],
        [{'connection': 'bad\u200bname'}],
        [{'connection': {'name': 'db'}}],
    ],
)
def test_unsafe_identity_connections_rejected(tool, identities):
    """Reject malformed or oversized user identity connection data."""
    instance, client, _ = tool
    client.request.return_value = {'identities': identities}
    assert instance.get_user({'user_id': 'id'})['error_code'] == 'API_ERROR'


def test_legitimate_identity_connection_names_preserved(tool):
    """Preserve valid connection names without shortening them."""
    instance, client, _ = tool
    name = 'Username-Password-Authentication'
    client.request.return_value = {'identities': [{'connection': name}]}
    assert instance.get_user({'user_id': 'id'})['connections'] == [name]


def test_search_uses_case_sensitive_email_and_limits_sanitized_matches(tool):
    instance, client, _ = tool
    client.request.return_value = [
        {'user_id': '2', 'email': 'jane+tag@example.com'},
        {'user_id': '1', 'email': 'Jane+tag@EXAMPLE.COM', 'name': 'Jane', 'email_verified': True, 'secret': 'hidden'},
        {'user_id': '3', 'email': 'Jane+tag@EXAMPLE.COM'},
    ]
    result = instance.search_users({'input': {'email': 'Jane+tag@EXAMPLE.COM', 'limit': 1}})
    assert result == {
        'success': True,
        'users': [{'user_id': '1', 'email': 'Jane+tag@EXAMPLE.COM', 'name': 'Jane', 'email_verified': True}],
        'count': 1,
    }
    client.request.assert_called_once_with(
        'search_users',
        params={
            'email': 'Jane+tag@EXAMPLE.COM',
            'fields': 'user_id,email,name,email_verified',
            'include_fields': 'true',
        },
    )
    client.request.return_value = []
    assert instance.search_users({'email': 'nobody@example.com'}) == {'success': True, 'users': [], 'count': 0}


@pytest.mark.parametrize(
    'args',
    [
        {'email': '" OR *:*'},
        {'email': 'a@b.com', 'limit': True},
        {'email': 'a@b.com', 'limit': 21},
        {'email': 'a..b@example.com'},
        {'email': 'x' * 255},
        {},
    ],
)
def test_invalid_search_never_calls_api(tool, args):
    instance, client, _ = tool
    result = instance.search_users(args)
    assert result['success'] is False and result['error_code'] == 'INVALID_INPUT'
    client.request.assert_not_called()


def test_user_fields_and_admin_block_default(tool):
    instance, client, _ = tool
    client.request.return_value = {
        'user_id': 'u',
        'identities': [{'connection': 'db', 'access_token': 'secret'}],
        'app_metadata': {'secret': 'secret'},
        'last_ip': '192.0.2.1',
    }
    result = instance.get_user(json.dumps({'user_id': 'u'}))
    assert result == {
        'success': True,
        'user_id': 'u',
        'email': None,
        'name': None,
        'email_verified': None,
        'blocked': False,
        'last_login': None,
        'logins_count': None,
        'connections': ['db'],
    }
    assert 'secret' not in str(result) and '192.0.2.1' not in str(result)
    client.request.assert_called_once_with(
        'get_user',
        identifier='u',
        params={
            'fields': 'user_id,email,name,email_verified,blocked,last_login,logins_count,identities',
            'include_fields': 'true',
        },
    )


def test_logs_are_bounded_and_derived_from_allowlist(tool):
    instance, client, _ = tool
    client.request.return_value = [
        {
            'log_id': 'l1',
            'type': 'fp',
            'date': '2026-01-01T00:00:00Z',
            'description': 'password secret 192.0.2.1',
            'ip': '192.0.2.1',
        },
        {'log_id': 'l2', 'type': 'unknown', 'description': 'instructions and secret'},
    ]
    result = instance.get_user_logs({'user_id': 'u', 'limit': 2})
    assert (
        result['count'] == 2 and result['events'][0]['description'] == 'Login failed because the password was invalid.'
    )
    assert 'secret' not in str(result) and '192.0.2.1' not in str(result)
    assert client.request.call_args.kwargs['params'] == {'page': 0, 'per_page': 2, 'sort': 'date:-1'}
    client.request.return_value = {
        'log_id': 'l',
        'type': 'unknown',
        'description': 'secret',
        'details': {'ip': '1.2.3.4'},
    }
    detail = instance.get_log_event({'log_id': 'l'})
    assert detail['diagnostics'] == 'No specific diagnostic is available for this event type.'
    assert 'secret' not in str(detail) and '1.2.3.4' not in str(detail)


def test_suspect_fields_are_omitted_from_logs(tool):
    instance, client, _ = tool
    client.request.return_value = {
        'log_id': 'l1',
        'type': 'limit_wc',
        'connection': 'db 192.0.2.1',
        'client_name': 'Bearer sensitive-token',
        'user_id': '2001:db8::1',
    }
    result = instance.get_log_event({'log_id': 'l1'})
    assert result['connection'] is None and result['client_name'] is None and result['user_id'] is None
    assert '192.0.2.1' not in str(result) and 'sensitive-token' not in str(result)


@pytest.mark.parametrize(
    'value,expected',
    [
        ('client:192.0.2.1', None),
        ('client 192.0.2.1', None),
        ('client 2001:db8::1', None),
        ('client:auth0:login', 'client:auth0:login'),
    ],
)
def test_log_fields_remove_ip_addresses_but_preserve_benign_colons(tool, value, expected):
    """Prevent IP addresses in exposed log fields while keeping harmless colon text."""
    instance, client, _ = tool
    client.request.return_value = {'type': 'f', 'client_name': value, 'connection': value, 'user_id': value}
    result = instance.get_log_event({'log_id': 'l1'})
    assert result['client_name'] == result['connection'] == result['user_id'] == expected
    if expected is None:
        assert value not in str(result)


def test_user_logs_maximum_is_enforced(tool):
    instance, client, _ = tool
    client.request.return_value = [{'log_id': str(i), 'type': 'f'} for i in range(60)]
    result = instance.get_user_logs({'user_id': 'u', 'limit': 50})
    assert result['count'] == 50 and len(result['events']) == 50
    assert client.request.call_args.kwargs['params']['per_page'] == 50
    client.request.reset_mock()
    assert instance.get_user_logs({'user_id': 'u', 'limit': 51})['error_code'] == 'INVALID_INPUT'
    client.request.assert_not_called()


@pytest.mark.parametrize('code', ['f', 'fp', 'fu', 'limit_wc', 'limit_sul', 'limit_mu'])
def test_recognized_event_diagnostics_are_allowlisted(tool, code):
    instance, client, _ = tool
    client.request.return_value = {'log_id': '1', 'type': code, 'description': 'private raw event'}
    result = instance.get_log_event({'log_id': '1'})
    assert result['success'] and result['diagnostics'] != 'No specific diagnostic is available for this event type.'
    assert 'private raw event' not in str(result)


def test_blocks_and_unblock_is_unavailable(tool):
    instance, client, _ = tool
    block = {'identifier': '192.0.2.1', 'ip': '192.0.2.1', 'connection': 'db'}
    client.request.return_value = {'blocked_for': [block]}
    result = instance.get_user_blocks({'user_id': 'u'})
    assert result == {
        'success': True,
        'has_blocks': True,
        'block_count': 1,
        'blocks': [{'identifier': '[REDACTED]', 'connection': 'db'}],
    }
    assert client.request.call_args.kwargs['params'] == {'consider_brute_force_enablement': 'true'}


@pytest.mark.parametrize(
    'method,key',
    [
        ('get_user', 'user_id'),
        ('get_user_logs', 'user_id'),
        ('get_user_blocks', 'user_id'),
        ('get_log_event', 'log_id'),
    ],
)
def test_id_validation_and_flat_errors(tool, method, key):
    instance, client, module = tool
    for value in ('', 'x' * 301, None, 42):
        result = getattr(instance, method)({key: value})
        assert result == {
            'success': False,
            'error': f'{key} must be a nonempty string of at most 300 characters.',
            'error_code': 'INVALID_INPUT',
            'retryable': False,
            'retry_after_seconds': None,
        }
    client.request.assert_not_called()
    client.request.side_effect = module.Auth0Error(
        'RATE_LIMITED', 'Rate limited.', retryable=True, retry_after_seconds=3
    )
    result = getattr(instance, method)({key: 'id'})
    assert result == {
        'success': False,
        'error': 'Rate limited.',
        'error_code': 'RATE_LIMITED',
        'retryable': True,
        'retry_after_seconds': 3,
    }


@pytest.mark.parametrize('value', ['Username-Password-Authentication', 'Passwordless-Login', 'Customer Token Portal'])
def test_legitimate_log_names_are_preserved(tool, value):
    instance, client, _ = tool
    client.request.return_value = {'type': 'f', 'connection': value, 'client_name': value}
    result = instance.get_log_event({'log_id': 'l'})
    assert result['connection'] == value and result['client_name'] == value


@pytest.mark.parametrize(
    'value', ['password=private', 'Bearer abcdef', 'secret: value', 'bad\x7fvalue', 'bad\u202evalue', 'x' * 301]
)
def test_credential_and_control_log_values_are_removed(tool, value):
    instance, client, _ = tool
    client.request.return_value = {'type': 'f', 'connection': value, 'client_name': value}
    result = instance.get_log_event({'log_id': 'l'})
    assert result['connection'] is None and result['client_name'] is None


def test_profile_fields_are_bounded_and_control_characters_removed(tool):
    instance, client, _ = tool
    client.request.return_value = {'name': 'A\n\u202e' + 'x' * 301, 'email': 'a\x00' + 'b' * 300}
    result = instance.get_user({'user_id': 'u'})
    assert result['name'] == 'A' + 'x' * 299
    assert result['email'] == 'a' + 'b' * 253


def test_tool_after_global_close_returns_structured_error(tool):
    instance, _, _ = tool
    instance.IGlobal.client = None
    result = instance.get_user({'user_id': 'u'})
    assert result['error_code'] == 'CLIENT_CLOSED'
