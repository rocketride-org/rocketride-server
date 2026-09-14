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

Same harness conventions as the sibling suites: __init__ bypassed via
``__new__``; ``_server``/``_account_info`` seeded; DAP helpers mocked.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

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


def _running_control():
    """TASK_CONTROL stub whose task is running and echoes _send_data calls."""
    task = SimpleNamespace(
        wait_for_running=AsyncMock(),
        _send_data=AsyncMock(return_value={'body': {'status': 'started'}}),
    )
    return SimpleNamespace(teamId='team-1', task=task)


# ---------------------------------------------------------------------------
# Proxy-mode authorization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_requires_task_control_on_the_targets_team():
    """The target lookup passes account_info + require='task.control' so
    authorization resolves against the TASK's team, not devTeam.
    """
    account = _account_info()
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_running_control())
    conn = _make_conn(account_info=account, server=server)

    response = await CProfileCommands.on_rrext_cprofile_start(
        conn, {'arguments': {'target': 'tk_target', 'session': 's'}}
    )

    server.get_task_control.assert_called_once_with('tk_target', account, require='task.control')
    assert response['body'] == {'status': 'started'}


@pytest.mark.asyncio
async def test_proxy_cross_team_target_denied_before_forwarding():
    """A denied target lookup aborts BEFORE anything reaches the engine
    subprocess — the cross-team profiling hole this closes.
    """
    server = MagicMock()
    server.get_task_control = MagicMock(side_effect=PermissionError('denied for this task'))
    conn = _make_conn(account_info=_account_info(), server=server)

    with pytest.raises(PermissionError, match='denied for this task'):
        await CProfileCommands.on_rrext_cprofile_stop(conn, {'arguments': {'target': 'tk_other_team'}})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'handler',
    [
        CProfileCommands.on_rrext_cprofile_start,
        CProfileCommands.on_rrext_cprofile_stop,
        CProfileCommands.on_rrext_cprofile_status,
        CProfileCommands.on_rrext_cprofile_report,
        CProfileCommands.on_rrext_cprofile_report_tree,
    ],
)
async def test_every_proxy_handler_authorizes_the_target(handler):
    """All five cprofile handlers route proxy targets through the authorized
    lookup — none may keep the old unchecked get_task_control(target) form.
    """
    account = _account_info()
    server = MagicMock()
    server.get_task_control = MagicMock(return_value=_running_control())
    conn = _make_conn(account_info=account, server=server)

    await handler(conn, {'arguments': {'target': 'tk_target'}})

    server.get_task_control.assert_called_once_with('tk_target', account, require='task.control')


# ---------------------------------------------------------------------------
# Direct mode is untouched
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_direct_mode_does_not_touch_task_lookup():
    """Without a target, the local profiler runs and no task lookup happens."""
    server = MagicMock()
    conn = _make_conn(account_info=_account_info(), server=server)

    response = await CProfileCommands.on_rrext_cprofile_status(conn, {'arguments': {}})

    server.get_task_control.assert_not_called()
    assert 'active' in (response['body'] or {})
