# MIT License
# Copyright (c) 2026 Aparavi Software AG
"""Approved v1 contract regressions using the shared fake, not a redis import shadow."""

import importlib
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from redis.exceptions import ConnectionError

from test.mocks.redis_fake import FakeRedis
from nodes.tool_redis import IInstance
from nodes.tool_redis.redis_client import (
    MAX_KEY_BYTES,
    MAX_RESULT_BYTES,
    MAX_VALUE_BYTES,
    RedisNodeError,
    RedisStore,
    Settings,
    bounded_result,
)
from nodes.tool_redis.host_policy import validate_public_host, public_connection


@pytest.fixture
def store():
    return RedisStore(FakeRedis(), Settings(allow_writes=True, key_prefix='rr:test:'))


def test_seven_tools_fake_round_trip(store):
    store.client.set('foreign:k', 'keep')
    assert not store.get('k')['found']
    assert store.set('k', 'value')['stored']
    assert store.get('k')['value'] == 'value'
    assert store.ttl('k')['has_expiry']
    assert store.expire('k', 20)['updated']
    assert store.ttl('k')['ttl_seconds'] == 20
    assert store.incr('counter', '9007199254740993')['value_decimal'] == '9007199254740993'
    assert store.incr('counter', '-1')['value_decimal'] == '9007199254740992'
    assert store.ttl('counter')['ttl_seconds'] == -1
    page = store.scan()
    assert page['done'] and set(page['keys']) == {'k', 'counter'}
    assert store.delete(['k', 'counter', 'missing', 'k'])['deleted_count'] == 2
    assert store.client.get('foreign:k') == 'keep'
    assert not store.expire('missing', 1)['updated']


@pytest.mark.parametrize(
    'method,args', [('set', ('k', 'v')), ('expire', ('k', 1)), ('incr', ('k',)), ('delete', (['k'],))]
)
def test_every_write_is_guarded(store, method, args):
    store.settings = Settings(allow_writes=False)
    with pytest.raises(RedisNodeError, match='read-only'):
        getattr(store, method)(*args)
    assert store.client._kv == {}


@pytest.mark.parametrize(
    'method,args',
    [
        ('expire', ('k', 0)),
        ('expire', ('k', -1)),
        ('expire', ('k', True)),
        ('incr', ('k', True)),
        ('incr', ('k', 1)),
        ('incr', ('k', '01')),
        ('incr', ('k', str(2**63))),
        ('scan', (True,)),
        ('scan', ('-1',)),
        ('scan', ('01',)),
        ('scan', (str(2**64),)),
        ('scan', ('0', 0)),
        ('scan', ('0', 501)),
        ('scan', ('0', True)),
        ('delete', ([],)),
        ('delete', (['k'] * 101,)),
        ('delete', (['k', None],)),
        ('delete', (['k', '*'],)),
    ],
)
def test_invalid_inputs_never_mutate(store, method, args):
    store.set('k', '1')
    with pytest.raises(RedisNodeError):
        getattr(store, method)(*args)
    assert store.get('k')['value'] == '1'


