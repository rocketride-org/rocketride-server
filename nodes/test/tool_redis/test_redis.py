# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Redis tool contracts, validation, lifecycle and sanitized failures; no network."""

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from redis.exceptions import (
    AuthenticationError,
    AuthorizationError,
    ConnectionError,
    DataError,
    MaxConnectionsError,
    ResponseError,
    TimeoutError,
)
from rocketlib import OPEN_MODE

from nodes.tool_redis import IGlobal, IInstance
from nodes.tool_redis.redis_client import MAX_TTL_SECONDS, RedisNodeError, RedisStore, Settings

global_module = importlib.import_module('nodes.tool_redis.IGlobal')


@pytest.fixture
def client():
    client = MagicMock()
    client.pipeline.return_value.__enter__.return_value = client.pipeline.return_value
    return client


@pytest.fixture
def store(client):
    return RedisStore(
        client, Settings.from_config({'key_prefix': 'rr:test:', 'allow_writes': True, 'max_value_bytes': 8})
    )


@pytest.fixture
def tool(store):
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = SimpleNamespace(store=store)
    return instance


@pytest.mark.parametrize(
    'name,value',
    [
        ('host', ''),
        ('host', 'redis://host'),
        ('port', True),
        ('port', 0),
        ('port', 65536),
        ('db', -1),
        ('allow_writes', 'false'),
        ('use_tls', 1),
        ('key_prefix', ''),
        ('key_prefix', '*:'),
        ('key_prefix', 'rr.dot:'),
        ('default_ttl_seconds', -1),
        ('default_ttl_seconds', True),
        ('max_connections', 0),
        ('max_connections', 101),
        ('max_value_bytes', 0),
        ('max_value_bytes', 1048577),
        ('socket_timeout', float('nan')),
        ('socket_timeout', float('inf')),
        ('socket_connect_timeout', 0),
        ('socket_timeout', True),
        ('password', {}),
    ],
)
def test_invalid_config(name, value):
    with pytest.raises(RedisNodeError):
        Settings.from_config({name: value})


def test_defaults_and_secret_repr():
    settings = Settings.from_config({'password': 'never-log-this'})
    assert settings.allow_writes is False
    assert settings.default_ttl_seconds == 3600
    assert 'never-log-this' not in repr(settings)


@pytest.mark.parametrize('key', ['', None, 1, True, '\ud800', 'é' * 600])
@pytest.mark.parametrize('method', ['redis_get', 'redis_ttl', 'redis_set'])
def test_bad_keys_touch_no_redis(tool, client, key, method):
    args = {'key': key}
    if method == 'redis_set':
        args['value'] = 'ok'
    assert getattr(tool, method)(args)['success'] is False
    assert client.mock_calls == []


@pytest.mark.parametrize('key', ['item', 'rr:test:item', '../item', '*', 'é'])
def test_literal_scope_on_every_operation(store, client, key):
    client.pipeline.return_value.execute.return_value = [b'ok', -1]
    client.ttl.return_value = -1
    store.get(key)
    client.pipeline.return_value.getrange.assert_called_with('rr:test:' + key, 0, 8)
    store.ttl(key)
    client.ttl.assert_called_with('rr:test:' + key)
    store.set(key, 'ok')
    assert client.set.call_args.args[0] == 'rr:test:' + key


@pytest.mark.parametrize(
    'raw,ttl,found,value',
    [(b'', -2, False, None), (b'', -1, True, ''), (b'blue', 12, True, 'blue'), ('é'.encode(), -1, True, 'é')],
)
def test_get_states(store, client, raw, ttl, found, value):
    client.pipeline.return_value.execute.return_value = [raw, ttl]
    assert store.get('k') == {'key': 'k', 'found': found, 'value': value, 'ttl_seconds': ttl}
    client.pipeline.assert_called_once_with(transaction=True)


@pytest.mark.parametrize('raw,code', [(b'x' * 9, 'value_too_large'), (b'\xff', 'invalid_encoding')])
def test_bad_stored_values(tool, client, raw, code):
    client.pipeline.return_value.execute.return_value = [raw, -1]
    assert tool.redis_get({'key': 'k'})['error_code'] == code


@pytest.mark.parametrize(
    'args,ex,nx,xx',
    [
        ({}, 3600, False, False),
        ({'ttl_seconds': 0}, None, False, False),
        ({'ttl_seconds': 7, 'condition': 'NX'}, 7, True, False),
        ({'condition': 'XX'}, 3600, False, True),
    ],
)
def test_set_expiry_and_conditions(store, client, args, ex, nx, xx):
    client.set.return_value = True
    result = store.set('k', '', **args)
    client.set.assert_called_once_with('rr:test:k', b'', ex=ex, nx=nx, xx=xx)
    assert result == {'key': 'k', 'stored': True, 'requested_ttl_seconds': ex or 0}


