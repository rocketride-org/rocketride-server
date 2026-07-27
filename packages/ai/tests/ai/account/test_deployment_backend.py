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

"""Contract tests for the deployments interface (file backend / OSS default).

These tests define the BEHAVIORAL CONTRACT of the teams-as-environments
model — publish immutability, pointer-move deploys, honest rollback labels,
soft removal, denormalized audit identity, sha256 artifact locking — over a
real filesystem store. The SaaS DB implementation must satisfy the same
assertions (its suite reuses these semantics against the DB).
"""

import shutil
import tempfile

import pytest

from ai.account.deployment_backend import FileDeploymentBackend, artifact_path
from ai.account.store import StorageError
from ai.account.store_providers.filesystem import FilesystemStore


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def store():
    """A throwaway filesystem IStore."""
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def backend(store):
    """The file deployment backend over the throwaway store."""
    return FileDeploymentBackend(store)


ACTOR = {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'}
OTHER = {'userId': 'user-2', 'display': 'M Harris', 'email': 'mh@example.com'}
PIPE = {'project_id': 'proj-1', 'name': 'Invoice Ingest', 'source': 'webhook_1', 'components': []}


# ============================================================================
# Publish — immutable registry
# ============================================================================


class TestPublish:
    @pytest.mark.asyncio
    async def test_versions_are_monotonic_and_immutable(self, backend, store):
        v1 = await backend.publish('org-1', 'proj-1', PIPE, ACTOR, 'first')
        v2 = await backend.publish('org-1', 'proj-1', {**PIPE, 'name': 'v2'}, ACTOR, 'second')
        assert (v1['version'], v2['version']) == (1, 2)

        # Both artifacts exist independently — publishing never overwrites.
        assert await store.read_file(artifact_path('org-1', 'proj-1', 1))
        assert await store.read_file(artifact_path('org-1', 'proj-1', 2))

        # Registry keeps both entries, newest first via versions().
        versions = await backend.versions('org-1', 'proj-1')
        assert [v['version'] for v in versions] == [2, 1]

    @pytest.mark.asyncio
    async def test_registry_entry_carries_denormalized_audit_identity(self, backend):
        entry = await backend.publish('org-1', 'proj-1', PIPE, ACTOR, 'note')
        # WHO published survives even if the user row is later deleted.
        assert entry['publishedBy'] == ACTOR
        assert entry['comment'] == 'note'
        assert entry['sha256'] and entry['bytes'] > 0
        assert entry['pipelineName'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_publish_requires_actor_and_pipeline(self, backend):
        with pytest.raises(ValueError, match='actor.userId'):
            await backend.publish('org-1', 'proj-1', PIPE, {})
        with pytest.raises(ValueError, match='pipeline'):
            await backend.publish('org-1', 'proj-1', {}, ACTOR)

    @pytest.mark.asyncio
    async def test_ids_must_be_path_safe(self, backend):
        for bad in ('a/b', '..', '.', '@x', '=x', ''):
            with pytest.raises(ValueError):
                await backend.publish('org-1', bad, PIPE, ACTOR)
            with pytest.raises(ValueError):
                await backend.publish(bad, 'proj-1', PIPE, ACTOR)


# ============================================================================
# Deploy — pointer moves (promotion and rollback)
# ============================================================================


class TestDeploy:
    @pytest.mark.asyncio
    async def test_deploy_points_team_at_version(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        dep = await backend.deploy('org-1', 'team-stag', 'proj-1', 1, ACTOR)
        assert dep['teamId'] == 'team-stag'
        assert dep['version'] == 1
        assert dep['state'] == 'active'
        # Mutations return the JOINED record — scheduler.sync() keys off
        # projectId, so a raw internal dict here silently breaks scheduling.
        assert dep['projectId'] == 'proj-1'
        assert dep['pipelineName'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_unpublished_version_refused(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        with pytest.raises(ValueError, match='not published'):
            await backend.deploy('org-1', 'team-stag', 'proj-1', 7, ACTOR)

    @pytest.mark.asyncio
    async def test_two_teams_hold_independent_pointers(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-stag', 'proj-1', 2, ACTOR)
        await backend.deploy('org-1', 'team-prod', 'proj-1', 1, OTHER)

        stag = await backend.get('org-1', 'team-stag', 'proj-1')
        prod = await backend.get('org-1', 'team-prod', 'proj-1')
        assert (stag['version'], prod['version']) == (2, 1)

    @pytest.mark.asyncio
    async def test_rollback_is_a_pointer_move_with_an_honest_label(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-prod', 'proj-1', 2, ACTOR)
        dep = await backend.deploy('org-1', 'team-prod', 'proj-1', 1, OTHER)
        assert dep['version'] == 1

        history = await backend.history('org-1', 'proj-1', 'team-prod')
        # Newest first: the downgrade is recorded as 'rollback', by whom.
        assert history[0]['action'] == 'rollback'
        assert history[0]['actor'] == OTHER
        assert history[0]['version'] == 1


# ============================================================================
# State + soft remove
# ============================================================================


class TestState:
    @pytest.mark.asyncio
    async def test_pause_resume(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-1', 'proj-1', 1, ACTOR)

        dep = await backend.set_state('org-1', 'team-1', 'proj-1', 'paused', ACTOR)
        assert dep['state'] == 'paused'
        dep = await backend.set_state('org-1', 'team-1', 'proj-1', 'active', ACTOR)
        assert dep['state'] == 'active'

    @pytest.mark.asyncio
    async def test_soft_remove_hides_but_retains_everything(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-1', 'proj-1', 1, ACTOR)
        await backend.set_state('org-1', 'team-1', 'proj-1', 'removed', ACTOR)

        # Hidden from reads...
        assert await backend.get('org-1', 'team-1', 'proj-1') is None
        assert await backend.list_team('org-1', 'team-1') == []
        # ...but the registry and the audit trail survive in full.
        assert len(await backend.versions('org-1', 'proj-1')) == 1
        actions = [h['action'] for h in await backend.history('org-1', 'proj-1')]
        assert 'remove' in actions and 'publish' in actions

        # And a fresh deploy revives the team's deployment.
        dep = await backend.deploy('org-1', 'team-1', 'proj-1', 1, ACTOR)
        assert dep['state'] == 'active'

    @pytest.mark.asyncio
    async def test_state_change_requires_existing_deployment(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        with pytest.raises(StorageError, match='No deployment'):
            await backend.set_state('org-1', 'team-x', 'proj-1', 'paused', ACTOR)


# ============================================================================
# Schedules
# ============================================================================


class TestSchedules:
    @pytest.mark.asyncio
    async def test_set_and_clear_per_source(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-1', 'proj-1', 1, ACTOR)

        dep = await backend.schedule_set('org-1', 'team-1', 'proj-1', 'webhook_1', '*/5 * * * *', True, ACTOR)
        assert dep['schedules']['webhook_1']['cron'] == '*/5 * * * *'
        assert dep['schedules']['webhook_1']['enabled'] is True

        dep = await backend.schedule_set('org-1', 'team-1', 'proj-1', 'webhook_1', None, True, ACTOR)
        assert 'webhook_1' not in dep['schedules']

    @pytest.mark.asyncio
    async def test_mark_run_stamps_last_fired(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-1', 'proj-1', 1, ACTOR)
        await backend.schedule_set('org-1', 'team-1', 'proj-1', 'webhook_1', '@hourly', True, ACTOR)

        await backend.mark_run('org-1', 'team-1', 'proj-1', 'webhook_1')
        dep = await backend.get('org-1', 'team-1', 'proj-1')
        assert dep['schedules']['webhook_1']['lastRunAt'] is not None


# ============================================================================
# Artifact integrity
# ============================================================================


class TestArtifact:
    @pytest.mark.asyncio
    async def test_artifact_round_trips_and_verifies(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        pipeline = await backend.artifact('org-1', 'proj-1', 1)
        assert pipeline['name'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_tampered_artifact_refuses_to_load(self, backend, store):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        # Tamper with the stored bytes AFTER publish — the registry sha256
        # must catch it, because what was tested must be what runs.
        await store.write_file(artifact_path('org-1', 'proj-1', 1), '{"project_id": "proj-1", "evil": true}')
        with pytest.raises(StorageError, match='sha256 mismatch'):
            await backend.artifact('org-1', 'proj-1', 1)

    @pytest.mark.asyncio
    async def test_unknown_version_refuses(self, backend):
        with pytest.raises(StorageError, match='not in the registry'):
            await backend.artifact('org-1', 'proj-1', 3)


# ============================================================================
# Scheduler feed
# ============================================================================


class TestIterActive:
    @pytest.mark.asyncio
    async def test_yields_only_active_deployments_across_orgs(self, backend):
        await backend.publish('org-1', 'proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', 'team-a', 'proj-1', 1, ACTOR)
        await backend.deploy('org-1', 'team-b', 'proj-1', 1, ACTOR)
        await backend.set_state('org-1', 'team-b', 'proj-1', 'paused', ACTOR)

        await backend.publish('org-2', 'proj-9', {**PIPE, 'project_id': 'proj-9'}, OTHER)
        await backend.deploy('org-2', 'team-z', 'proj-9', 1, OTHER)

        seen = [(d['orgId'], d['teamId'], d['projectId']) async for d in backend.iter_active()]
        assert ('org-1', 'team-a', 'proj-1') in seen
        assert ('org-2', 'team-z', 'proj-9') in seen
        assert all(t != 'team-b' for _, t, _p in seen)
