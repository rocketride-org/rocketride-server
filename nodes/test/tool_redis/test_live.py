# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Opt-in real Redis and RocketRide dispatch tests; unique disposable keys."""

import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
import redis

from nodes.tool_redis.redis_client import RedisStore, Settings

URL = os.environ.get('REDIS_TEST_URL', '')
pytestmark = pytest.mark.skipif(not URL, reason='Set REDIS_TEST_URL for disposable live Redis tests')


@pytest.fixture
def live():
    client = redis.Redis.from_url(URL, decode_responses=False, socket_connect_timeout=3, socket_timeout=3)
    client.ping()
    prefix = 'rr:test:' + uuid.uuid4().hex + ':'
    store = RedisStore(
        client, Settings(key_prefix=prefix, allow_writes=True, default_ttl_seconds=30, max_value_bytes=32)
    )
    yield store, client, prefix
    try:
        keys = list(client.scan_iter(match=prefix + '*'))
        if keys:
            client.delete(*keys)
    finally:
        client.close()


def test_real_round_trip_and_expiry(live):
    store, _, _ = live
    assert store.get('k')['found'] is False
    assert store.set('k', '', ttl_seconds=0)['stored']
    assert store.get('k')['value'] == ''
    assert store.ttl('k')['ttl_seconds'] == -1
    assert not store.set('k', 'skip', condition='NX')['stored']
    assert store.set('k', 'blue', ttl_seconds=1, condition='XX')['stored']
    assert store.get('k')['value'] == 'blue'
    deadline = time.monotonic() + 3
    while store.ttl('k')['exists'] and time.monotonic() < deadline:
        time.sleep(0.05)
    assert store.get('k')['ttl_seconds'] == -2


def test_real_type_encoding_size_and_scope(live):
    store, client, prefix = live
    client.hset(prefix + 'hash', mapping={'field': 'v'})
    client.set(prefix + 'binary', b'\xff')
    client.set(prefix + 'large', b'x' * 33)
    from nodes.tool_redis.redis_client import RedisNodeError

    for key, code in [('hash', 'invalid_operation'), ('binary', 'invalid_encoding'), ('large', 'value_too_large')]:
        with pytest.raises(RedisNodeError) as exc:
            store.get(key)
        assert exc.value.code == code
    logical = prefix + 'already_prefixed'
    store.set(logical, 'literal')
    assert client.get(prefix + logical) == b'literal'
    assert client.get(logical) is None


@pytest.mark.asyncio
@pytest.mark.parametrize('allow_writes', [False, True])
async def test_engine_tool_round_trip(client, live, allow_writes):
    """Tools source -> tool.invoke -> real node -> Redis, with no model key."""
    _, direct, prefix = live
    parts = urlsplit(URL)
    config = {
        'host': parts.hostname or 'localhost',
        'port': parts.port or 6379,
        'db': int(parts.path.strip('/') or 0),
        'username': unquote(parts.username or ''),
        'password': unquote(parts.password or ''),
        'use_tls': parts.scheme == 'rediss',
        'key_prefix': prefix,
        'allow_writes': allow_writes,
    }
    pipeline = {
        'project_id': 'redis_test_' + uuid.uuid4().hex,
        'source': 'tools_1',
        'components': [
            {'id': 'tools_1', 'provider': 'tools', 'config': {}, 'input': []},
            {
                'id': 'redis_1',
                'provider': 'tool_redis',
                'config': config,
                'input': [],
                'control': [{'classType': 'tool', 'from': 'tools_1'}],
            },
        ],
    }
    result = await client.use(pipeline=pipeline)
    token = result['token']
    try:

        async def call(tool, **args):
            return await client.tool(token=token, tool=tool, node_id='redis_1', input=args)

        assert (await call('redis_get', key='k'))['found'] is False
        if not allow_writes:
            denied = await call('redis_set', key='k', value='blocked')
            assert not denied['success'] and denied['error_code'] == 'permission_denied'
            for name, args in [
                ('redis_expire', {'key': 'k', 'ttl_seconds': 1}),
                ('redis_incr', {'key': 'k'}),
                ('redis_delete', {'keys': ['k']}),
            ]:
                blocked = await call(name, **args)
                assert blocked['error_code'] == 'permission_denied'
            assert direct.get(prefix + 'k') is None
            assert (await call('redis_scan'))['success']
            direct.set(prefix + 'k', 'read-only-data', ex=30)
            assert (await call('redis_get', key='k'))['value'] == 'read-only-data'
            assert (await call('redis_ttl', key='k'))['exists']
            return
        assert (await call('redis_set', key='k', value='from-engine', ttl_seconds=30))['stored']
        assert direct.get(prefix + 'k') == b'from-engine'
        fetched = await call('redis_get', key='k')
        assert fetched['value'] == 'from-engine' and fetched['success']
        ttl = await call('redis_ttl', key='k')
        assert 0 <= ttl['ttl_seconds'] <= 30
        assert not (await call('redis_set', key='k', value='skip', condition='NX'))['stored']
        assert (await call('redis_expire', key='k', ttl_seconds=60))['updated']
        assert (await call('redis_incr', key='count', amount='9007199254740993'))['value_decimal'] == '9007199254740993'
        assert (await call('redis_incr', key='count', amount='-1'))['value_decimal'] == '9007199254740992'
        assert (await call('redis_scan', cursor='0', count=500))['success']
        assert (await call('redis_delete', keys=['k', 'count']))['deleted_count'] == 2
        # services.json is also consumed by this direct tool-dispatch harness:
        # the generic lane runner only validates configuration for pure tools.
        service = Path(__file__).parents[2] / 'src/nodes/tool_redis/services.json'
        for case in json.loads(service.read_text())['test']['cases']:
            actual = await call(case['tool'], **case['arguments'])
            assert actual['success'], actual
            for field, expected in case['expect_tool'].items():
                assert actual[field] == expected, (case['name'], actual)
        assert (await call('redis_expire', key='missing', ttl_seconds=0))['error_code'] == 'invalid_input'
        assert (await call('redis_delete', keys=['*']))['error_code'] == 'invalid_input'
        direct.set(prefix + 'bad', 'not-a-number')
        assert not (await call('redis_incr', key='bad'))['success']
        direct.set(prefix + 'huge', b'x' * 65537)
        assert (await call('redis_get', key='huge'))['error_code'] == 'value_too_large'

    finally:
        await client.terminate(token)


