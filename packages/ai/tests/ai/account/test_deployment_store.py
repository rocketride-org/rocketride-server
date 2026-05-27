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

import pytest
import shutil
import tempfile

from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord
from ai.account.store import StorageError
from ai.account.store_providers.filesystem import FilesystemStore

CLIENT_1 = 'user-1'
CLIENT_2 = 'user-2'


@pytest.fixture
def istore():
    temp_path = tempfile.mkdtemp()
    yield FilesystemStore(f'filesystem://{temp_path}')
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def store(istore):
    return DeploymentStore(istore)


def make_record(project_id: str = 'proj-1', **kwargs) -> DeploymentRecord:
    return DeploymentRecord(pipeline={'project_id': project_id}, created_by=CLIENT_1, **kwargs)


class TestDeploymentStore:
    @pytest.mark.asyncio
    async def test_save_and_get(self, store):
        record = make_record(schedule='0 * * * *')
        await store.save(CLIENT_1, record)
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.pipeline['project_id'] == 'proj-1'
        assert result.schedule == '0 * * * *'
        assert result.created_by == CLIENT_1

    @pytest.mark.asyncio
    async def test_save_overwrites(self, store):
        await store.save(CLIENT_1, make_record(schedule='0 * * * *'))
        await store.save(CLIENT_1, make_record(schedule='1 * * * *'))
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.schedule == '1 * * * *'

    @pytest.mark.asyncio
    async def test_delete(self, store):
        await store.save(CLIENT_1, make_record())
        await store.delete(CLIENT_1, 'proj-1')
        with pytest.raises(StorageError):
            await store.get(CLIENT_1, 'proj-1')

    @pytest.mark.asyncio
    async def test_list_empty(self, store):
        assert await store.list(CLIENT_1) == []

    @pytest.mark.asyncio
    async def test_list(self, store):
        await store.save(CLIENT_1, make_record('proj-1'))
        await store.save(CLIENT_1, make_record('proj-2'))
        await store.save(CLIENT_1, make_record('proj-3'))
        results = await store.list(CLIENT_1)
        assert sorted(r.pipeline['project_id'] for r in results) == ['proj-1', 'proj-2', 'proj-3']

    @pytest.mark.asyncio
    async def test_get_missing_raises(self, store):
        with pytest.raises(StorageError):
            await store.get(CLIENT_1, 'nonexistent')

    @pytest.mark.asyncio
    async def test_delete_missing_raises(self, store):
        with pytest.raises(StorageError):
            await store.delete(CLIENT_1, 'nonexistent')

    @pytest.mark.asyncio
    async def test_isolation(self, store):
        await store.save(CLIENT_1, make_record('proj-1'))
        assert await store.list(CLIENT_2) == []
        with pytest.raises(StorageError):
            await store.get(CLIENT_2, 'proj-1')

    @pytest.mark.asyncio
    async def test_iter_all(self, store):
        await store.save(CLIENT_1, make_record('proj-1'))
        await store.save(CLIENT_1, make_record('proj-2'))
        await store.save(CLIENT_2, make_record('proj-3'))
        results = [(cid, r.pipeline['project_id']) async for cid, r in store.iter_all()]
        assert sorted(results) == [(CLIENT_1, 'proj-1'), (CLIENT_1, 'proj-2'), (CLIENT_2, 'proj-3')]

    @pytest.mark.asyncio
    async def test_iter_all_empty(self, store):
        results = [r async for r in store.iter_all()]
        assert results == []


class TestSaveMode:
    @pytest.mark.asyncio
    async def test_create_succeeds_when_absent(self, store):
        await store.save(CLIENT_1, make_record(schedule='0 * * * *'), mode='create')
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.schedule == '0 * * * *'

    @pytest.mark.asyncio
    async def test_create_raises_when_exists(self, store):
        await store.save(CLIENT_1, make_record())
        with pytest.raises(StorageError):
            await store.save(CLIENT_1, make_record(), mode='create')

    @pytest.mark.asyncio
    async def test_update_succeeds_when_exists(self, store):
        await store.save(CLIENT_1, make_record(schedule='0 * * * *'))
        await store.save(CLIENT_1, make_record(schedule='1 * * * *'), mode='update')
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.schedule == '1 * * * *'

    @pytest.mark.asyncio
    async def test_update_raises_when_absent(self, store):
        with pytest.raises(StorageError):
            await store.save(CLIENT_1, make_record(), mode='update')

    @pytest.mark.asyncio
    async def test_upsert_creates_when_absent(self, store):
        await store.save(CLIENT_1, make_record(schedule='0 * * * *'), mode='upsert')
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.schedule == '0 * * * *'

    @pytest.mark.asyncio
    async def test_upsert_overwrites_when_exists(self, store):
        await store.save(CLIENT_1, make_record(schedule='0 * * * *'))
        await store.save(CLIENT_1, make_record(schedule='1 * * * *'), mode='upsert')
        result = await store.get(CLIENT_1, 'proj-1')
        assert result.schedule == '1 * * * *'
