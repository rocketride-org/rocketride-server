# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Connections and transactions of the shared pgvector driver.

Every database call checks a connection out of a small bounded pool
(``ai.common.connection_pool.ConnectionPool``) for the length of one
transaction, and the transaction always ends (commit or rollback) before the
connection goes back. So no session is ever left idle in a transaction holding
locks, a failed statement never poisons the next call, and parallel tool calls
never share a transaction.

The pool is lazy: it opens at most ``max_size`` connections, only when a call
needs one, and closes a connection that stayed idle ``idle_timeout_s``.

Nothing is set for the session. Every read transaction starts with
:meth:`Statements.begin_read` (load pgvector, ``READ ONLY``, ``SET LOCAL``
statement timeout and HNSW iterative scan), and every write with
:meth:`Statements.begin_write`, because behind a transaction-mode pooler each
transaction may run on a different server session.

Errors reach callers as :class:`~ai.common.store.errors.StoreError` or
:class:`~ai.common.store.errors.ToolRefusal` with a message that never names
the host, port, user, password or database: libpq's connection errors do, so
they are replaced by a fixed sentence and the detail goes to the debug trace.
"""

from __future__ import annotations

import re
import threading
import time

from collections import deque
from contextlib import contextmanager
from typing import Any, Callable, Deque, Dict, Iterable, Iterator, Mapping, Optional, TypeVar

import psycopg2

from psycopg2.extensions import TRANSACTION_STATUS_IDLE
from rocketlib import debug

from ..errors import StoreError, ToolRefusal
from .sql import Statements

from ai.common.connection_pool import ConnectionPool, PoolClosed, PoolTimeout

T = TypeVar('T')

#: Seconds a connect may take before the server counts as unreachable.
CONNECT_TIMEOUT_S = 3

#: What the server is called in errors; the address never appears.
UNREACHABLE_TEXT = 'The pgvector database could not be reached'

#: ``application_name`` of the driver's sessions, so they are easy to find in ``pg_stat_activity``.
APPLICATION_NAME = 'rocketride-pgvector'

# SQLSTATEs the driver answers specially.
_UNDEFINED_TABLE = '42P01'
_UNDEFINED_OBJECT = '42704'
_QUERY_CANCELED = '57014'
_LOCK_NOT_AVAILABLE = '55P03'
_DATA_EXCEPTION = '22000'


class CollectionMissing(StoreError):
    """The table does not exist (it was never created, or was dropped since)."""


class LockUnavailable(StoreError):
    """A lock could not be taken within the transaction's ``lock_timeout``."""


class FairGate:
    """A counting semaphore that hands a released slot to the longest waiter.

    The pool wakes one waiter when a connection comes back, but the thread that
    returned it may take it again first; under steady load from many threads a
    waiter can lose that race until its acquire timeout runs out. Passing every
    checkout through this gate (with as many slots as the pool has connections)
    serves callers in arrival order, so a wait is bounded by the work queued
    ahead of it.
    """

    def __init__(self, slots: int) -> None:
        """Start with ``slots`` free slots."""
        self._lock = threading.Lock()
        self._free = max(1, int(slots))
        self._waiters: Deque[threading.Event] = deque()

    def acquire(self, timeout_s: float) -> bool:
        """Take a slot, waiting at most ``timeout_s``; False when none came in time."""
        with self._lock:
            if self._free > 0 and not self._waiters:
                self._free -= 1
                return True
            ticket = threading.Event()
            self._waiters.append(ticket)
        if ticket.wait(max(0.0, timeout_s)):
            return True
        with self._lock:
            if ticket.is_set():  # handed over between the timeout and the lock
                return True
            self._waiters.remove(ticket)
            return False

    def release(self) -> None:
        """Give the slot to the longest waiter, or back to the free count."""
        with self._lock:
            if self._waiters:
                self._waiters.popleft().set()
            else:
                self._free += 1


def _reset_connection(conn: Any) -> None:
    conn.rollback()
    if conn.get_transaction_status() != TRANSACTION_STATUS_IDLE:
        raise RuntimeError('connection did not return to idle after rollback')


