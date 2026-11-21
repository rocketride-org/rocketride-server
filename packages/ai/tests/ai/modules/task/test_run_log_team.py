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

"""
Team-scoped run-log continua (Phase 4 of teams-as-environments).

Deploy runs write the TEAM's continuum so teammates can watch/replay: the
single scope helper (scope_paths) turns the run's OWNER string into
the store path prefix + scope id that BOTH RunLogWriter and RunLogReader
consume — they cannot diverge. Covers: the helper's contract, a deploy
writer landing segments/control under teams/<tid>/files/.logs (and NOT in
the owner's user tree), scope-qualified spool filenames that the startup
sweep regex still matches (team ids are uuids with hyphens), the writer
registry keyed by scope so a team-scoped reader finds the LIVE writer, and
the dev path staying byte-identical to before.
"""

import os
import shutil
import tempfile

import pytest

import ai.modules.task.run_log as run_log
from ai.modules.task.run_log import (
    WRITERS,
    RunLogWriter,
    scope_paths,
    stream_name,
    sweep_spool_root,
    writer_key,
)
from ai.account.file_store import FileStore
from ai.account.store import Store, StorageError
from ai.account.models import RequestContext
from ai.account.store_providers.filesystem import FilesystemStore

# Shared identity constants + event helpers from the writer test module.
from .test_run_log import CLIENT, OWNER, PROJECT, SCOPE_ID, SOURCE, make_stamp, output_event

# A realistic team id: uuid-style, hyphens included — exactly what the spool
# filename regex must keep matching once scope ids can be team ids.
TEAM = '7f3adf10-2b6c-4a9e-9c11-aaaa5555bbbb'
TEAM_OWNER = f'=team/{TEAM}'
TEAM_SCOPE = f'team-{TEAM}'
DEPLOY_STREAM = stream_name(PROJECT, SOURCE, 'deploy')


# =============================================================================
# FIXTURES
# =============================================================================


@pytest.fixture
def istore():
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def spool_root():
    temp_path = tempfile.mkdtemp()
    yield temp_path
    shutil.rmtree(temp_path, ignore_errors=True)


