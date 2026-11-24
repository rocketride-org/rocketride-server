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

import json
import os
import shutil
import tempfile

import pytest

from ai.account.deployment_backend import (
    FileDeploymentBackend,
    artifact_content_dir,
    artifact_path,
    audience_display,
    audience_handle,
    delete_block_of,
)
from ai.account.store import StorageError, StorageNotFoundError
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
        v1 = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR, 'first')
        v2 = await backend.publish('org-1', 'acme.proj-1', {**PIPE, 'name': 'v2'}, ACTOR, 'second')
        assert (v1['version'], v2['version']) == (1, 2)

        # Both artifacts exist independently — publishing never overwrites.
        # Read via the entries' STORED paths: that is the reader contract.
        assert await store.read_file(v1['artifactPath'])
        assert await store.read_file(v2['artifactPath'])

        # Registry keeps both entries, newest first via versions().
        versions = await backend.versions('org-1', 'acme.proj-1')
        assert [v['version'] for v in versions] == [2, 1]

    @pytest.mark.asyncio
    async def test_registry_entry_carries_denormalized_audit_identity(self, backend):
        entry = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR, 'note')
        # WHO published survives even if the user row is later deleted.
        assert entry['publishedBy'] == ACTOR
        assert entry['comment'] == 'note'
        assert entry['sha256'] and entry['bytes'] > 0
        assert entry['pipelineName'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_publish_stamps_kind_state_and_metadata(self, backend):
        """The rail contract: kind rides the artifact dict, state is stamped by kind."""
        pipe = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        assert (pipe['kind'], pipe['state']) == ('pipe', 'private')
        # Display name always lives in metadata.manifest (pipelineName is legacy)
        assert pipe['metadata']['manifest']['name'] == 'Invoice Ingest'

        # App artifacts carry kind:'app' and deploy 'private' (internal-eligible;
        # the developer submits for review separately)
        app_artifact = {'kind': 'app', 'appId': 'acme.brandy', 'name': 'Brandy', 'appVersion': '1.0.0'}
        app = await backend.publish('org-1', 'acme.brandy', app_artifact, ACTOR)
        assert (app['kind'], app['state']) == ('app', 'private')
        assert app['metadata']['manifest']['name'] == 'Brandy'

    @pytest.mark.asyncio
    async def test_publish_persists_caller_metadata(self, backend):
        """A caller-supplied metadata blob is stored; manifest.name is synthesized when absent."""
        metadata = {'manifest': {'id': 'acme.brandy', 'categories': ['tools']}, 'build': {'errors': []}}
        entry = await backend.publish(
            'org-1', 'acme.brandy', {'kind': 'app', 'name': 'Brandy'}, ACTOR, metadata=metadata
        )
        assert entry['metadata']['build'] == {'errors': []}
        assert entry['metadata']['manifest']['categories'] == ['tools']
        # The synthesized display name fills the gap the caller left
        assert entry['metadata']['manifest']['name'] == 'Brandy'

    @pytest.mark.asyncio
    async def test_pre_rail_entries_read_without_new_keys(self, backend, store):
        """Old meta.json entries (no kind/state/metadata) still list and load."""
        entry = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        # Strip the rail keys in place — simulating a pre-0012 meta.json
        meta_path = 'orgs/org-1/files/.deployments/acme.proj-1/meta.json'
        import json as _json

        meta = _json.loads(await store.read_file(meta_path))
        for key in ('kind', 'state', 'metadata'):
            meta['versions'][0].pop(key, None)
        await store.write_file(meta_path, _json.dumps(meta))

        versions = await backend.versions('org-1', 'acme.proj-1')
        assert versions[0]['version'] == entry['version']
        assert 'kind' not in versions[0]  # readers tolerate absence via .get()
        artifact = await backend.artifact('org-1', 'acme.proj-1', entry['version'])
        assert artifact['name'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_publish_requires_actor_and_pipeline(self, backend):
        with pytest.raises(ValueError, match='actor.userId'):
            await backend.publish('org-1', 'acme.proj-1', PIPE, {})
        with pytest.raises(ValueError, match='pipeline'):
            await backend.publish('org-1', 'acme.proj-1', {}, ACTOR)

    @pytest.mark.asyncio
    async def test_ids_must_be_path_safe(self, backend):
        for bad in ('a/b', '..', '.', '@x', '=x', ''):
            with pytest.raises(ValueError):
                await backend.publish('org-1', bad, PIPE, ACTOR)
            with pytest.raises(ValueError):
                await backend.publish(bad, 'acme.proj-1', PIPE, ACTOR)


# ============================================================================
# Publishes — audience pointers (user | team | public)
# ============================================================================

AUD_USER = {'type': 'user', 'id': 'user-1'}
AUD_TEAM = {'type': 'team', 'id': 'team-1'}
AUD_PUBLIC = {'type': 'public', 'id': ''}
APP = {'kind': 'app', 'appId': 'acme.brandy', 'name': 'Brandy', 'appVersion': '1.0.0'}


class TestPublishes:
    @pytest.mark.asyncio
    async def test_publish_set_upserts_one_binding_per_audience(self, backend):
        """publish_set creates the audience binding (born 'enabled') and
        repoints it in place; artifactState joins the deployment's review state.
        """
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # 'private'
        v2 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR, comment='swapped the icon')

        row = await backend.publish_set(
            'org-1', 'app', 'acme.brandy', AUD_TEAM, v1['version'], {'name': 'Brandy', 'mode': 'free'}, ACTOR
        )
        assert (row['audience'], row['state'], row['version']) == (AUD_TEAM, 'enabled', 1)
        assert row['artifactState'] == 'private'  # the bound deployment's review state
        assert row['snapshot']['name'] == 'Brandy'

        # Repoint the SAME audience — still exactly one binding for it
        row = await backend.publish_set(
            'org-1', 'app', 'acme.brandy', AUD_TEAM, v2['version'], {'name': 'Brandy v2'}, ACTOR
        )
        assert row['version'] == 2
        rows = await backend.publish_of_app('org-1', 'app', 'acme.brandy')
        assert len(rows) == 1 and rows[0]['snapshot']['name'] == 'Brandy v2'

        # History rows are self-describing: the audience pair rides with its
        # display name ('' when the caller passed a bare dict) and never a
        # handle (composed per reader when the row is read), and a repoint
        # records the version it moved OFF of.
        binds = [
            r
            for r in (await backend.history('org-1', 'acme.brandy'))['rows']
            if r['action'] == 'publish' and (r.get('data') or {}).get('audience')
        ]
        assert [b['data']['audience'] for b in binds] == [{'type': 'team', 'id': 'team-1', 'name': ''}] * 2
        assert binds[0]['data']['previousVersion'] == 1  # newest first: the repoint
        assert 'previousVersion' not in binds[1]['data']  # the first bind moved off nothing

        # The DEPLOY rows (no audience) ride the developer's comment when
        # one was given, and stay bare when not.
        deploys = [
            r
            for r in (await backend.history('org-1', 'acme.brandy'))['rows']
            if r['action'] == 'publish' and not (r.get('data') or {}).get('audience')
        ]
        assert deploys[0]['data'] == {'comment': 'swapped the icon'}  # newest first: v2
        assert not (deploys[1].get('data') or {})  # v1 had no comment

    @pytest.mark.asyncio
    async def test_publish_set_lands_the_binding_in_the_requested_state(self, backend):
        """A caller carrying a disabled state through a version bump lands it in
        the same write; a repoint without one re-enables; anything else is refused.
        """
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        v2 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        row = await backend.publish_set(
            'org-1', 'app', 'acme.brandy', AUD_TEAM, v1['version'], {'name': 'B'}, ACTOR, state='disabled'
        )
        assert (row['state'], row['version']) == ('disabled', 1)
        rows = await backend.publish_of_app('org-1', 'app', 'acme.brandy')
        assert [(r['state'], r['version']) for r in rows] == [('disabled', 1)]

        row = await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_TEAM, v2['version'], {'name': 'B'}, ACTOR)
        assert (row['state'], row['version']) == ('enabled', 2)

        with pytest.raises(ValueError):
            await backend.publish_set(
                'org-1', 'app', 'acme.brandy', AUD_TEAM, v2['version'], {'name': 'B'}, ACTOR, state='removed'
            )

    @pytest.mark.asyncio
    async def test_publish_set_requires_a_registry_version(self, backend):
        """Publishing a version the rail has never seen is refused."""
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        with pytest.raises(StorageError):
            await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_TEAM, 99, {}, ACTOR)

    @pytest.mark.asyncio
    async def test_publish_lifecycle_get_list_and_binding_state(self, backend):
        """get/list see live bindings; binding-state flips disable/remove."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_USER, v1['version'], {'name': 'B'}, ACTOR)
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_PUBLIC, v1['version'], {'name': 'B'}, ACTOR)

        # Bindings are born 'enabled'; the deployment's review state rides as artifactState
        got = await backend.publish_get('org-1', 'app', 'acme.brandy', AUD_USER)
        assert (got['state'], got['artifactState']) == ('enabled', 'private')
        rows = await backend.publish_list('org-1', 'app', [AUD_USER, AUD_PUBLIC, AUD_TEAM])
        assert {(r['audience']['type'], r['state']) for r in rows} == {('user', 'enabled'), ('public', 'enabled')}

        # disable pulls the binding; soft-remove hides it from every reader
        flipped = await backend.publish_set_state('org-1', 'app', 'acme.brandy', AUD_PUBLIC, 'disabled', ACTOR)
        assert flipped['state'] == 'disabled'
        await backend.publish_set_state('org-1', 'app', 'acme.brandy', AUD_USER, 'removed', ACTOR)
        assert await backend.publish_get('org-1', 'app', 'acme.brandy', AUD_USER) is None
        with pytest.raises(ValueError):
            await backend.publish_set_state('org-1', 'app', 'acme.brandy', AUD_PUBLIC, 'ready', ACTOR)

        # Unbind rows say WHICH rung was touched — "v1 removed" alone would
        # read as the version vanishing from the registry.
        by_action = {r['action']: r for r in (await backend.history('org-1', 'acme.brandy'))['rows']}
        assert by_action['disabled']['data']['audience'] == {'type': 'public', 'id': '', 'name': ''}
        assert by_action['removed']['data']['audience'] == {'type': 'user', 'id': 'user-1', 'name': ''}

    @pytest.mark.asyncio
    async def test_publish_list_of_the_public_audience_returns_public_rows_only(self, backend):
        """Team and user pins never reach a public-rung listing (app_rows.public_winners relies on it)."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        for audience in (AUD_USER, AUD_TEAM, AUD_PUBLIC):
            await backend.publish_set('org-1', 'app', 'acme.brandy', audience, v1['version'], {'name': 'B'}, ACTOR)
        rows = await backend.publish_list('org-1', 'app', [AUD_PUBLIC])
        assert [r['audience'] for r in rows] == [AUD_PUBLIC]

    @pytest.mark.asyncio
    async def test_set_artifact_state_review_lifecycle(self, backend):
        """The review lifecycle lives on the deployment: private -> submit ->
        ready | rejected, with illegal transitions refused and a history event
        per move. The seeder may also override the born state directly.
        """
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # 'private'
        assert v1['state'] == 'private'

        submitted = await backend.set_artifact_state('org-1', 'acme.brandy', 1, 'submit', ACTOR)
        assert submitted['state'] == 'submit'
        approved = await backend.set_artifact_state('org-1', 'acme.brandy', 1, 'ready', ACTOR)
        assert approved['state'] == 'ready'

        # ready -> submit is not a legal move
        with pytest.raises(ValueError):
            await backend.set_artifact_state('org-1', 'acme.brandy', 1, 'submit', ACTOR)

        # The seeder can register a pre-approved artifact directly
        seeded = await backend.publish('org-1', 'acme.brandy', APP, ACTOR, state='ready')
        assert seeded['state'] == 'ready'
        with pytest.raises(ValueError):
            await backend.publish('org-1', 'acme.brandy', APP, ACTOR, state='enabled')

        # The review events land on the one history stream (newest first),
        # each carrying both endpoints of its transition.
        envelope = await backend.history('org-1', 'acme.brandy')
        review = {r['action']: r for r in envelope['rows'] if r['action'] in ('request', 'approved', 'rejected')}
        assert list(review) == ['approved', 'request']
        assert review['request']['data'] == {'from': 'private', 'to': 'submit'}
        assert review['approved']['data'] == {'from': 'submit', 'to': 'ready'}


