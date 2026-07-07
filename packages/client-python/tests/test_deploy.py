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
Integration tests for the deploy client API.

These tests connect to a live server and exercise the full CRUD lifecycle
(add, list, status, update, remove). They predate the TaskScheduler and
remain valid without modification for the following reasons:

- Tests that use the default schedule ('manual') are completely unaffected:
  manual deployments are never dispatched by the scheduler.
- Tests that supply a cron schedule (e.g. '*/15 * * * *') remove the
  deployment before the scheduler could ever fire — the minimum cron
  granularity is 60 s and all tests clean up in the 'finally' block.
- 'remove' now also calls scheduler.unschedule() server-side, but the
  observable client behaviour (status raises after remove) is unchanged.

These tests therefore cover the client API contract only. Scheduler
registration and execution are covered separately — see:
  packages/ai/tests/ai/modules/task/test_task_scheduler.py
"""

import os
import pytest
from rocketride import RocketRideClient

SERVER_URI = os.environ.get('ROCKETRIDE_URI', 'http://localhost:5565')

PROJECT_ID = f'test-project-{os.urandom(8).hex()}'

PIPELINE = {
    'project_id': PROJECT_ID,
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

PIPELINE_V2 = {
    'project_id': PROJECT_ID,
    'components': [
        {
            'id': 'chat_1',
            'provider': 'chat',
            'name': 'Test chat',
            'config': {'hideForm': True, 'mode': 'Source', 'type': 'chat'},
        },
        {
            'id': 'response_1',
            'provider': 'response',
            'config': {'lanes': []},
            'input': [{'lane': 'questions', 'from': 'chat_1'}],
        },
    ],
    'source': 'chat_1',
}


class TestDeploy:
    @pytest.fixture(autouse=True)
    async def setup(self):
        self.client = RocketRideClient(SERVER_URI, 'MYAPIKEY')
        await self.client.connect()
        yield
        await self.client.disconnect()

    # ── add ──────────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_add_returns_full_record(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            assert rec['pipeline']['project_id'] == PROJECT_ID
            assert rec['pipeline'] == PIPELINE
            assert rec['schedule'] == 'manual'
            assert rec['state'] == 'active'
            assert rec['userId']
            # The stored user credential must never be echoed back to clients.
            assert 'userToken' not in rec
            assert rec['createdAt'] > 0
            assert rec['updatedAt'] > 0
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_add_with_cron_schedule(self):
        rec = await self.client.deploy.add(PIPELINE, schedule='*/15 * * * *')
        try:
            assert rec['schedule'] == '*/15 * * * *'
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_add_invalid_schedule_raises(self):
        with pytest.raises(RuntimeError):
            await self.client.deploy.add(PIPELINE, schedule='not-a-cron')

    @pytest.mark.asyncio
    async def test_add_duplicate_raises(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            with pytest.raises(RuntimeError):
                await self.client.deploy.add(PIPELINE)
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    # ── list ─────────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_list_includes_created_deployment(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            deployments = await self.client.deploy.list()
            ids = [d['pipeline']['project_id'] for d in deployments]
            assert rec['pipeline']['project_id'] in ids
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_list_returns_list(self):
        deployments = await self.client.deploy.list()
        assert isinstance(deployments, list)

    # ── status ───────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_status_returns_deployment(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            status = await self.client.deploy.status(rec['pipeline']['project_id'])
            assert status['pipeline']['project_id'] == rec['pipeline']['project_id']
            assert status['state'] == 'active'
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_status_unknown_id_raises(self):
        with pytest.raises(RuntimeError):
            await self.client.deploy.status('nonexistent-deployment-id')

    # ── update ───────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_update_schedule(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            await self.client.deploy.update(rec['pipeline']['project_id'], schedule='0 * * * *')
            status = await self.client.deploy.status(rec['pipeline']['project_id'])
            assert status['schedule'] == '0 * * * *'
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_update_pipeline(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            await self.client.deploy.update(rec['pipeline']['project_id'], pipeline=PIPELINE_V2)
            status = await self.client.deploy.status(rec['pipeline']['project_id'])
            assert status['pipeline'] == PIPELINE_V2
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    @pytest.mark.asyncio
    async def test_update_bumps_updated_at(self):
        rec = await self.client.deploy.add(PIPELINE)
        try:
            await self.client.deploy.update(rec['pipeline']['project_id'], schedule='@hourly')
            status = await self.client.deploy.status(rec['pipeline']['project_id'])
            assert status['updatedAt'] >= rec['updatedAt']
        finally:
            await self.client.deploy.remove(rec['pipeline']['project_id'])

    # ── remove ───────────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_remove_deletes_deployment(self):
        rec = await self.client.deploy.add(PIPELINE)
        project_id = rec['pipeline']['project_id']
        await self.client.deploy.remove(project_id)
        with pytest.raises(RuntimeError):
            await self.client.deploy.status(project_id)

    @pytest.mark.asyncio
    async def test_remove_unknown_id_raises(self):
        with pytest.raises(RuntimeError):
            await self.client.deploy.remove('nonexistent-deployment-id')

    # ── update errors ─────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_update_nonexistent_raises(self):
        with pytest.raises(RuntimeError):
            await self.client.deploy.update('nonexistent-deployment-id', schedule='manual')
