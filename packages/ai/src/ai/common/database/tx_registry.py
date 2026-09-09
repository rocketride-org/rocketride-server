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


# Quoted savepoint names (e.g. SAVEPOINT "Sp 1") don't match this pattern and
# fall through to execute as raw SQL, bypassing the begin_nested() recovery
# path in _handle_savepoint. Acceptable: Drizzle only ever emits simple spN
# identifiers for its savepoints.
_SAVEPOINT_STMT = re.compile(
    r'^\s*(?:(?P<sp>savepoint)|(?P<rel>release)\s+savepoint|(?P<rb>rollback)\s+to\s+savepoint)'
    r'\s+(?P<name>[A-Za-z_][\w]*)\s*;?\s*$',
    re.IGNORECASE,
)


def _rewrite_placeholders(sql: str, params: list, binds: dict) -> str:
    """Rewrite $n → :bn outside strings, identifiers, and comments."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":  # single-quoted string ('' doubling; E'...' backslash)
            is_escape_string = out and out[-1] and out[-1][-1] in 'eE'
            j = i + 1
            while j < n:
                if is_escape_string and sql[j] == '\\':
                    j += 2
                    continue
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '"':  # quoted identifier ("" doubling)
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '-' and sql[i : i + 2] == '--':
            j = sql.find('\n', i)
            j = n if j == -1 else j
            out.append(sql[i:j])
            i = j
        elif ch == '/' and sql[i : i + 2] == '/*':  # nested block comments
            depth, j = 1, i + 2
            while j < n and depth:
                if sql[j : j + 2] == '/*':
                    depth += 1
                    j += 2
                elif sql[j : j + 2] == '*/':
                    depth -= 1
                    j += 2
                else:
                    j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '$':
            m = re.match(r'\$(\d+)', sql[i:])
            if m:  # $<digits> is never a dollar-quote tag (tags cannot start with a digit)
                idx = int(m.group(1))
                if idx < 1 or idx > len(params):
                    raise ValueError(f'placeholder ${idx} out of range for {len(params)} param(s)')
                key = f'b{idx}'
                binds[key] = params[idx - 1]
                out.append(f':{key}')
                i += m.end()
                continue
            tag = re.match(r'\$([A-Za-z_][\w]*)?\$', sql[i:])
            if tag:  # dollar-quoted body — copy through to the closing tag
                delim = tag.group(0)
                end = sql.find(delim, i + len(delim))
                j = n if end == -1 else end + len(delim)
                out.append(sql[i:j])
                i = j
            else:
                out.append(ch)
                i += 1
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def to_sqlalchemy_text(sql: str, params: list | None) -> tuple[TextClause, dict]:
    """Convert Postgres-style ``$1..$n`` placeholders to SQLAlchemy binds.

    Server-side binding means we never inline/escape values into SQL — the
    client forwards parameter values and the database driver binds them.
    The rewrite is quote-aware: ``$n`` inside string literals, quoted
    identifiers, dollar-quoted bodies, and comments is left untouched, and an
    index past ``len(params)`` raises ``ValueError`` instead of corrupting.
    """
    if not params:
        return text(sql), {}
    binds: dict = {}
    return text(_rewrite_placeholders(sql, params, binds)), binds


def shape_execute_result(result, max_rows: int, row_mode: str = 'object') -> dict | None:
    """Shape a SQLAlchemy result into ``{'rows', 'affected_rows'}`` (or None).

    ``row_mode='array'`` returns each row as a positional list (column order =
    ``result.keys()``) instead of a dict — required by ORM clients (Drizzle)
    whose result mappers key columns by position, where dict rows would
    silently collapse duplicate column names in joins.
    """
    if result.returns_rows:
        rows = result.fetchmany(max_rows + 1)
        if len(rows) > max_rows:
            return None
        if row_mode == 'array':
            return {'rows': [list(row) for row in rows], 'affected_rows': 0}
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
    # Stack of (name, NestedTransaction) for open SAVEPOINTs, oldest first.
    savepoints: list = field(default_factory=list)


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

    def execute(self, session_id: str, sql: str, params: list | None = None, row_mode: str = 'object') -> dict:
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
            # last_used refreshes whether the statement succeeds or fails: a
            # failed statement leaves the session in a recoverable state (the
            # caller can roll back or retry), so it shouldn't age toward reap.
            try:
                m = _SAVEPOINT_STMT.match(sql)
                if m:
                    self._handle_savepoint(held, m)
                    return {'rows': [], 'affected_rows': 0}
                clause, binds = to_sqlalchemy_text(sql, params)
                result = held.conn.execute(clause, binds)
                shaped = shape_execute_result(result, self._max_rows, row_mode)
                if shaped is None:
                    raise RuntimeError(f'query exceeded max_rows={self._max_rows}')
                return shaped
            finally:
                held.last_used = self._clock()

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

    @staticmethod
    def _handle_savepoint(held: _Held, m: re.Match) -> None:
        """Map savepoint statements onto SQLAlchemy nested transactions.

        Raw SAVEPOINT SQL cannot recover a connection after a DBAPI error
        (SQLAlchemy raises PendingRollbackError); ``begin_nested()`` is the
        supported path. Matches Postgres semantics: RELEASE destroys the target
        and every later savepoint; ROLLBACK TO destroys later savepoints but
        KEEPS the target re-rollbackable (the rolled-back SQLAlchemy object is
        inactive, so the target is re-minted via a fresh ``begin_nested()``).
        """
        name = m.group('name').lower()
        if m.group('sp'):
            held.savepoints.append((name, held.conn.begin_nested()))
            return
        for i in range(len(held.savepoints) - 1, -1, -1):
            if held.savepoints[i][0] == name:
                is_release = bool(m.group('rel'))
                # Resolve BEFORE deleting: if a commit/rollback raises mid-unwind,
                # unresolved entries stay on the stack for _drop() to clean up.
                for j in range(len(held.savepoints) - 1, i - 1, -1):
                    sp = held.savepoints[j][1]
                    if sp.is_active:
                        sp.commit() if is_release else sp.rollback()
                    del held.savepoints[j]
                if not is_release:
                    held.savepoints.append((name, held.conn.begin_nested()))
                return
        raise ValueError(f'unknown savepoint: {name}')

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
            for _, sp in reversed(held.savepoints):
                if sp.is_active:
                    sp.commit() if commit else sp.rollback()
            held.savepoints.clear()
            held.trans.commit() if commit else held.trans.rollback()
        finally:
            held.conn.close()
        return True
