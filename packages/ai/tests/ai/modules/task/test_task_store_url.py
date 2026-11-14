# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
The engine signs a task's /task/fetch URLs, ``store.url`` on the task channel.

Issue #1070: the task process runs pipeline code, so it does not hold the
signing key. It asks the engine, which resolves the path under the task's own
identity and storage root (taken from the connection, never the request) and
signs it; a path the task could not read itself is refused.
"""

from __future__ import annotations

import shutil
import tempfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import jwt
import pytest

from ai.account.models import RequestContext
from ai.account.store import Store
from ai.account.store_providers.filesystem import FilesystemStore
from ai.modules.task import task_channel
from ai.modules.task.task_channel import ChannelRefused
from ai.modules.task.task_engine import Task

_SIGNING_KEY = 'test-signing-key-of-32-bytes-min!'


@pytest.fixture
def store(monkeypatch):
    """The process store singleton over a throwaway filesystem backend, with the engine's signing env."""
    temp_path = tempfile.mkdtemp()
    store = Store(FilesystemStore(f'filesystem://{temp_path}'))
    monkeypatch.setattr(Store, '_instance', store)
    monkeypatch.setenv('RR_SIGNING_KEY', _SIGNING_KEY)
    monkeypatch.setenv('RR_BASE_URL', 'http://localhost:5565')
    yield store
    shutil.rmtree(temp_path, ignore_errors=True)


def _task(client_id='user-1', owner_kind='', team_id='team-1'):
    return Task(
        server=MagicMock(),
        id='t-1',
        project_id='p-1',
        source='s-1',
        token='tk',
        public_auth='pk',
        pipeline={},
        client_id=client_id,
        team_id=team_id,
        owner_kind=owner_kind,
    )


def _handler():
    command = task_channel._commands.get('store.url')
    assert command is not None, 'store.url is not a channel command'
    return command.handler


def _claim(url: str) -> dict:
    return jwt.decode(url.split('token=', 1)[1], _SIGNING_KEY, algorithms=['HS256'])


def test_store_url_is_a_channel_command_for_the_whole_run():
    command = task_channel._commands.get('store.url')

    assert command is not None and command.phase == task_channel.PHASE_RUN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('owner_kind', 'physical'),
    [
        ('', 'users/user-1/files/reports/q1.csv'),
        ('team', 'teams/team-1/files/tasks/p-1/reports/q1.csv'),
    ],
    ids=['user-run', 'team-run'],
)
async def test_the_engine_signs_under_the_tasks_own_identity_and_root(store, owner_kind, physical):
    from ai.modules.task.fetch import handle_fetch

    task = _task(owner_kind=owner_kind)
    engine_view = store._file_store(RequestContext.engine('user-1'), client_id='user-1', root=task._storage_root())
    await engine_view.write('reports/q1.csv', b'data')

    reply = await _handler()(task, {'path': 'reports/q1.csv', 'expires_in': 600, 'download_name': 'q1.csv'}, None)

    claim = _claim(reply.body['url'])
    assert (claim['sub'], claim['path'], claim['download_name']) == ('user-1', physical, 'q1.csv')
    response = await handle_fetch(SimpleNamespace(query_params={'token': reply.body['url'].split('token=', 1)[1]}))
    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'arguments',
    [
        {'path': '../../victim/files/secret.txt'},
        {'path': '@/User/=victim/secret.txt'},
        {'path': '@/Team/=team-1/secret.txt'},
        {'path': '@/Org/secret.txt'},
        {'path': ''},
        {'path': ['secret.txt']},
        {'path': 'secret.txt', 'expires_in': '600'},
        {'path': 'secret.txt', 'expires_in': True},
        {'path': 'secret.txt', 'expires_in': 0},
        {'path': 'secret.txt', 'download_name': 7},
    ],
    ids=[
        'traversal',
        'other-user',
        'team-scope',
        'org-scope',
        'empty',
        'not-a-string',
        'expires-str',
        'expires-bool',
        'expires-zero',
        'name-int',
    ],
)
async def test_a_path_the_task_cannot_read_itself_is_refused(store, arguments):
    with pytest.raises(ChannelRefused):
        await _handler()(_task(), arguments, None)


@pytest.mark.asyncio
async def test_an_anonymous_task_has_no_storage_to_sign_for(store):
    with pytest.raises(ChannelRefused):
        await _handler()(_task(client_id=''), {'path': 'secret.txt'}, None)
