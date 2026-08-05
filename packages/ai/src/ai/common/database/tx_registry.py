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

"""Hold DB connections open across calls so multi-statement transactions work."""

import re
import time
import uuid
import threading
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.sql.elements import TextClause

_PLACEHOLDER = re.compile(r'\$(\d+)')


def to_sqlalchemy_text(sql: str, params: list | None) -> tuple[TextClause, dict]:
    """Convert Postgres-style ``$1..$n`` placeholders to SQLAlchemy binds.

    Server-side binding means we never inline/escape values into SQL — the
    client forwards parameter values and the database driver binds them.
    Caveat: a literal ``$n`` inside a string/dollar-quoted body would also be
    rewritten; Sequelize-generated SQL uses clean ``$n`` placeholders so this
    is acceptable for the dialect's traffic.
    """
    if not params:
        return text(sql), {}
    binds: dict = {}

    def _sub(m: re.Match) -> str:
        idx = int(m.group(1))
        key = f'b{idx}'
        binds[key] = params[idx - 1]
        return f':{key}'

    return text(_PLACEHOLDER.sub(_sub, sql)), binds


def shape_execute_result(result, max_rows: int) -> dict | None:
    """Shape a SQLAlchemy result into ``{'rows', 'affected_rows'}`` (or None)."""
    if result.returns_rows:
        rows = result.fetchmany(max_rows + 1)
        if len(rows) > max_rows:
            return None
        cols = result.keys()
        return {'rows': [dict(zip(cols, row)) for row in rows], 'affected_rows': 0}
    rc = result.rowcount
    return {'rows': [], 'affected_rows': rc if isinstance(rc, int) and rc >= 0 else 0}


@dataclass
class _Held:
    conn: object
    trans: object
    last_used: float
    # Serialises calls on THIS session only; other sessions run concurrently.
    lock: threading.Lock = field(default_factory=threading.Lock)


class TransactionRegistry:
    """Owns connections checked out of the pool and held across tool calls."""

    def __init__(
        self,
        engine,
        *,
        max_sessions: int = 20,
        idle_timeout: float = 300.0,
        max_rows: int,
        clock=time.monotonic,
    ) -> None:
        self._engine = engine
        self._max_sessions = max_sessions
        self._idle_timeout = idle_timeout
        self._max_rows = max_rows
        self._clock = clock
        self._sessions: dict[str, _Held] = {}
        self._registry_lock = threading.Lock()  # guards the _sessions dict only

    def begin(self) -> str:
        """Checkout a connection, open a transaction, return a new session_id."""
        self.reap_idle()
        with self._registry_lock:
            if len(self._sessions) >= self._max_sessions:
                raise RuntimeError('too many open DB transactions; try again later')
            conn = self._engine.connect()
            try:
                trans = conn.begin()
                sid = uuid.uuid4().hex
                self._sessions[sid] = _Held(conn, trans, self._clock())
            except Exception:
                conn.close()
                raise
            return sid

    def execute(self, session_id: str, sql: str, params: list | None = None) -> dict:
        """Run SQL on the held connection; refresh last_used; return shaped result.

        Note: on a max_rows RuntimeError the session remains open; the caller
        should roll back the transaction before discarding the session_id.
        """
        held = self._require(session_id)
        # Hold only THIS session's lock across the live conn.execute(): other
        # sessions on the node run concurrently, and the idle reaper (which uses
        # a non-blocking acquire) skips a session while it is in-flight.
        with held.lock:
            with self._registry_lock:
                if self._sessions.get(session_id) is not held:
                    raise KeyError(session_id)  # finalised/reaped while we waited
            clause, binds = to_sqlalchemy_text(sql, params)
            result = held.conn.execute(clause, binds)
            held.last_used = self._clock()
            shaped = shape_execute_result(result, self._max_rows)
            if shaped is None:
                raise RuntimeError(f'query exceeded max_rows={self._max_rows}')
            return shaped

    def commit(self, session_id: str) -> None:
        """Commit the transaction and release the connection."""
        self._finalize(session_id, commit=True)

    def rollback(self, session_id: str) -> None:
        """Rollback the transaction and release the connection."""
        self._finalize(session_id, commit=False)

    def reap_idle(self) -> int:
        """Rollback+close sessions idle past idle_timeout; return count reaped.

        Sessions that are in-flight (their per-session lock is currently held by
        an execute/commit/rollback) are skipped, not blocked on.
        """
        now = self._clock()
        with self._registry_lock:
            candidates = [(sid, h) for sid, h in self._sessions.items() if now - h.last_used > self._idle_timeout]
        reaped = 0
        for sid, held in candidates:
            if not held.lock.acquire(blocking=False):
                continue  # in-flight; leave it for a later sweep
            try:
                if self._drop(sid, held, commit=False):
                    reaped += 1
            finally:
                held.lock.release()
        return reaped

    def close_all(self) -> None:
        """Rollback+close every session (for endGlobal)."""
        with self._registry_lock:
            items = list(self._sessions.items())
        for sid, held in items:
            with held.lock:
                self._drop(sid, held, commit=False)

    def _require(self, session_id: str) -> _Held:
        with self._registry_lock:
            held = self._sessions.get(session_id)
            if held is None:
                raise KeyError(session_id)
            return held

    def _finalize(self, session_id: str, *, commit: bool) -> None:
        held = self._require(session_id)
        with held.lock:
            if not self._drop(session_id, held, commit=commit):
                raise KeyError(session_id)

    def _drop(self, session_id: str, held: _Held, *, commit: bool) -> bool:
        """Remove the session from the registry and finalise its transaction.

        Caller MUST hold ``held.lock``. Returns False if the session was already
        removed by a concurrent finalise/reap.
        """
        with self._registry_lock:
            if self._sessions.get(session_id) is not held:
                return False
            del self._sessions[session_id]
        try:
            held.trans.commit() if commit else held.trans.rollback()
        finally:
            held.conn.close()
        return True
