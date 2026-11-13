# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Mocked Auth0 client security and request behavior."""

import sys
import types
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

import test_configuration

node = test_configuration.node


def response(status=200, body=None, headers=None):
    result = Mock(status_code=status, headers=headers or {}, content=b'json')
    result.json.return_value = body if body is not None else {}
    return result


@pytest.fixture
def client(node, monkeypatch):
    package, _, _, _ = node
    module = sys.modules[package.__name__ + '.auth0_client']
    requests = types.ModuleType('requests')
    requests.exceptions = types.SimpleNamespace(RequestException=Exception)
    requests.post = Mock(
        side_effect=lambda url, **kw: response(
            body={'access_token': kw['json']['client_id'] + '-token', 'expires_in': 3600}
        )
    )
    requests.request = Mock(return_value=response(body={'ok': True}))
    monkeypatch.setitem(sys.modules, 'requests', requests)
    monkeypatch.setattr(module.time, 'sleep', Mock())
    cfg = {
        'domain': 'tenant.us.auth0.com',
        'clientId': 'read',
        'clientSecret': 'read-secret',
        'allowWrite': True,
        'writeClientId': 'write',
        'writeClientSecret': 'write-secret',
    }
    return module, module.Auth0Client(cfg), requests, cfg


@pytest.mark.parametrize(
    'domain',
    [
        'auth0.com',
        'evil-auth0.com',
        'auth0.com.evil.net',
        'localhost',
        '127.0.0.1',
        'tenant.auth0.com:443',
        'tenant.auth0.com/path',
        'tenant.auth0.com?x=1',
        'tenant.auth0.com#x',
        'user@tenant.auth0.com',
        '-bad.auth0.com',
        'bad-.auth0.com',
        'a..auth0.com',
        'a' * 64 + '.auth0.com',
    ],
)
def test_rejects_unsafe_domains(client, domain):
    module, _, requests, cfg = client
    cfg['domain'] = domain
    with pytest.raises(module.Auth0Error) as error:
        module.Auth0Client(cfg)
    assert error.value.code == 'INVALID_DOMAIN'
    requests.post.assert_not_called()


def test_independent_tokens_reuse_and_concurrency(client):
    _, auth, requests, _ = client
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: auth.request('get_user', identifier='auth0|1'), range(30)))
    auth.request('unblock_user', identifier='auth0|1')
    auth.request('get_user', identifier='auth0|1')
    assert requests.post.call_count == 2
    assert requests.post.call_args_list[0].kwargs['json']['client_id'] == 'read'
    assert requests.post.call_args_list[1].kwargs['json']['client_id'] == 'write'
    assert requests.request.call_args_list[-2].kwargs['headers']['Authorization'] == 'Bearer write-token'
    assert requests.request.call_args.kwargs['headers']['Authorization'] == 'Bearer read-token'
    assert all(
        call.kwargs['allow_redirects'] is False
        for call in requests.post.call_args_list + requests.request.call_args_list
    )
    auth.close()
    assert auth._tokens == {'read': None, 'write': None} and auth._config == {}


def test_expiry_and_401_refresh(client, monkeypatch):
    module, auth, requests, _ = client
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    auth.request('get_user', identifier='1')
    clock[0] += 3600
    auth.request('get_user', identifier='1')
    assert requests.post.call_count == 2
    requests.request.side_effect = [response(401), response(200)]
    auth.request('get_user', identifier='1')
    assert requests.post.call_count == 3
    requests.request.side_effect = [response(401), response(401)]
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'AUTHENTICATION_FAILED'


@pytest.mark.parametrize('status', [401, 429, 500])
def test_writes_never_replayed(client, status):
    module, auth, requests, _ = client
    requests.request.return_value = response(status)
    with pytest.raises(module.Auth0Error):
        auth.request('unblock_user', identifier='1')
    assert requests.request.call_count == 1


