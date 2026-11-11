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

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import ai.account
import ai.modules.task.task_server_facade as facade_mod
from ai.modules.task.task_server_facade import start_server_task_as_team


# ============================================================================
# Helpers
# ============================================================================


async def _dispatch(ttl, *, owner_kind='team', owner_user_id='', controls=None):
    """Run a dispatch with a capture stub in place of the DAP request.

    Args:
        ttl: The schedule window handed to the facade.
        owner_kind: ``'team'`` (@team deploy) or ``'user'`` (@me deploy).
        owner_user_id: The owning user of a @me deploy.
        controls: The live registry the server answers ``control_by_key``
            from; defaults to the one deploy control this dispatch starts.

    Returns:
        Dict with the execute ``arguments``, the synthetic ``account_info``,
        the returned ``key`` and the ``server`` stub.
    """
    captured = {}

    async def fake_request(self, command, *, token=None, arguments=None, data=None):
        # Step 1: record what the facade actually put on the wire, plus the
        # synthetic identity the dispatch constructed for the connection.
        captured['command'] = command
        captured['arguments'] = arguments
        captured['account_info'] = self._account_info
        # Step 2: answer like a successful execute (the address in the token slot).
        return {'success': True, 'body': {'token': 'acme.proj-1.src-1'}}

    # The server's live registry, by key. The facade must look its run up by
    # the deploy key and never walk the caller rungs (resolve_control).
    owner_id = owner_user_id if owner_kind == 'user' else 'team-1'
    if controls is None:
        key = f'deploy.{owner_id}.acme.proj-1.src-1'
        controls = {key: SimpleNamespace(key=key)}
    server = MagicMock()
    server.control_by_key = MagicMock(side_effect=lambda key: controls[key])
    server.resolve_control = MagicMock(side_effect=AssertionError('the facade must not resolve through the rungs'))

    # The connection constructor needs a real server; stub it out entirely —
    # this is a wire-shape test, not a TaskConn test. The org's developer id
    # comes from the account layer, not from any session.
    with (
        patch.object(facade_mod._InProcessConn, '__init__', return_value=None),
        patch.object(facade_mod._InProcessConn, 'request', fake_request),
        patch.object(ai.account.account, 'get_developer_id', AsyncMock(return_value='acme'), create=True),
    ):
        captured['key'] = await start_server_task_as_team(
            server,
            {'components': []},
            org_id='org-1',
            team_id='team-1',
            trigger='schedule',
            ttl=ttl,
            owner_kind=owner_kind,
            owner_user_id=owner_user_id,
        )
    captured['server'] = server
    return captured


# ============================================================================
# Tests
# ============================================================================


@pytest.mark.asyncio
async def test_no_window_sends_ttl_zero():
    """No schedule window -> ttl=0 on the wire (run until the pipeline exits)."""
    arguments = (await _dispatch(None))['arguments']
    assert arguments['ttl'] == 0


@pytest.mark.asyncio
async def test_fixed_window_sends_ttl_seconds():
    """A fixed window -> its seconds ride the wire verbatim."""
    arguments = (await _dispatch(1800))['arguments']
    assert arguments['ttl'] == 1800


@pytest.mark.asyncio
async def test_pipeline_and_team_ride_alongside_ttl():
    """The execute arguments carry pipeline + teamId + ttl, nothing implicit."""
    arguments = (await _dispatch(None))['arguments']
    assert arguments['pipeline'] == {'components': []}
    assert arguments['teamId'] == 'team-1'
    assert set(arguments) == {'pipeline', 'teamId', 'ttl'}


@pytest.mark.asyncio
async def test_deploy_dispatch_carries_no_human_identity():
    """The synthetic team identity is actor-free: the TEAM owns the run.

    Deploy runs must be identical regardless of who deployed or fired them —
    who did lives in the audit log and deployment history, never on the run.
    """
    account_info = (await _dispatch(None))['account_info']
    assert account_info.userId == ''
    assert account_info.displayName == ''
    assert account_info.email == ''
    assert account_info.devTeam == 'team-1'
    # The address namespace rides the synthetic org: it is the org's, not a human's.
    assert account_info.organization['developerId'] == 'acme'


@pytest.mark.asyncio
async def test_team_deploy_returns_the_team_deploy_key():
    """A @team deploy hands back the key of the run it started: deploy.<team>.<address>."""
    captured = await _dispatch(None)
    assert captured['key'] == 'deploy.team-1.acme.proj-1.src-1'
    captured['server'].control_by_key.assert_called_once_with('deploy.team-1.acme.proj-1.src-1')
    captured['server'].resolve_control.assert_not_called()


@pytest.mark.asyncio
async def test_me_deploy_returns_its_own_key_while_the_owner_plays_the_same_pipeline():
    """A @me deploy shares its address with the owner's dev run of the same pipeline.
    The facade must hand back the DEPLOY run's key, never the Play'd dev run's.
    """
    controls = {
        'dev.user-7.acme.proj-1.src-1': SimpleNamespace(key='dev.user-7.acme.proj-1.src-1'),
        'deploy.user-7.acme.proj-1.src-1': SimpleNamespace(key='deploy.user-7.acme.proj-1.src-1'),
    }
    captured = await _dispatch(None, owner_kind='user', owner_user_id='user-7', controls=controls)
    assert captured['key'] == 'deploy.user-7.acme.proj-1.src-1'
    assert captured['account_info'].userId == 'user-7'
    captured['server'].resolve_control.assert_not_called()
