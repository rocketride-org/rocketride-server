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
single scope helper (scope_paths) turns (run_kind, client_id, team_id) into
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
from ai.account.store import Store
from ai.account.models import RequestContext
from ai.account.store_providers.filesystem import FilesystemStore

# Shared identity constants + event helpers from the writer test module.
from .test_run_log import CLIENT, PROJECT, SOURCE, make_stamp, output_event

# A realistic team id: uuid-style, hyphens included — exactly what the spool
# filename regex must keep matching once scope ids can be team ids.
TEAM = '7f3adf10-2b6c-4a9e-9c11-aaaa5555bbbb'
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
        CLIENT,
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
        CLIENT,
        PROJECT,
        SOURCE,
        'deploy',
        team_id=TEAM,
        spool_root=spool_root,
    )


# =============================================================================
# SCOPE HELPER CONTRACT
# =============================================================================


class TestScopePaths:
    def test_dev_is_owner_scoped(self):
        # Dev: no prefix (the FileStore's own anchor), owner as scope id.
        assert scope_paths('dev', CLIENT, '') == ('', CLIENT)

    def test_dev_ignores_team(self):
        # A team id on a dev run is meaningless and must not change scope
        # (the COMMAND layer rejects the pairing; the helper stays total).
        assert scope_paths('dev', CLIENT, TEAM) == ('', CLIENT)

    def test_deploy_is_team_scoped(self):
        # Deploy: the internal-identity scope grammar + team id as scope id.
        assert scope_paths('deploy', CLIENT, TEAM) == (f'@/Team/={TEAM}/', TEAM)

    def test_deploy_without_team_is_an_error(self):
        # A deploy run with no team has no valid home — fail loudly rather
        # than silently landing team output in a user tree.
        with pytest.raises(ValueError):
            scope_paths('deploy', CLIENT, '')


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
        assert spooled and all(name.startswith(f'{TEAM}.{DEPLOY_STREAM}.') for name in spooled)

        # The anchored startup-sweep regex still matches the team-qualified
        # form (uuid hyphens included) — stale team spools get cleaned too.
        assert all(run_log._SPOOL_FILE_RE.match(name) for name in spooled)
        await writer.end_run('ok')

    @pytest.mark.asyncio
    async def test_sweep_removes_stale_team_spool(self, spool_root):
        # A leftover team-scoped spool file from a crashed supervisor is
        # swept exactly like the user-scoped form.
        stale = os.path.join(spool_root, f'{TEAM}.{DEPLOY_STREAM}.000042.jsonl')
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
            assert WRITERS.get(writer_key(TEAM, DEPLOY_STREAM)) is writer
            assert writer_key(CLIENT, DEPLOY_STREAM) not in WRITERS
        finally:
            await writer.end_run('ok')
        assert writer_key(TEAM, DEPLOY_STREAM) not in WRITERS


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
    async def test_unscoped_deploy_reader_is_rejected_at_construction(self, istore, spool_root):
        # Deploy continua have no user-scope home anymore: building a deploy
        # reader without a team fails LOUDLY at construction (same helper,
        # same rule as the writer) instead of quietly reading nothing.
        with pytest.raises(ValueError):
            run_log.RunLogReader(
                FileStore(Store(istore), CLIENT, RequestContext.internal('test')),
                CLIENT,
                PROJECT,
                SOURCE,
                'deploy',
                spool_root=spool_root,
            )
