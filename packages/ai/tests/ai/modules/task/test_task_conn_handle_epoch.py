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

"""File handles must not outlive the identity that opened them.

One task WebSocket can change identity without closing (re-auth, or
deauth then auth). File handles are Store-wide and were keyed only by the
socket, so the next identity could read/write/close the previous identity's
open handles. The connection now carries an auth generation; handles are
stamped with it, rejected on any other generation, swept when the identity
changes, and an open that finishes after the change is closed on the spot.

These tests drive the REAL TaskConn auth handlers, the real ``fs_open``
handler and a real filesystem-backed Store.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ai.account.file_store import FileStore
from ai.account.models import RequestContext
from ai.account.store import StorageError, Store
from ai.account.store_providers.filesystem import FilesystemStore
from ai.modules.task.task_conn import TaskConn
from ai.modules.task.task_server import TaskServer

from .test_task_conn import _make_account_info, _make_conn


@pytest.fixture
def store(monkeypatch):
    """A real Store over a throwaway directory, installed as the singleton."""
    path = tempfile.mkdtemp()
    s = Store(FilesystemStore(f'filesystem://{path}'))
    monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: s))
    yield s
    shutil.rmtree(path, ignore_errors=True)


def _identity(user_id: str):
    """AccountInfo-shaped stub that also renders the connect result."""
    info = _make_account_info(user_id=user_id)
    info.to_connect_result = lambda: {}
    return info


@pytest.fixture
def conn(store):
    """A TaskConn (real auth/store handlers) whose credentials map to users A and B."""
    accounts = {'cred-a': _identity('user-a'), 'cred-b': _identity('user-b')}

    async def authenticate_credential(credential):
        return accounts[credential]

    c = _make_conn(authenticated=False)
    c._server = SimpleNamespace(
        _server=SimpleNamespace(authenticate_credential=authenticate_credential),
        broadcast_server_event=AsyncMock(),
        release_unauthed_slot=lambda ip: None,
        acquire_unauthed_slot=lambda ip: None,
        _unauthed_by_ip={},
        _task_control={},
        store=store,
    )
    return c


def _push_server(conn):
    """A server double that runs the real push path (``_push_rebuilt``) over ``conn``."""
    server = SimpleNamespace(
        _connections={1: conn}, debug_message=lambda m: None, _authz=None, count_authz=lambda kind: 0
    )
    server._push_rebuilt = MethodType(TaskServer._push_rebuilt, server)
    server._push_rebuilt_locked = MethodType(TaskServer._push_rebuilt_locked, server)
    return server


async def _auth(conn, credential):
    await TaskConn.on_auth(conn, {'arguments': {'auth': credential}})


def _spy_backend_close(store):
    """Record backend close calls without changing behaviour."""
    store._store.close_write = AsyncMock(wraps=store._store.close_write)
    store._store.close_read = AsyncMock(wraps=store._store.close_read)


# ---------------------------------------------------------------------------
# Handles die with the identity that opened them
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reauth_as_another_user_cannot_use_a_write_handle(conn, store):
    """A opens a write handle; after re-auth as B, B cannot write to or close it."""
    await _auth(conn, 'cred-a')
    handle = await conn._get_file_store().open_write('secret.bin')

    await _auth(conn, 'cred-b')

    fs_b = conn._get_file_store()
    with pytest.raises(StorageError):
        await fs_b.write_chunk(handle, b'planted')
    with pytest.raises(StorageError):
        await fs_b.close_write(handle)


@pytest.mark.asyncio
async def test_reauth_as_another_user_cannot_read_a_read_handle(conn, store):
    """A opens a read handle; after re-auth as B, B cannot read from it."""
    await _auth(conn, 'cred-a')
    fs_a = conn._get_file_store()
    writer = await fs_a.open_write('secret.bin')
    await fs_a.write_chunk(writer, b'top secret')
    await fs_a.close_write(writer)
    handle = (await fs_a.open_read('secret.bin'))['handle']

    await _auth(conn, 'cred-b')

    with pytest.raises(StorageError):
        await conn._get_file_store().read_chunk(handle, 0, 10)


@pytest.mark.asyncio
async def test_deauth_then_auth_as_another_user_cannot_use_the_handle(conn, store):
    """A -> deauth -> B: B cannot reach A's handle."""
    await _auth(conn, 'cred-a')
    handle = await conn._get_file_store().open_write('secret.bin')

    await TaskConn.on_deauth(conn, {})
    await _auth(conn, 'cred-b')

    with pytest.raises(StorageError):
        await conn._get_file_store().write_chunk(handle, b'planted')


