# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Redis client contracts and regressions."""

from unittest.mock import MagicMock

import pytest
from redis.exceptions import (
    ConnectionError,
)
from nodes.tool_redis import IInstance
from nodes.tool_redis.redis_client import (
    MAX_KEY_BYTES,
    MAX_RESULT_BYTES,
    MAX_VALUE_BYTES,
    RedisNodeError,
    Settings,
    bounded_result,
)
from ._fixtures import client as client, fake_store as fake_store, store as store


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
        ('key_prefix', 'rr'),
        ('default_ttl_seconds', -1),
        ('default_ttl_seconds', True),
        ('max_connections', 0),
        ('max_connections', 101),
        ('max_value_bytes', 0),
        ('max_value_bytes', 65537),
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


def test_prefix_separator_keeps_neighbouring_namespaces_out():
    from test.mocks.redis_fake import FakeRedis
    from nodes.tool_redis.redis_client import RedisStore

    client = FakeRedis()
    client.set('app2:x', 'other namespace')
    store = RedisStore(client, Settings.from_config({'key_prefix': 'app:', 'allow_writes': True}))
    assert store.scan()['keys'] == []
    store.set('2:x', 'own namespace')
    assert client.get('app:2:x') == b'own namespace'
    assert client.get('app2:x') == 'other namespace'


@pytest.mark.parametrize('prefix', [':', 'rr:', 'x' * 127 + ':'])
def test_prefix_accepts_separator_and_maximum_length(prefix):
    assert Settings.from_config({'key_prefix': prefix}).key_prefix == prefix


@pytest.mark.parametrize('name', ['use_tls', 'allow_writes'])
def test_tls_url_does_not_hide_an_invalid_boolean(name):
    with pytest.raises(RedisNodeError, match='boolean'):
        Settings.from_config({'host': 'rediss://redis.example', name: 'false'})


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
    store.expire(key, 1)
    client.expire.assert_called_with('rr:test:' + key, 1)
    store.incr(key)
    client.incrby.assert_called_with('rr:test:' + key, 1)
    # Glob characters are literal: DEL must accept every key SET can create.
    store.delete([key])
    client.delete.assert_called_with('rr:test:' + key)


@pytest.mark.parametrize(
    'raw,ttl,found,value',
    [(b'', -2, False, None), (b'', -1, True, ''), (b'blue', 12, True, 'blue'), ('é'.encode(), -1, True, 'é')],
)
def test_get_states(store, client, raw, ttl, found, value):
    client.pipeline.return_value.execute.return_value = [raw, ttl]
    assert store.get('k') == {'key': 'k', 'found': found, 'value': value, 'ttl_seconds': ttl}
    client.pipeline.assert_called_once_with(transaction=True)


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


@pytest.mark.parametrize('ttl', [-2, -1, 0, 20])
def test_ttl_sentinels(store, client, ttl):
    client.ttl.return_value = ttl
    assert store.ttl('k') == {'key': 'k', 'ttl_seconds': ttl, 'exists': ttl != -2, 'has_expiry': ttl >= 0}


def test_seven_tools_fake_round_trip(fake_store):
    fake_store.client.set('foreign:k', 'keep')
    assert not fake_store.get('k')['found']
    assert fake_store.set('k', 'value')['stored']
    assert fake_store.get('k')['value'] == 'value'
    assert fake_store.ttl('k')['has_expiry']
    assert fake_store.expire('k', 20)['updated']
    assert fake_store.ttl('k')['ttl_seconds'] == 20
    assert fake_store.incr('counter', '9007199254740993')['value_decimal'] == '9007199254740993'
    assert fake_store.incr('counter', '-1')['value_decimal'] == '9007199254740992'
    assert fake_store.ttl('counter')['ttl_seconds'] == -1
    page = fake_store.scan()
    assert page['done'] and set(page['keys']) == {'k', 'counter'}
    assert fake_store.delete(['k', 'counter', 'missing', 'k'])['deleted_count'] == 2
    assert fake_store.client.get('foreign:k') == 'keep'
    assert not fake_store.expire('missing', 1)['updated']


@pytest.mark.parametrize(
    'method,args', [('set', ('k', 'v')), ('expire', ('k', 1)), ('incr', ('k',)), ('delete', (['k'],))]
)
def test_every_write_is_guarded(fake_store, method, args):
    fake_store.settings = Settings(allow_writes=False)
    with pytest.raises(RedisNodeError, match='read-only'):
        getattr(fake_store, method)(*args)
    assert fake_store.client._kv == {}


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
        ('delete', (['k', ''],)),
    ],
)
def test_invalid_inputs_never_mutate(fake_store, method, args):
    fake_store.set('k', '1')
    with pytest.raises(RedisNodeError):
        getattr(fake_store, method)(*args)
    assert fake_store.get('k')['value'] == '1'