# ============================================================================
# Deploy — pointer moves (promotion and rollback)
# ============================================================================


class TestDeploy:
    @pytest.mark.asyncio
    async def test_deploy_points_team_at_version(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        dep = await backend.deploy('org-1', '=team/team-stag', 'acme.proj-1', 1, ACTOR)
        assert dep['teamId'] == dep['audience'] == '=team/team-stag'
        assert dep['version'] == 1
        assert dep['state'] == 'enabled'
        # Mutations return the JOINED record — scheduler.sync() keys off
        # projectId, so a raw internal dict here silently breaks scheduling.
        assert dep['projectId'] == 'acme.proj-1'
        assert dep['pipelineName'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_deploy_persists_and_restamps_the_billing_team(self, backend):
        # The ABSOLUTE billing stamp: written at pointer time, re-stamped on
        # every pointer move, and returned on the joined record ('' on
        # records from before the field existed).
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        dep = await backend.deploy('org-1', '=user/u1', 'acme.proj-1', 1, ACTOR, 'team-dev')
        assert dep['billingTeamId'] == 'team-dev'
        # deploy() returns the joined record from the mutation path, which does
        # not prove the write landed — read it back from storage to assert both
        # the version pointer AND the billing stamp actually persisted.
        stored = await backend.get('org-1', '=user/u1', 'acme.proj-1')
        assert stored['version'] == 1
        assert stored['billingTeamId'] == 'team-dev'
        # A pointer move re-decides the stamp.
        dep = await backend.deploy('org-1', '=user/u1', 'acme.proj-1', 2, ACTOR, 'team-prod')
        assert dep['billingTeamId'] == 'team-prod'
        stored = await backend.get('org-1', '=user/u1', 'acme.proj-1')
        assert stored['version'] == 2
        assert stored['billingTeamId'] == 'team-prod'

    @pytest.mark.asyncio
    async def test_unpublished_version_refused(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        with pytest.raises(ValueError, match='not published'):
            await backend.deploy('org-1', '=team/team-stag', 'acme.proj-1', 7, ACTOR)

    @pytest.mark.asyncio
    async def test_two_teams_hold_independent_pointers(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-stag', 'acme.proj-1', 2, ACTOR)
        await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 1, OTHER)

        stag = await backend.get('org-1', '=team/team-stag', 'acme.proj-1')
        prod = await backend.get('org-1', '=team/team-prod', 'acme.proj-1')
        assert (stag['version'], prod['version']) == (2, 1)

    @pytest.mark.asyncio
    async def test_rollback_is_a_pointer_move_with_an_honest_label(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 2, ACTOR)
        dep = await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 1, OTHER)
        assert dep['version'] == 1

        history = (await backend.history('org-1', 'acme.proj-1', '=team/team-prod'))['rows']
        # Newest first: the downgrade is recorded as 'rollback', by whom.
        assert history[0]['action'] == 'rollback'
        assert history[0]['actor'] == OTHER
        assert history[0]['version'] == 1
        # Every row carries the stable append-order key (paging identity).
        assert [h['seq'] for h in history] == sorted((h['seq'] for h in history), reverse=True)

    @pytest.mark.asyncio
    async def test_history_ties_break_by_append_order(self, backend, monkeypatch):
        # Two mutations inside the clock's resolution get the SAME 'at'
        # stamp; ordering must still be newest-append-first (the DB backend
        # guarantees this via id.desc() — the file backend must match).
        import ai.account.deployment_backend as backend_mod

        monkeypatch.setattr(backend_mod.time, 'time', lambda: 1_000_000.0)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 2, ACTOR)
        await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 1, OTHER)

        history = (await backend.history('org-1', 'acme.proj-1', '=team/team-prod'))['rows']
        # (Org-wide publish rows ride along in a team-filtered view.)
        assert [h['action'] for h in history] == ['rollback', 'deploy', 'publish', 'publish']

    @pytest.mark.asyncio
    async def test_history_is_a_paged_list_envelope(self, backend):
        # History is the unbounded audit surface: the BACKEND owns paging
        # and returns the standard {rows,total,page,pageSize} envelope.
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        for _ in range(4):
            await backend.deploy('org-1', '=team/team-prod', 'acme.proj-1', 1, ACTOR)

        page1 = await backend.history('org-1', 'acme.proj-1', None, {'page': 1, 'page_size': 2})
        page2 = await backend.history('org-1', 'acme.proj-1', None, {'page': 2, 'page_size': 2})
        assert (page1['total'], page1['page'], page1['pageSize']) == (5, 1, 2)
        assert len(page1['rows']) == 2 and len(page2['rows']) == 2
        # seq-descending across page boundaries: no overlap, no gaps.
        seqs = [r['seq'] for r in page1['rows'] + page2['rows']]
        assert seqs == sorted(seqs, reverse=True) and len(set(seqs)) == 4

        # Search and filters run inside the envelope too.
        publishes = await backend.history('org-1', 'acme.proj-1', None, {'search': 'publish'})
        assert [r['action'] for r in publishes['rows']] == ['publish']
        filtered = await backend.history('org-1', 'acme.proj-1', None, {'filters': {'action': 'deploy'}})
        assert filtered['total'] == 4