def test_conditional_refusal_is_not_an_error(tool, client):
    client.set.return_value = None
    assert tool.redis_set({'key': 'k', 'value': 'v', 'condition': 'NX'})['stored'] is False


@pytest.mark.parametrize(
    'args',
    [
        {'value': {}},
        {'value': True},
        {'value': b'x'},
        {'value': '\ud800'},
        {'value': 'é' * 5},
        {'ttl_seconds': -1},
        {'ttl_seconds': True},
        {'ttl_seconds': 1.5},
        {'ttl_seconds': MAX_TTL_SECONDS + 1},
        {'condition': 'nx'},
        {'condition': ['NX']},
        {'host': 'other'},
    ],
)
def test_set_validation_before_network(tool, client, args):
    assert tool.redis_set({'key': 'k', 'value': 'v', **args})['success'] is False
    assert client.mock_calls == []


def test_read_only_blocks_set_and_allows_reads(client):
    tool = IInstance.__new__(IInstance)
    tool.IGlobal = SimpleNamespace(store=RedisStore(client, Settings()))
    result = tool.redis_set({'key': 'k', 'value': 'v'})
    assert result['error_code'] == 'permission_denied'
    assert client.mock_calls == []
    client.ttl.return_value = -1
    assert tool.redis_ttl({'key': 'k'})['success']
    client.pipeline.return_value.execute.return_value = [b'v', -1]
    assert tool.redis_get({'key': 'k'})['value'] == 'v'


@pytest.mark.parametrize('ttl', [-2, -1, 0, 20])
def test_ttl_sentinels(store, client, ttl):
    client.ttl.return_value = ttl
    assert store.ttl('k') == {'key': 'k', 'ttl_seconds': ttl, 'exists': ttl != -2, 'has_expiry': ttl >= 0}


@pytest.mark.parametrize(
    'exc,code',
    [
        (AuthenticationError, 'authentication_error'),
        (AuthorizationError, 'permission_denied'),
        (MaxConnectionsError, 'connection_error'),
        (ConnectionError, 'connection_error'),
        (TimeoutError, 'connection_error'),
        (ResponseError, 'invalid_operation'),
        (DataError, 'invalid_input'),
    ],
)
@pytest.mark.parametrize('operation', ['redis_get', 'redis_set', 'redis_ttl'])
def test_errors_are_redacted(tool, client, exc, code, operation):
    client.set.side_effect = exc('redis://secret-password@private-host')
    client.ttl.side_effect = exc('redis://secret-password@private-host')
    client.pipeline.return_value.execute.side_effect = exc('redis://secret-password@private-host')
    args = {'key': 'k', **({'value': 'v'} if operation == 'redis_set' else {})}
    result = getattr(tool, operation)(args)
    assert result['error_code'] == code
    assert 'secret-password' not in str(result)
    assert 'private-host' not in str(result)
    assert result['outcome'] == (
        'unknown' if operation == 'redis_set' and exc in (ConnectionError, TimeoutError) else 'not_applied'
    )


def test_input_normalization_and_discovery(tool, client):
    client.ttl.return_value = -2
    assert tool.redis_ttl('{"input": {"key": "missing"}}')['ttl_seconds'] == -2
    methods = tool._collect_tool_methods()
    assert set(methods) == {
        'redis_get',
        'redis_set',
        'redis_ttl',
        'redis_expire',
        'redis_incr',
        'redis_scan',
        'redis_delete',
    }
    tool._tool_config_description = lambda: ''
    descriptors = tool._build_tool_descriptors(methods)
    assert {d['name'] for d in descriptors} == set(methods)
    assert all(d['inputSchema']['additionalProperties'] is False for d in descriptors)


def test_framework_invocation(tool, client):
    client.ttl.return_value = -1
    param = {'tool_name': 'redis_ttl', 'input': {'key': 'k'}}
    result = tool._dispatch_tool(param, 'tool.invoke')
    assert result['output']['ttl_seconds'] == -1


@pytest.mark.parametrize('args', [None, [], 3, 'malformed', {}, {'host': 'other'}])
def test_malformed_tool_args(tool, client, args):
    assert tool.redis_get(args)['success'] is False
    assert client.mock_calls == []


@pytest.mark.parametrize('args', [None, [], 3, True, 'malformed', 'null', '[]', '3', 'true'])
def test_scan_rejects_non_object_arguments(tool, client, args):
    result = tool.redis_scan(args)
    assert result['error_code'] == 'invalid_input'
    assert result['outcome'] == 'not_applied'
    assert client.mock_calls == []


@pytest.mark.parametrize('args', [{}, '{}', {'input': {}}, '{"input": {}}'])
def test_scan_accepts_empty_argument_objects(tool, client, args):
    client.scan.return_value = (0, [])
    assert tool.redis_scan(args) == {'success': True, 'cursor': '0', 'keys': [], 'done': True, 'skipped': 0}
    client.scan.assert_called_once_with(cursor=0, match='rr:test:*', count=100)