def test_retry_budget_and_error_sanitization(client):
    module, auth, requests, _ = client
    requests.request.side_effect = [response(429, headers={'Retry-After': '3'}), response(503), response(503)]
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'AUTH0_UNAVAILABLE'
    assert module.time.sleep.call_count == 2
    assert sum(call.args[0] for call in module.time.sleep.call_args_list) <= 10
    requests.request.side_effect = None
    requests.request.return_value = response(403, {'error': 'other', 'message': 'read-secret'})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'API_ERROR' and 'read-secret' not in str(error.value)
    requests.request.return_value = response(403, {'error': 'insufficient_scope'})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'MISSING_SCOPE'


def test_disabled_writes_and_route_restrictions(client):
    module, _, requests, cfg = client
    cfg['allowWrite'] = False
    auth = module.Auth0Client(cfg)
    for operation, identifier in [('unblock_user', '1'), ('https://evil.test', None), ('get_user', '..')]:
        with pytest.raises(module.Auth0Error):
            auth.request(operation, identifier=identifier)
    requests.post.assert_not_called()


def test_write_connection_failure_is_not_replayed(client):
    module, auth, requests, _ = client
    requests.request.side_effect = Exception('sensitive details')
    with pytest.raises(module.Auth0Error) as error:
        auth.request('unblock_user', identifier='1')
    assert requests.request.call_count == 1
    assert error.value.retryable is False and 'sensitive' not in str(error.value)


def test_large_retry_after_is_not_shortened(client):
    module, auth, requests, _ = client
    requests.request.return_value = response(429, headers={'Retry-After': '30'})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert requests.request.call_count == 1
    assert error.value.retry_after_seconds == 30
    module.time.sleep.assert_not_called()


def test_invalid_oauth_response_and_credential_sanitization(client):
    module, auth, requests, _ = client
    requests.post.side_effect = None
    requests.post.return_value = response(200, {'access_token': 'private-token', 'expires_in': None})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'AUTHENTICATION_FAILED' and 'private-token' not in str(error.value)
    requests.request.assert_not_called()


def test_encoded_identifiers_and_fixed_host(client):
    _, auth, requests, _ = client
    auth.request('get_user', identifier='auth0|one/two')
    assert requests.request.call_args.args[1] == 'https://tenant.us.auth0.com/api/v2/users/auth0%7Cone%2Ftwo'


@pytest.mark.parametrize('domain', ['', ' ', 'https://id:secret@tenant.auth0.com', '.auth0.com'])
def test_invalid_domain_configuration_never_connects(client, domain):
    module, _, requests, cfg = client
    cfg['domain'] = domain
    with pytest.raises(ValueError):
        module.Auth0Client(cfg)
    requests.post.assert_not_called()
    requests.request.assert_not_called()


@pytest.mark.parametrize('status', [400, 401, 403, 302])
def test_oauth_failure_never_exposes_credentials(client, status):
    module, auth, requests, _ = client
    requests.post.side_effect = None
    requests.post.return_value = response(status, {'error_description': 'read-secret'})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'AUTHENTICATION_FAILED'
    assert 'read-secret' not in str(error.value)
    requests.request.assert_not_called()
    assert requests.post.call_args.kwargs['allow_redirects'] is False


def test_token_grant_and_early_refresh(client, monkeypatch):
    module, auth, requests, _ = client
    now = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    auth.request('get_user', identifier='1')
    assert requests.post.call_args.args == ('https://tenant.us.auth0.com/oauth/token',)
    assert requests.post.call_args.kwargs['json'] == {
        'grant_type': 'client_credentials',
        'client_id': 'read',
        'client_secret': 'read-secret',
        'audience': 'https://tenant.us.auth0.com/api/v2/',
    }
    now[0] += 3539
    auth.request('get_user', identifier='1')
    assert requests.post.call_count == 1
    now[0] += 2
    auth.request('get_user', identifier='1')
    assert requests.post.call_count == 2


def test_non_json_and_empty_responses(client):
    module, auth, requests, _ = client
    invalid = response(200)
    invalid.json.side_effect = ValueError('sensitive response')
    requests.request.return_value = invalid
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'API_ERROR' and 'sensitive' not in str(error.value)
    requests.request.return_value = response(204)
    assert auth.request('get_user', identifier='1') == {}