# ============================================================================
# State + soft remove
# ============================================================================


class TestState:
    @pytest.mark.asyncio
    async def test_disable_enable(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        deployed = await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        assert deployed['deployedAt'] is not None

        dep = await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'disabled', ACTOR)
        assert dep['state'] == 'disabled'
        # deployedAt is the POINTER-MOVE stamp — state flips never bump it.
        assert dep['deployedAt'] == deployed['deployedAt']
        dep = await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'enabled', ACTOR)
        assert dep['state'] == 'enabled'

        # History records the user verbs, not raw states.
        actions = [h['action'] for h in (await backend.history('org-1', 'acme.proj-1'))['rows']]
        assert 'disable' in actions and 'enable' in actions

    @pytest.mark.asyncio
    async def test_old_state_names_are_rejected(self, backend):
        # The pre-0007 vocabulary must not silently round-trip.
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        with pytest.raises(ValueError, match='invalid state'):
            await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'paused', ACTOR)
        with pytest.raises(ValueError, match='invalid state'):
            await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'active', ACTOR)

    @pytest.mark.asyncio
    async def test_soft_remove_hides_but_retains_everything(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'removed', ACTOR)

        # Hidden from reads...
        assert await backend.get('org-1', '=team/team-1', 'acme.proj-1') is None
        assert await backend.list_team('org-1', '=team/team-1') == []
        # ...but the registry and the audit trail survive in full.
        assert len(await backend.versions('org-1', 'acme.proj-1')) == 1
        actions = [h['action'] for h in (await backend.history('org-1', 'acme.proj-1'))['rows']]
        assert 'remove' in actions and 'publish' in actions

        # And a fresh deploy revives the team's deployment.
        dep = await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        assert dep['state'] == 'enabled'

    @pytest.mark.asyncio
    async def test_state_change_requires_existing_deployment(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        with pytest.raises(StorageError, match='No deployment'):
            await backend.set_state('org-1', '=team/team-x', 'acme.proj-1', 'disabled', ACTOR)


# ============================================================================
# Schedules
# ============================================================================


class TestSchedules:
    @pytest.mark.asyncio
    async def test_set_and_clear_per_source(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)

        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '*/5 * * * *', ACTOR)
        assert dep['schedules']['webhook_1']['cron'] == '*/5 * * * *'
        assert dep['schedules']['webhook_1']['paused'] is False
        assert dep['schedules']['webhook_1']['ttl'] is None

        # The run window ('fixed window') rides the schedule record.
        dep = await backend.schedule_set(
            'org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '*/5 * * * *', ACTOR, 1800
        )
        assert dep['schedules']['webhook_1']['ttl'] == 1800

        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', None, ACTOR)
        assert 'webhook_1' not in dep['schedules']

    @pytest.mark.asyncio
    async def test_pause_resume_one_schedule(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '*/5 * * * *', ACTOR, 900)

        # Pause keeps cron/ttl; resume flips it back.
        dep = await backend.schedule_set_paused('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', True, ACTOR)
        assert dep['schedules']['webhook_1']['paused'] is True
        assert dep['schedules']['webhook_1']['cron'] == '*/5 * * * *'
        assert dep['schedules']['webhook_1']['ttl'] == 900
        dep = await backend.schedule_set_paused('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', False, ACTOR)
        assert dep['schedules']['webhook_1']['paused'] is False

    @pytest.mark.asyncio
    async def test_pause_survives_cron_edit(self, backend):
        # Editing cron/ttl must NOT silently unpause a paused schedule.
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '*/5 * * * *', ACTOR)
        await backend.schedule_set_paused('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', True, ACTOR)

        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '@hourly', ACTOR, 600)
        assert dep['schedules']['webhook_1']['paused'] is True
        assert dep['schedules']['webhook_1']['cron'] == '@hourly'

    @pytest.mark.asyncio
    async def test_source_config_set_and_survives_schedule_edits(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)

        # Config on an UNSCHEDULED source creates the row with cron '' —
        # the 'manual' wire semantic, so nothing ever fires from it.
        dep = await backend.source_config_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', 'none', True, ACTOR)
        assert dep['schedules']['webhook_1']['traceLevel'] == 'none'
        assert dep['schedules']['webhook_1']['debugOut'] is True
        assert dep['schedules']['webhook_1']['cron'] == ''

        # Setting a schedule keeps the config; clearing it keeps the row
        # BECAUSE config is still set (cron returns to '').
        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '@hourly', ACTOR, 600)
        assert dep['schedules']['webhook_1']['traceLevel'] == 'none'
        assert dep['schedules']['webhook_1']['debugOut'] is True
        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', None, ACTOR)
        assert dep['schedules']['webhook_1']['cron'] == ''
        assert dep['schedules']['webhook_1']['traceLevel'] == 'none'

        # Clearing the config back to defaults, then the schedule: row gone.
        await backend.source_config_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', None, False, ACTOR)
        dep = await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', None, ACTOR)
        assert 'webhook_1' not in dep['schedules']

    @pytest.mark.asyncio
    async def test_pause_requires_existing_schedule(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        with pytest.raises(StorageError, match='No schedule'):
            await backend.schedule_set_paused('org-1', '=team/team-1', 'acme.proj-1', 'ghost_1', True, ACTOR)

    @pytest.mark.asyncio
    async def test_mark_run_stamps_last_fired(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR)
        await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '@hourly', ACTOR)

        await backend.mark_run('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1')
        dep = await backend.get('org-1', '=team/team-1', 'acme.proj-1')
        assert dep['schedules']['webhook_1']['lastRunAt'] is not None


