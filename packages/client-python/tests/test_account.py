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

"""Unit tests for AccountApi invites: the request sent and the member returned."""

import pytest

from rocketride.account import AccountApi

INVITED = {
    'userId': 'user-1',
    'displayName': 'Ben Lee',
    'email': 'ben@acme.test',
    'role': 'member',
    'status': 'pending',
    'devTeamId': 'team-1',
}
TEAMS = [{'teamId': 'team-1', 'permissions': ['task.control']}]
INVITE_ARGS = {'email': 'ben@acme.test', 'given_name': 'Ben', 'family_name': 'Lee', 'role': 'member'}
WIRE_ARGS = {'email': 'ben@acme.test', 'givenName': 'Ben', 'familyName': 'Lee', 'role': 'member'}


class FakeClient:
    """Async fake whose ``call`` records the command and kwargs it receives."""

    def __init__(self):
        self.calls = []

    async def call(self, command, **kwargs):
        """Record the call and return a server invite result."""
        self.calls.append((command, kwargs))
        return INVITED


@pytest.mark.asyncio
async def test_invite_sends_teams_and_dev_team_and_returns_member():
    """invite() forwards teamAssignments and devTeamId and returns the server's member."""
    fake = FakeClient()
    member = await AccountApi(fake).invite('org-1', **INVITE_ARGS, team_assignments=TEAMS, dev_team_id='team-1')
    assert fake.calls == [
        (
            'rrext_account_members',
            {'subcommand': 'invite', 'orgId': 'org-1', **WIRE_ARGS, 'teamAssignments': TEAMS, 'devTeamId': 'team-1'},
        )
    ]
    assert member == INVITED


@pytest.mark.asyncio
async def test_invite_without_teams_sends_only_the_basics():
    """Leaving the optional arguments out sends the same request as before."""
    fake = FakeClient()
    await AccountApi(fake).invite('org-1', **INVITE_ARGS)
    assert fake.calls == [('rrext_account_members', {'subcommand': 'invite', 'orgId': 'org-1', **WIRE_ARGS})]


@pytest.mark.asyncio
async def test_invite_member_sends_the_same_request_and_returns_none():
    """The deprecated invite_member() still works and still returns None."""
    fake = FakeClient()
    result = await AccountApi(fake).invite_member('org-1', **INVITE_ARGS, team_assignments=TEAMS, dev_team_id='team-1')
    assert fake.calls[0][1]['devTeamId'] == 'team-1'
    assert result is None