def test_scan_accepts_pydantic_arguments(tool, client):
    from pydantic import BaseModel

    class ScanInput(BaseModel):
        count: int = 1

    client.scan.return_value = (0, [])
    assert tool.redis_scan(ScanInput())['success']
    client.scan.assert_called_once_with(cursor=0, match='rr:test:*', count=1)


def test_scan_rejects_failed_model_conversion(tool, client):
    class InvalidInput:
        def model_dump(self):
            raise ValueError('credential:secret')

    result = tool.redis_scan(InvalidInput())
    assert result['error_code'] == 'invalid_input'
    assert 'secret' not in str(result)
    assert client.mock_calls == []


def make_global():
    node = IGlobal.__new__(IGlobal)
    node.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    return node


def test_config_mode_no_dependency_or_network(monkeypatch):
    node = make_global()
    node.IEndpoint.endpoint.openMode = OPEN_MODE.CONFIG
    monkeypatch.setattr(node, '_settings', lambda: pytest.fail('config mode read settings'))
    monkeypatch.setattr(global_module, 'create_client', lambda _: pytest.fail('connected in config mode'))
    node.beginGlobal()
    assert node.store is None


def test_startup_and_cleanup(monkeypatch, client):
    import depends

    monkeypatch.setattr(depends, 'load_depends', lambda _: None)
    node = make_global()
    pool = MagicMock()
    monkeypatch.setattr(node, '_settings', Settings)
    monkeypatch.setattr(global_module, 'create_client', lambda _: (client, pool))
    node.beginGlobal()
    client.ping.assert_called_once()
    assert node.store.client is client
    node.endGlobal()
    node.endGlobal()
    client.close.assert_called_once()
    pool.disconnect.assert_called_once()
    assert node.client is node.pool is node.store is None


def test_failed_startup_cleans_resources(monkeypatch, client):
    import depends

    monkeypatch.setattr(depends, 'load_depends', lambda _: None)
    node = make_global()
    pool = MagicMock()
    client.ping.side_effect = ConnectionError('secret')
    monkeypatch.setattr(node, '_settings', Settings)
    monkeypatch.setattr(global_module, 'create_client', lambda _: (client, pool))
    with pytest.raises(RedisNodeError, match='could not complete'):
        node.beginGlobal()
    pool.disconnect.assert_called_once()
    assert node.store is None


def test_close_failure_still_disconnects_pool(client):
    node = make_global()
    node.client = client
    node.pool = pool = MagicMock()
    client.close.side_effect = RuntimeError('secret')
    node.endGlobal()
    pool.disconnect.assert_called_once()
    assert node.client is node.pool is None


def test_pool_configuration(monkeypatch):
    import redis

    pool = MagicMock()
    factory = MagicMock(return_value=pool)
    monkeypatch.setattr(redis, 'ConnectionPool', factory)
    client = MagicMock()
    monkeypatch.setattr(redis, 'Redis', MagicMock(return_value=client))
    actual, actual_pool = global_module.create_client(Settings(use_tls=True, username='u', password='secret'))
    assert (actual, actual_pool) == (client, pool)
    kwargs = factory.call_args.kwargs
    assert kwargs['retry'].get_retries() == 0
    assert kwargs['max_connections'] == 10
    assert kwargs['socket_connect_timeout'] == 3
    assert kwargs['socket_timeout'] == 5
    assert kwargs['connection_class'] is redis.SSLConnection
    assert kwargs['ssl_cert_reqs'] == 'required' and kwargs['ssl_check_hostname']
    assert kwargs['decode_responses'] is False


def test_password_precedence(monkeypatch):
    node = make_global()
    node.glb = SimpleNamespace(logicalType='tool_redis', connConfig={})
    cfg = {}
    monkeypatch.setattr(global_module.Config, 'getNodeConfig', lambda *_: cfg)
    monkeypatch.setenv('REDIS_PASSWORD', 'environment-secret')
    assert node._settings().password is None
    cfg['password'] = 'configured-secret'
    assert node._settings().password == 'configured-secret'


def test_local_credentials_are_optional_in_editor():
    """RocketRide fields default to required unless optional is explicit."""
    import json
    from pathlib import Path

    service = Path(__file__).parents[2] / 'src/nodes/tool_redis/services.json'
    fields = json.loads(service.read_text())['fields']
    assert fields['tool_redis.username']['optional'] is True
    assert fields['tool_redis.password']['optional'] is True
    assert fields['tool_redis.password']['secure'] is True


def test_example_declares_source_for_development_panel():
    import json
    from pathlib import Path

    example = Path(__file__).parents[2] / 'src/nodes/tool_redis/example.pipe'
    pipeline = json.loads(example.read_text())
    source = next(c for c in pipeline['components'] if c['id'] == pipeline['source'])
    assert source['provider'] == 'tools'
    assert source['config']['mode'] == 'Source'