# ============================================================================
# Artifact integrity
# ============================================================================


class TestArtifact:
    @pytest.mark.asyncio
    async def test_artifact_round_trips_and_verifies(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        pipeline = await backend.artifact('org-1', 'acme.proj-1', 1)
        assert pipeline['name'] == 'Invoice Ingest'

    @pytest.mark.asyncio
    async def test_tampered_artifact_refuses_to_load(self, backend, store):
        entry = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        # Tamper with the stored bytes AFTER publish — the registry sha256
        # must catch it, because what was tested must be what runs.
        await store.write_file(entry['artifactPath'], '{"project_id": "proj-1", "evil": true}')
        with pytest.raises(StorageError, match='sha256 mismatch'):
            await backend.artifact('org-1', 'acme.proj-1', 1)

    @pytest.mark.asyncio
    async def test_unknown_version_refuses(self, backend):
        with pytest.raises(StorageError, match='not in the registry'):
            await backend.artifact('org-1', 'acme.proj-1', 3)

    def test_artifact_paths_are_content_unique(self):
        # The content hash in the filename is what makes concurrent
        # publishers race-safe: two racers allocating the SAME version
        # number with different pipelines write DIFFERENT files, so the
        # CAS loser's artifact can never overwrite the winner's.
        a = artifact_path('org-1', 'acme.proj-1', 1, 'a' * 64)
        b = artifact_path('org-1', 'acme.proj-1', 1, 'b' * 64)
        assert a != b


# ============================================================================
# deploy delete — one version's storage goes while nothing points at it
# ============================================================================


async def _write_content(store, entry):
    """Lay the content dir beside the registry JSON the way the doors do (bundle/source/dist/build.log)."""
    content_dir = artifact_content_dir(entry['artifactPath'])
    for rel in ('bundle/app.zip', 'source/package.json', 'dist/index.html', 'build.log'):
        await store.write_file(f'{content_dir}/{rel}', rel)
    return content_dir


class TestDeleteVersion:
    @pytest.mark.asyncio
    async def test_free_version_loses_every_path_and_the_number_is_never_reused(self, backend, store):
        """Plan 2.3: the registry JSON, the whole sibling content dir and the
        registry entry are gone; the history keeps the deploy line and gains
        the delete line; the next deploy takes a HIGHER number.
        """
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR, 'first')
        v2 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR, 'second')
        content_dir = await _write_content(store, v2)
        assert await store.list_files(content_dir + '/')

        result = await backend.delete_version('org-1', 'acme.brandy', 2, OTHER)
        assert result['deleted'] is True and (result['version'], result['kind']) == (2, 'app')
        assert result['sha256'] == v2['sha256']

        # Every path the version owned is gone: the JSON, the content tree,
        # the directory itself (the filesystem store removes it whole).
        with pytest.raises(StorageNotFoundError):
            await store.read_file(v2['artifactPath'])
        assert await store.list_files(content_dir + '/') == []
        assert not os.path.isdir(os.path.join(store._root_path, content_dir))
        # The registry entry is gone; v1 and its bytes are untouched.
        assert [v['version'] for v in await backend.versions('org-1', 'acme.brandy')] == [1]
        assert await store.read_file(v1['artifactPath'])

        # History: the deploy line stays, a delete line (who, when, what) is added.
        rows = (await backend.history('org-1', 'acme.brandy'))['rows']
        delete_rows = [r for r in rows if r['action'] == 'delete']
        assert len(delete_rows) == 1
        assert delete_rows[0]['version'] == 2 and delete_rows[0]['actor'] == OTHER
        assert delete_rows[0]['data'] == {'sha256': v2['sha256'], 'kind': 'app'}
        assert [r['version'] for r in rows if r['action'] == 'publish'] == [2, 1]

        # The number is never reused: the next deploy is v3, not v2.
        v3 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR, 'third')
        assert v3['version'] == 3

    @pytest.mark.asyncio
    async def test_pinned_version_is_refused_naming_the_rung(self, backend, store):
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        await _write_content(store, v1)
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_TEAM, 1, {'name': 'B'}, ACTOR)
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_PUBLIC, 1, {'name': 'B'}, ACTOR)
        # Each rung by the handle the server composes; with no reader a team
        # it cannot name reads by id
        with pytest.raises(ValueError, match=r'v1 is published to =team/team-1, @public; unpublish it first'):
            await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        # Nothing moved: the bytes and the entry are intact.
        assert await store.read_file(v1['artifactPath'])
        assert [v['version'] for v in await backend.versions('org-1', 'acme.brandy')] == [1]

        # A pipe's team pointer pins the same way; a soft-removed pointer does not.
        p1 = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR, 'team-1')
        with pytest.raises(ValueError, match='=team/team-1'):
            await backend.delete_version('org-1', 'acme.proj-1', 1, ACTOR)
        await backend.set_state('org-1', '=team/team-1', 'acme.proj-1', 'removed', ACTOR)
        assert (await backend.delete_version('org-1', 'acme.proj-1', 1, ACTOR))['deleted'] is True
        with pytest.raises(StorageNotFoundError):
            await store.read_file(p1['artifactPath'])

    @pytest.mark.asyncio
    async def test_version_in_review_is_refused(self, backend):
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        await backend.set_artifact_state('org-1', 'acme.brandy', 1, 'submit', ACTOR)
        with pytest.raises(ValueError, match='v1 is in review; withdraw it first'):
            await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        # Withdrawn, it is free again.
        await backend.set_artifact_state('org-1', 'acme.brandy', 1, 'private', ACTOR)
        assert (await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR))['deleted'] is True

    @pytest.mark.asyncio
    async def test_building_version_is_refused(self, backend):
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        for status in ('queued', 'building'):
            await backend.set_build('org-1', 'acme.brandy', 1, {'status': status})
            with pytest.raises(ValueError, match='v1 is still building; wait for the build to finish'):
                await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        # A finished build (ok or failed) no longer holds the version.
        await backend.set_build('org-1', 'acme.brandy', 1, {'status': 'failed'})
        assert (await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR))['deleted'] is True

    @pytest.mark.asyncio
    async def test_unknown_version_and_bad_arguments_refuse(self, backend):
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        with pytest.raises(StorageError, match='v7: not in the registry'):
            await backend.delete_version('org-1', 'acme.brandy', 7, ACTOR)
        with pytest.raises(ValueError, match='positive integer'):
            await backend.delete_version('org-1', 'acme.brandy', 0, ACTOR)
        with pytest.raises(StorageError, match='not in the registry'):
            await backend.delete_version('org-1', 'acme.nothing', 1, ACTOR)

    @pytest.mark.asyncio
    async def test_versions_rows_carry_deletable_from_the_same_checks(self, backend):
        """The card draws its delete mark from ``deletable`` alone: it is the
        verb's refusal check evaluated on every row of the version strip.
        """
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # v1: pinned below
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # v2: in review
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # v3: building
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)  # v4: free
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_USER, 1, {'name': 'B'}, ACTOR)
        await backend.set_artifact_state('org-1', 'acme.brandy', 2, 'submit', ACTOR)
        await backend.set_build('org-1', 'acme.brandy', 3, {'status': 'queued'})
        rows = await backend.versions('org-1', 'acme.brandy')
        assert [(r['version'], r['deletable']) for r in rows] == [(4, True), (3, False), (2, False), (1, False)]
        # A disabled pin still pins; a soft-removed one frees the version.
        await backend.publish_set_state('org-1', 'app', 'acme.brandy', AUD_USER, 'disabled', ACTOR)
        assert [r['deletable'] for r in await backend.versions('org-1', 'acme.brandy') if r['version'] == 1] == [False]
        await backend.publish_set_state('org-1', 'app', 'acme.brandy', AUD_USER, 'removed', ACTOR)
        assert [r['deletable'] for r in await backend.versions('org-1', 'acme.brandy') if r['version'] == 1] == [True]

    @pytest.mark.asyncio
    async def test_delete_commits_the_meta_before_the_bytes_go(self, backend, store, monkeypatch):
        """The registry forgets the version FIRST; the content tree goes next and the registry JSON last."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        content_dir = await _write_content(store, v1)
        order = []
        real_tree, real_file = store.delete_tree, store.delete_file

        async def spy_tree(prefix):
            order.append(('tree', prefix, [v['version'] for v in await backend.versions('org-1', 'acme.brandy')]))
            return await real_tree(prefix)

        async def spy_file(filename, expected_version=None):
            order.append(('file', filename, [v['version'] for v in await backend.versions('org-1', 'acme.brandy')]))
            return await real_file(filename, expected_version)

        monkeypatch.setattr(store, 'delete_tree', spy_tree)
        monkeypatch.setattr(store, 'delete_file', spy_file)
        assert (await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR))['deleted'] is True
        # Both byte deletes saw a registry that had ALREADY forgotten v1; tree before JSON.
        assert [(kind, path) for kind, path, _ in order] == [('tree', content_dir), ('file', v1['artifactPath'])]
        assert all(seen == [] for _, _, seen in order)

    @pytest.mark.asyncio
    async def test_delete_retries_after_a_content_tree_failure(self, backend, store, monkeypatch):
        """A store failure on the tree leaves the JSON (the marker) and names the leftover; the retry finishes."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        content_dir = await _write_content(store, v1)
        real_tree = store.delete_tree

        async def failing_tree(prefix):
            raise StorageError('disk went away')

        monkeypatch.setattr(store, 'delete_tree', failing_tree)
        with pytest.raises(StorageError, match=rf'removed from the registry.*{content_dir}.*run deploy delete again'):
            await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        # The registry is already right; the bytes linger.
        assert await backend.versions('org-1', 'acme.brandy') == []
        assert await store.read_file(v1['artifactPath'])
        assert await store.list_files(content_dir + '/')

        monkeypatch.setattr(store, 'delete_tree', real_tree)
        result = await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        assert result['deleted'] is True and result['sha256'] == v1['sha256'] and result['kind'] == 'app'
        with pytest.raises(StorageNotFoundError):
            await store.read_file(v1['artifactPath'])
        assert await store.list_files(content_dir + '/') == []
        rows = (await backend.history('org-1', 'acme.brandy'))['rows']
        assert [r['version'] for r in rows if r['action'] == 'delete'] == [1]  # one delete line, not two

    @pytest.mark.asyncio
    async def test_delete_retries_after_a_registry_json_failure(self, backend, store, monkeypatch):
        """The tree is gone, the JSON failed: the error names the JSON and the retry removes it."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        content_dir = await _write_content(store, v1)
        real_file = store.delete_file

        async def failing_file(filename, expected_version=None):
            raise StorageError('permission denied')

        monkeypatch.setattr(store, 'delete_file', failing_file)
        with pytest.raises(StorageError, match=rf'{v1["artifactPath"]}.*run deploy delete again'):
            await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        assert await store.list_files(content_dir + '/') == []
        assert await store.read_file(v1['artifactPath'])

        monkeypatch.setattr(store, 'delete_file', real_file)
        assert (await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR))['deleted'] is True
        with pytest.raises(StorageNotFoundError):
            await store.read_file(v1['artifactPath'])

    @pytest.mark.asyncio
    async def test_delete_is_idempotent_once_the_bytes_are_gone(self, backend, store):
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        await _write_content(store, v1)
        first = await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        again = await backend.delete_version('org-1', 'acme.brandy', 1, OTHER)
        assert again['deleted'] is True and again['deletedAt'] == first['deletedAt']
        assert (again['sha256'], again['kind']) == (v1['sha256'], 'app')
        rows = (await backend.history('org-1', 'acme.brandy'))['rows']
        assert [r['actor'] for r in rows if r['action'] == 'delete'] == [ACTOR]  # the retry wrote nothing
        # A version that never existed is still "not in the registry".
        with pytest.raises(StorageError, match='v9: not in the registry'):
            await backend.delete_version('org-1', 'acme.brandy', 9, ACTOR)

    @pytest.mark.asyncio
    async def test_delete_persists_the_inferred_kind_of_a_legacy_meta(self, backend, store):
        """B37: deleting a pre-C.17 meta's last version must not free the name for another kind."""
        v1 = await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        # A pre-C.17 meta carries no top-level kind: strip it as the upgrade finds it.
        path = backend._meta_path('org-1', 'acme.brandy')
        meta = json.loads(await store.read_file(path))
        del meta['kind']
        await store.write_file(path, json.dumps(meta))

        await backend.delete_version('org-1', 'acme.brandy', 1, ACTOR)
        assert json.loads(await store.read_file(path))['kind'] == 'app'
        assert await backend.versions('org-1', 'acme.brandy') == []
        with pytest.raises(ValueError, match="'acme.brandy' is already an app in this organization"):
            await backend.publish('org-1', 'acme.brandy', {**PIPE, 'project_id': 'brandy'}, ACTOR)
        # The name's own kind still deploys, at a never-reused number.
        assert (await backend.publish('org-1', 'acme.brandy', APP, ACTOR))['version'] == 2
        assert v1['version'] == 1

    def test_delete_block_of_is_the_shared_rule(self):
        """Both editions refuse through this one function (the saas twin imports it)."""
        free = {'version': 5, 'state': 'private', 'metadata': {'build': {'status': 'ok'}}}
        assert delete_block_of(free, []) == ''
        # A stored handle is ignored; the stored display name names the team
        pin = {'audience': {'type': 'team', 'id': 't-1', 'name': 'Production', 'handle': '@team/Production'}}
        assert delete_block_of(free, [pin]) == 'v5 is published to @Production; unpublish it first'
        personal = {'audience': {'type': 'user', 'id': 'u-1'}}
        assert delete_block_of(free, [personal]) == 'v5 is published to Personal; unpublish it first'
        assert delete_block_of({**free, 'state': 'submit'}, []) == 'v5 is in review; withdraw it first'
        building = {**free, 'metadata': {'build': {'status': 'building'}}}
        assert delete_block_of(building, []) == 'v5 is still building; wait for the build to finish'
        # The pin outranks the other reasons: unpublishing is the first step.
        assert 'unpublish' in delete_block_of({**building, 'state': 'submit'}, [pin])

    def test_audience_display_stores_the_pair_and_name_and_never_a_handle(self):
        """The stored payload goes through audience.py: a stored handle is dropped, the store's id too."""
        stored = audience_display({'type': 'team', 'id': 't-1', 'name': 'Production', 'handle': '@team/Production'})
        assert stored == {'type': 'team', 'id': 't-1', 'name': 'Production'}
        assert audience_display({'type': 'public', 'id': 'x'}) == {'type': 'public', 'id': '', 'name': ''}
        with pytest.raises(ValueError):
            audience_display({'type': 'everyone', 'id': 'x'})

    def test_audience_handle_is_composed_for_the_reader(self):
        """The owner reads @me, anyone else Personal; a team by the reader's name, the stored one, or its id."""
        user = {'type': 'user', 'id': 'u-1'}
        assert audience_handle(user, caller_id='u-1') == '@me'
        assert audience_handle(user, caller_id='u-2') == 'Personal'
        team = {'type': 'team', 'id': 't-1', 'name': 'Old name', 'handle': '@team/Old name'}
        assert audience_handle(team, team_names={'t-1': 'Production'}) == '@Production'
        assert audience_handle({'type': 'team', 'id': 't-1'}) == '=team/t-1'
        assert audience_handle({'type': 'public', 'id': ''}) == '@public'


