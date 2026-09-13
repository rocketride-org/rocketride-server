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

"""cmd_log handler tests — the team-scope permission gate.

The reader itself is contract-tested in test_run_log_reader /
test_run_log_team; these tests pin what the COMMAND layer owns: THE SCOPE
IS THE KIND (teamId present = that team's deploy continuum, absent = the
caller's own dev stream; runKind is not a wire argument), per-subcommand permission
resolution against the ADDRESSED team ('task.monitor' reads,
'task.control' delete) with uniform denial for non-members, unscoped dev
requests keeping the original default-team check, and the derived scope
reaching the reader construction.
"""

from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.modules.task.commands.cmd_log as cmd_mod
from ai.modules.task.commands.cmd_log import LogCommands
from ai.account.models import resolve_team_permissions


# ============================================================================
# Harness
# ============================================================================

TEAM = 'team-1'


def _account_info(*, teams=None, dev_team=TEAM, user_id='user-1'):
    """AccountInfo-shaped stub with an organization and teams."""
    return SimpleNamespace(
        userId=user_id,
        displayName='Rod C',
        email='rod@example.com',
        devTeam=dev_team,
        organization={
            'id': 'org-1',
            'name': 'Acme',
            'permissions': [],
            'teams': teams
            if teams is not None
            else [{'id': TEAM, 'name': 'Production', 'permissions': ['task.control', 'task.monitor']}],
        },
        sysPermissions=[],
    )


def _make_conn(account_info):
    """A LogCommands instance with __init__ bypassed, real team-permission math."""
    conn = LogCommands.__new__(LogCommands)
    LogCommands.__init__(conn, 1, MagicMock(), MagicMock())
    conn._account_info = account_info
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()

    # Default-team check: recorded so tests can assert WHICH gate ran.
    conn.verify_permission = MagicMock()

    # Real team-permission semantics (mirrors TaskConn.verify_team_permission):
    # resolve against the ADDRESSED team, uniform denial.
    def verify_team_permission(self, team_id, perm):
        if perm not in resolve_team_permissions(self._account_info, team_id):
            raise PermissionError(f"Permission '{perm}' denied")

    conn.verify_team_permission = MethodType(verify_team_permission, conn)
    return conn


@pytest.fixture
def reader_stub(monkeypatch):
    """Replace RunLogReader in the module: capture construction, stub reads."""
    calls = {}

    class FakeReader:
        def __init__(self, store, client_id, project_id, source, run_kind, *, team_id=''):
            calls['args'] = (client_id, project_id, source)
            calls['run_kind'] = run_kind
            calls['team_id'] = team_id
            self.chapters = AsyncMock(return_value={'chapters': [], 'completed': True})
            self.read = AsyncMock(return_value={'events': []})
            self.segment_raw = AsyncMock(return_value={'segment': 0, 'data': '', 'final': True})
            self.delete = AsyncMock(return_value={'deletedSegments': 1})

    monkeypatch.setattr(cmd_mod, 'RunLogReader', FakeReader)
    # The reader's store handle is irrelevant here — stub the singleton hop.
    monkeypatch.setattr(cmd_mod.Store, 'file_store', classmethod(lambda cls, ctx, client_id=None: MagicMock()))
    return calls


def _args(**over):
    """Baseline team-scoped (deploy) read arguments; override per test."""
    base = {'projectId': 'proj-1', 'source': 'chat_1', 'teamId': TEAM}
    base.update(over)
    return base


# ============================================================================
# Scope inference
# ============================================================================


class TestScopeInference:
    @pytest.mark.asyncio
    async def test_team_scope_means_deploy(self, reader_stub):
        # The scope IS the kind: a teamId addresses the team's DEPLOY
        # continuum — no runKind on the wire.
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args())
        assert reader_stub['run_kind'] == 'deploy'

    @pytest.mark.asyncio
    async def test_no_team_means_own_dev_stream(self, reader_stub):
        # Unscoped = the caller's own dev stream, default-team permission
        # check, reader anchored at the caller with NO team scope.
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args(teamId=None))
        conn.verify_permission.assert_called_once_with('task.monitor')
        assert reader_stub['team_id'] == ''
        assert reader_stub['run_kind'] == 'dev'

    @pytest.mark.asyncio
    async def test_run_kind_is_not_a_wire_argument(self, reader_stub):
        # runKind is ignored like any unknown argument: the scope alone
        # decides which continuum a request addresses.
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args(runKind='dev'))
        assert reader_stub['run_kind'] == 'deploy'


# ============================================================================
# Team permission resolution
# ============================================================================


class TestTeamGate:
    @pytest.mark.asyncio
    async def test_teammate_reads_the_deploy_stream(self, reader_stub):
        # task.monitor on the addressed team is the read right; the default-
        # team gate must NOT run (the TEAM is the scope, not the default).
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args())
        conn.verify_permission.assert_not_called()
        assert reader_stub['team_id'] == TEAM
        assert reader_stub['args'] == ('user-1', 'proj-1', 'chat_1')
        assert reader_stub['run_kind'] == 'deploy'

    @pytest.mark.asyncio
    async def test_all_read_subcommands_take_the_team_scope(self, reader_stub):
        conn = _make_conn(_account_info())
        await conn._log_read({}, _args())
        assert reader_stub['team_id'] == TEAM
        await conn._log_segment({}, _args(segment=0))
        assert reader_stub['team_id'] == TEAM

    @pytest.mark.asyncio
    async def test_non_member_denied_uniformly(self, reader_stub):
        # A foreign/unknown team resolves to no permissions — the denial is
        # indistinguishable from a real team the caller cannot access.
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._log_chapters({}, _args(teamId='team-elsewhere'))

    @pytest.mark.asyncio
    async def test_monitor_only_member_cannot_delete(self, reader_stub):
        # Delete is destructive: task.control on the team, not just monitor.
        info = _account_info(teams=[{'id': TEAM, 'name': 'Production', 'permissions': ['task.monitor']}])
        conn = _make_conn(info)
        await conn._log_chapters({}, _args())  # reads still fine
        with pytest.raises(PermissionError):
            await conn._log_delete({}, _args(all=True))

    @pytest.mark.asyncio
    async def test_controller_deletes_the_team_stream(self, reader_stub):
        conn = _make_conn(_account_info())
        result = await conn._log_delete({}, _args(all=True))
        assert result['body'] == {'deletedSegments': 1}
        assert reader_stub['team_id'] == TEAM
