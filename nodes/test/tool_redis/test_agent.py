# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Opt-in real-model acceptance: correct keys, arguments and exactly one call per request."""

import json
import os
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
import redis

MODEL = os.environ.get('ROCKETRIDE_REDIS_AGENT_MODEL', '')
PROVIDER = os.environ.get('ROCKETRIDE_REDIS_AGENT_PROVIDER', 'gemini')
URL = os.environ.get('REDIS_TEST_URL', '')
pytestmark = pytest.mark.skipif(
    not MODEL or not URL, reason='Set ROCKETRIDE_REDIS_AGENT_MODEL and REDIS_TEST_URL for live model acceptance'
)


@pytest.mark.asyncio
@pytest.mark.parametrize('attempt', range(3))
async def test_agent_performs_each_requested_operation_once(client, attempt):
    """Run all seven tools, including two legitimate increments in separate requests."""
    assert PROVIDER in ('gemini', 'ollama'), 'Select gemini or ollama with ROCKETRIDE_REDIS_AGENT_PROVIDER'
    sample = Path(__file__).parents[2] / 'src/nodes/tool_redis/agent-example.pipe'
    pipeline = json.loads(sample.read_text())
    pipeline['project_id'] = 'redis_agent_test_' + uuid.uuid4().hex
    pipeline['source'] = 'tools_1'
    pipeline['components'] = [
        node for node in pipeline['components'] if node['provider'] not in ('chat', 'response_answers')
    ]
    pipeline['components'].insert(0, {'id': 'tools_1', 'provider': 'tools', 'config': {}, 'input': []})
    agent = next(node for node in pipeline['components'] if node['provider'] == 'agent_llamaindex')
    agent['input'] = []
    agent['control'] = [{'classType': 'tool', 'from': 'tools_1'}]
    llm = next(node for node in pipeline['components'] if node['provider'] == 'llm_gemini')
    if PROVIDER == 'ollama':
        llm['provider'] = 'llm_ollama'
        llm['config'] = {
            'profile': 'custom',
            'serverbase': os.environ.get('ROCKETRIDE_REDIS_AGENT_URL', 'http://127.0.0.1:11434/v1'),
            'modelTotalTokens': 16384,
            'modelOutputTokens': 1024,
            'temperature': 0,
        }
    else:
        assert os.environ.get('ROCKETRIDE_GEMINI_KEY'), 'Set ROCKETRIDE_GEMINI_KEY in the engine environment'
    llm['config']['model'] = MODEL
    parts = urlsplit(URL)
    prefix = 'rr:agent-test:' + uuid.uuid4().hex + ':'
    store = next(node for node in pipeline['components'] if node['provider'] == 'tool_redis')
    store['config'].update(
        host=parts.hostname,
        port=parts.port or 6379,
        db=int(parts.path.strip('/') or 0),
        username=unquote(parts.username or ''),
        password=unquote(parts.password or ''),
        use_tls=parts.scheme == 'rediss',
        key_prefix=prefix,
        allow_writes=True,
    )
    direct = redis.Redis.from_url(URL, socket_connect_timeout=3, socket_timeout=3)
    checks = [
        (
            "Set Redis key 'message' to 'hello' with ttl_seconds 120. Perform only this operation and report the result.",
            'redis_set',
            {'stored': True},
        ),
        (
            "Get Redis key 'message'. Perform only this operation and report its value.",
            'redis_get',
            {'found': True, 'value': 'hello'},
        ),
        (
            "Get the TTL of Redis key 'message'. Perform only this operation and report it.",
            'redis_ttl',
            {'exists': True, 'has_expiry': True},
        ),
        (
            "Set the expiry of Redis key 'message' to 240 seconds using redis_expire. Perform only this operation.",
            'redis_expire',
            {'updated': True, 'requested_ttl_seconds': 240},
        ),
        (
            "Increment the Redis key 'counter' by 3 exactly once. Report the returned value.",
            'redis_incr',
            {'value_decimal': '3'},
        ),
        (
            "Increment the Redis key 'counter' by 3 exactly once again. This is a new requested increment. Report the returned value.",
            'redis_incr',
            {'value_decimal': '6'},
        ),
        (
            "Scan Redis once with cursor '0' and count 100. Report the keys and next cursor.",
            'redis_scan',
            {'cursor': '0', 'done': True},
        ),
        (
            "Delete the two explicit Redis keys 'message' and 'counter' in one redis_delete call. Report deleted_count.",
            'redis_delete',
            {'deleted_count': 2},
        ),
        (
            "Get Redis key 'missing'. Report found=false if it does not exist; do not retry.",
            'redis_get',
            {'found': False},
        ),
        (
            'Increment the Redis key counter by 3 exactly once and report the returned value.',
            'redis_incr',
            {'value_decimal': '3'},
        ),
    ]
    token = None
    try:
        run = await client.use(pipeline=pipeline)
        token = run['token']
        for query, tool, expected in checks:
            result = await client.tool(
                token=token, tool='run_agent', node_id=agent['id'], input={'query': query}, timeout=180000
            )
            trace = result['stack'][0]['payload']
            assert isinstance(trace, list), result
            actions = [step['action'] for step in trace]
            print(
                json.dumps({'attempt': attempt, 'model': MODEL, 'tool': tool, 'actions': actions, 'trace': trace}),
                flush=True,
            )
            assert result['meta']['tool_calls'] == 1 and actions == ['redis_1.' + tool], result
            observation = json.loads(trace[0]['observation'])
            assert observation['success'], result
            assert all(observation.get(field) == value for field, value in expected.items()), result
            args = trace[0]['action_input']
            if tool in ('redis_set', 'redis_get', 'redis_ttl', 'redis_expire'):
                assert args['key'] == ('missing' if expected.get('found') is False else 'message'), result
            if tool == 'redis_set':
                assert direct.get(prefix + 'message') == b'hello'
                assert 0 < direct.ttl(prefix + 'message') <= 120
            elif tool == 'redis_expire':
                assert 0 < direct.ttl(prefix + 'message') <= 240
            elif tool == 'redis_incr':
                assert args == {'key': 'counter', 'amount': '3'}, result
                assert direct.get(prefix + 'counter') == expected['value_decimal'].encode()
            elif tool == 'redis_scan':
                assert set(observation['keys']) == {'message', 'counter'}, result
            elif tool == 'redis_delete':
                assert set(args['keys']) == {'message', 'counter'}, result
                assert not direct.exists(prefix + 'message', prefix + 'counter')
    finally:
        try:
            if token:
                await client.terminate(token)
        finally:
            keys = list(direct.scan_iter(match=prefix + '*'))
            if keys:
                direct.delete(*keys)
            direct.close()