def test_limits_and_utf8_boundary(fake_store):
    value = 'x' * (MAX_VALUE_BYTES - 2) + 'é'
    fake_store.set('k', value)
    assert fake_store.get('k')['value'] == value
    with pytest.raises(RedisNodeError, match='limit'):
        fake_store.set('k', value + 'x')
    raw = value.encode() + b'\xff'
    fake_store.client.set('rr:test:k', raw)
    with pytest.raises(RedisNodeError) as err:
        fake_store.get('k')
    assert err.value.code == 'value_too_large'  # before UTF-8 decoding
    key = 'x' * (MAX_KEY_BYTES - len(fake_store.settings.key_prefix))
    fake_store.set(key, 'ok')
    with pytest.raises(RedisNodeError):
        fake_store.set(key + 'é', 'bad')


def test_ascii_escaped_result_limit(fake_store):
    with pytest.raises(RedisNodeError) as err:
        bounded_result({'value': 'x' * MAX_RESULT_BYTES})
    assert err.value.code == 'result_too_large'
    value = 'é' * (MAX_VALUE_BYTES // 2)
    tool = IInstance.__new__(IInstance)
    tool.IGlobal = type('Global', (), {'store': fake_store})()
    result = tool.redis_set({'key': 'k', 'value': value})
    assert result['error_code'] == 'result_too_large'
    assert 'read back' in result['error'] and 'SCAN' not in result['error']
    assert not tool.redis_get({'key': 'k'})['found']
    fake_store.client.set('rr:test:k', value)
    assert tool.redis_get({'key': 'k'})['error_code'] == 'result_too_large'


def test_counter_overflow_and_wrong_type_do_not_change_value(fake_store):
    fake_store.set('k', str(2**63 - 1))
    with pytest.raises(RedisNodeError):
        fake_store.incr('k')
    assert fake_store.get('k')['value'] == str(2**63 - 1)
    fake_store.client.hset('rr:test:hash', mapping={'a': 'b'})
    with pytest.raises(RedisNodeError):
        fake_store.incr('hash')


@pytest.mark.parametrize('value,amount', [(str(2**63), '-1'), (str(-(2**63) - 1), '1')])
def test_counter_rejects_out_of_range_stored_value_before_addition(fake_store, value, amount):
    fake_store.set('k', value)
    with pytest.raises(RedisNodeError) as err:
        fake_store.incr('k', amount)
    assert err.value.code == 'invalid_operation'
    assert err.value.outcome == 'not_applied'
    assert fake_store.get('k')['value'] == value


def test_scan_one_call_empty_page_and_full_cursor(fake_store):
    fake_store.client = MagicMock()
    fake_store.client.scan.return_value = (2**64 - 1, [])
    assert fake_store.scan('0', 1) == {'cursor': str(2**64 - 1), 'keys': [], 'done': False, 'skipped': 0}
    fake_store.client.scan.assert_called_once_with(cursor=0, match='rr:test:*', count=1)


def test_scan_skips_invalid_keys_and_preserves_cursor(fake_store):
    fake_store.client = MagicMock()
    fake_store.client.scan.return_value = (
        7,
        [b'foreign:k', b'rr:test:\xff', b'rr:test:', b'rr:test:' + b'x' * 256, b'rr:test:k'],
    )
    assert fake_store.scan() == {'cursor': '7', 'keys': ['k'], 'done': False, 'skipped': 4}


def test_scan_rejects_oversized_results(fake_store):
    fake_store.client = MagicMock()
    fake_store.client.scan.return_value = (0, [b'rr:test:' + b'x' * 200] * 1000)
    with pytest.raises(RedisNodeError) as err:
        fake_store.scan()
    assert err.value.code == 'result_too_large'


@pytest.mark.parametrize('operation,args', [('expire', ('k', 3)), ('incr', ('k', '1')), ('delete', (['k'],))])
def test_new_writes_report_unknown_and_are_not_retried(fake_store, operation, args):
    mock = MagicMock(side_effect=ConnectionError('credential:secret'))
    setattr(fake_store.client, {'expire': 'expire', 'incr': 'incrby', 'delete': 'delete'}[operation], mock)
    with pytest.raises(RedisNodeError) as err:
        getattr(fake_store, operation)(*args)
    assert err.value.outcome == 'unknown' and 'secret' not in str(err.value)
    assert mock.call_count == 1


def test_tls_url_and_prefix_rules():
    s = Settings.from_config({'host': 'rediss://redis.example:6380'})
    assert (s.host, s.port, s.use_tls) == ('redis.example', 6380, True)
    for host in [
        'rediss://u:secret@redis.example',
        'rediss://redis.example/0',
        'rediss://redis.example?x=1',
        'rediss://redis.example:0',
        'rediss://redis.example:65536',
        'redis://redis.example',
    ]:
        with pytest.raises(RedisNodeError):
            Settings.from_config({'host': host})
    for prefix in ['bad.dot:', 'bad*', '', 'x' * 129]:
        with pytest.raises(RedisNodeError):
            Settings.from_config({'key_prefix': prefix})
