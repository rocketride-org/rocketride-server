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
from ai.account.file_store import FileStore
from ai.account.models import resolve_team_permissions
from ai.account.store import Store, StorageError
from ai.account.store_providers.filesystem import FilesystemStore

from ..test_run_log import PROJECT, SOURCE, make_stamp, open_writer, output_event
from ..test_run_log_team import TEAM as TEAM_UUID
from ..test_run_log_team import open_deploy_writer


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
        def __init__(self, store, owner, project_id, source, run_kind, *, version=None):
            calls['args'] = (owner, project_id, source)
            calls['run_kind'] = run_kind
            calls['owner'] = owner
            calls['version'] = version
            self.chapters = AsyncMock(return_value={'chapters': [], 'completed': True})
            self.read = AsyncMock(return_value={'events': []})
            self.segment_raw = AsyncMock(return_value={'segment': 0, 'data': '', 'final': True})
            self.delete = AsyncMock(return_value={'deletedSegments': 1})

    monkeypatch.setattr(cmd_mod, 'RunLogReader', FakeReader)
    # The reader's store handle is irrelevant here — stub the singleton hop.
    monkeypatch.setattr(
        cmd_mod.Store, 'file_store', classmethod(lambda cls, ctx, client_id=None, root=None, declared=(): MagicMock())
    )
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
        assert reader_stub['owner'] == '=user/user-1'
        assert reader_stub['run_kind'] == 'dev'

    @pytest.mark.asyncio
    async def test_a_team_audience_is_that_teams_deploy_stream(self, reader_stub):
        # A deployment row's teamId (its audience) passed back unchanged
        # addresses the team's deploy continuum, gated on that team
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args(teamId=f'=team/{TEAM}'))
        assert (reader_stub['owner'], reader_stub['run_kind']) == (f'=team/{TEAM}', 'deploy')

    @pytest.mark.asyncio
    async def test_the_callers_own_audience_is_their_personal_deploy_stream(self, reader_stub):
        conn = _make_conn(_account_info())
        await conn._log_chapters({}, _args(teamId='=user/user-1'))
        conn.verify_permission.assert_called_once_with('task.monitor')
        assert (reader_stub['owner'], reader_stub['run_kind']) == ('=user/user-1', 'deploy')

    @pytest.mark.asyncio
    @pytest.mark.parametrize('audience', ['=user/other', '@public', '@me', '=team/t/x'])
    async def test_an_audience_this_reader_cannot_address_is_refused(self, reader_stub, audience):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError):
            await conn._log_chapters({}, _args(teamId=audience))
        assert 'run_kind' not in reader_stub

    @pytest.mark.asyncio
    async def test_the_orgs_run_logs_are_its_admins(self, reader_stub):
        # Plan 8.3: an org-owned run (@org, an unattended @public) is watched
        # by the org's admins; a member is refused like any permission miss
        with pytest.raises(PermissionError):
            await _make_conn(_account_info())._log_chapters({}, _args(teamId='=org/org-1'))
        assert 'run_kind' not in reader_stub
        admin = _account_info()
        admin.organization['permissions'] = ['org.admin']
        await _make_conn(admin)._log_chapters({}, _args(teamId=None, owner='=org/org-1'))
        assert (reader_stub['owner'], reader_stub['run_kind']) == ('=org/org-1', 'deploy')
        with pytest.raises(PermissionError):
            await _make_conn(admin)._log_chapters({}, _args(teamId=None, owner='=org/another'))

    @pytest.mark.asyncio
    async def test_a_completed_me_run_replays_from_the_owner_its_row_carried(self, reader_stub):
        # The @me replay bug (plan 7.5): the task row of a personal deploy
        # names its BILLING team in teamId, its logs live in its owner's
        # tree. The reader takes the row's owner and reads the user's own
        # deploy continuum, whatever teamId says.
        conn = _make_conn(_account_info())
        await conn._log_read({}, _args(teamId=TEAM, owner='=user/user-1', runKind='deploy'))
        assert (reader_stub['owner'], reader_stub['run_kind']) == ('=user/user-1', 'deploy')
        conn.verify_permission.assert_called_once_with('task.monitor')

    @pytest.mark.asyncio
    async def test_another_users_owner_is_refused_and_a_team_owner_is_its_teams(self, reader_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._log_read({}, _args(teamId=None, owner='=user/user-2'))
        await conn._log_read({}, _args(teamId=None, owner=f'=team/{TEAM}', runKind='dev'))
        # A team owner is always the deploy continuum
        assert (reader_stub['owner'], reader_stub['run_kind']) == (f'=team/{TEAM}', 'deploy')
        with pytest.raises(ValueError):
            await conn._log_read({}, _args(teamId=None, owner='user-2'))

    @pytest.mark.asyncio
    async def test_a_pinned_versions_stream_is_its_own(self, reader_stub):
        # C.36: the version rides to the reader, which reads '...deploy.v000012'
        conn = _make_conn(_account_info())
        await conn._log_read({}, _args(version=12))
        assert (reader_stub['owner'], reader_stub['version']) == (f'=team/{TEAM}', 12)
        with pytest.raises(ValueError):
            await conn._log_read({}, _args(version='12'))

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
        assert reader_stub['owner'] == f'=team/{TEAM}'
        assert reader_stub['args'] == (f'=team/{TEAM}', 'proj-1', 'chat_1')
        assert reader_stub['run_kind'] == 'deploy'

    @pytest.mark.asyncio
    async def test_all_read_subcommands_take_the_team_scope(self, reader_stub):
        conn = _make_conn(_account_info())
        await conn._log_read({}, _args())
        assert reader_stub['owner'] == f'=team/{TEAM}'
        await conn._log_segment({}, _args(segment=0))
        assert reader_stub['owner'] == f'=team/{TEAM}'

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
        assert reader_stub['owner'] == f'=team/{TEAM}'


# ============================================================================
# API key endpoints scope
# ============================================================================


def _scoped_info(endpoints, developer_id='acme'):
    """A team member whose API key is scoped to ``endpoints``, in an org with ``developer_id``."""
    info = _account_info()
    info.organization['developerId'] = developer_id
    info.endpoints = endpoints
    return info


class TestEndpointScope:
    @pytest.mark.asyncio
    async def test_a_stream_inside_the_scope_is_readable(self, reader_stub):
        # The stream of acme.proj-1.chat_1 is exactly what the key names.
        conn = _make_conn(_scoped_info(['acme.proj-1.chat_1']))
        await conn._log_read({}, _args())
        assert reader_stub['args'] == (f'=team/{TEAM}', 'proj-1', 'chat_1')

    @pytest.mark.asyncio
    async def test_a_pipe_wildcard_admits_every_source(self, reader_stub):
        conn = _make_conn(_scoped_info(['acme.proj-1.*']))
        await conn._log_chapters({}, _args(source='webhook_1'))
        assert reader_stub['args'] == (f'=team/{TEAM}', 'proj-1', 'webhook_1')

    @pytest.mark.asyncio
    async def test_a_stream_outside_the_scope_is_denied_on_every_subcommand(self, reader_stub):
        # task.monitor/task.control on the team are held; the scope alone
        # refuses, and no reader is built for the foreign stream.
        conn = _make_conn(_scoped_info(['acme.proj-1.chat_1']))
        for handler, extra in (
            (conn._log_chapters, {}),
            (conn._log_read, {}),
            (conn._log_segment, {'segment': 0}),
            (conn._log_delete, {'all': True}),
        ):
            with pytest.raises(PermissionError):
                await handler({}, _args(projectId='proj-2', **extra))
        assert 'args' not in reader_stub

    @pytest.mark.asyncio
    async def test_the_own_dev_stream_is_scoped_too(self, reader_stub):
        conn = _make_conn(_scoped_info(['acme.proj-1.chat_1']))
        with pytest.raises(PermissionError):
            await conn._log_read({}, _args(teamId=None, source='other_1'))

    @pytest.mark.asyncio
    async def test_streams_outside_the_scope_are_denied(self, reader_stub):
        conn = _make_conn(_scoped_info(['acme.proj-1.chat_1']))
        with pytest.raises(PermissionError):
            await conn.on_rrext_log({'arguments': {'subcommand': 'streams', 'projectId': 'proj-2', 'source': 'chat_1'}})

    @pytest.mark.asyncio
    async def test_another_developer_namespace_is_outside_the_scope(self, reader_stub):
        # The stream's address is built under the caller's org developer id,
        # so a scope naming another namespace does not reach it.
        conn = _make_conn(_scoped_info(['other.proj-1.chat_1']))
        with pytest.raises(PermissionError):
            await conn._log_read({}, _args())

    @pytest.mark.asyncio
    async def test_an_org_without_a_developer_id_reaches_nothing_with_a_scoped_key(self, reader_stub):
        conn = _make_conn(_scoped_info(['acme.proj-1.chat_1'], developer_id=None))
        with pytest.raises(PermissionError):
            await conn._log_read({}, _args())

    @pytest.mark.asyncio
    async def test_an_empty_scope_allows_nothing(self, reader_stub):
        conn = _make_conn(_scoped_info([]))
        with pytest.raises(PermissionError):
            await conn._log_read({}, _args())


# streams: real writer, real store, real reader — no stubs


@pytest.fixture
def real_store(monkeypatch, tmp_path):
    """A filesystem store shared by the handler's readers and the test's writers."""
    istore = FilesystemStore(f'filesystem://{tmp_path}/store')

    def file_store(cls, ctx, client_id=None):
        return FileStore(Store(istore), client_id, ctx)

    monkeypatch.setattr(cmd_mod.Store, 'file_store', classmethod(file_store))
    return istore


# How each kind of run is opened: dev and @me in the caller's tree, team in the team's tree.
_OPEN = {
    'dev': open_writer,
    'me': lambda store, spool: open_writer(store, spool, kind='deploy'),
    'team': open_deploy_writer,
}


async def _write_run(kind, store, tmp_path):
    """One completed run of ``kind`` ('dev' | 'me' | 'team') with a single output event."""
    writer = await _OPEN[kind](store, str(tmp_path))
    stamp, _, _ = make_stamp(100)
    writer.append(stamp(output_event(f'{kind}-run')))
    await writer._drain_uploads()
    await writer.end_run('ok')


def _conn(*team_permissions):
    """A caller holding ``team_permissions`` on TEAM_UUID; none = no team membership."""
    teams = [{'id': TEAM_UUID, 'name': 'Production', 'permissions': list(team_permissions)}] if team_permissions else []
    return _make_conn(_account_info(teams=teams))


async def _streams(conn, **extra):
    args = {'subcommand': 'streams', 'projectId': PROJECT, 'source': SOURCE, **extra}
    return (await conn.on_rrext_log({'arguments': args}))['body']['streams']


class TestStreams:
    @pytest.mark.asyncio
    async def test_finds_the_dev_run_and_the_team_run_in_one_call(self, real_store, tmp_path):
        await _write_run('dev', real_store, tmp_path)
        await _write_run('team', real_store, tmp_path)
        conn = _conn('task.monitor')

        streams = await _streams(conn)

        assert [(s['teamId'], s['runKind'], s['ownerKind'], s['teamName']) for s in streams] == [
            ('', 'dev', 'user', ''),
            (TEAM_UUID, 'deploy', 'team', 'Production'),
        ]
        assert all(len(s['chapters']) == 1 and s['completed'] for s in streams)
        # The entry is enough to read that stream.
        page = await conn._reader_for({'projectId': PROJECT, 'source': SOURCE, 'teamId': TEAM_UUID}).read(from_seq=1)
        assert [e['body']['output'] for e in page['events'] if e.get('event') == 'output'] == ['team-run']

    @pytest.mark.asyncio
    async def test_a_personal_deploy_is_the_callers_own(self, real_store, tmp_path):
        await _write_run('me', real_store, tmp_path)
        assert [(s['teamId'], s['runKind'], s['ownerKind']) for s in await _streams(_conn())] == [
            ('', 'deploy', 'user')
        ]

    @pytest.mark.asyncio
    async def test_a_team_the_caller_cannot_monitor_is_absent(self, real_store, tmp_path):
        await _write_run('team', real_store, tmp_path)
        assert await _streams(_conn('task.control')) == []

    @pytest.mark.asyncio
    async def test_a_team_id_in_the_request_does_not_change_the_scopes(self, real_store, tmp_path):
        await _write_run('dev', real_store, tmp_path)
        assert [s['runKind'] for s in await _streams(_conn(), teamId=TEAM_UUID)] == ['dev']

    @pytest.mark.asyncio
    async def test_a_caller_without_monitor_rights_gets_no_streams(self, real_store, tmp_path):
        await _write_run('dev', real_store, tmp_path)
        conn = _conn('task.monitor')
        conn.verify_permission.side_effect = PermissionError("Permission 'task.monitor' denied")
        with pytest.raises(PermissionError):
            await _streams(conn)
        conn.verify_permission.assert_called_once_with('task.monitor')

    @pytest.mark.asyncio
    async def test_a_failed_read_surfaces_instead_of_dropping_the_scope(self, real_store, tmp_path, monkeypatch):
        await _write_run('team', real_store, tmp_path)

        async def failing_read(self, path, max_size=0):
            raise StorageError('boom')

        monkeypatch.setattr(FileStore, 'read', failing_read)
        with pytest.raises(StorageError, match='boom'):
            await _streams(_conn('task.monitor'))
