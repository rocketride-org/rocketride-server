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


"""Shared harness for the #972 authority tests (revocation, re-check).

``FakeAccount`` stands in for the account singleton: ``rows`` is the
``users`` table as the live read sees it (``user id -> (enabled,
frozenset(sys_permissions))``), and its ``_service`` rebuilds identities
from the same rows, the way the SaaS ``get_authentication_result`` does
(``waitlisted = not enabled``; a missing row raises ``ValueError``). Two
``TaskServer``s can share one instance (two engine replicas over one DB).

Servers and connections are built with ``__new__`` (no background tasks, no
sockets); a connection's transport is a mock whose ``disconnect`` records
the close, and every event it is sent lands in ``sent``.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, List, Optional, Sequence, Tuple
from unittest.mock import AsyncMock, MagicMock

import ai.account
from ai.account.base import AccountBase
from ai.account.models import AccountInfo
from ai.modules.task.task_conn import TaskConn
from ai.modules.task.task_server import TaskServer
from rocketride import EVENT_TYPE

ORG = 'org-1'
IP = '10.0.0.1'


class _FakeService:
    """The SaaS ``AccountService`` surface the identity pushes use."""

    def __init__(self, account: 'FakeAccount') -> None:
        self._account = account
        self.rebuilds: List[str] = []

    async def get_authentication_result(self, user_id: str, auth: str, capabilities=None) -> AccountInfo:
        """Rebuild an identity from the fake ``users`` row."""
        self.rebuilds.append(user_id)
        if self._account.fail_rebuild is not None:
            raise self._account.fail_rebuild
        row = self._account.rows.get(user_id)
        if row is None:
            raise ValueError(f'User {user_id} not found')
        enabled, perms = row
        return identity(user_id, perms, auth=auth, waitlisted=not enabled)


class FakeAccount(AccountBase):
    """Account singleton stand-in over an in-memory ``users`` table."""

    supports_live_authority = True
    capabilities = ('saas',)

    def __init__(self, rows: Optional[Dict[str, Tuple[bool, FrozenSet[str]]]] = None) -> None:
        self.rows: Dict[str, Tuple[bool, FrozenSet[str]]] = dict(rows or {})
        self.fail = False
        self.fail_rebuild: Optional[BaseException] = None
        self.reads: List[List[str]] = []
        self._service = _FakeService(self)

    async def authenticate(self, credential: str):
        """Not used by these tests."""
        return (401, 'not used')

    async def live_authority(self, user_ids: Sequence[str]) -> Optional[Dict[str, Tuple[bool, FrozenSet[str]]]]:
        """One batched read of the rows present (raises when ``fail`` is set)."""
        self.reads.append(list(user_ids))
        if self.fail:
            raise RuntimeError('database unavailable')
        return {uid: self.rows[uid] for uid in user_ids if uid in self.rows}


def identity(
    user_id: str, perms=(), *, auth: str = 'rr_session', waitlisted: bool = False, org: str = ORG
) -> AccountInfo:
    """A full-user identity in ``org`` holding ``perms`` as sysPermissions."""
    return AccountInfo(
        auth=auth,
        userId=user_id,
        organization={'id': org, 'name': org, 'permissions': [], 'teams': []},
        sysPermissions=sorted(perms),
        waitlisted=waitlisted,
    )


def make_server(account: FakeAccount, monkeypatch) -> TaskServer:
    """A TaskServer with ``__init__`` bypassed, over ``account``."""
    monkeypatch.setattr(ai.account, 'account', account)
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._config = {}
    ts._server = MagicMock()
    ts.debug_message = MagicMock()
    ts.store_stub = MagicMock()
    ts.store_stub.close_all_handles = AsyncMock()
    monkeypatch.setattr(TaskServer, 'store', property(lambda self: self.store_stub))
    return ts


def make_conn(server: TaskServer, info: Optional[AccountInfo], *, connection_id: int = 1, monitors=None) -> TaskConn:
    """An authenticated TaskConn registered on ``server``, holding ``info``."""
    conn = TaskConn.__new__(TaskConn)
    conn._connection_id = connection_id
    conn._client_ip = IP
    conn._authenticated = info is not None
    conn._account_info = info
    conn._auth_attempts = 0
    conn._messages_in = 0
    conn._messages_out = 0
    conn._last_activity = 0.0
    conn._connected_at = 0.0
    conn._client_info = {}
    conn._monitors = dict(monitors or {})
    conn._server = server
    conn.sent: List[dict] = []

    transport = MagicMock()

    async def _send(message):
        conn.sent.append(message)

    transport.send = AsyncMock(side_effect=_send)
    transport.disconnect = MagicMock()
    conn._transport = transport

    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.build_error = MagicMock(side_effect=lambda req, msg: {'type': 'response', 'success': False, 'message': msg})
    conn.build_event = MagicMock(
        side_effect=lambda evt, id='', body=None: {'type': 'event', 'event': evt, 'body': body}
    )
    conn.debug_message = MagicMock()
    server._connections[connection_id] = conn
    return conn


def events(conn: TaskConn, name: Optional[str] = None) -> List[dict]:
    """Events delivered to ``conn`` (optionally only those named ``name``)."""
    return [m for m in conn.sent if m.get('type') == 'event' and (name is None or m.get('event') == name)]


WILDCARD_ALL = {'*': EVENT_TYPE.DASHBOARD | EVENT_TYPE.BILLING}
