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

"""A small bounded pool of exclusively checked-out database connections.

Tool calls on one node run in parallel on worker threads. A DB-API connection
is thread-safe, but every cursor on it shares ONE transaction, so two calls on
one shared connection interleave inside the same transaction: one call's
rollback undoes the other's work, and per-transaction settings (``READ ONLY``,
``SET LOCAL statement_timeout``) apply to whichever call happens to open the
transaction. The fix is ownership: each call checks out a connection that no
other call can touch until it is returned, runs its own transaction, and gives
the connection back clean.

The pool is driver-agnostic. The caller supplies:

- ``connect()`` — open a new connection;
- ``reset(conn)`` — return a used connection to a clean idle state (e.g.
  rollback) or raise if it cannot; a connection whose reset raises is closed
  and dropped;
- ``is_usable(conn)`` — cheap local check before reuse (no round trip);
- ``close(conn)`` — close quietly.

Waiting is bounded: :meth:`ConnectionPool.connection` raises
:class:`PoolTimeout` when no connection frees up within ``acquire_timeout_s``
(or the caller's shorter ``timeout_s``, e.g. what is left of a deadline).
With ``idle_timeout_s`` set, a connection left idle that long is closed (by a
small daemon thread that wakes every ``min(idle_timeout_s / 2, 5 s)``, so an
idle node gives its connections back without any further call).
``connection(fresh=True)`` closes every idle connection and opens a new one:
the checkout to use after a connection was lost, since the idle ones most
likely went down with it; :meth:`ConnectionPool.close_idle` does the same for
a caller that does not retry. After :meth:`ConnectionPool.close`, idle
connections are closed at once and in-use ones as they are returned.
"""

from __future__ import annotations

import threading
import time

from contextlib import contextmanager
from typing import Any, Callable, Iterator, List, Optional, Tuple


class PoolTimeout(TimeoutError):
    """No connection became available within the acquire timeout."""


class PoolClosed(RuntimeError):
    """The pool was closed (node shutdown); no new connections are handed out."""


# Longest sleep between two idle-reaper passes, so a connection is closed at
# most this long after its idle timeout.
MAX_REAP_INTERVAL_S = 5.0


