# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
useExisting returns a live instance instead of starting the submitted pipeline.

The caller has to be able to tell the two apart: a run against stale
configuration is otherwise indistinguishable from a run of what was just sent,
and reads as a successful measurement of the wrong thing.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.models import AccountInfo
from ai.modules.task.task_control import TaskControl
from ai.modules.task.task_server import ControlRegistry, EngineRegistry, TaskServer

ADDRESS = 'acme.project-1.src'
KEY = f'dev.user-1.{ADDRESS}'
# The identity every launch in this module runs as.
IDENTITY = dict(client_id='user-1', user_id='user-1', team_id='team-1', org_id='org-1', developer_id='acme')


def _make_server():
    """A TaskServer with no event loop, no ports, and no real account service."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = ControlRegistry()
    ts._engines = EngineRegistry()
    ts._engine_unavailable = {}
    ts._control_starts = {}
    ts._engine_restarts = {}
    ts._restart_tasks = set()
    ts._control_expiry = []
    ts._engine_expiry = []
    ts._expiry_gen = 0
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts.debug_message = MagicMock()
    return ts


def _pipeline(model='gpt-4.1-mini'):
    return {
        'project_id': 'project-1',
        'source': 'src',
        'components': [
            {'id': 'src', 'provider': 'webhook', 'config': {}},
            {'id': 'llm', 'provider': 'llm_openai', 'config': {'model': model}},
        ],
    }


def _running(pipeline):
    """A TaskControl whose task reports itself as still running, owned by user-1."""
    control = TaskControl()
    control.key = KEY
    control.address = ADDRESS
    control.id = ADDRESS
    control.developer_id = 'acme'
    control.userId = 'user-1'
    control.teamId = 'team-1'
    control.run_kind = 'dev'
    control.owner_kind = 'user'
    control.project_id = 'project-1'
    control.source = 'src'
    control.provider = 'webhook'
    control.pipeline = pipeline
    control.task = MagicMock()
    control.task.is_task_complete.return_value = False
    # A private engine this control holds alone: restartable in place
    control.task.shared = False
    control.task.holds = frozenset({KEY})
    return control


def _owner():
    """The owner's session: a restart resolves the address under it."""
    return AccountInfo(
        auth='rr_key',
        userId='user-1',
        organization={'id': 'org-1', 'name': '', 'permissions': [], 'teams': [], 'developerId': 'acme'},
    )


def _request(pipeline):
    return {
        'command': 'launch',
        'arguments': {'pipeline': pipeline, 'useExisting': True},
    }


@pytest.mark.asyncio
async def test_reused_flag_marks_an_instance_that_was_already_running():
    ts = _make_server()
    ts._task_control[KEY] = _running(_pipeline())

    result = await ts.start_task(_request(_pipeline()), conn=MagicMock(), **IDENTITY)

    assert result['reused'] is True
    assert result['token'] == ADDRESS


@pytest.mark.asyncio
async def test_a_differing_pipeline_is_reported_as_ignored():
    ts = _make_server()
    ts._task_control[KEY] = _running(_pipeline(model='gpt-4.1-mini'))

    await ts.start_task(_request(_pipeline(model='claude-opus-5')), conn=MagicMock(), **IDENTITY)

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' in said


@pytest.mark.asyncio
async def test_an_identical_pipeline_is_reused_without_the_notice():
    ts = _make_server()
    ts._task_control[KEY] = _running(_pipeline())

    result = await ts.start_task(_request(_pipeline()), conn=MagicMock(), **IDENTITY)

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' not in said
    assert result['reused'] is True


@pytest.mark.asyncio
async def test_the_restarted_pipeline_is_what_a_later_reuse_compares_against():
    """
    restart(P2) then use(P2, useExisting) must not report a difference.

    That is the documented way to apply new configuration to a live token, so
    the control has to describe what is running. Left stale, the flow warns
    about the pipeline that is actually loaded and stays silent about the one
    that is not — exactly backwards.
    """
    ts = _make_server()
    control = _running(_pipeline(model='gpt-4.1-mini'))
    control.teamId = ''
    ts._task_control[KEY] = control
    control.task.restart_task = AsyncMock()
    control.task.has_attached_debugger.return_value = False

    restarted = _pipeline(model='claude-opus-5')
    conn = MagicMock()
    conn._account_info = _owner()
    await ts.restart_task({'arguments': {'token': ADDRESS, 'pipeline': restarted}}, conn=conn)

    assert control.pipeline == restarted

    ts.debug_message.reset_mock()
    await ts.start_task(_request(restarted), conn=MagicMock(), **IDENTITY)
    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' not in said