@pytest.mark.asyncio
async def test_epoch_alone_rejects_a_stale_handle_without_the_sweep(store):
    """Even if no sweep ran, a ctx from another generation is refused."""
    old = FileStore(store, 'user-a', RequestContext(account_info=_identity('user-a'), conn_id='c1', auth_epoch=1))
    new = FileStore(store, 'user-a', RequestContext(account_info=_identity('user-a'), conn_id='c1', auth_epoch=2))
    handle = await old.open_write('f.bin')

    with pytest.raises(StorageError, match='identity changed'):
        await new.write_chunk(handle, b'x')


@pytest.mark.asyncio
async def test_deauth_closes_handles_releases_locks_and_closes_the_backend(conn, store):
    """Deauth tears handles down exactly like disconnect: registry, write lock, backend."""
    _spy_backend_close(store)
    await _auth(conn, 'cred-a')
    fs = conn._get_file_store()
    await fs.open_write('w.bin')
    assert len(store._shared_handles) == 1
    assert len(store._shared_write_locks) == 1

    await TaskConn.on_deauth(conn, {})

    assert store._shared_handles == {}
    assert store._shared_write_locks == set()
    store._store.close_write.assert_awaited_once()


# ---------------------------------------------------------------------------
# In-flight open racing an identity change
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_open_finishing_after_identity_change_is_rejected_and_closed(conn, store):
    """An open that awaits the backend across deauth+auth must not leave a usable handle."""
    _spy_backend_close(store)
    entered, release = asyncio.Event(), asyncio.Event()
    real_open_write = store._store.open_write

    async def gated_open_write(path):
        entered.set()
        await release.wait()
        return await real_open_write(path)

    store._store.open_write = gated_open_write

    await _auth(conn, 'cred-a')
    opening = asyncio.ensure_future(conn._store_fs_open({}, {'path': 'late.bin', 'mode': 'w'}))
    await entered.wait()

    await TaskConn.on_deauth(conn, {})
    await _auth(conn, 'cred-b')
    release.set()

    with pytest.raises(StorageError, match='Authentication changed'):
        await opening

    assert store._shared_handles == {}
    assert store._shared_write_locks == set()
    store._store.close_write.assert_awaited_once()


# ---------------------------------------------------------------------------
# Unchanged behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_same_identity_keeps_working(conn, store):
    """No identity change: open, write, read back and close all succeed."""
    await _auth(conn, 'cred-a')
    resp = await conn._store_fs_open({}, {'path': 'ok.bin', 'mode': 'w'})
    handle = resp['body']['handle']
    fs = conn._get_file_store()
    assert await fs.write_chunk(handle, b'hello') == 5
    await fs.close_write(handle)

    info = (await conn._store_fs_open({}, {'path': 'ok.bin'}))['body']
    assert await fs.read_chunk(info['handle'], 0, 10) == b'hello'
    await fs.close_read(info['handle'])
    assert store._shared_handles == {}


@pytest.mark.asyncio
async def test_disconnect_closes_handles_from_every_epoch(store):
    """Store.close_all_handles ignores the epoch: older generations are closed too."""
    _spy_backend_close(store)
    account = _identity('user-a')
    for epoch in (1, 2, 3):
        fs = FileStore(store, 'user-a', RequestContext(account_info=account, conn_id='c1', auth_epoch=epoch))
        await fs.open_write(f'e{epoch}.bin')
    assert len(store._shared_handles) == 3

    await store.close_all_handles('c1')

    assert store._shared_handles == {}
    assert store._shared_write_locks == set()
    assert store._store.close_write.await_count == 3


