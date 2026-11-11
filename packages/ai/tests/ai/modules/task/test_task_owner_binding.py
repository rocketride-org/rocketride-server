# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""A run belongs to its owner: naming it never reuses or replaces another owner's run.

Develop's #2988 pinned this for caller-supplied task tokens. Tokens are gone
(a run is addressed by ``developerId.pipelineId.source`` and keyed
``runKind.ownerId.address``), so the same guarantees are pinned on the
address model:

- a caller cannot name a registry key (``token`` is refused on execute);
- another user's run of the same address is a different control: it is
  neither reused (``useExisting``) nor replaced once it finishes;
- a personal (@me) deploy and the same user's dev run of the same address are
  different controls;
- the owner still reuses its own live run.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.task_engine import Task
from ai.modules.task.task_server import TASK_CONTROL, TaskServer
from ai.modules.task.types import TaskError

ADDRESS = 'acme.proj-tk.src'

PIPELINE = {
    'project_id': 'proj-tk',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'webhook', 'config': {}}],
}


# =============================================================================
# Helpers
# =============================================================================


@pytest.fixture
def no_launch(monkeypatch):
    """The run is "up": the subprocess launch is not under test."""

    async def _start(self, *args, **kwargs):
        return None

    monkeypatch.setattr(Task, 'start_task', _start)


def _server():
    """A TaskServer with ``__init__`` bypassed and no real account service."""
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
    ts.debug_message = MagicMock()
    ts._debug_task_started = lambda *args: None
    return ts


def _request(**arguments):
    return {'command': 'execute', 'arguments': {'pipeline': json.loads(json.dumps(PIPELINE)), **arguments}}


async def _start(ts, user_id='user-1', run_kind='dev', owner_kind='', **arguments):
    return await ts.start_task(
        _request(**arguments),
        MagicMock(),
        client_id=user_id,
        user_id=user_id,
        team_id='team-1',
        org_id='org-1',
        run_kind=run_kind,
        owner_kind=owner_kind,
        developer_id='acme',
    )


def _live_run(user_id='user-1', complete=False):
    """A registered dev run of ADDRESS owned by ``user_id``."""
    control = TASK_CONTROL()
    control.client_id = user_id
    control.userId = user_id
    control.teamId = 'team-1'
    control.orgId = 'org-1'
    control.run_kind = 'dev'
    control.owner_kind = 'user'
    control.developer_id = 'acme'
    control.pipeline = json.loads(json.dumps(PIPELINE))
    control.source = 'src'
    control.provider = 'webhook'
    control.project_id = 'proj-tk'
    control.address = ADDRESS
    control.id = ADDRESS
    control.key = f'dev.{user_id}.{ADDRESS}'
    control.task = SimpleNamespace(
        is_task_complete=lambda: complete,
        wait_for_running=AsyncMock(),
        stop_task=AsyncMock(),
    )
    return control


# =============================================================================
# A run is bound to its owner
# =============================================================================


@pytest.mark.asyncio
async def test_another_users_session_cannot_reuse_a_run_by_naming_its_key():
    ts = _server()
    control = _live_run(user_id='user-1')
    ts._task_control[control.key] = control

    with pytest.raises(TaskError) as excinfo:
        await _start(ts, user_id='user-2', useExisting=True, token=control.key)
    assert excinfo.value.field == 'token'
    control.task.wait_for_running.assert_not_awaited()
    assert ts._task_control == {control.key: control}


@pytest.mark.asyncio
async def test_another_users_session_does_not_reuse_a_run_of_the_same_address(no_launch):
    ts = _server()
    control = _live_run(user_id='user-1')
    ts._task_control[control.key] = control

    result = await _start(ts, user_id='user-2', useExisting=True)
    assert result['reused'] is False
    assert ts._task_control[control.key] is control
    assert ts._task_control[f'dev.user-2.{ADDRESS}'].userId == 'user-2'
    control.task.wait_for_running.assert_not_awaited()


@pytest.mark.asyncio
async def test_another_user_cannot_take_over_a_finished_run(no_launch):
    ts = _server()
    control = _live_run(user_id='user-1', complete=True)
    ts._task_control[control.key] = control

    await _start(ts, user_id='user-2')
    assert ts._task_control[control.key] is control
    assert f'dev.user-2.{ADDRESS}' in ts._task_control


@pytest.mark.asyncio
async def test_a_personal_deploy_does_not_reuse_the_same_users_dev_run(no_launch):
    """Same user and address, different run_kind: a different control."""
    ts = _server()
    control = _live_run(user_id='user-1')
    ts._task_control[control.key] = control

    result = await _start(ts, user_id='user-1', run_kind='deploy', owner_kind='user', useExisting=True)
    assert result['reused'] is False
    assert ts._task_control[control.key] is control
    assert f'deploy.user-1.{ADDRESS}' in ts._task_control
    control.task.wait_for_running.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_owner_still_reuses_its_run():
    ts = _server()
    control = _live_run(user_id='user-1')
    ts._task_control[control.key] = control

    result = await _start(ts, user_id='user-1', useExisting=True)
    assert result['reused'] is True and result['token'] == ADDRESS
