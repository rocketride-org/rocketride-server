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

API 2 also covers every ``rr_`` socket, including users with no ``sys.*``.
The hash-only ``live_credentials`` read checks the actual key's exact owner,
revocation/deletion, enabled owner, and effective expiry. It never rebuilds
an identity or adds permissions. Its verification stamp is independent of
the user-authority stamp: neither an account push nor a successful user read
can keep an expired, evicted, or revoked credential alive. Authentication
captures the effective expiry before installing the identity; every request
and event gate enforces that deadline even between sweeps or during outages.

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
import hashlib
import math
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
# Backstop (s) on one identity rebuild read, the same R + 1 the sweep's read gets.
REBUILD_TIMEOUT = R + 1
JITTER = 0.2
# At most one ``[AUTHZ] denied`` warning per connection per this many seconds.
DENY_LOG_INTERVAL = 60.0


def validate_credential_provider(account: Any) -> None:
    """Reject an incomplete hosted overlay instead of disabling key rechecks."""
    from ai.account.base import AccountBase

    enabled = bool(getattr(account, 'supports_live_credentials', False))
    if 'saas' in getattr(account, 'capabilities', ()) and not enabled:
        raise RuntimeError('SaaS account overlay must enable live credential verification (LIVE_AUTHORITY_API 2)')
    provider = getattr(account, 'live_credentials', None)
    if enabled and (not callable(provider) or getattr(provider, '__func__', None) is AccountBase.live_credentials):
        raise RuntimeError('Account overlay must implement live_credentials before enabling it')
    # Live credentials alone leave every sys.* holder permanently gated: the
    # authority stamp is only ever refreshed by a live_authority read.
    if enabled and not getattr(account, 'supports_live_authority', False):
        raise RuntimeError('Account overlay enabling live credentials must also enable live authority')


