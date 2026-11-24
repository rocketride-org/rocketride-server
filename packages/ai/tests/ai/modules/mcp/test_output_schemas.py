# Copyright 2026 Aparavi Software AG. MIT License.
"""Output schemas (tools/_results.py): the schemas, error envelopes, rare results and a validating client."""

import json

import pytest
from jsonschema import Draft202012Validator
from mcp.client import Client

from ai.modules.mcp.credentials import HOSTED_MODELS_CAPABILITY
from ai.modules.mcp.errors import _bad, _timeout, normalize_error
from ai.modules.mcp.handlers import build_mcp_server
from ai.modules.mcp.registry import TaskRegistry
from ai.modules.mcp.tooling import ToolRegistry, _local_engine_only_refusal
from ai.modules.mcp.tools import capability, register_all
from ai.modules.mcp.tools._results import ERROR_RESULT, RESULT_SCHEMAS

from .conftest import FAKE_DEPLOYMENT, FakeEngineClient

PIPE = {'source': 'a', 'components': []}
LOG = {'projectId': 'p', 'source': 's'}
EVENT = {'type': 'event', 'event': 'apaevt_flow', 'body': {'logSeq': 1, 'eventTime': 1.0}}
CLOSED = {'id': 3, 'beginSeq': 10, 'doc': 'parse', 'beginTime': 1.0, 'elapsed': 0.5, 'calls': 2, 'open': False}
OPEN = {'id': 4, 'beginSeq': 12, 'doc': None, 'beginTime': 3.0, 'open': True, 'touched': None}
NULLS = dict.fromkeys(['state', 'completedCount', 'failedCount', 'totalCount', 'errors', 'warnings'])
HOSTED = {'services': {'llm_openai': {'title': 'OpenAI'}}}


def _registry():
    registry = ToolRegistry(local_engine=True)
    register_all(registry)
    return registry


def _valid(name, payload):
    return Draft202012Validator(RESULT_SCHEMAS[name]).is_valid(payload)


async def _call(name, args, engine=None):
    return await _registry().handler(name)(engine or FakeEngineClient(), TaskRegistry(), args)


def test_every_tool_lists_its_union_schema():
    for tool in _registry().tools():
        assert tool.output_schema == RESULT_SCHEMAS[tool.name]
    for name, schema in RESULT_SCHEMAS.items():
        Draft202012Validator.check_schema(schema)
        assert schema['type'] == 'object', name
        assert schema['oneOf'][-1] == ERROR_RESULT, name


class _DapFailure(RuntimeError):
    dap_result = {'success': False, 'message': {'code': 7}}


async def test_every_error_envelope_matches_every_schema():
    envelopes = [
        _bad('m', 'h'),
        _timeout('m', 'h'),
        normalize_error(RuntimeError('x')),
        normalize_error(_DapFailure('x')),
        await _local_engine_only_refusal('send_files')(None, None, {}),
    ]
    async with Client(build_mcp_server(FakeEngineClient, local_engine=True)) as client:
        envelopes.append((await client.call_tool('no_such_tool', {})).structured_content)
    for name in RESULT_SCHEMAS:
        for envelope in envelopes:
            assert _valid(name, envelope), (name, envelope)
        assert not _valid(name, {'ok': False, 'message': 'x'}), name
        assert not _valid(name, {'ok': 'yes'}), name


@pytest.mark.parametrize(
    'name, args, key, value',
    [
        ('store_read', {'path': 'a.txt'}, 'content', 5),
        ('run_pipeline', {'pipeline': PIPE}, 'task_token', 1),
        ('validate_pipeline', {'pipeline': PIPE}, 'ok', 'false'),
        ('monitor', {'task_token': 't', 'timeout': 0}, 'state', 'x'),
        ('deploy_list', {}, 'count', 'x'),
        ('list_integrations', {'name': 'qdrant'}, 'status', 'bogus'),
    ],
)
async def test_a_real_result_with_one_wrong_value_is_rejected(name, args, key, value):
    assert not _valid(name, {**await _call(name, args), key: value})


# Results no other test produces. The conftest hook validates each one.
@pytest.mark.parametrize(
    'name, args, kwargs, attrs, ok',
    [
        ('monitor', {'task_token': 't', 'timeout': 0}, {'task_statuses': [NULLS]}, {}, True),
        ('deploy_list', {}, {}, {'deploy_results': {'list': {'rows': [FAKE_DEPLOYMENT], 'total': None}}}, True),
        ('deploy_versions', {'project_id': 'p'}, {}, {'deploy_results': {'versions': {'total': None}}}, True),
        ('validate_pipeline', {'pipeline': PIPE}, {'validate_result': {'errors': 'bad', 'warnings': {}}}, {}, False),
        ('log_chapters', LOG, {}, {'log_chapters_result': {'chapters': [{'beginSeq': 1, 'endTime': None}]}}, True),
        ('log_read', LOG, {}, {'log_read_result': {'events': [EVENT], 'nextSeq': 5, 'truncatedAtSeq': 4}}, True),
        ('log_traces', LOG, {}, {}, True),
        ('log_traces', {**LOG, 'teamId': 't'}, {}, {'log_traces_result': {'open': [OPEN], 'closed': [CLOSED]}}, True),
        ('log_trace', {**LOG, 'beginSeq': 1}, {}, {}, True),
        ('log_trace', {**LOG, 'beginSeq': '7'}, {}, {'log_trace_result': {'summary': CLOSED, 'events': []}}, True),
        ('describe_component', {'name': 'llm_openai'}, {'services': HOSTED}, {}, True),
        ('list_integrations', {}, {'services': HOSTED}, {}, True),
        ('list_integrations', {'name': 'llm_openai'}, {}, {}, True),
    ],
)
async def test_results_no_other_test_produces(name, args, kwargs, attrs, ok):
    engine = FakeEngineClient(capabilities=[HOSTED_MODELS_CAPABILITY], **kwargs)
    for attr, value in attrs.items():
        setattr(engine, attr, value)
    assert (await _call(name, args, engine))['ok'] is ok


async def test_team_deploy_warnings_match(monkeypatch):
    async def _warning(*args):
        return capability.TEAM_DEPLOY_WARNING

    monkeypatch.setattr(capability, '_team_deploy_warning', _warning)
    engine = FakeEngineClient()
    engine.deploy_results['add'] = {'artifact': None, 'deployment': FAKE_DEPLOYMENT}
    added = await _call('deploy_add', {'pipeline': PIPE, 'deploy_to': 't'}, engine)
    moved = await _call('deploy_to_team', {'project_id': 'p', 'version': 3, 'team_id': 't'}, engine)
    assert added['warnings'] == moved['warnings'] == [capability.TEAM_DEPLOY_WARNING]


async def test_a_validating_client_accepts_real_results():
    engine = FakeEngineClient(validate_result={'errors': [{'message': 'bad'}], 'warnings': []})
    async with Client(build_mcp_server(lambda: engine, local_engine=True)) as client:
        for name, args in [('list_components', {}), ('monitor', {'task_token': 't', 'timeout': 0})]:
            result = await client.call_tool(name, args)
            assert result.is_error is False, name
            assert json.loads(result.content[0].text) == result.structured_content
        result = await client.call_tool('run_pipeline', {'pipeline': PIPE, 'inputs': 'x'})
        rejected = await client.call_tool('validate_pipeline', {'pipeline': PIPE})
    assert result.structured_content['result'] == 'RESULT'
    assert rejected.is_error is True
    assert set(rejected.structured_content) == {'ok', 'errors', 'warnings'}
