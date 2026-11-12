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
AuthzRecheck: the engine's live re-check of platform authority (#972).

A connection's identity (``TaskConn._account_info``) is a snapshot taken at
auth time. Pushes refresh it on the instance that served a change, but a
revocation that never pushes (another replica, a CLI tool, direct SQL) left
a removed or disabled platform admin with ``sys.*`` authority on an open
socket. This module closes that gap for every *subject*: a connection on
this server (``TaskServer._connections``), authenticated, not ``pk_``/``tk_``,
whose cached ``sysPermissions`` is non-empty.

Sweep: every ``T`` seconds (start to start, +/-20 % jitter; a read that
overran starts the next sweep at once) one batched ``live_authority`` read
covers every subject's user. Per subject, a missing row, a disabled user or
any cached ``sysPermissions`` element missing from the row revokes the
connection (``TaskConn.revoke``); otherwise the connection is verified as of
the sweep start. Widening is ignored. A failed read changes nothing.

Gate: ``gate_ok`` refuses a subject not verified within ``THRESHOLD``
seconds; ``TaskConn.on_receive`` and every event send consult it, so if
authority cannot be read nothing runs or is sent on stale authority, while
the connection stays open and resumes after the next good read.

Bound: a gap of at most 1.2 T between sweeps plus a read of at most R + 1
revokes within 9 s; the gate's ``THRESHOLD`` = 1.2 T + (R + 1) + 1 = 10 s.
"""

import asyncio
import random
import time
from typing import TYPE_CHECKING, Any, Callable, List, Set, Tuple

from rocketlib import debug, warning

from .task_conn import authority_subject

if TYPE_CHECKING:
    from .task_conn import TaskConn
    from .task_server import TaskServer

# Sweep period (s), read budget (s; the SaaS read times out at R, the engine
# backstop at R + 1) and the gate threshold (s): 1.2 T + (R + 1) + 1.
T, R, THRESHOLD = 5.0, 2.0, 10.0
JITTER = 0.2
# At most one ``[AUTHZ] denied`` warning per connection per this many seconds.
DENY_LOG_INTERVAL = 60.0


class AuthzRecheck:
    """Periodic live re-check of platform authority for one TaskServer."""

    def __init__(
        self,
        server: 'TaskServer',
        account: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ) -> None:
        """
        Bind the re-check to a server and the account facade.

        Args:
            server: The TaskServer whose connections are re-checked.
            account: The account facade (``live_authority``).
            clock: Monotonic clock (seconds); injectable for tests.
            rng: Uniform [0, 1) source for the jitter; injectable for tests.
        """
        self._server = server
        self._account = account
        self._clock = clock
        self._rng = rng
        self._stopping = False
        self._wake = asyncio.Event()
        # Revoke notices in flight (strong references until they finish)
        self._notices: Set[asyncio.Task] = set()

    def clock(self) -> float:
        """The monotonic clock every verification stamp is read from."""
        return self._clock()

    def is_subject(self, conn: 'TaskConn') -> bool:
        """True when ``conn`` is re-checked: registered here, authenticated, holding sys.* authority."""
        try:
            registered = self._server._connections.get(conn.get_connection_id()) is conn
        except Exception:
            return False
        return registered and bool(getattr(conn, '_authenticated', False)) and authority_subject(conn._account_info)

    def gate_ok(self, conn: 'TaskConn') -> bool:
        """False only for a subject not verified within THRESHOLD seconds."""
        if not self.is_subject(conn):
            return True
        return self.clock() - getattr(conn, '_authz_verified_at', 0.0) <= THRESHOLD

    async def sweep_once(self) -> None:
        """Read every subject's authority in one batch and act on it."""
        start = self.clock()
        captured: List[Tuple['TaskConn', Any]] = [
            (conn, conn._account_info) for conn in list(self._server._connections.values()) if self.is_subject(conn)
        ]
        if not captured:
            return

        user_ids = sorted({info.userId for _, info in captured})
        try:
            rows = await asyncio.wait_for(self._account.live_authority(user_ids), R + 1)
        except Exception as e:
            self._read_failed(len(user_ids), repr(e))
            return
        if rows is None:
            self._read_failed(len(user_ids), 'no result')
            return

        # Decide every subject, stamp every verified one, then revoke the
        # rest, all with no await: no client can delay another's stamp or
        # its own revoke. Only the notices (bounded sends + disconnect) run
        # afterwards, as independent tasks.
        narrowed: List[Tuple['TaskConn', Any, str]] = []
        for conn, info in captured:
            row = rows.get(info.userId)
            if row is None:
                narrowed.append((conn, info, 'user row gone'))
            elif not row[0]:
                narrowed.append((conn, info, 'user disabled'))
            elif set(info.sysPermissions) - set(row[1]):
                narrowed.append((conn, info, 'sysPermissions narrowed'))
            elif conn._account_info is info:
                # Verified as of the sweep start, if the identity read is still the one held
                conn._authz_verified_at = max(getattr(conn, '_authz_verified_at', 0.0), start)
        for conn, info, reason in narrowed:
            if conn.revoke_authority(info, f'live authority: {reason}'):
                notice = asyncio.ensure_future(conn.send_revoke_notice())
                self._notices.add(notice)
                notice.add_done_callback(self._notices.discard)

    def gate_denied(self, conn: 'TaskConn', command: Any) -> None:
        """Count a refused request; warn at most once per connection per DENY_LOG_INTERVAL."""
        denied = self._server.count_authz('denied_unavailable')
        now = self.clock()
        if now - getattr(conn, '_authz_denied_logged_at', float('-inf')) < DENY_LOG_INTERVAL:
            return
        conn._authz_denied_logged_at = now
        warning(
            f'[AUTHZ] denied conn={conn.get_connection_id()} user={conn._account_info.userId} '
            f'command={command} denied_unavailable={denied}'
        )

    def _read_failed(self, users: int, why: str) -> None:
        """Count and log a failed read; nothing is decided on it."""
        failed = self._server.count_authz('read_failed')
        warning(f'[AUTHZ] live authority read failed users={users} error={why} read_failed={failed}')

    async def run(self) -> None:
        """Sweep until ``stop``: each start is the previous start + T * (1 +/- JITTER)."""
        next_start = self.clock()
        while not self._stopping:
            delay = next_start - self.clock()
            if delay > 0:
                try:
                    await asyncio.wait_for(self._wake.wait(), delay)
                except asyncio.TimeoutError:
                    pass
                if self._stopping:
                    break
            started = self.clock()
            try:
                await self.sweep_once()
            except Exception as e:
                debug(f'[AUTHZ] sweep error: {e!r}')
            next_start = started + T * (1 + JITTER * (2 * self._rng() - 1))

    async def stop(self) -> None:
        """Stop the sweep loop (it exits at its next wake-up) and end pending revoke notices."""
        self._stopping = True
        self._wake.set()
        notices = list(self._notices)
        for notice in notices:
            notice.cancel()
        await asyncio.gather(*notices, return_exceptions=True)
