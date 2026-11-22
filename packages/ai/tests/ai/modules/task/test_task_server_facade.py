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
from ai.modules.task.task_control import DeploymentRef
from ai.modules.task.task_control import unattended_attribution
from ai.modules.task.task_server_facade import start_server_task_as_team

#: The control id the execute answers with (the token slot, plan section 1).
CONTROL_ID = '=control/0123456789abcdef0123456789abcdef'


# ============================================================================
# Helpers
# ============================================================================


async def _dispatch(ttl, *, audience='=team/team-1', billing='', controls=None):
    """Run a dispatch with a capture stub in place of the DAP request.

    Args:
        ttl: The schedule window handed to the facade.
        audience: The publication the unattended run fires (plan 8.3's second table).
        billing: The pointer's billing stamp (an @me pointer needs one).
        controls: The live registry the server answers ``control_by_key``
            from, by control id; defaults to the one deploy control this
            dispatch starts.

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
        captured['deployment'] = self._trusted_deployment
        captured['attribution'] = self._trusted_attribution
        # Step 2: answer like a successful execute (the control id in the token slot).
        return {'success': True, 'body': {'token': CONTROL_ID, 'address': 'acme.proj-1.src-1'}}

    # The server's live registry, by control id. The facade must look its run
    # up by the id the execute answered with and never walk the caller rungs
    # (resolve_target).
    if controls is None:
        controls = {CONTROL_ID: SimpleNamespace(key=CONTROL_ID)}
    server = MagicMock()
    server.control_by_key = MagicMock(side_effect=lambda key: controls[key])
    server.resolve_target = AsyncMock(side_effect=AssertionError('the facade must not resolve through the rungs'))

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
            attribution=unattended_attribution(audience, org_id='org-1', billing_stamp=billing),
            deployment=DeploymentRef(org_id='org-1', team_id=audience, project_id='proj-1'),
            trigger='schedule',
            ttl=ttl,
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
async def test_the_pipeline_rides_alongside_ttl_and_the_team_does_not():
    """The execute arguments carry pipeline + ttl, nothing implicit: who pays rides the trusted channel."""
    captured = await _dispatch(None)
    arguments = captured['arguments']
    assert arguments['pipeline'] == {'components': []}
    assert set(arguments) == {'pipeline', 'ttl'}
    assert (captured['attribution'].rung, captured['attribution'].team_id) == ('team', 'team-1')


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
async def test_team_deploy_returns_the_key_of_the_run_it_started():
    """A @team deploy hands back the key (the control id) of the run the execute answered with."""
    captured = await _dispatch(None)
    assert captured['key'] == CONTROL_ID
    captured['server'].control_by_key.assert_called_once_with(CONTROL_ID)
    captured['server'].resolve_target.assert_not_called()


@pytest.mark.asyncio
async def test_me_deploy_returns_its_own_key_while_the_owner_plays_the_same_pipeline():
    """A @me deploy shares its address with the owner's dev run of the same pipeline.
    The facade hands back the DEPLOY run's id, never the Play'd dev run's: the
    execute answered with it, and no rung is walked.
    """
    played = '=control/feedfacefeedfacefeedfacefeedface'
    controls = {played: SimpleNamespace(key=played), CONTROL_ID: SimpleNamespace(key=CONTROL_ID)}
    captured = await _dispatch(None, audience='=user/user-7', billing='team-1', controls=controls)
    assert captured['key'] == CONTROL_ID
    assert captured['account_info'].userId == 'user-7'
    captured['server'].resolve_target.assert_not_called()


@pytest.mark.asyncio
async def test_the_deployment_rides_the_trusted_channel_not_the_wire():
    """The run names the deployment it resolved through, out of reach of DAP arguments."""
    captured = await _dispatch(None)
    assert captured['deployment'] == DeploymentRef(org_id='org-1', team_id='=team/team-1', project_id='proj-1')
    assert 'deployment' not in captured['arguments']


@pytest.mark.asyncio
@pytest.mark.parametrize('audience', ['=org/org-1', '@public'])
async def test_the_org_mode_carries_no_user_and_no_team(audience):
    """Plan 8.3: an unattended @org or @public run is the org's: no user, no team, the org-level grant."""
    captured = await _dispatch(None, audience=audience)
    account_info = captured['account_info']
    assert (account_info.userId, account_info.devTeam, account_info.teamOrder) == ('', '', [])
    assert account_info.organization['teams'] == [] and account_info.organization['permissions'] == ['org.admin']
    attribution = captured['attribution']
    assert (attribution.owner_kind, attribution.owner_id, attribution.user_id, attribution.team_id) == (
        'org',
        'org-1',
        '',
        '',
    )
