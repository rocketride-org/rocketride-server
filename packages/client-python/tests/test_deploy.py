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
Integration tests for the deploy client API (teams-as-environments).

These tests connect to a live server and exercise the published contract:
add (immutable registry versions), deploy (pointing a team at a
version — promotion and rollback alike), the standard list envelopes on
list/versions/history, pause/resume, soft remove with a surviving audit
trail, per-source schedules, and the single cron evaluator.

Against the OSS test server the one team is 'local'. Every test uses a
fresh project id (the registry is immutable — versions accumulate forever
by design) and soft-removes its deployment in ``finally`` so scheduled
work can never leak across tests. Scheduler dispatch itself is covered
server-side (test_task_scheduler.py), not here.
"""

import os
import re

import pytest

from rocketride import RocketRideClient, registry_id_of

SERVER_URI = os.environ.get('ROCKETRIDE_URI', 'http://127.0.0.1:5565')

# The one team on the OSS test server, by its audience (a bare team id is no
# deploy target, plan 2.5).
TEAM = '=team/local'


def make_pipeline(project_id: str) -> dict:
    """A minimal valid pipeline for one throwaway project id."""
    return {
        'project_id': project_id,
        'name': 'SDK deploy test',
        'components': [
            {
                'id': 'webhook_1',
                'provider': 'webhook',
                'name': 'Test webhook',
                'config': {'hideForm': True, 'mode': 'Source', 'type': 'webhook'},
            },
            {
                'id': 'response_1',
                'provider': 'response',
                'config': {'lanes': []},
                'input': [{'lane': 'text', 'from': 'webhook_1'}],
            },
        ],
        'source': 'webhook_1',
    }


def fresh_project() -> str:
    """A unique project id per test — registry versions accumulate forever."""
    return f'sdk-deploy-{os.urandom(6).hex()}'


class TestDeploy:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.client = RocketRideClient(SERVER_URI, 'MYAPIKEY')
        result = await self.client.connect()
        org = result.get('organization') or {}
        # The server composes every registry name from the organization's
        # developer id and refuses a deploy without one: there is no fallback
        self.developer_id = org.get('developerId') or ''
        if not self.developer_id:
            pytest.fail('the test organization has no developer id; claim one before running the deploy suite')
        yield
        await self.client.disconnect()

    def registry_id(self, project: str) -> str:
        """The row name the server composes for a short id (developerId.slug)."""
        return registry_id_of(project, self.developer_id)

    async def _cleanup(self, project_id: str) -> None:
        """Soft-remove the test deployment; tolerate never-deployed projects."""
        try:
            await self.client.deploy.remove(project_id, TEAM)
        except RuntimeError:
            pass

    # ── publish ──────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_publish_returns_immutable_artifact(self):
        project = fresh_project()
        result = await self.client.deploy.add(make_pipeline(project), comment='first cut')
        artifact = result['artifact']
        assert artifact['version'] == 1
        assert artifact['sha256'] and artifact['bytes'] > 0
        assert artifact['comment'] == 'first cut'
        assert artifact['publishedBy']['userId']
        # Publishing alone puts nothing live.
        assert 'deployment' not in result

        # A second publish allocates the NEXT version; v1 is untouched.
        result2 = await self.client.deploy.add(make_pipeline(project))
        assert result2['artifact']['version'] == 2
        versions = await self.client.deploy.versions(project)
        assert [v['version'] for v in versions['rows']] == [2, 1]

    @pytest.mark.asyncio
    async def test_artifact_returns_the_published_pipeline(self):
        project = fresh_project()
        pipeline = make_pipeline(project)
        await self.client.deploy.add(pipeline)
        fetched = await self.client.deploy.artifact(project, 1)
        # The published definition (sha-verified server-side). It was sent
        # without a store block, so the door stored it with the default one:
        # every version carries a block.
        assert fetched == {
            **pipeline,
            'store': {
                'tagline': '',
                'categories': ['pipeline'],
                'tags': [],
                'links': {},
                'mode': 'free',
                'billing': {'plans': []},
            },
        }
        with pytest.raises(RuntimeError):
            await self.client.deploy.artifact(project, 9)

        # A pipeline that carries its own block is stored exactly as sent.
        listed = fresh_project()
        own = {**make_pipeline(listed), 'store': {'tagline': 'Mine', 'mode': 'free'}}
        await self.client.deploy.add(own)
        assert await self.client.deploy.artifact(listed, 1) == own

    @pytest.mark.asyncio
    async def test_publish_with_deploy_to_is_one_step(self):
        project = fresh_project()
        try:
            result = await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            dep = result['deployment']
            assert dep['teamId'] == TEAM
            assert dep['projectId'] == self.registry_id(project)
            assert dep['version'] == 1
            assert dep['state'] == 'enabled'
        finally:
            await self._cleanup(project)

    # ── deploy: promotion and rollback are the same pointer move ─────────────

    @pytest.mark.asyncio
    async def test_deploy_and_rollback_move_the_pointer(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project))
            await self.client.deploy.add(make_pipeline(project))

            dep = await self.client.deploy.deploy(project, 2, TEAM)
            assert dep['version'] == 2

            # Rollback = the same call aimed at the older version.
            dep = await self.client.deploy.deploy(project, 1, TEAM)
            assert dep['version'] == 1

            # The audit trail labels the downgrade honestly, newest first.
            history = await self.client.deploy.history(project, team_id=TEAM)
            actions = [h['action'] for h in history['rows']]
            assert actions[0] == 'rollback'
            # seq is the stable append-order identity: strictly descending.
            seqs = [h['seq'] for h in history['rows']]
            assert seqs == sorted(seqs, reverse=True)
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_deploy_unpublished_version_raises(self):
        project = fresh_project()
        await self.client.deploy.add(make_pipeline(project))
        with pytest.raises(RuntimeError):
            await self.client.deploy.deploy(project, 7, TEAM)

    @pytest.mark.asyncio
    async def test_run_now_dispatches_and_is_stoppable(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            result = await self.client.deploy.run(project, 'webhook_1', TEAM)
            # The control id in the token slot, the address beside it: both required.
            assert re.fullmatch(r'=control/[0-9a-f]{32}', result['token'])
            assert result['address'] == f'{self.registry_id(project)}.webhook_1'
            # The UI's stop path: resolve the live control and terminate it.
            # team_id addresses the TEAM's deploy run — an unscoped lookup
            # resolves the caller's own dev run and finds nothing here.
            token = await self.client.get_task_token(project_id=project, source='webhook_1', team_id=TEAM)
            assert token == result['token']
            await self.client.terminate(token)
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_run_now_refuses_disabled(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            await self.client.deploy.disable(project, TEAM)
            with pytest.raises(RuntimeError):
                await self.client.deploy.run(project, 'webhook_1', TEAM)
        finally:
            await self._cleanup(project)

    # ── reads: standard list envelopes ───────────────────────────────────────

    @pytest.mark.asyncio
    async def test_list_returns_the_standard_envelope(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)

            body = await self.client.deploy.list()
            assert set(body) == {'rows', 'total', 'page', 'pageSize'}
            assert any(d['projectId'] == self.registry_id(project) for d in body['rows'])

            # Team scope + paging args travel through.
            page = await self.client.deploy.list(team_id=TEAM, page_size=1)
            assert page['pageSize'] == 1 and len(page['rows']) <= 1
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_get_returns_joined_record(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            dep = await self.client.deploy.get(project, TEAM)
            assert dep['projectId'] == self.registry_id(project)
            assert dep['sha256']
            assert dep['schedules'] == {}
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_get_unknown_project_raises(self):
        with pytest.raises(RuntimeError):
            await self.client.deploy.get('nonexistent-project', TEAM)

    # ── state: enable / disable / soft remove ────────────────────────────────

    @pytest.mark.asyncio
    async def test_disable_enable(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            dep = await self.client.deploy.disable(project, TEAM)
            assert dep['state'] == 'disabled'
            dep = await self.client.deploy.enable(project, TEAM)
            assert dep['state'] == 'enabled'
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_remove_is_soft_and_history_survives(self):
        project = fresh_project()
        await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
        dep = await self.client.deploy.remove(project, TEAM)
        assert dep['state'] == 'removed'

        # Hidden from listings...
        body = await self.client.deploy.list()
        assert not any(d['projectId'] == self.registry_id(project) for d in body['rows'])
        # ...but the audit trail keeps everything, including the removal.
        history = await self.client.deploy.history(project)
        assert 'remove' in [h['action'] for h in history['rows']]

    # ── schedules + the single evaluator ─────────────────────────────────────

    @pytest.mark.asyncio
    async def test_set_schedule_and_clear(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)

            dep = await self.client.deploy.set_schedule(project, 'webhook_1', '0 * * * *', TEAM)
            assert dep['schedules']['webhook_1']['cron'] == '0 * * * *'
            assert dep['schedules']['webhook_1']['paused'] is False

            # None clears the schedule row entirely.
            dep = await self.client.deploy.set_schedule(project, 'webhook_1', None, TEAM)
            assert 'webhook_1' not in dep['schedules']
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_pause_and_resume_one_schedule(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            await self.client.deploy.set_schedule(project, 'webhook_1', '0 * * * *', TEAM, ttl=600)

            # Pause keeps cron/ttl; a cron edit must not unpause it.
            dep = await self.client.deploy.pause_schedule(project, 'webhook_1', TEAM)
            assert dep['schedules']['webhook_1']['paused'] is True
            assert dep['schedules']['webhook_1']['cron'] == '0 * * * *'
            assert dep['schedules']['webhook_1']['ttl'] == 600
            dep = await self.client.deploy.set_schedule(project, 'webhook_1', '30 * * * *', TEAM)
            assert dep['schedules']['webhook_1']['paused'] is True

            dep = await self.client.deploy.resume_schedule(project, 'webhook_1', TEAM)
            assert dep['schedules']['webhook_1']['paused'] is False

            # Pausing a source with no schedule is an explicit error.
            with pytest.raises(RuntimeError):
                await self.client.deploy.pause_schedule(project, 'ghost_1', TEAM)
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_set_schedule_invalid_cron_raises(self):
        project = fresh_project()
        try:
            await self.client.deploy.add(make_pipeline(project), deploy_to=TEAM)
            with pytest.raises(RuntimeError):
                await self.client.deploy.set_schedule(project, 'webhook_1', 'not-a-cron', TEAM)
        finally:
            await self._cleanup(project)

    @pytest.mark.asyncio
    async def test_preview_is_the_single_evaluator(self):
        ok = await self.client.deploy.preview('*/15 * * * *', count=3)
        assert ok['valid'] is True
        assert len(ok['next']) == 3
        assert ok['next'][0] < ok['next'][1] < ok['next'][2]

        bad = await self.client.deploy.preview('not-a-cron')
        assert bad['valid'] is False
        assert bad['error']