@pytest.mark.asyncio
async def test_a_restart_stores_the_pipeline_in_the_shape_a_launch_would():
    """
    A launch stamps `source` and gives the source component a config. A restart
    that stores the raw request would differ from the same pipeline after a
    launch normalises it, so the comparison would report a difference that the
    launch itself introduced.
    """
    ts = _make_server()
    control = _running(_pipeline())
    control.teamId = ''
    ts._task_control[KEY] = control
    control.task.restart_task = AsyncMock()
    control.task.has_attached_debugger.return_value = False

    # As a caller would write it: no config on the source node.
    raw = {
        'project_id': 'project-1',
        'source': 'src',
        'components': [{'id': 'src', 'provider': 'webhook'}, {'id': 'llm', 'provider': 'llm_openai'}],
    }
    conn = MagicMock()
    conn._account_info = _owner()
    await ts.restart_task({'arguments': {'token': ADDRESS, 'pipeline': raw}}, conn=conn)

    assert control.pipeline['source'] == 'src'
    assert control.pipeline['components'][0]['config'] == {}

    # The same pipeline submitted again must not read as different.
    ts.debug_message.reset_mock()
    resubmitted = {
        'project_id': 'project-1',
        'source': 'src',
        'components': [{'id': 'src', 'provider': 'webhook'}, {'id': 'llm', 'provider': 'llm_openai'}],
    }
    await ts.start_task(
        {'command': 'launch', 'arguments': {'pipeline': resubmitted, 'useExisting': True}},
        conn=MagicMock(),
        **IDENTITY,
    )
    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' not in said


@pytest.mark.asyncio
async def test_an_invalid_pipeline_is_refused_before_the_task_is_stopped():
    """
    Normalisation doubles as validation, so it has to happen first.

    Rejecting after the restart would leave the task stopped, TaskEngine.restart_task
    holding the new pipeline, and control.pipeline still naming the old one —
    three views of the world, none of them running.
    """
    ts = _make_server()
    original = _pipeline()
    control = _running(original)
    control.teamId = ''
    ts._task_control[KEY] = control
    control.task.restart_task = AsyncMock()
    control.task.has_attached_debugger.return_value = False

    # The source component the control names is not in this pipeline.
    broken = {'project_id': 'project-1', 'components': [{'id': 'other', 'provider': 'webhook'}]}
    conn = MagicMock()
    conn._account_info = _owner()
    with pytest.raises(ValueError):
        await ts.restart_task({'arguments': {'token': ADDRESS, 'pipeline': broken}}, conn=conn)

    control.task.restart_task.assert_not_awaited()
    assert control.pipeline is original, 'the record still describes what is running'


@pytest.mark.asyncio
async def test_a_restart_cannot_change_the_source():
    """
    The source is part of the task's identity, as restart_task documents.

    _apply_source_defaults stamps the control's source onto the pipeline, so a
    request naming a different one would be silently overwritten — the caller
    would believe it had switched source and be told nothing.
    """
    ts = _make_server()
    control = _running(_pipeline())
    control.teamId = ''
    ts._task_control[KEY] = control
    control.task.restart_task = AsyncMock()
    control.task.has_attached_debugger.return_value = False

    other_source = {
        'project_id': 'project-1',
        'source': 'llm',  # a real component, but not the one this task runs
        'components': [{'id': 'src', 'provider': 'webhook'}, {'id': 'llm', 'provider': 'llm_openai'}],
    }
    conn = MagicMock()
    conn._account_info = _owner()
    with pytest.raises(ValueError, match='source'):
        await ts.restart_task({'arguments': {'token': ADDRESS, 'pipeline': other_source}}, conn=conn)

    control.task.restart_task.assert_not_awaited()