async def open_deploy_writer(istore, spool_root, stamp=None, raise_floor=None):
    """Create + open a TEAM-scoped deploy writer (internal identity)."""
    if stamp is None:
        stamp, raise_floor, _ = make_stamp()
    writer = RunLogWriter(
        FileStore(Store(istore), CLIENT, RequestContext.internal('test')),
        TEAM_OWNER,
        PROJECT,
        SOURCE,
        'deploy',
        stamp,
        raise_floor,
        team_id=TEAM,
        spool_root=spool_root,
    )
    await writer.open(trigger='schedule', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
    return writer


def team_reader(istore, spool_root):
    """A reader over the TEAM's deploy continuum (same scope helper)."""
    return run_log.RunLogReader(
        FileStore(Store(istore), CLIENT, RequestContext.internal('test')),
        TEAM_OWNER,
        PROJECT,
        SOURCE,
        'deploy',
        spool_root=spool_root,
    )


# =============================================================================
# SCOPE HELPER CONTRACT
# =============================================================================


class TestScopePaths:
    def test_a_user_owner_is_its_own_tree(self):
        # A user-owned run (dev, @me, a caller's @public): the user's id root,
        # the kind and id as scope id; the run kind splits dev from deploy
        assert scope_paths(OWNER) == (f'=user/{CLIENT}/', SCOPE_ID)

    def test_a_team_owner_is_the_team_tree(self):
        # A team-owned run: the team's id root (plan 2.5) + its scope id
        assert scope_paths(TEAM_OWNER) == (f'=team/{TEAM}/', TEAM_SCOPE)

    def test_an_org_owner_is_the_org_tree(self):
        # An org-owned run (@org, an unattended @public): the org's id root
        assert scope_paths('=org/org-1') == ('=org/org-1/', 'org-org-1')

    def test_the_oss_local_owners_never_share_a_scope(self):
        # OSS: the user, the team and the org are all 'local'; the kind keeps
        # their spool files and live writers apart
        scopes = {scope_paths(f'={kind}/local')[1] for kind in ('user', 'team', 'org')}
        assert scopes == {'user-local', 'team-local', 'org-local'}

    @pytest.mark.parametrize('bad', ['user-1', '=team/', '@team/x', '@public', '=team/a/b', '=control/x', ''])
    def test_anything_but_an_owner_is_refused(self, bad):
        # Only an owner string names a tree: a bare id, the store, a path and
        # a control id are refused (defense in depth; upstream callers
        # validate the caller first).
        with pytest.raises(ValueError):
            scope_paths(bad)

    def test_a_pinned_version_is_a_stream_of_its_own(self):
        # C.36: '<project>.<source>.<runKind>.v000012' and its control file
        assert stream_name(PROJECT, SOURCE, 'deploy', 12) == f'{DEPLOY_STREAM}.v000012'
        assert (
            run_log.control_store_path(PROJECT, SOURCE, 'deploy', 12) == f'.logs/{PROJECT}/{SOURCE}.deploy.v000012.json'
        )
        assert run_log.segment_store_path(PROJECT, SOURCE, 'deploy', 3, 12) == (
            f'.logs/{PROJECT}/{SOURCE}.deploy.v000012.000003.jsonl'
        )
        assert run_log._SPOOL_FILE_RE.match(f'{TEAM_SCOPE}.{DEPLOY_STREAM}.v000012.000003.jsonl')


# =============================================================================
# TEAM-SCOPED WRITER
# =============================================================================


class TestTeamScopedWriter:
    @pytest.mark.asyncio
    async def test_deploy_stream_lands_in_team_tree(self, istore, spool_root):
        writer = await open_deploy_writer(istore, spool_root)
        stamp, _, _ = make_stamp(100)
        writer.append(stamp(output_event('team-run')))
        await writer._drain_uploads()
        await writer.end_run('ok')

        # Control + segments live under the TEAM's system tree...
        team_files = await istore.list_files(f'teams/{TEAM}/files/.logs/{PROJECT}')
        names = [path.rsplit('/', 1)[-1] for path in (team_files or [])]
        assert f'{SOURCE}.deploy.json' in names
        assert any(name.startswith(f'{SOURCE}.deploy.') and name.endswith('.jsonl') for name in names)

        # ...and NOTHING leaked into the run owner's user tree.
        user_files = await istore.list_files(f'users/{CLIENT}/files/.logs/{PROJECT}')
        assert not [path for path in (user_files or []) if '.deploy.' in path]

    @pytest.mark.asyncio
    async def test_spool_files_are_team_qualified_and_sweepable(self, istore, spool_root):
        writer = await open_deploy_writer(istore, spool_root)
        stamp, _, _ = make_stamp(100)
        writer.append(stamp(output_event('spooled')))

        # The live spool file carries the TEAM id (not the user id) so two
        # scopes deploying the same project never collide on one host.
        spooled = [name for name in os.listdir(spool_root) if name.endswith('.jsonl')]
        assert spooled and all(name.startswith(f'{TEAM_SCOPE}.{DEPLOY_STREAM}.') for name in spooled)

        # The anchored startup-sweep regex still matches the team-qualified
        # form (uuid hyphens included) — stale team spools get cleaned too.
        assert all(run_log._SPOOL_FILE_RE.match(name) for name in spooled)
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_sweep_removes_stale_team_spool(self, spool_root):
        # A leftover team-scoped spool file from a crashed supervisor is
        # swept exactly like the user-scoped form.
        stale = os.path.join(spool_root, f'{TEAM_SCOPE}.{DEPLOY_STREAM}.000042.jsonl')
        with open(stale, 'w', encoding='utf-8') as f:
            f.write('{"stale": true}\n')
        sweep_spool_root(spool_root)
        assert not os.path.exists(stale)

    @pytest.mark.asyncio
    async def test_live_writer_registered_under_team_scope(self, istore, spool_root):
        writer = await open_deploy_writer(istore, spool_root)
        try:
            # Registered by SCOPE id: a team-scoped reader's live-writer
            # lookup (delete coordination, live tail) finds it; the owner's
            # user-scoped key does not exist.
            assert WRITERS.get(writer_key(TEAM_SCOPE, DEPLOY_STREAM)) is writer
            assert writer_key(SCOPE_ID, DEPLOY_STREAM) not in WRITERS
        finally:
            await writer.end_run('ok')
        assert writer_key(TEAM_SCOPE, DEPLOY_STREAM) not in WRITERS


# =============================================================================
# PERSONAL (@me) DEPLOY WRITER — private storage, real billing provenance
# =============================================================================

# A real billing team for an @me run: the run bills to it, but its logs must
# NOT live in the team tree. Distinct from TEAM so a leak is unambiguous.
BILLING_TEAM = 'bbbb1111-2c6c-4a9e-9c11-ffff9999cccc'


class TestPersonalDeployWriter:
    """A user-owned (@me) deploy: storage scope and billing provenance are
    SEPARATE. The user owner keeps the logs in the owner's private user tree,
    while team_id still records the run's REAL billing team on the control
    record — so a private @me log is never stored in (nor leaked to) the
    billing team's tree, and its billing context stays auditable.
    """

    async def _open_me_writer(self, istore, spool_root):
        stamp, raise_floor, _ = make_stamp()
        writer = RunLogWriter(
            FileStore(Store(istore), CLIENT, RequestContext.internal('test')),
            OWNER,  # user-owned => PRIVATE storage scope
            PROJECT,
            SOURCE,
            'deploy',
            stamp,
            raise_floor,
            team_id=BILLING_TEAM,  # real billing team (provenance)
            spool_root=spool_root,
        )
        await writer.open(trigger='manual', user=CLIENT, pipeline_hash='abc123', trace_level='summary')
        return writer

    @pytest.mark.asyncio
    async def test_me_deploy_logs_stay_private_in_user_tree(self, istore, spool_root):
        writer = await self._open_me_writer(istore, spool_root)
        stamp, _, _ = make_stamp(100)
        writer.append(stamp(output_event('me-run')))
        await writer._drain_uploads()
        await writer.end_run('ok')

        # Private: the deploy continuum lives in the OWNER's user tree...
        user_files = await istore.list_files(f'users/{CLIENT}/files/.logs/{PROJECT}')
        names = [path.rsplit('/', 1)[-1] for path in (user_files or [])]
        assert f'{SOURCE}.deploy.json' in names
        assert any(name.startswith(f'{SOURCE}.deploy.') and name.endswith('.jsonl') for name in names)

        # ...and NOTHING landed in the billing team's tree — that would leak a
        # private personal run to every teammate.
        team_files = await istore.list_files(f'teams/{BILLING_TEAM}/files/.logs/{PROJECT}')
        assert not (team_files or [])

    @pytest.mark.asyncio
    async def test_me_deploy_control_stamps_the_real_billing_team(self, istore, spool_root):
        writer = await self._open_me_writer(istore, spool_root)
        stamp, _, _ = make_stamp(100)
        writer.append(stamp(output_event('me-run')))
        await writer.end_run('ok')

        # Provenance is NOT lost to the private-scope '': the control record
        # carries the REAL billing team, so the run's billing/secrets context
        # is auditable even though its logs are private. (Before the scope/
        # provenance split this was either '' here or a leak into the team
        # tree — never both correct.)
        assert writer._control['teamId'] == BILLING_TEAM

    @pytest.mark.asyncio
    async def test_me_deploy_spool_is_user_qualified_not_team(self, istore, spool_root):
        writer = await self._open_me_writer(istore, spool_root)
        stamp, _, _ = make_stamp(100)
        writer.append(stamp(output_event('me-run')))

        # The live spool file carries the OWNER (user) scope id, never the
        # billing team — the storage scope is the user's.
        spooled = [name for name in os.listdir(spool_root) if name.endswith('.jsonl')]
        assert spooled and all(name.startswith(f'{SCOPE_ID}.{DEPLOY_STREAM}.') for name in spooled)
        assert not any(name.startswith(f'{BILLING_TEAM}.') for name in spooled)
        await writer.end_run('ok')


# =============================================================================
# TEAM-SCOPED READER
# =============================================================================


class TestTeamScopedReader:
    @pytest.mark.asyncio
    async def test_reader_reads_the_team_stream(self, istore, spool_root):
        # Seed one completed deploy run in the team tree.
        stamp, raise_floor, _ = make_stamp()
        writer = await open_deploy_writer(istore, spool_root, stamp, raise_floor)
        for i in range(3):
            writer.append(stamp(output_event(f'deploy-{i}')))
        await writer._drain_uploads()
        await writer.end_run('ok')

        # A teammate's reader (same scope helper) sees chapters + events.
        reader = team_reader(istore, spool_root)
        chapters = await reader.chapters()
        assert len(chapters['chapters']) == 1 and chapters['completed'] is True
        body = await reader.read(from_seq=1)
        outputs = [e['body'].get('output') for e in body['events'] if e.get('event') == 'output']
        assert outputs == ['deploy-0', 'deploy-1', 'deploy-2']

    @pytest.mark.asyncio
    async def test_a_user_owned_deploy_reader_is_user_scoped(self, istore, spool_root):
        # A user-owned deploy reader targets the owner's @me continuum in
        # the user tree (same helper, same rule as the writer) — never a
        # team's stream.
        reader = run_log.RunLogReader(
            FileStore(Store(istore), CLIENT, RequestContext.internal('test')),
            OWNER,
            PROJECT,
            SOURCE,
            'deploy',
            spool_root=spool_root,
        )
        assert reader._scope_prefix == f'=user/{CLIENT}/'
        assert reader._scope_id == SCOPE_ID

    @pytest.mark.asyncio
    async def test_a_failed_read_is_not_never_logged(self, istore, spool_root, monkeypatch):
        # Only a missing control means the stream was never logged; any other
        # store failure must surface, or a logged stream silently disappears.
        writer = await open_deploy_writer(istore, spool_root)
        await writer.end_run('ok')

        async def failing_read(self, path, max_size=0):
            raise StorageError('boom')

        monkeypatch.setattr(FileStore, 'read', failing_read)
        with pytest.raises(StorageError, match='boom'):
            await team_reader(istore, spool_root).chapters()