# ============================================================================
# Scheduler feed
# ============================================================================


class TestIterEnabled:
    @pytest.mark.asyncio
    async def test_yields_only_enabled_deployments_across_orgs(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-a', 'acme.proj-1', 1, ACTOR)
        await backend.deploy('org-1', '=team/team-b', 'acme.proj-1', 1, ACTOR)
        await backend.set_state('org-1', '=team/team-b', 'acme.proj-1', 'disabled', ACTOR)

        await backend.publish('org-2', 'other.proj-9', {**PIPE, 'project_id': 'proj-9'}, OTHER)
        await backend.deploy('org-2', '=team/team-z', 'other.proj-9', 1, OTHER)

        seen = [(d['orgId'], d['teamId'], d['projectId']) async for d in backend.iter_enabled()]
        assert ('org-1', '=team/team-a', 'acme.proj-1') in seen
        assert ('org-2', '=team/team-z', 'other.proj-9') in seen
        assert all(t != '=team/team-b' for _, t, _p in seen)

    @pytest.mark.asyncio
    async def test_fresh_store_yields_nothing(self, backend):
        # A store with no orgs/ tree yet (fresh install) must not break the
        # scheduler feed — iter_enabled swallows the StorageError and yields
        # nothing instead of raising.
        assert [d async for d in backend.iter_enabled()] == []


# ============================================================================
# The store slot — a pipe's @public pointer (plan 10.1, 2026-11-20)
# ============================================================================


class TestStoreSlot:
    @pytest.mark.asyncio
    async def test_a_pipe_points_the_store_at_a_version_with_its_billing_stamp(self, backend):
        # The store is a pipe's audience like any other: the pointer lives in
        # the public slot of the one publish map and carries its stamp.
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        dep = await backend.deploy('org-1', '@public', 'acme.proj-1', 1, ACTOR, 'team-dev')
        assert (dep['teamId'], dep['version'], dep['state'], dep['billingTeamId']) == (
            '@public',
            1,
            'enabled',
            'team-dev',
        )
        stored = await backend.get('org-1', '@public', 'acme.proj-1')
        assert (stored['teamId'], stored['billingTeamId']) == ('@public', 'team-dev')
        # The row is THE public publish of the map, not a team named '@public'
        rows = await backend.publish_of_app('org-1', 'pipe', 'acme.proj-1')
        assert [r['audience'] for r in rows] == [{'type': 'public', 'id': ''}]

    @pytest.mark.asyncio
    async def test_the_list_returns_the_store_row_beside_the_other_slots(self, backend):
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-a', 'acme.proj-1', 1, ACTOR, 'team-a')
        await backend.deploy('org-1', '=user/u1', 'acme.proj-1', 1, ACTOR, 'team-a')
        await backend.deploy('org-1', '@public', 'acme.proj-1', 1, ACTOR, 'team-a')
        assert sorted(d['teamId'] for d in await backend.list_team('org-1')) == ['=team/team-a', '=user/u1', '@public']
        assert [d['teamId'] for d in await backend.list_team('org-1', '@public')] == ['@public']
        # An app's store publish stays out of the pipe list
        await backend.publish('org-1', 'acme.brandy', {'kind': 'app', 'appId': 'acme.brandy', 'name': 'B'}, ACTOR)
        await backend.publish_set('org-1', 'app', 'acme.brandy', {'type': 'public', 'id': ''}, 1, {}, ACTOR)
        assert all(d['projectId'] == 'acme.proj-1' for d in await backend.list_team('org-1'))

    @pytest.mark.asyncio
    async def test_a_schedule_on_the_store_slot_is_kept_fed_and_billed_to_the_stamp(self, backend):
        # Any published pipe can be scheduled: the store slot takes a
        # schedule, the scheduler feed carries it, and the record the fire
        # reads names the billing team stamped when it was published.
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '@public', 'acme.proj-1', 1, ACTOR, 'team-dev')
        dep = await backend.schedule_set('org-1', '@public', 'acme.proj-1', 'webhook_1', '0 2 * * *', ACTOR, 3600)
        assert dep['schedules']['webhook_1']['cron'] == '0 2 * * *'
        fed = [d async for d in backend.iter_enabled() if d['teamId'] == '@public']
        assert [(d['projectId'], d['schedules']['webhook_1']['cron']) for d in fed] == [('acme.proj-1', '0 2 * * *')]
        fired = await backend.get('org-1', '@public', 'acme.proj-1')
        assert fired['billingTeamId'] == 'team-dev'
        # Unpublishing the store row stops the feed
        await backend.set_state('org-1', '@public', 'acme.proj-1', 'removed', ACTOR)
        assert [d async for d in backend.iter_enabled() if d['teamId'] == '@public'] == []