def test_limits_and_utf8_boundary(store):
    value = 'é' * (MAX_VALUE_BYTES // 2)
    store.set('k', value)
    assert store.get('k')['value'] == value
    with pytest.raises(RedisNodeError, match='limit'):
        store.set('k', value + 'x')
    raw = value.encode() + b'\xff'
    store.client.set('rr:test:k', raw)
    with pytest.raises(RedisNodeError) as err:
        store.get('k')
    assert err.value.code == 'value_too_large'  # before UTF-8 decoding
    key = 'x' * (MAX_KEY_BYTES - len(store.settings.key_prefix))
    store.set(key, 'ok')
    with pytest.raises(RedisNodeError):
        store.set(key + 'é', 'bad')


def test_ascii_escaped_result_limit(store):
    with pytest.raises(RedisNodeError) as err:
        bounded_result({'value': 'x' * MAX_RESULT_BYTES})
    assert err.value.code == 'result_too_large'
    store.set('k', 'é' * (MAX_VALUE_BYTES // 2))
    tool = IInstance.__new__(IInstance)
    tool.IGlobal = type('Global', (), {'store': store})()
    assert tool.redis_get({'key': 'k'})['error_code'] == 'result_too_large'


def test_counter_overflow_and_wrong_type_do_not_change_value(store):
    store.set('k', str(2**63 - 1))
    with pytest.raises(RedisNodeError):
        store.incr('k')
    assert store.get('k')['value'] == str(2**63 - 1)
    store.client.hset('rr:test:hash', mapping={'a': 'b'})
    with pytest.raises(RedisNodeError):
        store.incr('hash')


def test_scan_one_call_empty_page_and_full_cursor(store):
    store.client = MagicMock()
    store.client.scan.return_value = (2**64 - 1, [])
    assert store.scan('0', 1) == {'cursor': str(2**64 - 1), 'keys': [], 'done': False}
    store.client.scan.assert_called_once_with(cursor=0, match='rr:test:*', count=1)
    store.client.scan.return_value = (0, [b'foreign:secret'])
    with pytest.raises(RedisNodeError) as err:
        store.scan()
    assert err.value.code == 'invalid_response'
    store.client.scan.return_value = (0, [b'rr:test:\xff'])
    with pytest.raises(RedisNodeError) as err:
        store.scan()
    assert err.value.code == 'invalid_encoding'
    store.client.scan.return_value = (0, [b'rr:test:' + b'x' * 200] * 1000)
    with pytest.raises(RedisNodeError) as err:
        store.scan()
    assert err.value.code == 'result_too_large'


@pytest.mark.parametrize('operation,args', [('expire', ('k', 3)), ('incr', ('k', '1')), ('delete', (['k'],))])
def test_new_writes_report_unknown_and_are_not_retried(store, operation, args):
    mock = MagicMock(side_effect=ConnectionError('credential:secret'))
    setattr(store.client, {'expire': 'expire', 'incr': 'incrby', 'delete': 'delete'}[operation], mock)
    with pytest.raises(RedisNodeError) as err:
        getattr(store, operation)(*args)
    assert err.value.outcome == 'unknown' and 'secret' not in str(err.value)
    assert mock.call_count == 1


@pytest.mark.parametrize(
    'address',
    [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '::1',
        'fc00::1',
        '::ffff:127.0.0.1',
    ],
)
def test_host_rejects_non_global_dns(monkeypatch, address):
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', (address, 6379))])
    with pytest.raises(RedisNodeError):
        validate_public_host('test', 6379)


def test_host_rejects_mixed_dns_and_unresolved(monkeypatch):
    import socket

    monkeypatch.setattr(
        socket, 'getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379)), (0, 0, 0, '', ('10.0.0.1', 6379))]
    )
    with pytest.raises(RedisNodeError):
        validate_public_host('test', 6379)
    monkeypatch.setattr(socket, 'getaddrinfo', MagicMock(side_effect=socket.gaierror()))
    with pytest.raises(RedisNodeError):
        validate_public_host('test', 6379)


def test_dns_rebinding_peer_rejected_before_auth(monkeypatch):
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379))])
    sock = MagicMock()
    sock.getpeername.return_value = ('127.0.0.1', 6379)

    class Base:
        host, port = 'test', 6379

        def _connect(self):
            return sock

    with pytest.raises(RedisNodeError):
        public_connection(Base)()._connect()
    sock.close.assert_called_once()


def test_hosted_gate_cannot_be_disabled_in_config(monkeypatch):
    module = importlib.import_module('nodes.tool_redis.IGlobal')
    monkeypatch.setattr(module, 'is_hosted', lambda: True)
    with pytest.raises(RedisNodeError, match='requires TLS'):
        module.create_client(Settings(host='localhost'))
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('127.0.0.1', 6379))])
    with pytest.raises(RedisNodeError, match='public'):
        module.create_client(Settings(host='localhost', use_tls=True))


def test_tls_url_and_prefix_rules():
    s = Settings.from_config({'host': 'rediss://redis.example:6380'})
    assert (s.host, s.port, s.use_tls) == ('redis.example', 6380, True)
    for host in [
        'rediss://u:secret@redis.example',
        'rediss://redis.example/0',
        'rediss://redis.example?x=1',
        'redis://redis.example',
    ]:
        with pytest.raises(RedisNodeError):
            Settings.from_config({'host': host})
    for prefix in ['bad.dot:', 'bad*', '', 'x' * 129]:
        with pytest.raises(RedisNodeError):
            Settings.from_config({'key_prefix': prefix})


def test_real_pool_retry_configuration():
    module = importlib.import_module('nodes.tool_redis.IGlobal')
    client, pool = module.create_client(Settings())
    try:
        assert pool.connection_kwargs['retry'].get_retries() == 0
    finally:
        client.close()
        pool.disconnect()


def test_catalog_pipeline_uses_disposable_fixture_port(monkeypatch):
    """The generic runner must reach the fixture, not the default port 6379."""
    from test.framework.discovery import get_node_test_config
    from test.framework.pipeline import PipelineBuilder

    monkeypatch.setenv('ROCKETRIDE_REDIS_HOST', '127.0.0.1')
    nodes_dir = Path(__file__).parents[2] / 'src' / 'nodes'
    config = get_node_test_config('tool_redis', str(nodes_dir))
    assert config is not None
    pipeline = PipelineBuilder(config, 'default').build()
    redis_node = next(node for node in pipeline['components'] if node['provider'] == 'tool_redis')
    assert redis_node['config']['port'] == 6381
    assert redis_node['config']['default']['host'] == '127.0.0.1'
