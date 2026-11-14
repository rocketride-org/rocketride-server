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

"""Unit tests for ai.modules.task.commands.engine_access.engine_for.

A request through a DORMANT control restarts its engine with the team's
current secrets, so the caller's team access is re-checked first; a live
control is served without the extra check.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands.engine_access import engine_for, wait_running
from ai.modules.task.types import TaskError


def _conn(*, denied=False):
    """A command connection whose team check can be made to refuse."""
    verify = MagicMock(side_effect=PermissionError('no longer on the team') if denied else None)
    return SimpleNamespace(
        verify_team_permission=verify, _server=SimpleNamespace(ensure_engine=AsyncMock(return_value='engine'))
    )


@pytest.mark.asyncio
async def test_a_dormant_control_rechecks_the_team_before_its_engine_restarts():
    """The restart loads the team's current secrets: an owner who left the team is refused before it."""
    conn = _conn(denied=True)
    control = SimpleNamespace(dormant=True, teamId='team-1')

    with pytest.raises(PermissionError):
        await engine_for(conn, control, 'task.data')

    conn.verify_team_permission.assert_called_once_with('team-1', 'task.data')
    conn._server.ensure_engine.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_dormant_control_with_team_access_restarts_its_engine():
    """The check passes: the engine is started again under the same key."""
    conn = _conn()
    control = SimpleNamespace(dormant=True, teamId='team-1')

    assert await engine_for(conn, control, 'task.control') == 'engine'

    conn.verify_team_permission.assert_called_once_with('team-1', 'task.control')
    conn._server.ensure_engine.assert_awaited_once_with(control)


@pytest.mark.asyncio
async def test_a_live_control_is_served_without_the_team_check():
    """A live engine loads nothing new: the request keeps today's owner-by-identity access."""
    conn = _conn(denied=True)
    control = SimpleNamespace(dormant=False, teamId='team-1')

    assert await engine_for(conn, control, 'task.data') == 'engine'

    conn.verify_team_permission.assert_not_called()


@pytest.mark.asyncio
async def test_an_engine_that_never_confirms_running_is_engine_start_failed():
    """wait_for_running's bare TimeoutError becomes the plan 3.8 error, carrying the engine key."""
    engine = SimpleNamespace(engine_key='hash-1:user-a', wait_for_running=AsyncMock(side_effect=TimeoutError('silent')))

    with pytest.raises(TaskError) as err:
        await wait_running(engine)
    assert (err.value.code, err.value.engineKey) == (TaskError.ENGINE_START_FAILED, 'hash-1:user-a')


@pytest.mark.asyncio
async def test_a_running_engine_passes_wait_running():
    """No conversion on the happy path."""
    engine = SimpleNamespace(engine_key='k', wait_for_running=AsyncMock())

    await wait_running(engine)

    engine.wait_for_running.assert_awaited_once_with()