class AuthzRecheck:
    """Periodic live re-check of platform authority for one TaskServer."""

    def __init__(
        self,
        server: 'TaskServer',
        account: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        rng: Callable[[], float] = random.random,
    ) -> None:
        """
        Bind the re-check to a server and the account facade.

        Args:
            server: The TaskServer whose connections are re-checked.
            account: The account facade (``live_authority``).
            clock: Monotonic clock (seconds); injectable for tests.
            wall_clock: UTC epoch clock for effective expiry deadlines.
            rng: Uniform [0, 1) source for the jitter; injectable for tests.
        """
        self._server = server
        self._account = account
        self._clock = clock
        self._wall_clock = wall_clock
        self._rng = rng
        self._stopping = False
        self._wake = asyncio.Event()
        # Revoke notices in flight (strong references until they finish)
        self._notices: Set[asyncio.Task] = set()

    def clock(self) -> float:
        """The monotonic clock every verification stamp is read from."""
        return self._clock()

    def is_subject(self, conn: 'TaskConn') -> bool:
        """True for registered authenticated sys-authority or persistent-key sockets."""
        try:
            registered = self._server._connections.get(conn.get_connection_id()) is conn
        except Exception:
            return False
        return (
            registered
            and bool(getattr(conn, '_authenticated', False))
            and (authority_subject(conn._account_info) or self.credential_subject(conn._account_info))
        )

    def credential_subject(self, info: Any) -> bool:
        """Every rr_ key is rechecked; task, PKCE, and raw delegated classes stay unchanged."""
        auth = getattr(info, 'auth', '')
        return (
            bool(getattr(self._account, 'supports_live_credentials', False))
            and isinstance(auth, str)
            and auth.startswith('rr_')
        )

    @staticmethod
    def _key_hash(info: Any) -> str:
        return hashlib.sha256(info.auth.encode('utf-8')).hexdigest()

    def _credential_record(self, info: Any, rows: Any):
        """Validate provider output, requiring the key's exact owner and a live deadline."""
        row = rows.get(self._key_hash(info))
        if not isinstance(row, (tuple, list)) or len(row) != 2 or row[0] != info.userId:
            return None
        expiry = row[1]
        if expiry is not None and (
            isinstance(expiry, bool)
            or not isinstance(expiry, (int, float))
            or not math.isfinite(expiry)
            or expiry <= self._wall_clock()
        ):
            return None
        return row

    async def check_credential(self, info: Any):
        """Before auth installation, verify the presenting key and capture its expiry."""
        rows = await asyncio.wait_for(self._account.live_credentials([self._key_hash(info)]), R + 1)
        if not isinstance(rows, dict):
            raise RuntimeError('Credential verification unavailable')
        return self._credential_record(info, rows)

    def stamp_credential(self, conn: 'TaskConn', info: Any, record: Any, start: float) -> None:
        """Record liveness without changing any cached permission or extending expiry."""
        conn._credential_verified_for = (self._key_hash(info), info.userId)
        conn._credential_verified_at = start
        conn._credential_expires_at = record[1]

    def gate_ok(self, conn: 'TaskConn') -> bool:
        """False only for a subject not verified within THRESHOLD seconds."""
        if not self.is_subject(conn):
            return True
        info = conn._account_info
        if authority_subject(info) and self.clock() - getattr(conn, '_authz_verified_at', 0.0) > THRESHOLD:
            return False
        if self.credential_subject(info):
            if getattr(conn, '_credential_verified_for', None) != (self._key_hash(info), info.userId):
                return False
            if self.clock() - getattr(conn, '_credential_verified_at', 0.0) > THRESHOLD:
                return False
            expiry = getattr(conn, '_credential_expires_at', None)
            if expiry is not None and self._wall_clock() >= expiry:
                return False
        return True

    async def sweep_once(self) -> None:
        """Read every subject's authority in one batch and act on it."""
        start = self.clock()
        captured: List[Tuple['TaskConn', Any]] = [
            (conn, conn._account_info) for conn in list(self._server._connections.values()) if self.is_subject(conn)
        ]
        if not captured:
            return

        authority = [(conn, info) for conn, info in captured if authority_subject(info)]
        credentials = [(conn, info) for conn, info in captured if self.credential_subject(info)]
        user_ids = sorted({info.userId for _, info in authority})
        key_hashes = sorted({self._key_hash(info) for _, info in credentials})

        async def read(hook, values, label):
            if not values:
                return {}
            try:
                result = await asyncio.wait_for(hook(values), R + 1)
                if isinstance(result, dict):
                    return result
                self._read_failed(len(values), f'{label}: no result')
            except Exception as exc:
                # Provider errors can contain SQL parameters; no credential
                # material is needed in the operational failure log.
                self._read_failed(len(values), f'{label}: {type(exc).__name__}')
            return None

        # Separate stamps: a successful user read never verifies the key, and
        # a successful key read never refreshes cached sys authority.
        rows, key_rows = await asyncio.gather(
            read(self._account.live_authority, user_ids, 'authority'),
            read(self._account.live_credentials, key_hashes, 'credentials'),
        )

        # Decide every subject, stamp every verified one, then revoke the
        # rest, all with no await: no client can delay another's stamp or
        # its own revoke. Only the notices (bounded sends + disconnect) run
        # afterwards, as independent tasks.
        narrowed: List[Tuple['TaskConn', Any, str]] = []
        for conn, info in authority if rows is not None else ():
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
        for conn, info in credentials if key_rows is not None else ():
            record = self._credential_record(info, key_rows)
            if record is None:
                narrowed.append((conn, info, 'credential inactive, expired, or owner changed'))
            elif conn._account_info is info and getattr(conn, '_authenticated', False):
                self.stamp_credential(conn, info, record, start)
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
        # Let notices scheduled but not yet started reach their send, so a
        # cancel runs their finally (the disconnect) instead of skipping it.
        await asyncio.sleep(0)
        notices = list(self._notices)
        for notice in notices:
            notice.cancel()
        await asyncio.gather(*notices, return_exceptions=True)
