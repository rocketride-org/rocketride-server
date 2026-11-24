# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Global contracts and regressions."""

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from redis.exceptions import (
    ConnectionError,
)
from rocketlib import OPEN_MODE
from nodes.tool_redis import IGlobal
from nodes.tool_redis.redis_client import (
    RedisNodeError,
    Settings,
)
from ._fixtures import client as client

global_module = importlib.import_module('nodes.tool_redis.IGlobal')


def make_global():
    node = IGlobal.__new__(IGlobal)
    node.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=None))
    return node


@pytest.mark.parametrize('host_mode', ['is_hosted', 'is_shared_host', 'local'])
@pytest.mark.parametrize('use_tls', [False, True])
def test_editor_warns_about_hosted_tls_without_connecting(monkeypatch, host_mode, use_tls):
    node = make_global()
    monkeypatch.setattr(node, '_settings', lambda: Settings(use_tls=use_tls))
    monkeypatch.setattr(global_module, 'is_hosted', lambda: host_mode == 'is_hosted')
    monkeypatch.setattr(global_module, 'is_shared_host', lambda: host_mode == 'is_shared_host')
    monkeypatch.setattr(global_module, 'create_client', lambda _: pytest.fail('editor connected'))
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: pytest.fail('editor resolved DNS'))
    warn = MagicMock()
    monkeypatch.setattr(global_module, 'warning', warn)
    node.validateConfig()
    if host_mode != 'local' and not use_tls:
        warn.assert_called_once_with('Hosted Redis requires TLS with certificate and hostname verification.')
    else:
        warn.assert_not_called()


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


@pytest.mark.parametrize('host_mode', ['is_hosted', 'is_shared_host'])
def test_hosted_pool_uses_guarded_tls_connection(monkeypatch, host_mode):
    import redis

    monkeypatch.setattr(global_module, 'is_hosted', lambda: host_mode == 'is_hosted')
    monkeypatch.setattr(global_module, 'is_shared_host', lambda: host_mode == 'is_shared_host')
    dns = MagicMock(return_value=[(0, 0, 0, '', ('8.8.8.8', 6379))])
    monkeypatch.setattr('socket.getaddrinfo', dns)
    guard = MagicMock(wraps=global_module.public_connection)
    monkeypatch.setattr(global_module, 'public_connection', guard)
    client, pool = global_module.create_client(Settings(host='redis.example', use_tls=True))
    try:
        guard.assert_called_once_with(redis.SSLConnection)
        assert pool.connection_class is not redis.SSLConnection
        assert issubclass(pool.connection_class, redis.SSLConnection)
        assert pool.connection_kwargs['ssl_cert_reqs'] == 'required'
        assert pool.connection_kwargs['ssl_check_hostname'] is True
        dns.assert_called_once()
        # Exercise the class selected by create_client, not a separately
        # constructed guard: a new connection must re-check DNS before TCP/TLS.
        dns.return_value = [(0, 0, 0, '', ('127.0.0.1', 6379))]
        tcp = MagicMock()
        monkeypatch.setattr(redis.Connection, '_connect', tcp)
        with pytest.raises(RedisNodeError, match='exclusively to public'):
            pool.connection_class(**pool.connection_kwargs)._connect()
        assert dns.call_count == 2
        tcp.assert_not_called()
    finally:
        client.close()
        pool.disconnect()


def test_password_precedence(monkeypatch):
    node = make_global()
    node.glb = SimpleNamespace(logicalType='tool_redis', connConfig={})
    cfg = {}
    monkeypatch.setattr(global_module.Config, 'getNodeConfig', lambda *_: cfg)
    monkeypatch.setenv('REDIS_PASSWORD', 'environment-secret')
    assert node._settings().password is None
    cfg['password'] = 'configured-secret'
    assert node._settings().password == 'configured-secret'


def test_real_pool_retry_configuration():
    module = importlib.import_module('nodes.tool_redis.IGlobal')
    client, pool = module.create_client(Settings())
    try:
        assert pool.connection_kwargs['retry'].get_retries() == 0
    finally:
        client.close()
        pool.disconnect()