# ============================================================================
# The name row and the one publish map (plan 2.3, 10.1 — C.17)
# ============================================================================


class TestNameRow:
    @pytest.mark.asyncio
    async def test_a_name_keeps_its_kind(self, backend):
        """One namespace across kinds (B37): the first deploy fixes the kind, the other kinds are refused."""
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        app_under_the_pipes_name = {'kind': 'app', 'appId': 'acme.proj-1', 'name': 'Brandy', 'appVersion': '1.0.0'}
        with pytest.raises(ValueError, match='already a pipe in this organization'):
            await backend.publish('org-1', 'acme.proj-1', app_under_the_pipes_name, ACTOR)
        # Nothing was written for the refused kind
        assert [v['version'] for v in await backend.versions('org-1', 'acme.proj-1')] == [1]

    @pytest.mark.asyncio
    async def test_the_kind_lookup_reads_each_names_row(self, backend):
        """A pipe row is a pipe, an app row an app; a name with no row, or no valid name, is absent (plan 9.1, G2)."""
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)

        kinds = await backend.kinds_of('org-1', ['acme.proj-1', 'acme.brandy', 'acme.unknown', '../x', 'acme.proj-1'])

        assert kinds == {'acme.proj-1': 'pipe', 'acme.brandy': 'app'}
        # Another org's tree holds neither name
        assert await backend.kinds_of('org-2', ['acme.proj-1']) == {}

    @pytest.mark.asyncio
    async def test_the_kind_lookup_reads_a_legacy_meta_by_its_versions(self, backend, store):
        """A pre-C.17 meta without a top-level kind answers its newest version's kind, as publish reads it."""
        import json

        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        path = backend._meta_path('org-1', 'acme.brandy')
        meta = json.loads(await store.read_file(path))
        del meta['kind']
        await store.write_file(path, json.dumps(meta))

        assert await backend.kinds_of('org-1', ['acme.brandy']) == {'acme.brandy': 'app'}

    @pytest.mark.asyncio
    async def test_versions_come_from_the_name_row(self, backend, store):
        """The meta IS the name row: its nextVersion hands out the numbers and is never decremented."""
        import json

        for _ in range(3):
            await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        assert [v['version'] for v in await backend.versions('org-1', 'acme.proj-1')] == [3, 2, 1]
        meta = json.loads(await store.read_file(backend._meta_path('org-1', 'acme.proj-1')))
        assert (meta['kind'], meta['nextVersion']) == ('pipe', 4)

    @pytest.mark.asyncio
    async def test_pointer_rows_are_publish_rows(self, backend):
        """A team or personal pointer is a row of the one publish map, read back by kind (plan 10.1)."""
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR, 'team-1')
        await backend.deploy('org-1', '=user/user-1', 'acme.proj-1', 1, ACTOR, 'team-home')

        rows = {r['audience']['type']: r for r in await backend.publish_of_app('org-1', 'pipe', 'acme.proj-1')}
        assert set(rows) == {'team', 'user'}
        assert (rows['team']['audience']['id'], rows['team']['billingTeamId']) == ('team-1', 'team-1')
        assert (rows['user']['audience']['id'], rows['user']['billingTeamId']) == ('user-1', 'team-home')
        assert all(
            (r['kind'], r['version'], r['state'], r['artifactState']) == ('pipe', 1, 'enabled', 'private')
            for r in rows.values()
        )
        assert all(r['projectId'] == 'acme.proj-1' for r in rows.values())
        # The one map answers by kind: the pipe's rows are no app's rows
        assert await backend.publish_get('org-1', 'app', 'acme.proj-1', AUD_TEAM) is None
        assert (await backend.publish_get('org-1', 'pipe', 'acme.proj-1', AUD_TEAM))['version'] == 1

    @pytest.mark.asyncio
    async def test_publish_set_keeps_a_pointers_schedules_and_billing(self, backend):
        """Repointing a pipe row through publish_set keeps what the pointer verbs stamped."""
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        await backend.deploy('org-1', '=team/team-1', 'acme.proj-1', 1, ACTOR, 'team-1')
        await backend.schedule_set('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1', '@hourly', ACTOR)

        row = await backend.publish_set('org-1', 'pipe', 'acme.proj-1', AUD_TEAM, 2, {'name': 'Invoice Ingest'}, ACTOR)
        assert (row['version'], row['billingTeamId']) == (2, 'team-1')
        dep = await backend.get('org-1', '=team/team-1', 'acme.proj-1')
        assert dep['version'] == 2 and dep['schedules']['webhook_1']['cron'] == '@hourly'
        # And a version of the wrong kind is refused
        with pytest.raises(ValueError, match='not a app'):
            await backend.publish_set('org-1', 'app', 'acme.proj-1', AUD_TEAM, 2, {}, ACTOR)

    @pytest.mark.asyncio
    async def test_a_legacy_meta_folds_its_deployments_into_the_publish_map(self, backend, store):
        """A pre-C.17 file's team pointers read as publish rows, and the next write drops the old dict."""
        import json

        entry = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        path = backend._meta_path('org-1', 'acme.proj-1')
        meta = json.loads(await store.read_file(path))
        meta.pop('publishes', None)
        meta['deployments'] = {
            'team-a': {
                'teamId': 'team-a',
                'version': entry['version'],
                'state': 'enabled',
                'billingTeamId': 'team-a',
                'schedules': {'webhook_1': {'cron': '@daily', 'paused': False}},
                'createdAt': 1.0,
                'createdBy': ACTOR,
                'updatedAt': 2.0,
                'updatedBy': ACTOR,
                'deployedAt': 2.0,
            }
        }
        await store.write_file(path, json.dumps(meta))

        dep = await backend.get('org-1', '=team/team-a', 'acme.proj-1')
        assert (dep['teamId'], dep['version'], dep['billingTeamId'], dep['deployedAt']) == (
            '=team/team-a',
            1,
            'team-a',
            2.0,
        )
        assert dep['schedules']['webhook_1']['cron'] == '@daily'
        rows = await backend.publish_of_app('org-1', 'pipe', 'acme.proj-1')
        assert [(r['audience']['type'], r['audience']['id']) for r in rows] == [('team', 'team-a')]
        feed = [d async for d in backend.iter_enabled()]
        assert [(d['teamId'], d['projectId']) for d in feed] == [('=team/team-a', 'acme.proj-1')]

        await backend.set_state('org-1', '=team/team-a', 'acme.proj-1', 'disabled', ACTOR)
        rewritten = json.loads(await store.read_file(path))
        assert 'deployments' not in rewritten and rewritten['publishes']['=team/team-a']['state'] == 'disabled'

    @pytest.mark.asyncio
    async def test_a_legacy_meta_without_a_kind_still_keeps_its_kind(self, backend, store):
        """A pre-C.17 meta carries no top-level kind: its versions say what the name is, and another kind is refused."""
        import json

        await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        path = backend._meta_path('org-1', 'acme.proj-1')
        meta = json.loads(await store.read_file(path))
        del meta['kind']
        del meta['nextVersion']
        await store.write_file(path, json.dumps(meta))

        app_under_the_pipes_name = {'kind': 'app', 'appId': 'acme.proj-1', 'name': 'Brandy', 'appVersion': '1.0.0'}
        with pytest.raises(ValueError, match='already a pipe in this organization'):
            await backend.publish('org-1', 'acme.proj-1', app_under_the_pipes_name, ACTOR)
        assert [v['version'] for v in await backend.versions('org-1', 'acme.proj-1')] == [1]
        # The same kind keeps publishing, numbered past the highest version
        again = await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)
        assert again['version'] == 2
        assert json.loads(await store.read_file(path))['kind'] == 'pipe'

    @pytest.mark.asyncio
    async def test_a_legacy_publish_row_without_a_kind_reads_as_its_versions_kind(self, backend, store):
        """A pre-C.17 app publish row carries no kind: it is read, and returned, as the app it points at."""
        import json

        await backend.publish('org-1', 'acme.brandy', APP, ACTOR)
        await backend.publish_set('org-1', 'app', 'acme.brandy', AUD_PUBLIC, 1, {'name': 'Brandy'}, ACTOR)
        path = backend._meta_path('org-1', 'acme.brandy')
        meta = json.loads(await store.read_file(path))
        del meta['publishes']['@public']['kind']
        await store.write_file(path, json.dumps(meta))

        row = await backend.publish_get('org-1', 'app', 'acme.brandy', AUD_PUBLIC)
        assert row is not None and row['kind'] == 'app'
        assert [r['kind'] for r in await backend.publish_of_app('org-1', 'app', 'acme.brandy')] == ['app']
        assert [r['kind'] for r in await backend.publish_list('org-1', 'app', [AUD_PUBLIC])] == ['app']
        assert await backend.publish_get('org-1', 'pipe', 'acme.brandy', AUD_PUBLIC) is None

    @pytest.mark.asyncio
    async def test_a_storage_failure_propagates_instead_of_reading_as_no_project(self, store):
        """Only a MISSING meta is 'no project'; a store that is down raises through the readers."""

        class _DownStore(type(store)):
            """The throwaway store with its reads broken."""

            async def read_file(self, filename):
                raise StorageError('storage unavailable')

            async def read_file_with_metadata(self, filename):
                raise StorageError('storage unavailable')

        backend = FileDeploymentBackend(_DownStore(f'filesystem://{store._root_path}'))
        with pytest.raises(StorageError, match='storage unavailable'):
            await backend.publish_of_app('org-1', 'pipe', 'acme.proj-1')
        with pytest.raises(StorageError, match='storage unavailable'):
            await backend.get('org-1', '=team/team-1', 'acme.proj-1')
        # A desktop never reads a pipe as an app because the store was down
        with pytest.raises(StorageError, match='storage unavailable'):
            await backend.kinds_of('org-1', ['acme.proj-1'])
        # A publish never treats a broken read as a fresh project
        with pytest.raises(StorageError, match='storage unavailable'):
            await backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR)

    @pytest.mark.asyncio
    async def test_a_listing_failure_propagates_instead_of_reading_as_no_projects(self, store):
        """Only a MISSING deployments tree is 'no projects'; a listing that fails raises through every walk."""

        class _DownListing(type(store)):
            """The throwaway store with its directory listing broken."""

            async def list_entries(self, *args, **kwargs):
                raise StorageError('listing unavailable')

        backend = FileDeploymentBackend(_DownListing(f'filesystem://{store._root_path}'))
        with pytest.raises(StorageError, match='listing unavailable'):
            await backend.publish_list('org-1', 'pipe', [AUD_PUBLIC])
        with pytest.raises(StorageError, match='listing unavailable'):
            await backend.list_team('org-1', None)

    @pytest.mark.asyncio
    async def test_a_missing_deployments_tree_is_no_projects(self, store, backend):
        """A fresh store (no tree at all, or a store that reports the prefix missing) lists nothing."""
        assert await backend.publish_list('org-1', 'pipe', [AUD_PUBLIC]) == []
        assert await backend.list_team('org-1', None) == []

        class _NoTree(type(store)):
            """A store that reports the deployments prefix as not found."""

            async def list_entries(self, *args, **kwargs):
                raise StorageNotFoundError('no such prefix')

        fresh = FileDeploymentBackend(_NoTree(f'filesystem://{store._root_path}'))
        assert await fresh.publish_list('org-1', 'pipe', [AUD_PUBLIC]) == []
        assert await fresh.list_team('org-1', None) == []


