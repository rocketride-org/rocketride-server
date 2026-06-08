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
DeploymentStore — persistence layer for deployment control records.

Stores each deployment as a JSON file at:
    users/<client_id>/deployments/<project_id>.json

A single store instance is shared across all clients; caller supplies
client_id on every method call.

Uses IStore directly (not FileStore) because deployments are small structured
JSON, not user-uploaded binary data.
"""

from typing import AsyncGenerator, Literal

from rocketlib import error

from .models import DeploymentRecord
from .store import IStore, StorageError


class DeploymentStore:
    """Read/write DeploymentRecord objects via an IStore backend."""

    def __init__(self, store: IStore) -> None:
        self._store = store

    async def save(
        self,
        client_id: str,
        record: DeploymentRecord,
        *,
        mode: Literal['upsert', 'create', 'update'] = 'upsert',
    ) -> None:
        """Persist a deployment record.

        Args:
            mode: 'upsert' creates or overwrites (default); 'create' raises StorageError if
                  the record already exists; 'update' raises StorageError if it does not exist.
        """
        path = self._path(client_id, record.pipeline['project_id'])
        data = record.model_dump_json()

        if mode == 'create':
            try:
                await self._store.read_file(path)
            except StorageError:
                # TOCTOU: another writer could create the file between here and write_file.
                # IStore has no atomic create-only primitive, so this narrow race is accepted.
                await self._store.write_file(path, data)
                return
            raise StorageError(f'Deployment already exists: {record.pipeline["project_id"]}')

        if mode == 'update':
            _, version = await self._store.read_file_with_metadata(path)
            await self._store.write_file_atomic(path, data, expected_version=version)
            return

        await self._store.write_file(path, data)

    async def get(self, client_id: str, project_id: str) -> DeploymentRecord:
        """
        Return the deployment record for project_id.

        Raises:
            StorageError: If the deployment does not exist.
        """
        data = await self._store.read_file(self._path(client_id, project_id))
        return DeploymentRecord.model_validate_json(data)

    async def delete(self, client_id: str, project_id: str) -> None:
        """
        Remove the deployment record for project_id.

        Raises:
            StorageError: If the deployment does not exist.
        """
        await self._store.delete_file(self._path(client_id, project_id))

    async def list(self, client_id: str) -> list[DeploymentRecord]:
        """Return all deployment records for the given client, in no particular order."""
        paths = await self._store.list_entries(
            self._prefix(client_id), recursive=False, include_dirs=False, name_pattern='*.json'
        )
        records = []
        for path in paths:
            try:
                data = await self._store.read_file(path)
                records.append(DeploymentRecord.model_validate_json(data))
            except (StorageError, Exception) as e:
                error(f'DeploymentStore.list: skipping {path}: {e}')
        return records

    async def iter_all(self) -> 'AsyncGenerator[DeploymentRecord, None]':
        """Async-generate every DeploymentRecord in the store, across all users."""
        users = await self._store.list_entries('users/', recursive=False, include_files=False)
        for user in users:
            for dep in await self._store.list_entries(
                f'{user}deployments/', recursive=False, include_dirs=False, name_pattern='*.json'
            ):
                try:
                    data = await self._store.read_file(dep)
                    rec = DeploymentRecord.model_validate_json(data)
                    yield rec
                except Exception as e:
                    error(f'DeploymentStore.iter_all: skipping {dep}: {e}')

    def _path(self, client_id: str, project_id: str) -> str:
        return f'users/{client_id}/deployments/{project_id}.json'

    def _prefix(self, client_id: str) -> str:
        return f'users/{client_id}/deployments/'


__all__ = ['DeploymentStore']