def _connection_usable(conn: Any) -> bool:
    return conn.closed == 0 and not conn.autocommit


def _close_connection(conn: Any) -> None:
    conn.close()


class PgDatabase:
    """The pool of one store, and the transactions every driver call runs in."""

    def __init__(
        self,
        connect_args: Mapping[str, Any],
        statements: Statements,
        *,
        statement_timeout_ms: int,
        max_size: int = 4,
        idle_timeout_s: Optional[float] = 60.0,
        acquire_grace_s: float = 5.0,
    ) -> None:
        """Prepare the pool; no connection is opened until a call needs one."""
        self._connect_args = dict(connect_args)
        self._sql = statements
        self.statement_timeout_ms = int(statement_timeout_ms)
        #: Whether read transactions set ``hnsw.iterative_scan`` (pgvector 0.8 and later); decided at open.
        self.iterative_scan = False
        self._secrets = _secrets_of(self._connect_args)
        self._acquire_timeout_s = self.statement_timeout_ms / 1000.0 + acquire_grace_s
        self._gate = FairGate(max(1, int(max_size)))
        self._pool = ConnectionPool(
            self._connect,
            max_size=max(1, int(max_size)),
            acquire_timeout_s=self._acquire_timeout_s,
            reset=_reset_connection,
            is_usable=_connection_usable,
            close=_close_connection,
            idle_timeout_s=idle_timeout_s,
        )
        self._closed = threading.Event()

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @property
    def pool_size(self) -> int:
        """Connections that exist right now (idle and in use)."""
        return self._pool.size

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def close(self) -> None:
        """Close idle connections now and the others as they come back."""
        self._closed.set()
        self._pool.close()

    # ------------------------------------------------------------------
    # Transactions
    # ------------------------------------------------------------------

    @contextmanager
    def _checkout(self, *, fresh: bool = False) -> Iterator[Any]:
        """A pooled connection for one transaction, taken in arrival order (see :class:`FairGate`)."""
        started = time.monotonic()
        if not self._gate.acquire(self._acquire_timeout_s):
            raise PoolTimeout(f'Timed out after {self._acquire_timeout_s:g} s waiting for a database connection')
        try:
            left = max(0.0, self._acquire_timeout_s - (time.monotonic() - started))
            with self._pool.connection(fresh=fresh, timeout_s=left) as conn:
                yield conn
        finally:
            self._gate.release()

    def run_read(self, work: Callable[[Any], T]) -> T:
        """Run ``work(cursor)`` in one read-only transaction and return its result.

        A connection found dead (the server or pooler restarted while it was
        idle) is dropped and the call is run once more on a new connection;
        a read has no side effect to repeat.
        """
        begin = self._sql.begin_read(self.statement_timeout_ms, self.iterative_scan)
        for attempt in (0, 1):
            try:
                with self._checkout(fresh=attempt > 0) as conn:
                    try:
                        with conn.cursor() as cur:
                            cur.execute(begin)
                            result = work(cur)
                        conn.rollback()
                        return result
                    except psycopg2.Error as e:
                        if _connection_lost(conn, e):
                            self._pool.discard(conn)
                            if attempt == 0:
                                debug(f'pgvector: connection lost, retrying the read once: {self._redact(e)}')
                                continue
                        raise
            except (PoolTimeout, PoolClosed, psycopg2.Error) as e:
                raise self._map(e) from None
        raise StoreError(UNREACHABLE_TEXT)  # pragma: no cover - the loop returns or raises

    def run_write(self, work: Callable[[Any], T], *, lock: bool = True, lock_timeout_ms: Optional[int] = None) -> T:
        """Run ``work(cursor)`` in one write transaction and commit it.

        With ``lock`` the transaction first takes the table's advisory lock, so
        writes from every process are applied one at a time. A write is never
        retried: a connection lost at commit leaves its outcome unknown.
        """
        begin = self._sql.begin_write(self.statement_timeout_ms, lock_timeout_ms)
        try:
            with self._checkout() as conn:
                try:
                    with conn.cursor() as cur:
                        cur.execute(begin)
                        if lock:
                            statement, params = self._sql.lock()
                            cur.execute(statement, params)
                        result = work(cur)
                    conn.commit()
                    return result
                except BaseException as e:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    if isinstance(e, psycopg2.Error) and _connection_lost(conn, e):
                        self._pool.discard(conn)
                    raise
        except (PoolTimeout, PoolClosed, psycopg2.Error) as e:
            raise self._map(e) from None

    # ------------------------------------------------------------------
    # Connections and errors
    # ------------------------------------------------------------------

    def _connect(self) -> Any:
        try:
            conn = psycopg2.connect(
                connect_timeout=CONNECT_TIMEOUT_S, application_name=APPLICATION_NAME, **self._connect_args
            )
        except psycopg2.Error as e:
            debug(f'pgvector: connecting failed: {self._redact(e)}')
            raise StoreError(UNREACHABLE_TEXT) from None
        # READ ONLY and SET LOCAL only apply inside a transaction, which psycopg2
        # opens implicitly only while autocommit is off.
        conn.autocommit = False
        return conn

    def _map(self, e: BaseException) -> Exception:
        """The StoreError/ToolRefusal a pool or database failure is reported as."""
        if isinstance(e, StoreError):
            return e
        if isinstance(e, PoolTimeout):
            return ToolRefusal('TIMEOUT', 'Timed out waiting for a free database connection')
        if isinstance(e, PoolClosed):
            return StoreError('The store is shutting down')
        code = getattr(e, 'pgcode', None)
        text = self._redact(e)
        if code is None:
            if isinstance(e, (psycopg2.OperationalError, psycopg2.InterfaceError)):
                debug(f'pgvector: connection failure: {text}')
                return StoreError(UNREACHABLE_TEXT)
            return StoreError(text)
        if code == _UNDEFINED_TABLE:
            return CollectionMissing('The collection table does not exist')
        if code == _QUERY_CANCELED:
            return ToolRefusal(
                'TIMEOUT', f'The statement ran longer than {self.statement_timeout_ms} ms and was cancelled'
            )
        if code == _LOCK_NOT_AVAILABLE:
            return LockUnavailable('The table is locked by another session')
        if code == _UNDEFINED_OBJECT and 'vector' in text:
            return StoreError('The pgvector extension is not installed in this database')
        if code == _DATA_EXCEPTION and 'dimensions' in text:
            return ToolRefusal('DIMENSION_MISMATCH', text)
        return StoreError(text)

    def _redact(self, e: BaseException) -> str:
        """The first line of an error's message with every connection detail blanked out."""
        text = (str(e).strip().splitlines() or [''])[0]
        for secret in self._secrets:
            text = text.replace(secret, '***')
        return text