# ============================================================================
# Build recovery scan: one org's failure never costs the others
# ============================================================================


class TestScanBuilds:
    @staticmethod
    async def _queued_app(backend, org_id):
        """One app version in ``org_id`` whose build was left 'queued'."""
        await backend.publish(org_id, 'acme.brandy', APP, ACTOR)
        await backend.set_build(org_id, 'acme.brandy', 1, {'status': 'queued'})

    @staticmethod
    def _down_for(store, broken, attempts):
        """A store whose deployments listing fails for the orgs in ``broken`` (each call counted)."""

        class _PartlyDown(type(store)):
            """The throwaway store with some orgs' deployments trees unreadable."""

            async def list_entries(self, prefix, *args, **kwargs):
                for org_id in broken:
                    if prefix.startswith(f'orgs/{org_id}/'):
                        attempts.append(org_id)
                        raise StorageError(f'{org_id} unavailable')
                return await super().list_entries(prefix, *args, **kwargs)

        return _PartlyDown(f'filesystem://{store._root_path}')

    @pytest.mark.asyncio
    async def test_a_later_orgs_failure_keeps_the_earlier_orgs_matches_and_is_logged(self, store, backend, monkeypatch):
        """org-a's queued build is returned although org-b's tree cannot be listed; the failure is logged by org."""
        import ai.account.deployment_backend as backend_mod

        await self._queued_app(backend, 'org-a')
        await self._queued_app(backend, 'org-b')
        logged = []
        monkeypatch.setattr(backend_mod, 'error', lambda message: logged.append(message))
        monkeypatch.setattr(backend_mod, '_SCAN_RETRY_DELAYS', (0.0, 0.0))
        attempts = []

        scanning = FileDeploymentBackend(self._down_for(store, {'org-b'}, attempts))
        rows = await scanning.scan_builds(('queued', 'building'))

        assert rows == [{'orgId': 'org-a', 'projectId': 'acme.brandy', 'version': 1}]
        # One pass plus the two bounded retries, then it gives up and says so
        assert attempts == ['org-b', 'org-b', 'org-b']
        assert any('org org-b' in m and 'org-b unavailable' in m for m in logged)
        assert any('gave up on org org-b' in m for m in logged)

    @pytest.mark.asyncio
    async def test_an_org_that_recovers_on_a_retry_pass_is_returned(self, store, backend, monkeypatch):
        """A transient failure is retried in the same process; the org's builds come back on the next pass."""
        import ai.account.deployment_backend as backend_mod

        await self._queued_app(backend, 'org-a')
        await self._queued_app(backend, 'org-b')
        monkeypatch.setattr(backend_mod, 'error', lambda message: None)
        monkeypatch.setattr(backend_mod, '_SCAN_RETRY_DELAYS', (0.0, 0.0))
        attempts = []
        broken = {'org-b'}

        class _Recovering(type(store)):
            """org-b's listing fails once, then answers."""

            async def list_entries(self, prefix, *args, **kwargs):
                if prefix.startswith('orgs/org-b/') and 'org-b' in broken:
                    broken.discard('org-b')
                    attempts.append('org-b')
                    raise StorageError('org-b unavailable')
                return await super().list_entries(prefix, *args, **kwargs)

        scanning = FileDeploymentBackend(_Recovering(f'filesystem://{store._root_path}'))
        rows = await scanning.scan_builds(('queued',))

        assert sorted(r['orgId'] for r in rows) == ['org-a', 'org-b']
        assert attempts == ['org-b']

    @pytest.mark.asyncio
    async def test_the_request_path_listings_still_raise(self, store, backend):
        """publish_list and list_team are not the recovery scan: a listing failure raises there."""
        await self._queued_app(backend, 'org-b')
        down = FileDeploymentBackend(self._down_for(store, {'org-b'}, []))
        with pytest.raises(StorageError, match='org-b unavailable'):
            await down.publish_list('org-b', 'app', [AUD_PUBLIC])
        with pytest.raises(StorageError, match='org-b unavailable'):
            await down.list_team('org-b', None)

    @pytest.mark.asyncio
    async def test_concurrent_first_publishes_cannot_both_take_the_name(self, backend):
        """Two first publishes of one name race: one fixes the kind and takes v1, the other kind is refused."""
        import asyncio

        app_under_the_pipes_name = {'kind': 'app', 'appId': 'acme.proj-1', 'name': 'Brandy', 'appVersion': '1.0.0'}
        results = await asyncio.gather(
            backend.publish('org-1', 'acme.proj-1', PIPE, ACTOR),
            backend.publish('org-1', 'acme.proj-1', app_under_the_pipes_name, ACTOR),
            return_exceptions=True,
        )
        winners = [r for r in results if isinstance(r, dict)]
        refused = [r for r in results if isinstance(r, ValueError)]
        assert len(winners) == 1 and len(refused) == 1
        assert 'already a' in str(refused[0])
        assert [v['version'] for v in await backend.versions('org-1', 'acme.proj-1')] == [1]
