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

"""Trusted-dispatch wire contract tests for ``start_server_task_as_team``.

Pins the execute-arguments shape the engine consumes — most importantly the
ttl contract: a deploy run ALWAYS sends ``ttl`` (0 = no window, run until
the pipeline exits; N = the schedule's fixed-window seconds). Omitting it
would silently apply the server's default idle timeout, a dev-task policy
that must never govern deploy runs.
"""

from unittest.mock import AsyncMock, patch

import pytest

import ai.modules.task.task_server_facade as facade_mod
from ai.modules.task.task_server_facade import start_server_task_as_team


# ============================================================================
# Helpers
# ============================================================================


async def _dispatch(ttl):
    """Run a dispatch with a capture stub in place of the DAP request.

    Returns:
        Tuple of (execute arguments dict, the synthetic AccountInfo used).
    """
    captured = {}

    async def fake_request(self, command, *, token=None, arguments=None, data=None):
        # Step 1: record what the facade actually put on the wire, plus the
        # synthetic identity the dispatch constructed for the connection.
        captured['command'] = command
        captured['arguments'] = arguments
        captured['account_info'] = self._account_info
        # Step 2: answer like a successful execute.
        return {'success': True, 'body': {'token': 'tk_test'}}

    # The connection constructor needs a real server; stub it out entirely —
    # this is a wire-shape test, not a TaskConn test.
    with (
        patch.object(facade_mod._InProcessConn, '__init__', return_value=None),
        patch.object(facade_mod._InProcessConn, 'request', fake_request),
    ):
        await start_server_task_as_team(
            AsyncMock(),
            {'components': []},
            org_id='org-1',
            team_id='team-1',
            trigger='schedule',
            ttl=ttl,
        )
    return captured['arguments'], captured['account_info']


# ============================================================================
# Tests
# ============================================================================


@pytest.mark.asyncio
async def test_no_window_sends_ttl_zero():
    """No schedule window -> ttl=0 on the wire (run until the pipeline exits)."""
    arguments, _ = await _dispatch(None)
    assert arguments['ttl'] == 0


@pytest.mark.asyncio
async def test_fixed_window_sends_ttl_seconds():
    """A fixed window -> its seconds ride the wire verbatim."""
    arguments, _ = await _dispatch(1800)
    assert arguments['ttl'] == 1800


@pytest.mark.asyncio
async def test_pipeline_and_team_ride_alongside_ttl():
    """The execute arguments carry pipeline + teamId + ttl, nothing implicit."""
    arguments, _ = await _dispatch(None)
    assert arguments['pipeline'] == {'components': []}
    assert arguments['teamId'] == 'team-1'
    assert set(arguments) == {'pipeline', 'teamId', 'ttl'}


@pytest.mark.asyncio
async def test_deploy_dispatch_carries_no_human_identity():
    """The synthetic team identity is actor-free: the TEAM owns the run.

    Deploy runs must be identical regardless of who deployed or fired them —
    who did lives in the audit log and deployment history, never on the run.
    """
    _, account_info = await _dispatch(None)
    assert account_info.userId == ''
    assert account_info.displayName == ''
    assert account_info.email == ''
    assert account_info.defaultTeam == 'team-1'