@pytest.mark.parametrize('operation', ['get_user', 'unblock_user'])
def test_transport_errors_are_sanitized_and_not_replayed(client, operation):
    module, auth, requests, _ = client
    requests.request.side_effect = Exception('credential=read-secret token=private-token')
    with pytest.raises(module.Auth0Error) as error:
        auth.request(operation, identifier='1')
    assert error.value.code == 'AUTH0_UNAVAILABLE'
    assert error.value.retryable is (operation == 'get_user')
    assert 'read-secret' not in str(error.value) and 'private-token' not in str(error.value)
    assert requests.request.call_count == 1


@pytest.mark.parametrize(
    'operation',
    [
        'search_users',
        'get_user',
        'get_user_logs',
        'get_log_event',
        'get_user_blocks',
        'get_connection',
        'get_connection_clients',
        'list_connections',
        'list_users',
        'list_applications',
        'search_logs',
        'get_brute_force_settings',
        'get_ip_throttling_settings',
        'list_roles',
        'get_user_roles',
        'get_user_permissions',
        'list_organizations',
        'get_organization_members',
        'unblock_user',
    ],
)
@pytest.mark.parametrize('status,code', [(403, 'MISSING_SCOPE'), (404, None)])
def test_all_tools_map_remote_errors_through_flat_contract(client, node, operation, status, code):
    _, auth, requests, _ = client
    instance = node[0].IInstance()
    instance.IGlobal = types.SimpleNamespace(client=auth)
    failed = response(status, {'error': 'Forbidden', 'errorCode': 'insufficient_scope', 'message': 'private-token'})
    if operation == 'unblock_user':
        requests.request.side_effect = [response(200, {'blocked_for': [{'identifier': 'x'}]}), failed]
    else:
        requests.request.return_value = failed
    args = {'email': 'a@example.com'} if operation == 'search_users' else {}
    if operation not in (
        'search_users',
        'list_connections',
        'list_users',
        'list_applications',
        'search_logs',
        'get_brute_force_settings',
        'get_ip_throttling_settings',
        'list_roles',
        'list_organizations',
    ):
        key = {
            'get_log_event': 'log_id',
            'get_connection': 'connection_id',
            'get_connection_clients': 'connection_id',
            'get_organization_members': 'organization_id',
        }.get(operation, 'user_id')
        args[key] = 'id'
    result = getattr(instance, operation)(args)
    if operation == 'unblock_user':
        assert result['error_code'] == 'WRITE_AUTHORIZATION_REQUIRED'
        requests.request.assert_not_called()
        return
    expected = code or (
        'RESOURCE_NOT_FOUND'
        if operation
        in (
            'search_users',
            'get_log_event',
            'get_connection',
            'get_connection_clients',
            'list_connections',
            'list_users',
            'list_applications',
            'search_logs',
            'get_brute_force_settings',
            'get_ip_throttling_settings',
            'list_roles',
            'list_organizations',
            'get_organization_members',
        )
        else 'USER_NOT_FOUND'
    )
    assert result == {
        'success': False,
        'error': 'The Auth0 application lacks a required permission.'
        if status == 403
        else 'The requested Auth0 resource was not found.',
        'error_code': expected,
        'retryable': False,
        'retry_after_seconds': None,
    }
    assert 'private-token' not in str(result)