def test_real_concurrent_incr_and_nx(live):
    store, direct, prefix = live
    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(lambda _: store.incr('counter')['value_decimal'], range(100)))
        wins = list(workers.map(lambda _: store.set('winner', 'value', condition='NX')['stored'], range(20)))
    assert len(set(results)) == 100
    assert direct.get(prefix + 'counter') == b'100'
    assert sum(wins) == 1
    store.expire('counter', 60)
    store.incr('counter')
    assert 0 < store.ttl('counter')['ttl_seconds'] <= 60
    direct.set(prefix + 'max', str(2**63 - 1))
    from nodes.tool_redis.redis_client import RedisNodeError

    with pytest.raises(RedisNodeError):
        store.incr('max')
    assert direct.get(prefix + 'max') == str(2**63 - 1).encode()


def test_real_scan_full_walk(live):
    store, direct, prefix = live
    for i in range(20):
        store.set(str(i), 'value')
    cursor, found = '0', set()
    for _ in range(10000):
        page = store.scan(cursor, 1)
        found.update(page['keys'])
        cursor = page['cursor']
        if page['done']:
            break
    else:
        pytest.fail('SCAN did not finish')
    assert found == {str(i) for i in range(20)}


@pytest.mark.parametrize('url_var', ['REDIS_AUTH_TEST_URL', 'REDIS_TLS_TEST_URL'])
def test_real_auth_and_tls(monkeypatch, url_var):
    from nodes.tool_redis.IGlobal import create_client
    from nodes.tool_redis.redis_client import RedisNodeError, redis_call

    url = os.environ.get(url_var)
    if not url:
        pytest.skip(f'Set {url_var} for authentication/TLS integration')
    parts = urlsplit(url)
    cfg = dict(
        host=parts.hostname, port=parts.port, password=unquote(parts.password or ''), use_tls=parts.scheme == 'rediss'
    )
    # TLS endpoints in the fixture trust a test CA only through SSL_CERT_FILE.
    if cfg['use_tls']:
        ca = os.environ.get('REDIS_TLS_CA_FILE')
        if not ca:
            pytest.skip('Set REDIS_TLS_CA_FILE')
        monkeypatch.setenv('SSL_CERT_FILE', ca)
    client, pool = create_client(Settings.from_config(cfg))
    try:
        assert client.ping()
        assert pool.connection_kwargs['retry'].get_retries() == 0
    finally:
        client.close()
        pool.disconnect()
    cfg['password'] = 'incorrect-test-password'
    client, pool = create_client(Settings.from_config(cfg))
    try:
        with pytest.raises(RedisNodeError) as err:
            redis_call(client.ping)
        assert err.value.code == 'authentication_error'
    finally:
        client.close()
        pool.disconnect()
    if cfg['use_tls']:
        cfg['host'] = '127.0.0.1'  # test certificate has only DNS:localhost
        client, pool = create_client(Settings.from_config(cfg))
        try:
            with pytest.raises(RedisNodeError):
                redis_call(client.ping)
        finally:
            client.close()
            pool.disconnect()
        cfg['host'] = 'localhost'
        monkeypatch.setenv('SSL_CERT_FILE', '/nonexistent/redis-test-ca')
        client, pool = create_client(Settings.from_config(cfg))
        try:
            with pytest.raises(RedisNodeError):
                redis_call(client.ping)
        finally:
            client.close()
            pool.disconnect()


def test_real_acl_denies_mutation(live):
    from nodes.tool_redis.IGlobal import create_client
    from nodes.tool_redis.redis_client import RedisNodeError

    _, direct, prefix = live
    name = 'rrtest_' + uuid.uuid4().hex
    direct.acl_setuser(
        name,
        enabled=True,
        passwords=['+test-only'],
        keys=[prefix + '*'],
        commands=['+ping', '+ttl', '+getrange', '+multi', '+exec'],
    )
    parts = urlsplit(URL)
    client = pool = None
    try:
        client, pool = create_client(
            Settings(
                host=parts.hostname,
                port=parts.port or 6379,
                db=int(parts.path.strip('/') or 0),
                username=name,
                password='test-only',
                key_prefix=prefix,
                allow_writes=True,
            )
        )
        assert client.ping()
        with pytest.raises(RedisNodeError) as error:
            RedisStore(client, Settings(key_prefix=prefix, allow_writes=True)).set('blocked', 'v')
        assert error.value.code == 'permission_denied'
        assert error.value.outcome == 'not_applied'
        assert direct.get(prefix + 'blocked') is None
    finally:
        if client is not None:
            client.close()
        if pool is not None:
            pool.disconnect()
        direct.acl_deluser(name)