@pytest.mark.asyncio
async def test_stale_sweep_leaves_current_epoch_and_other_connections_alone(store):
    """Only this connection's OLDER generations are swept."""
    account = _identity('user-a')
    mk = lambda conn_id, epoch: FileStore(  # noqa: E731
        store, 'user-a', RequestContext(account_info=account, conn_id=conn_id, auth_epoch=epoch)
    )
    old, cur, other = mk('c1', 1), mk('c1', 2), mk('c2', 1)
    h_old = await old.open_write('old.bin')
    h_cur = await cur.open_write('cur.bin')
    h_other = await other.open_write('other.bin')

    await store.close_stale_handles('c1', 2)

    assert h_old not in store._shared_handles
    assert h_cur in store._shared_handles
    assert h_other in store._shared_handles


@pytest.mark.asyncio
async def test_empty_conn_id_is_unowned_and_unaffected(store):
    """conn_id '' keeps its old behaviour: usable, and never swept."""
    fs = FileStore(store, 'user-a', RequestContext.internal('test'))
    fs._ctx.conn_id = ''
    handle = await fs.open_write('u.bin')
    await store.close_stale_handles('', 5)
    assert await fs.write_chunk(handle, b'ab') == 2
    await fs.close_write(handle)


# ---------------------------------------------------------------------------
# Account pushes racing a re-auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('push', ['account', 'org'])
@pytest.mark.asyncio
async def test_push_resolving_after_reauth_does_not_overwrite_the_new_identity(conn, store, monkeypatch, push):
    """A push for A that lands after the socket re-authed as B must not put A back."""
    from ai.account import account

    await _auth(conn, 'cred-a')
    gate = asyncio.Event()

    async def get_auth(user_id, auth):
        await gate.wait()
        return _identity('user-a')

    monkeypatch.setattr(account, '_service', SimpleNamespace(get_authentication_result=get_auth), raising=False)
    conn._account_info.auth = 'rr_a'
    conn.send_event = AsyncMock()
    server = _push_server(conn)
    if push == 'account':
        running = asyncio.ensure_future(TaskServer.push_account_update(server, 'user-a'))
    else:
        running = asyncio.ensure_future(TaskServer.push_org_update(server, 'org-1'))
    await asyncio.sleep(0)

    await _auth(conn, 'cred-b')
    handle_b = await conn._get_file_store().open_write('b-secret.bin')
    gate.set()
    await running

    assert conn._account_info.userId == 'user-b'
    conn.send_event.assert_not_awaited()
    await conn._get_file_store().write_chunk(handle_b, b'from-b')


@pytest.mark.asyncio
async def test_push_without_identity_change_still_refreshes(conn, store, monkeypatch):
    """No re-auth during the lookup: the fresh identity is applied and pushed."""
    from ai.account import account

    await _auth(conn, 'cred-a')
    fresh = _identity('user-a')

    async def get_auth(user_id, auth):
        return fresh

    monkeypatch.setattr(account, '_service', SimpleNamespace(get_authentication_result=get_auth), raising=False)
    conn._account_info.auth = 'rr_a'
    conn.send_event = AsyncMock()
    fresh.to_push_result = lambda: {}
    server = _push_server(conn)

    await TaskServer.push_account_update(server, 'user-a')

    assert conn._account_info is fresh
    conn.send_event.assert_awaited_once()


# ---------------------------------------------------------------------------
# Concurrent teardown of one handle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_teardowns_close_the_backend_once(store):
    """The identity sweep racing disconnect cleanup must not double-close a handle."""
    fs = FileStore(store, 'user-a', RequestContext(account_info=_identity('user-a'), conn_id='c1', auth_epoch=1))
    await fs.open_write('x.bin')
    gate = asyncio.Event()
    calls = []
    real = store._store.close_write

    async def gated(path, context):
        calls.append(path)
        await gate.wait()
        return await real(path, context)

    store._store.close_write = gated
    sweep = asyncio.ensure_future(store.close_stale_handles('c1', 2))
    await asyncio.sleep(0)
    disconnect = asyncio.ensure_future(store.close_all_handles('c1'))
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(sweep, disconnect)

    assert len(calls) == 1
    assert store._shared_handles == {}
    assert store._shared_write_locks == set()