@pytest.mark.parametrize(
    'operation,argument,payload,path',
    [
        ('search_users', {'email': 'jane@example.com'}, [], '/users'),
        ('get_user', {'user_id': 'auth0|1'}, {'user_id': 'auth0|1'}, '/users/auth0%7C1'),
        ('get_user_logs', {'user_id': 'auth0|1'}, [], '/users/auth0%7C1/logs'),
        ('get_log_event', {'log_id': 'log1'}, {'log_id': 'log1'}, '/logs/log1'),
        ('get_user_blocks', {'user_id': 'auth0|1'}, {'blocked_for': []}, '/user-blocks/auth0%7C1'),
        ('get_connection', {'connection_id': 'con/1'}, {'id': 'con/1'}, '/connections/con%2F1'),
        ('get_connection_clients', {'connection_id': 'con/1'}, {'clients': []}, '/connections/con%2F1/clients'),
        ('list_connections', {}, [], '/connections'),
        ('list_users', {}, [], '/users'),
        ('list_applications', {}, [], '/clients'),
        ('search_logs', {}, [], '/logs'),
        ('get_brute_force_settings', {}, {'enabled': True}, '/attack-protection/brute-force-protection'),
        ('get_ip_throttling_settings', {}, {'enabled': True}, '/attack-protection/suspicious-ip-throttling'),
        ('list_roles', {}, [], '/roles'),
        ('get_user_roles', {'user_id': 'auth0|1'}, [], '/users/auth0%7C1/roles'),
        ('get_user_permissions', {'user_id': 'auth0|1'}, [], '/users/auth0%7C1/permissions'),
        ('list_organizations', {}, {'organizations': []}, '/organizations'),
        ('get_organization_members', {'organization_id': 'org/1'}, {'members': []}, '/organizations/org%2F1/members'),
    ],
)
def test_read_tools_use_approved_http_routes_and_read_token(client, node, operation, argument, payload, path):
    _, auth, requests, _ = client
    instance = node[0].IInstance()
    instance.IGlobal = types.SimpleNamespace(client=auth)
    requests.request.return_value = response(200, payload)
    assert getattr(instance, operation)(argument)['success'] is True
    call = requests.request.call_args
    assert call.args == ('GET', 'https://tenant.us.auth0.com/api/v2' + path)
    assert call.kwargs['headers']['Authorization'] == 'Bearer read-token'
    assert call.kwargs['allow_redirects'] is False
    assert requests.post.call_args.kwargs['json']['client_id'] == 'read'


def test_connection_clients_route_passes_cursor_once(client, node):
    """Send the cursor as an HTTP parameter and do not fetch another page."""
    _, auth, requests, _ = client
    instance = node[0].IInstance()
    instance.IGlobal = types.SimpleNamespace(client=auth)
    requests.request.return_value = response(200, {'clients': [], 'next': 'next-token'})
    result = instance.get_connection_clients({'connection_id': 'con/1', 'limit': 3, 'cursor': 'cursor+/='})
    assert result['next_cursor'] == 'next-token'
    requests.request.assert_called_once()
    call = requests.request.call_args
    assert call.args == ('GET', 'https://tenant.us.auth0.com/api/v2/connections/con%2F1/clients')
    assert call.kwargs['params'] == {'take': 3, 'from': 'cursor+/='}
    assert call.kwargs['headers']['Authorization'] == 'Bearer read-token'


def test_client_uses_separate_read_and_write_tokens(client):
    _, auth, requests, _ = client
    requests.request.side_effect = [response(200, {'blocked_for': [{'identifier': 'x'}]}), response(204)]
    auth.request('get_user_blocks', identifier='auth0|1', params={'consider_brute_force_enablement': 'true'})
    auth.request('unblock_user', identifier='auth0|1')
    read_call, write_call = requests.request.call_args_list
    assert read_call.args == ('GET', 'https://tenant.us.auth0.com/api/v2/user-blocks/auth0%7C1')
    assert read_call.kwargs['params'] == {'consider_brute_force_enablement': 'true'}
    assert read_call.kwargs['headers']['Authorization'] == 'Bearer read-token'
    assert write_call.args == ('DELETE', 'https://tenant.us.auth0.com/api/v2/user-blocks/auth0%7C1')
    assert write_call.kwargs['headers']['Authorization'] == 'Bearer write-token'
    assert [call.kwargs['json']['client_id'] for call in requests.post.call_args_list] == ['read', 'write']


def test_api_redirect_is_not_followed(client):
    module, auth, requests, _ = client
    requests.request.return_value = response(302, headers={'Location': 'https://evil.example/collect'})
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'API_ERROR'
    assert requests.request.call_count == 1
    assert requests.request.call_args.kwargs['allow_redirects'] is False