def _connection_lost(conn: Any, e: BaseException) -> bool:
    """Whether ``e`` broke the connection itself (rather than failing one statement)."""
    if isinstance(e, psycopg2.InterfaceError):
        return True
    return getattr(conn, 'closed', 0) != 0


def _secrets_of(connect_args: Mapping[str, Any]) -> Iterable[str]:
    """Every connection detail that must never appear in an error message, longest first."""
    values: Dict[str, None] = {}

    def add(value: Any) -> None:
        if value is None:
            return
        text = str(value).strip()
        if len(text) >= 3:
            values[text] = None

    for key in ('dsn', 'host', 'hostaddr', 'port', 'user', 'password', 'dbname', 'database'):
        add(connect_args.get(key))
    dsn = connect_args.get('dsn')
    if isinstance(dsn, str) and dsn:
        match = re.match(r'^[a-z][a-z0-9+.-]*://(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]*)(?::(\d+))?(?:/([^?]*))?', dsn)
        if match:
            for part in match.groups():
                add(part)
        for key, value in re.findall(r'(\w+)\s*=\s*(\S+)', dsn):
            if key in ('host', 'hostaddr', 'port', 'user', 'password', 'dbname'):
                add(value)
    return sorted(values, key=len, reverse=True)


__all__ = ['APPLICATION_NAME', 'CollectionMissing', 'FairGate', 'LockUnavailable', 'PgDatabase', 'UNREACHABLE_TEXT']
