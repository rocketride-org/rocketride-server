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

"""Unit tests for ai.modules.task.commands.cmd_cprofile.CProfileCommands.

Coverage focus: PROXY-MODE AUTHORIZATION. The proxy path forwards profiler
commands into a pipeline's engine subprocess, so the target lookup must
require ``task.control`` on the TARGET TASK'S team — a devTeam holder
must not be able to profile another team's engine (the cross-team hole this
suite pins closed). Direct mode (no target) keeps its devTeam check.

The profiler gate (plan 7.5): an engine profile is engine-level signal, so a
caller other than ``sys.admin``/``internal`` may profile only a ``@dev`` or
``@me`` control whose engine is private to its owner.

Same harness conventions as the sibling suites: __init__ bypassed via
``__new__``; ``_server``/``_account_info`` seeded; DAP helpers mocked.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands import cmd_cprofile
from ai.modules.task.commands.cmd_cprofile import CProfileCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, account_info=None, server=None, connection_id=7):
    """Build a CProfileCommands instance with __init__ bypassed."""
    conn = CProfileCommands.__new__(CProfileCommands)
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn._connection_id = connection_id
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.verify_permission = MagicMock()  # devTeam gate, granted by default
    return conn


def _account_info():
    """AccountInfo-shaped stub for an apikey session."""
    return SimpleNamespace(
        userId='user-1',
        auth='ak_x',
        userToken='token-user-1',
        devTeam='team-1',
        organization={'id': 'org-1', 'teams': [{'id': 'team-1', 'permissions': ['task.control']}]},
        sysPermissions=[],
    )


def _running_control(*, rung='dev', owner_id='user-1', engine_key='hash-1:user-1', shared=False):
    """TaskControl stub whose task is running and echoes _send_data calls."""
    task = SimpleNamespace(
        wait_for_running=AsyncMock(),
        _send_data=AsyncMock(return_value={'body': {'status': 'started'}}),
        engine_key=engine_key,
        shared=shared,
    )
    return SimpleNamespace(teamId='team-1', rung=rung, owner_id=owner_id, task=task, touch=MagicMock())


def _server_for(control):
    """A server stub that resolves ``control`` and hands back its running engine."""
    server = MagicMock()
    server.resolve_control = MagicMock(return_value=control)
    server.ensure_engine = AsyncMock(side_effect=lambda c: c.task)
    return server


# ---------------------------------------------------------------------------
# Proxy-mode authorization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_requires_task_control_on_the_targets_team():
    """The target lookup passes account_info + require='task.control' so
    authorization resolves against the TASK's team, not devTeam.
    """
    account = _account_info()
    server = _server_for(_running_control())
    conn = _make_conn(account_info=account, server=server)

    response = await CProfileCommands.on_rrext_cprofile_start(
        conn, {'arguments': {'target': 'acme.pipe.target', 'session': 's'}}
    )

    server.resolve_control.assert_called_once_with('acme.pipe.target', account, 'task.control')
    assert response['body'] == {'status': 'started'}


@pytest.mark.asyncio
async def test_proxy_is_activity_of_the_resolved_control():
    """A request into the engine restarts the idle clock of the control it came through."""
    control = _running_control()
    server = _server_for(control)
    conn = _make_conn(account_info=_account_info(), server=server)

    await CProfileCommands.on_rrext_cprofile_start(conn, {'arguments': {'target': 'acme.pipe.target', 'session': 's'}})

    control.touch.assert_called_once_with()


@pytest.mark.asyncio
async def test_proxy_cross_team_target_denied_before_forwarding():
    """A denied target lookup aborts BEFORE anything reaches the engine
    subprocess — the cross-team profiling hole this closes.
    """
    server = MagicMock()
    server.resolve_control = MagicMock(side_effect=PermissionError('denied for this task'))
    conn = _make_conn(account_info=_account_info(), server=server)

    with pytest.raises(PermissionError, match='denied for this task'):
        await CProfileCommands.on_rrext_cprofile_stop(conn, {'arguments': {'target': 'acme.pipe.other_team'}})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'handler',
    [
        CProfileCommands.on_rrext_cprofile_start,
        CProfileCommands.on_rrext_cprofile_stop,
        CProfileCommands.on_rrext_cprofile_status,
        CProfileCommands.on_rrext_cprofile_report,
        CProfileCommands.on_rrext_cprofile_report_tree,
        CProfileCommands.on_rrext_cprofile_threads,
    ],
)
async def test_every_proxy_handler_authorizes_the_target(handler):
    """All six cprofile handlers route proxy targets through the authorized
    lookup — none may keep an unchecked lookup of the target.
    """
    account = _account_info()
    server = _server_for(_running_control())
    conn = _make_conn(account_info=account, server=server)

    await handler(conn, {'arguments': {'target': 'acme.pipe.target'}})

    server.resolve_control.assert_called_once_with('acme.pipe.target', account, 'task.control')


# ---------------------------------------------------------------------------
# The profiler gate: a private engine or sys.admin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize('sys_permissions', [['sys.admin'], ['internal']])
@pytest.mark.parametrize(
    'shape',
    [
        {'rung': 'team', 'owner_id': 'team-1', 'engine_key': 'hash-1:team-1'},
        {'rung': 'public', 'owner_id': 'user-1', 'engine_key': 'hash-1', 'shared': True},
        {'rung': 'dev', 'owner_id': 'user-1', 'engine_key': 'hash-1', 'shared': True},
    ],
    ids=['team', 'public', 'shared-engine'],
)
async def test_operators_may_profile_any_engine(sys_permissions, shape):
    """sys.admin / internal profile @team, @public and cross-user engines."""
    control = _running_control(**shape)
    account = _account_info()
    account.sysPermissions = sys_permissions
    server = _server_for(control)
    conn = _make_conn(account_info=account, server=server)

    response = await CProfileCommands.on_rrext_cprofile_start(conn, {'arguments': {'target': 'acme.pipe.target'}})

    assert response['body'] == {'status': 'started'}
    control.task._send_data.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('rung', ['dev', 'me'])
async def test_an_owner_may_profile_their_own_private_engine(rung):
    """A plain user profiles their own @dev / @me control on a hash:owner engine."""
    control = _running_control(rung=rung, owner_id='user-1', engine_key='hash-1:user-1')
    server = _server_for(control)
    conn = _make_conn(account_info=_account_info(), server=server)

    response = await CProfileCommands.on_rrext_cprofile_start(conn, {'arguments': {'target': 'acme.pipe.target'}})

    assert response['body'] == {'status': 'started'}
    server.ensure_engine.assert_awaited_once_with(control)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'shape',
    [
        {'rung': 'team', 'owner_id': 'team-1', 'engine_key': 'hash-1:team-1'},
        {'rung': 'public', 'owner_id': 'user-1', 'engine_key': 'hash-1:user-1'},
        {'rung': 'dev', 'owner_id': 'user-1', 'engine_key': 'hash-1', 'shared': True},
        {'rung': 'me', 'owner_id': 'user-1', 'engine_key': 'hash-1:user-2'},
    ],
    ids=['team', 'public', 'shared-engine', 'another-owners-engine'],
)
async def test_a_plain_user_is_refused_anything_but_a_private_engine(shape):
    """@team, @public and shared engines are refused before anything reaches the engine."""
    control = _running_control(**shape)
    server = _server_for(control)
    conn = _make_conn(account_info=_account_info(), server=server)

    with pytest.raises(PermissionError, match='Profiling requires a private engine or sys.admin') as refused:
        await CProfileCommands.on_rrext_cprofile_start(conn, {'arguments': {'target': 'acme.pipe.target'}})

    assert refused.value.required == 'private engine or sys.admin'
    server.ensure_engine.assert_not_awaited()
    control.task._send_data.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_stopped_engine_is_started_again_before_the_profile():
    """The proxy profiles the engine ensure_engine hands back, not the stopped one."""
    control = _running_control()
    restarted = SimpleNamespace(
        wait_for_running=AsyncMock(),
        _send_data=AsyncMock(return_value={'body': {'status': 'started'}}),
    )
    server = _server_for(control)
    server.ensure_engine = AsyncMock(return_value=restarted)
    conn = _make_conn(account_info=_account_info(), server=server)

    await CProfileCommands.on_rrext_cprofile_start(conn, {'arguments': {'target': 'acme.pipe.target'}})

    restarted._send_data.assert_awaited_once()
    control.task._send_data.assert_not_awaited()


# ---------------------------------------------------------------------------
# Direct mode is untouched
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_direct_mode_does_not_touch_task_lookup():
    """Without a target, the local profiler runs and no task lookup happens."""
    server = MagicMock()
    conn = _make_conn(account_info=_account_info(), server=server)

    response = await CProfileCommands.on_rrext_cprofile_status(conn, {'arguments': {}})

    server.resolve_control.assert_not_called()
    assert 'active' in (response['body'] or {})


@pytest.mark.asyncio
async def test_direct_threads_checks_permission_and_lists():
    """The new verb is gated like the others and answers from the local profiler."""
    conn = _make_conn(account_info=_account_info())

    response = await CProfileCommands.on_rrext_cprofile_threads(conn, {'arguments': {}})

    conn.verify_permission.assert_called_once_with('task.control')
    assert 'threads' in (response['body'] or {})


@pytest.mark.asyncio
@pytest.mark.parametrize('arguments, expected', [({}, None), ({'thread': 0}, 0), ({'thread': 3}, 3)])
async def test_direct_report_tree_forwards_the_thread(monkeypatch, arguments, expected):
    """The thread argument reaches the profiler as sent, 0 included, else None."""
    report_tree = MagicMock(return_value={'tree': None})
    monkeypatch.setattr(cmd_cprofile.profiler, 'report_tree', report_tree)
    conn = _make_conn(account_info=_account_info())

    await CProfileCommands.on_rrext_cprofile_report_tree(conn, {'arguments': arguments})

    assert report_tree.call_args.kwargs['thread'] == expected