def test_write_token_failure_does_not_use_read_credentials(client):
    module, auth, requests, _ = client
    requests.post.side_effect = [response(200, {'access_token': 'read-token', 'expires_in': 3600}), response(403)]
    auth.request('get_user', identifier='1')
    with pytest.raises(module.Auth0Error) as error:
        auth.request('unblock_user', identifier='1')
    assert error.value.code == 'AUTHENTICATION_FAILED'
    assert [call.kwargs['json']['client_id'] for call in requests.post.call_args_list] == ['read', 'write']
    assert requests.request.call_count == 1


def test_unauthorized_write_invalidates_only_its_token(client):
    module, auth, requests, _ = client
    auth.request('get_user', identifier='1')
    requests.request.return_value = response(401)
    with pytest.raises(module.Auth0Error):
        auth.request('unblock_user', identifier='1')
    requests.request.return_value = response(200)
    auth.request('get_user', identifier='1')
    assert [call.kwargs['json']['client_id'] for call in requests.post.call_args_list] == ['read', 'write']
    assert requests.request.call_args.kwargs['headers']['Authorization'] == 'Bearer read-token'


def test_close_during_token_refresh_waits_and_clears_credentials(client):
    import threading

    module, auth, requests, _ = client
    entered, release = threading.Event(), threading.Event()

    def post(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return response(body={'access_token': 'token', 'expires_in': 3600})

    requests.post.side_effect = post
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(auth.request, 'get_user', identifier='u')
        assert entered.wait(5)
        closed = pool.submit(auth.close)
        release.set()
        pending.result(timeout=5)
        closed.result(timeout=5)
    assert auth._config == {} and auth._tokens == {'read': None, 'write': None}
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='u')
    assert error.value.code == 'CLIENT_CLOSED'


@pytest.mark.parametrize('domain', ['Tenant.US.Auth0.com', ' tenant.us.auth0.com ', 'https://tenant.us.auth0.com/'])
def test_normalizes_valid_tenant_domain(client, domain):
    module, _, _, cfg = client
    cfg['domain'] = domain
    assert module.Auth0Client(cfg)._base == 'https://tenant.us.auth0.com'


def test_rate_limit_reset_header_and_invalid_values(client, monkeypatch):
    module, _, _, _ = client
    monkeypatch.setattr(module.time, 'time', lambda: 1000)
    assert module._retry_after({'x-ratelimit-reset': '1007'}) == 7
    assert module._retry_after({'Retry-After': '2', 'x-ratelimit-reset': '1007'}) == 2
    for value in ('nan', 'inf', 'bad', '999'):
        assert module._retry_after({'x-ratelimit-reset': value}) == 0


@pytest.mark.parametrize(
    'headers,delay',
    [
        ({'Retry-After': '4'}, 4),
        ({'x-ratelimit-reset': '1007'}, 7),
        ({'Retry-After': 'invalid'}, None),
        ({}, None),
    ],
)
def test_token_rate_limit_reports_retry_delay_without_retry(client, monkeypatch, headers, delay):
    """Report OAuth rate-limit headers without repeating the token request."""
    module, auth, requests, _ = client
    monkeypatch.setattr(module.time, 'time', lambda: 1000)
    requests.post.side_effect = None
    requests.post.return_value = response(429, headers=headers)
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='id')
    assert error.value.code == 'RATE_LIMITED' and error.value.retry_after_seconds == delay
    assert error.value.retryable is True
    requests.post.assert_called_once()
    requests.request.assert_not_called()


@pytest.mark.parametrize('field', ['error', 'errorCode'])
@pytest.mark.parametrize('value', [[], {}, 1, True, None])
def test_malformed_forbidden_codes_return_api_error(client, field, value):
    """Treat malformed forbidden error codes as API errors without exposing them."""
    module, auth, requests, _ = client
    body = {'error': 'insufficient_scope', 'errorCode': 'feature_not_enabled'}
    body[field] = value
    requests.request.return_value = response(403, body)
    with pytest.raises(module.Auth0Error) as error:
        auth.request('get_user', identifier='1')
    assert error.value.code == 'API_ERROR'
