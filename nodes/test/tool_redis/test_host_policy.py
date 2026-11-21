# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Host policy contracts and regressions."""

import importlib
from unittest.mock import MagicMock

import pytest
from nodes.tool_redis.redis_client import (
    RedisNodeError,
    Settings,
)
from nodes.tool_redis.host_policy import validate_public_host, public_connection


def test_redis_and_http_use_the_same_address_policy():
    from ai.common.utils.pinned_http import is_public_address
    from ai.common.utils.url_utils import is_public_address as url_policy
    from nodes.tool_redis import host_policy

    assert host_policy.is_public_address is url_policy is is_public_address


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
        'fec0::1',
        '::a9fe:a9fe',
        '::7f00:1',
        '::ffff:127.0.0.1',
        '64:ff9b::a9fe:a9fe',
        '64:ff9b:1::808:808',
        '2002:7f00:1::',
        '2001:0:808:808:0:0:80ff:fffe',
        '2001:0:7f00:1:0:0:f7f7:f7f7',
    ],
)
def test_host_rejects_non_global_dns(monkeypatch, address):
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', (address, 6379))])
    with pytest.raises(RedisNodeError, match='must resolve exclusively to public') as err:
        validate_public_host('test', 6379)
    assert err.value.code == 'invalid_host'


def test_host_unwraps_nat64_without_rejecting_the_prefix(monkeypatch):
    """64:ff9b::/96 hides an IPv4 address: judge the wrapped address, not the prefix."""
    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('64:ff9b::808:808', 6379))])
    assert validate_public_host('test', 6379) == ['64:ff9b::808:808']


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


def test_hosted_tls_checks_peer_before_handshake(monkeypatch):
    import redis

    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379))])
    sock = MagicMock()
    sock.getpeername.return_value = ('127.0.0.1', 6379)
    monkeypatch.setattr(redis.Connection, '_connect', lambda _self: sock)
    wrap = MagicMock(return_value=sock)
    monkeypatch.setattr(redis.SSLConnection, '_wrap_socket_with_ssl', wrap)
    connection = public_connection(redis.SSLConnection)(host='redis.example')
    with pytest.raises(RedisNodeError, match='non-public'):
        connection._connect()
    wrap.assert_not_called()
    sock.close.assert_called_once()


def test_hosted_tls_pins_ip_and_keeps_hostname_for_certificate(monkeypatch):
    import redis

    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379))])
    sock, wrapped = MagicMock(), MagicMock()
    sock.getpeername.return_value = ('8.8.8.8', 6379)
    calls = []

    def connect(connection):
        calls.append(('tcp', connection.host))
        return sock

    def wrap(connection, raw):
        calls.append(('tls', connection.host))
        assert raw is sock
        return wrapped

    monkeypatch.setattr(redis.Connection, '_connect', connect)
    monkeypatch.setattr(redis.SSLConnection, '_wrap_socket_with_ssl', wrap)
    connection = public_connection(redis.SSLConnection)(host='redis.example')
    assert connection._connect() is wrapped
    assert calls == [('tcp', '8.8.8.8'), ('tls', 'redis.example')]
    assert connection.host == 'redis.example'


def test_hosted_connection_failure_restores_hostname(monkeypatch):
    import redis

    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379))])
    monkeypatch.setattr(redis.Connection, '_connect', MagicMock(side_effect=OSError('unreachable')))
    connection = public_connection(redis.Connection)(host='redis.example')
    with pytest.raises(OSError):
        connection._connect()
    assert connection.host == 'redis.example'


def test_hosted_connection_tries_only_validated_addresses(monkeypatch):
    import redis

    monkeypatch.setattr(
        'socket.getaddrinfo',
        lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379)), (0, 0, 0, '', ('1.1.1.1', 6379))],
    )
    sock = MagicMock()
    sock.getpeername.return_value = ('1.1.1.1', 6379)
    attempts = []

    def connect(connection):
        attempts.append(connection.host)
        if len(attempts) == 1:
            raise OSError('first address unreachable')
        return sock

    monkeypatch.setattr(redis.Connection, '_connect', connect)
    connection = public_connection(redis.Connection)(host='redis.example')
    assert connection._connect() is sock
    assert attempts == ['8.8.8.8', '1.1.1.1']
    assert connection.host == 'redis.example'


def test_hosted_tls_failure_closes_raw_socket(monkeypatch):
    import redis

    monkeypatch.setattr('socket.getaddrinfo', lambda *_a, **_k: [(0, 0, 0, '', ('8.8.8.8', 6379))])
    sock = MagicMock()
    sock.getpeername.return_value = ('8.8.8.8', 6379)
    monkeypatch.setattr(redis.Connection, '_connect', lambda _self: sock)
    monkeypatch.setattr(redis.SSLConnection, '_wrap_socket_with_ssl', MagicMock(side_effect=OSError('bad certificate')))
    connection = public_connection(redis.SSLConnection)(host='redis.example')
    with pytest.raises(OSError, match='bad certificate'):
        connection._connect()
    sock.close.assert_called_once()
    assert connection.host == 'redis.example'
