# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the execution tools (`tools/execution.py`):
`run_pipeline`, `run_dropper_pipe`, `send_data`, `terminate`, `send_files`.
"""

import asyncio

import pytest

from ai.modules.mcp.registry import TaskRegistry
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import execution
from ai.modules.mcp.tools import register_all


# Minimal inline pipeline used everywhere a definition is required — the
# tools are inline-only (no server-side filepath reads by design).
PIPE = {'source': 'a', 'components': []}


# --- registration -----------------------------------------------------------


def test_register_all_registers_all_execution_tools():
    registry = ToolRegistry()

    register_all(registry)

    names = set(registry.names())
    assert {'run_pipeline', 'run_dropper_pipe', 'send_data', 'terminate', 'send_files'} <= names


def test_execution_register_binds_handlers_directly():
    registry = ToolRegistry()

    execution.register(registry)

    for name in ('run_pipeline', 'run_dropper_pipe', 'send_data', 'terminate', 'send_files'):
        assert registry.handler(name) is not None


# --- run_pipeline ------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_pipeline_requires_pipeline(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.used == []


@pytest.mark.asyncio
async def test_run_pipeline_returns_token_and_registers_it(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE})

    assert result == {'ok': True, 'task_token': fake_engine._token, 'projectId': 'proj-fake', 'source': 'src-fake'}
    assert fake_engine.used == [{'pipeline': PIPE, 'pipelineTraceLevel': 'summary'}]
    registered = tasks.get(fake_engine._token)
    assert registered is not None
    assert registered['pipeline_ref'] == '<inline>'


@pytest.mark.asyncio
async def test_run_pipeline_with_inline_pipeline_registers_inline_ref(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()
    pipeline = {'source': 'x', 'components': []}

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': pipeline})

    assert result['ok'] is True
    registered = tasks.get(fake_engine._token)
    assert registered['pipeline_ref'] == '<inline>'
    assert fake_engine.used == [{'pipeline': pipeline, 'pipelineTraceLevel': 'summary'}]


@pytest.mark.asyncio
async def test_run_pipeline_forwards_optional_kwargs(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_pipeline')(
        fake_engine,
        tasks,
        {'pipeline': PIPE, 'ttl': 30, 'use_existing': True, 'source': 'src', 'threads': 4},
    )

    assert fake_engine.used == [
        {
            'pipeline': PIPE,
            'ttl': 30,
            'use_existing': True,
            'source': 'src',
            'threads': 4,
            'pipelineTraceLevel': 'summary',
        }
    ]


@pytest.mark.asyncio
async def test_run_pipeline_with_inputs_also_sends_and_returns_result(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE, 'inputs': 'hello world'})

    assert result['ok'] is True
    assert result['task_token'] == fake_engine._token
    assert result['result'] == fake_engine._result
    assert result['projectId'] == 'proj-fake'
    assert result['source'] == 'src-fake'
    assert fake_engine.sent == [{'token': fake_engine._token, 'data': 'hello world', 'objinfo': None, 'mimetype': None}]
    # One-shot run completed synchronously -- the token must not leak in the registry (#1).
    assert tasks.get(fake_engine._token) is None


@pytest.mark.asyncio
async def test_run_pipeline_without_inputs_does_not_call_send(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE})

    assert 'result' not in result
    assert fake_engine.sent == []
    # No inputs -> long-lived run -- the token stays registered for later monitor/send_data/terminate calls.
    assert tasks.get(fake_engine._token) is not None


# --- send_data ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_data_requires_token(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_data')(fake_engine, tasks, {'input': 'x'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.sent == []


@pytest.mark.asyncio
async def test_send_data_requires_input(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_data')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.sent == []


@pytest.mark.asyncio
async def test_send_data_returns_result(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_data')(fake_engine, tasks, {'task_token': 'tok-1', 'input': 'payload'})

    assert result == {'ok': True, 'result': fake_engine._result}
    assert fake_engine.sent == [{'token': 'tok-1', 'data': 'payload', 'objinfo': None, 'mimetype': None}]


@pytest.mark.asyncio
async def test_send_data_accepts_token_and_data_aliases(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_data')(fake_engine, tasks, {'token': 'tok-2', 'data': 'payload2'})

    assert result['ok'] is True
    assert fake_engine.sent == [{'token': 'tok-2', 'data': 'payload2', 'objinfo': None, 'mimetype': None}]


@pytest.mark.asyncio
async def test_send_data_times_out(fake_engine, monkeypatch):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    async def _hang(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(fake_engine, 'send', _hang)
    # Shrink the budget so asyncio.wait_for itself produces the timeout —
    # proving the seam call is actually wrapped, not just that a raised
    # TimeoutError is converted.
    monkeypatch.setattr(execution, 'DEFAULT_TIMEOUT_SECONDS', 0.01)

    result = await registry.handler('send_data')(fake_engine, tasks, {'task_token': 'tok-1', 'input': 'payload'})

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


# --- terminate -----------------------------------------------------------


@pytest.mark.asyncio
async def test_terminate_requires_token(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('terminate')(fake_engine, tasks, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.terminated == []


@pytest.mark.asyncio
async def test_terminate_calls_seam_and_removes_from_registry(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('terminate')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result == {'ok': True, 'terminated': 'tok-1'}
    assert fake_engine.terminated == ['tok-1']
    assert tasks.get('tok-1') is None


# --- send_files ------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_files_requires_token(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_files')(fake_engine, tasks, {'files': ['/tmp/a.pdf']})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.sent_files == []


@pytest.mark.asyncio
async def test_send_files_rejects_empty_files(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('send_files')(fake_engine, tasks, {'task_token': 'tok-1', 'files': []})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.sent_files == []


@pytest.mark.asyncio
async def test_send_files_calls_seam_with_files_then_token_order(fake_engine):
    """Footgun: SDK arg order is (files, token) -- token second, not first."""
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()
    files = ['/tmp/a.pdf', '/tmp/b.pdf']

    result = await registry.handler('send_files')(fake_engine, tasks, {'task_token': 'tok-1', 'files': files})

    assert result == {'ok': True, 'result': {'uploaded': 2}}
    assert fake_engine.sent_files == [{'files': files, 'token': 'tok-1'}]


# --- run_dropper_pipe --------------------------------------------------------


def test_register_all_includes_run_dropper_pipe():
    registry = ToolRegistry()
    register_all(registry)
    assert 'run_dropper_pipe' in set(registry.names())


@pytest.mark.asyncio
async def test_run_dropper_pipe_requires_pipeline(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_dropper_pipe')(fake_engine, tasks, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.used == []


@pytest.mark.asyncio
async def test_run_dropper_pipe_returns_self_contained_upload_url(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE})

    assert result['ok'] is True
    assert result['task_token'] == fake_engine._token
    # pk_ only: /task/data resolves the task from the public key, and the tk_
    # control token must never ride in a URL (access logs, Referer, history).
    assert result['upload_url'] == (f'{fake_engine.base_url}/task/data?auth={fake_engine._public_token}')
    assert fake_engine._token not in result['upload_url']
    assert result['dropper_url'] == (f'{fake_engine.base_url}/dropper?auth={fake_engine._public_token}')
    assert result['projectId'] == 'proj-fake'
    assert result['source'] == 'src-fake'
    # token tracked so monitor/terminate work against it
    assert tasks.get(fake_engine._token) is not None


@pytest.mark.asyncio
async def test_run_dropper_pipe_forwards_kwargs_and_never_inline_sends(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_dropper_pipe')(
        fake_engine,
        tasks,
        {'pipeline': PIPE, 'ttl': 30, 'use_existing': True, 'source': 'src', 'threads': 4, 'inputs': 'ignored'},
    )

    # `inputs` is NOT forwarded and NO send() happens -- this tool never inline-sends.
    assert fake_engine.used == [
        {
            'pipeline': PIPE,
            'ttl': 30,
            'use_existing': True,
            'source': 'src',
            'threads': 4,
            'pipelineTraceLevel': 'summary',
        }
    ]
    assert fake_engine.sent == []


@pytest.mark.asyncio
async def test_run_dropper_pipe_bad_request_when_engine_omits_public_token(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()
    fake_engine._public_token = None  # simulate an engine response missing publicToken

    result = await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    # no null-keyed task leaked into the registry
    assert tasks.get(None) is None
    # the already-started task is torn down, not orphaned until its ttl
    assert fake_engine.terminated == ['tok-1']


# --- pipelineTraceLevel passthrough --------------------------------------


@pytest.mark.asyncio
async def test_run_pipeline_forwards_pipeline_trace_level(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE, 'pipelineTraceLevel': 'full'})

    assert fake_engine.used == [{'pipeline': PIPE, 'pipelineTraceLevel': 'full'}]


@pytest.mark.asyncio
async def test_run_dropper_pipe_forwards_pipeline_trace_level(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE, 'pipelineTraceLevel': 'summary'})

    assert fake_engine.used == [{'pipeline': PIPE, 'pipelineTraceLevel': 'summary'}]


@pytest.mark.asyncio
async def test_run_pipeline_missing_token_is_bad_request(fake_engine, monkeypatch):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    async def _no_token(**kwargs):
        return {}

    monkeypatch.setattr(fake_engine, 'use', _no_token)

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'


# --- projectId/source and trace level defaults ---


@pytest.mark.asyncio
async def test_run_pipeline_returns_project_id_and_source(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE})

    assert result['projectId'] == 'proj-fake'
    assert result['source'] == 'src-fake'


@pytest.mark.asyncio
async def test_run_pipeline_defaults_trace_level_to_summary(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE})

    assert fake_engine.used[0]['pipelineTraceLevel'] == 'summary'


@pytest.mark.asyncio
async def test_run_pipeline_explicit_none_wins(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': PIPE, 'pipelineTraceLevel': 'none'})

    assert fake_engine.used[0]['pipelineTraceLevel'] == 'none'


@pytest.mark.asyncio
async def test_run_dropper_pipe_returns_project_id_and_source(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    result = await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE})

    assert result['projectId'] == 'proj-fake'
    assert result['source'] == 'src-fake'


@pytest.mark.asyncio
async def test_run_dropper_pipe_defaults_trace_level_to_summary(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE})

    assert fake_engine.used[0]['pipelineTraceLevel'] == 'summary'


@pytest.mark.asyncio
async def test_run_dropper_pipe_explicit_none_wins(fake_engine):
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    await registry.handler('run_dropper_pipe')(fake_engine, tasks, {'pipeline': PIPE, 'pipelineTraceLevel': 'none'})

    assert fake_engine.used[0]['pipelineTraceLevel'] == 'none'


@pytest.mark.asyncio
async def test_run_pipeline_initial_send_timeout_keeps_token_registered(fake_engine, monkeypatch):
    """The initial-send Timeout envelope must carry the token in its hint and
    leave the token registered so the caller can recover the still-running task.
    """
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    async def _hang(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(fake_engine, 'send', _hang)
    monkeypatch.setattr(execution, 'DEFAULT_TIMEOUT_SECONDS', 0.01)

    result = await registry.handler('run_pipeline')(
        fake_engine, tasks, {'pipeline': {'components': []}, 'inputs': 'hello'}
    )

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'
    assert fake_engine._token in result['hint']
    assert tasks.get(fake_engine._token) is not None


@pytest.mark.asyncio
async def test_run_pipeline_use_timeout_registers_no_token(fake_engine, monkeypatch):
    """The use() timeout branch: distinct envelope, and no token registered
    (unlike the initial-send branch, there is no token to recover yet).
    """
    registry = ToolRegistry()
    execution.register(registry)
    tasks = TaskRegistry()

    async def _hang(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(fake_engine, 'use', _hang)
    monkeypatch.setattr(execution, 'DEFAULT_TIMEOUT_SECONDS', 0.01)

    result = await registry.handler('run_pipeline')(fake_engine, tasks, {'pipeline': {'components': []}})

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'
    assert 'start the task' in result['message']
    assert tasks.list() == []