class ConnectionPool:
    """Bounded pool; each checkout is exclusive until returned."""

    def __init__(
        self,
        connect: Callable[[], Any],
        *,
        max_size: int,
        acquire_timeout_s: float,
        reset: Callable[[Any], None],
        is_usable: Callable[[Any], bool],
        close: Callable[[Any], None],
        idle_timeout_s: Optional[float] = None,
    ) -> None:
        if max_size < 1:
            raise ValueError('max_size must be >= 1')
        if idle_timeout_s is not None and idle_timeout_s <= 0:
            raise ValueError('idle_timeout_s must be > 0 (or None for no idle timeout)')
        self._connect = connect
        self._reset = reset
        self._is_usable = is_usable
        self._close_conn = close
        self.max_size = max_size
        self.acquire_timeout_s = acquire_timeout_s
        self.idle_timeout_s = idle_timeout_s
        # (connection, time.monotonic() when it was returned); newest last.
        self._idle: List[Tuple[Any, float]] = []
        # Connections handed out or being opened right now; bounded by max_size
        # together with the idle list.
        self._checked_out = 0
        self._closed = False
        # id() of checked-out connections marked broken by discard().
        self._broken: set = set()
        self._cond = threading.Condition()
        # Idle reaper: started on the first return to the idle list, stopped by close().
        self._reaper: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------
    # Introspection (tests, diagnostics)
    # ------------------------------------------------------------------

    @property
    def size(self) -> int:
        """Connections that currently exist (idle + checked out)."""
        with self._cond:
            return len(self._idle) + self._checked_out

    @property
    def idle(self) -> int:
        with self._cond:
            return len(self._idle)

    @property
    def closed(self) -> bool:
        return self._closed

    # ------------------------------------------------------------------
    # Checkout
    # ------------------------------------------------------------------

    @contextmanager
    def connection(self, *, fresh: bool = False, timeout_s: Optional[float] = None) -> Iterator[Any]:
        """Check out a connection exclusively for the duration of the block.

        The block owns the connection's transaction. On exit — normal or by
        exception — the connection is reset (rolled back) and reused; if it was
        :meth:`discard`-ed, the reset fails, or it is no longer usable, it is
        closed and dropped instead.

        ``fresh=True`` closes every idle connection and opens a new one. Use it
        after a connection was found dead: a server or pooler restart drops all
        idle sessions at once, and the cheap local usability check cannot see
        that until a statement fails on them.

        ``timeout_s`` shortens the wait for a free connection below
        ``acquire_timeout_s`` (never lengthens it); with nothing left to wait
        it still hands out an idle connection or opens one if a slot is free.
        """
        conn = self._acquire(fresh=fresh, timeout_s=timeout_s)
        try:
            yield conn
        finally:
            self._release(conn)

    def close_idle(self) -> None:
        """Close every idle connection now; checked-out ones are untouched.

        For a caller that found its connection dead and does not retry: a
        server or pooler restart drops every idle session at once, so the
        next checkouts must open new connections rather than take another
        dead one.
        """
        with self._cond:
            idle, self._idle = self._idle, []
        for conn, _returned in idle:
            self._close_quietly(conn)

    def discard(self, conn: Any) -> None:
        """Mark a checked-out connection as broken; it is closed on release.

        Call this for connection-level failures (dropped socket, server
        restart, an interrupted protocol state), where a rollback cannot be
        trusted to leave a clean session.
        """
        with self._cond:
            self._broken.add(id(conn))

    def _acquire(self, *, fresh: bool = False, timeout_s: Optional[float] = None) -> Any:
        wait_s = self.acquire_timeout_s if timeout_s is None else max(0.0, min(self.acquire_timeout_s, timeout_s))
        deadline = time.monotonic() + wait_s
        dead: List[Any] = []
        try:
            with self._cond:
                while True:
                    if self._closed:
                        raise PoolClosed('the database connection pool is closed (the node is shutting down)')
                    dead.extend(self._expired_locked(time.monotonic()))
                    if fresh:
                        dead.extend(conn for conn, _ in self._idle)
                        self._idle = []
                    while self._idle:
                        candidate, _returned = self._idle.pop()
                        if self._is_usable(candidate):
                            self._checked_out += 1
                            return candidate
                        # Died while idle (server restart, idle timeout): drop
                        # it (closed outside the lock) and keep looking; a
                        # fresh one is opened below if needed.
                        dead.append(candidate)
                    if self._checked_out < self.max_size:
                        # Reserve the slot before the (slow) connect, outside the lock.
                        self._checked_out += 1
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise PoolTimeout(
                            f'Timed out after {round(wait_s, 3):g} s waiting for a database connection '
                            f'({self.max_size} in use)'
                        )
                    self._cond.wait(remaining)
        finally:
            for conn in dead:
                self._close_quietly(conn)
        try:
            return self._connect()
        except BaseException:
            with self._cond:
                self._checked_out -= 1
                self._cond.notify()
            raise

    def _release(self, conn: Any) -> None:
        with self._cond:
            keep = id(conn) not in self._broken
            self._broken.discard(id(conn))
        if keep:
            try:
                self._reset(conn)
            except Exception:
                keep = False
        if keep and not self._is_usable(conn):
            keep = False
        with self._cond:
            self._checked_out -= 1
            pooled = keep and not self._closed
            if pooled:
                self._idle.append((conn, time.monotonic()))
                self._start_reaper_locked()
            self._cond.notify()
        if not pooled:
            # Broken, unusable, or returned after close(): never reused.
            self._close_quietly(conn)

    # ------------------------------------------------------------------
    # Idle reaping
    # ------------------------------------------------------------------

    def _expired_locked(self, now: float) -> List[Any]:
        """Remove and return idle connections past the idle timeout (caller holds the lock)."""
        if self.idle_timeout_s is None or not self._idle:
            return []
        keep: List[Tuple[Any, float]] = []
        expired: List[Any] = []
        for conn, returned in self._idle:
            if now - returned >= self.idle_timeout_s:
                expired.append(conn)
            else:
                keep.append((conn, returned))
        self._idle = keep
        return expired

    def _start_reaper_locked(self) -> None:
        if self.idle_timeout_s is None or self._reaper is not None or self._closed:
            return
        self._reaper = threading.Thread(target=self._reap_loop, name='db-pool-idle-reaper', daemon=True)
        self._reaper.start()

    @property
    def reap_interval_s(self) -> Optional[float]:
        """Seconds between idle-reaper passes (None without an idle timeout)."""
        if self.idle_timeout_s is None:
            return None
        return max(0.01, min(float(self.idle_timeout_s) / 2, MAX_REAP_INTERVAL_S))

    def _reap_loop(self) -> None:
        interval = self.reap_interval_s
        while not self._stop.wait(interval):
            with self._cond:
                expired = self._expired_locked(time.monotonic())
            for conn in expired:
                self._close_quietly(conn)

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close idle connections now; checked-out ones close when returned."""
        with self._cond:
            self._closed = True
            idle, self._idle = self._idle, []
            self._cond.notify_all()
        self._stop.set()
        for conn, _returned in idle:
            self._close_quietly(conn)

    def _close_quietly(self, conn: Any) -> None:
        try:
            self._close_conn(conn)
        except Exception:
            pass
