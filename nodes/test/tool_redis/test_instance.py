# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Instance contracts and regressions."""

from pathlib import Path

import pytest
from pydantic import BaseModel
from redis.exceptions import (
    AuthenticationError,
    AuthorizationError,
    ConnectionError,
    DataError,
    MaxConnectionsError,
    ResponseError,
    TimeoutError,
)
from nodes.tool_redis.redis_client import (
    MAX_TTL_SECONDS,
    RedisStore,
    Settings,
)
from ._fixtures import tool_for


@pytest.mark.parametrize('key', ['', None, 1, True, '\ud800', 'é' * 600])
@pytest.mark.parametrize('method', ['redis_get', 'redis_ttl', 'redis_set'])
def test_bad_keys_touch_no_redis(tool, client, key, method):
    args = {'key': key}
    if method == 'redis_set':
        args['value'] = 'ok'
    assert getattr(tool, method)(args)['success'] is False
    assert client.mock_calls == []


@pytest.mark.parametrize('raw,code', [(b'x' * 9, 'value_too_large'), (b'\xff', 'invalid_encoding')])
def test_bad_stored_values(tool, client, raw, code):
    client.pipeline.return_value.execute.return_value = [raw, -1]
    assert tool.redis_get({'key': 'k'})['error_code'] == code


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
    tool = tool_for(RedisStore(client, Settings()))
    result = tool.redis_set({'key': 'k', 'value': 'v'})
    assert result['error_code'] == 'permission_denied'
    assert client.mock_calls == []
    client.ttl.return_value = -1
    assert tool.redis_ttl({'key': 'k'})['success']
    client.pipeline.return_value.execute.return_value = [b'v', -1]
    assert tool.redis_get({'key': 'k'})['value'] == 'v'


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


@pytest.mark.parametrize('error_type', [ValueError, RuntimeError])
def test_scan_rejects_failed_model_conversion(tool, client, error_type):
    class InvalidInput:
        def model_dump(self):
            raise error_type('credential:secret')

    result = tool.redis_scan(InvalidInput())
    assert result['error_code'] == 'invalid_input'
    assert 'secret' not in str(result)
    assert client.mock_calls == []


def test_local_credentials_are_optional_in_editor():
    """A property is required only when it says so; the credential catalog reads an env property as required unless it says false."""
    import json
    from pathlib import Path

    service = Path(__file__).parents[2] / 'src/nodes/tool_redis/services.json'
    fields = json.loads(service.read_text())['propertyDefinitions']
    assert fields['tool_redis.username'].get('required') is not True
    assert fields['tool_redis.password']['required'] is False
    assert fields['tool_redis.password']['secret'] is True
    assert fields['tool_redis.password']['env'] == 'ROCKETRIDE_REDIS_PASSWORD'


def test_example_declares_source_for_development_panel():
    import json
    from pathlib import Path

    example = Path(__file__).parents[2] / 'src/nodes/tool_redis/example.pipe'
    pipeline = json.loads(example.read_text())
    source = next(c for c in pipeline['components'] if c['id'] == pipeline['source'])
    assert source['provider'] == 'tools'
    assert source['config']['mode'] == 'Source'


def test_agent_omitted_optional_arguments_use_defaults(fake_store):
    class SetInput(BaseModel):
        key: str = 'k'
        value: str = 'value'
        ttl_seconds: int | None = None
        condition: str | None = None

    tool = tool_for(fake_store)

    result = tool.redis_set(SetInput().model_dump())
    assert result['success'] and result['stored']
    assert result['requested_ttl_seconds'] == fake_store.settings.default_ttl_seconds
    result = tool.redis_incr({'key': 'counter', 'amount': None})
    assert result['success'] and result['value_decimal'] == '1'
    result = tool.redis_scan({'input': {'cursor': '0', 'count': None}})
    assert result['success'] and result['done']
    assert set(result['keys']) == {'k', 'counter'}
    assert tool.redis_scan({'cursor': None, 'count': None})['success']


def test_null_required_and_unknown_arguments_are_still_invalid(fake_store):
    tool = tool_for(fake_store)

    assert tool.redis_set({'key': 'k', 'value': None})['error_code'] == 'invalid_input'
    assert tool.redis_scan({'unexpected': None})['error_code'] == 'invalid_input'
    assert fake_store.client._kv == {}


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
    # The config is addressed by leaf path: host is a root leaf, not a key of a profile block
    assert redis_node['config']['host'] == '127.0.0.1'
