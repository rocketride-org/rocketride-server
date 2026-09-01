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

from unittest.mock import MagicMock

import pytest

from ai.modules.task.task_server import TaskServer, TASK_CONTROL


def _make_server():
    """A TaskServer with no event loop, no ports, and no real account service."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts._server.account.generate_token.return_value = 'pk_public'
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
    """A TASK_CONTROL whose task reports itself as still running."""
    control = TASK_CONTROL()
    control.token = 'tk_test'
    control.id = 'abcd1234.src'
    control.project_id = 'project-1'
    control.source = 'src'
    control.provider = 'webhook'
    control.public_auth = 'pk_public'
    control.pipeline = pipeline
    control.task = MagicMock()
    control.task.is_task_complete.return_value = False
    return control


def _request(pipeline):
    return {
        'command': 'launch',
        'arguments': {'token': 'tk_test', 'pipeline': pipeline, 'useExisting': True},
    }


@pytest.mark.asyncio
async def test_reused_flag_marks_an_instance_that_was_already_running():
    ts = _make_server()
    ts._task_control['tk_test'] = _running(_pipeline())

    result = await ts.start_task(_request(_pipeline()), conn=MagicMock())

    assert result['reused'] is True
    assert result['token'] == 'tk_test'


@pytest.mark.asyncio
async def test_a_differing_pipeline_is_reported_as_ignored():
    ts = _make_server()
    ts._task_control['tk_test'] = _running(_pipeline(model='gpt-4.1-mini'))

    await ts.start_task(_request(_pipeline(model='claude-opus-5')), conn=MagicMock())

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' in said


@pytest.mark.asyncio
async def test_an_identical_pipeline_is_reused_without_the_notice():
    ts = _make_server()
    ts._task_control['tk_test'] = _running(_pipeline())

    result = await ts.start_task(_request(_pipeline()), conn=MagicMock())

    said = ' '.join(str(call) for call in ts.debug_message.call_args_list)
    assert 'ignoring the submitted pipeline' not in said
    assert result['reused'] is True
