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

"""Tests for begin/commit/rollback tool functions and session-aware execute."""

import types

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from ai.common.database.db_instance_base import DatabaseInstanceBase
from ai.common.database.tx_registry import TransactionRegistry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _engine_shared():
    """In-memory SQLite engine with a shared StaticPool connection (like test_tx_registry)."""
    e = create_engine(
        'sqlite://',
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def _make_iglobal(*, allow_execute: bool, engine=None):
    """Build a minimal IGlobal stub with a real TransactionRegistry."""
    if engine is None:
        engine = _engine_shared()
    registry = TransactionRegistry(engine, max_rows=1000)
    return types.SimpleNamespace(
        allow_execute=allow_execute,
        max_execute_rows=1000,
        engine=engine,
        tx_registry=registry,
    )


def _make_instance(iglobal):
    """Instantiate a concrete DatabaseInstanceBase subclass with the given IGlobal."""

    class _Concrete(DatabaseInstanceBase):
        def _db_display_name(self):
            return 'TestDB'

        def _db_dialect(self):
            return 'sqlite'

    inst = _Concrete.__new__(_Concrete)
    inst.IGlobal = iglobal
    return inst


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def instance_with_execute_disabled():
    iglobal = _make_iglobal(allow_execute=False)
    return _make_instance(iglobal)


@pytest.fixture
def instance_with_sqlite_registry():
    iglobal = _make_iglobal(allow_execute=True)
    return _make_instance(iglobal)


# ---------------------------------------------------------------------------
# (a) Gate enforcement: all tx tools refuse when allow_execute=False
# ---------------------------------------------------------------------------


def test_begin_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.begin({})


def test_commit_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.commit({'session_id': 'fake'})


def test_rollback_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.rollback({'session_id': 'fake'})


def test_execute_with_session_id_requires_allow_execute(instance_with_execute_disabled):
    with pytest.raises(ValueError, match='allow_execute'):
        instance_with_execute_disabled.execute({'sql': 'SELECT 1', 'session_id': 'fake'})


# ---------------------------------------------------------------------------
# (b) Full roundtrip: begin → execute(INSERT with params) → commit → stateless SELECT
# ---------------------------------------------------------------------------


def test_session_roundtrip(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['z'], 'session_id': sid})
    inst.commit({'session_id': sid})
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == [{'v': 'z'}]


def test_begin_returns_session_id(instance_with_sqlite_registry):
    result = instance_with_sqlite_registry.begin({})
    assert 'session_id' in result
    assert isinstance(result['session_id'], str)
    assert len(result['session_id']) > 0


def test_commit_returns_ok(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    result = inst.commit({'session_id': sid})
    assert result == {'ok': True}


# ---------------------------------------------------------------------------
# (c) Rollback discards uncommitted rows
# ---------------------------------------------------------------------------


def test_rollback_discards_row(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': 'INSERT INTO t (v) VALUES ($1)', 'params': ['should_vanish'], 'session_id': sid})
    result = inst.rollback({'session_id': sid})
    assert result == {'ok': True}
    # Stateless read should see no rows
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == []
    # The session is invalidated after rollback: reusing the sid must error
    # (mirrors the post-reap invalidation in test_reap_idle_rolls_back).
    with pytest.raises(ValueError):
        inst.execute({'sql': 'SELECT 1', 'session_id': sid})
    with pytest.raises(ValueError):
        inst.commit({'session_id': sid})


def test_stateless_execute_overflow_rolls_back_write(instance_with_sqlite_registry):
    """A non-session write whose RETURNING overflows max_execute_rows must roll back.

    Regression: _executeRawQuery used to log + return None inside engine.begin(),
    so the write committed even though execute() raised.
    """
    inst = instance_with_sqlite_registry
    inst.IGlobal.max_execute_rows = 0  # any RETURNING row overflows
    with pytest.raises(RuntimeError, match='max_execute_rows'):
        inst.execute({'sql': "INSERT INTO t (v) VALUES ('rollback_me') RETURNING v"})
    # The overflowing write must NOT have persisted.
    inst.IGlobal.max_execute_rows = 1000
    out = inst.execute({'sql': 'SELECT v FROM t'})
    assert out['rows'] == []


def test_session_execute_overflow_keeps_session_alive(instance_with_sqlite_registry):
    """A session-bound execute that overflows leaves the session open.

    The failed statement does not auto-destroy the session: the client owns
    recovery via an explicit rollback (or `rollback to savepoint`), so the
    connection stays pinned until the client releases it or the idle reaper
    reclaims it.
    """
    inst = instance_with_sqlite_registry
    # 0-row cap so a session RETURNING overflows.
    inst.IGlobal.tx_registry = TransactionRegistry(inst.IGlobal.engine, max_rows=0)
    sid = inst.begin({})['session_id']
    with pytest.raises(RuntimeError, match='max_rows'):
        inst.execute({'sql': "INSERT INTO t (v) VALUES ('x') RETURNING v", 'session_id': sid})
    # The session survives the failed statement: an explicit rollback succeeds.
    assert inst.rollback({'session_id': sid}) == {'ok': True}


def test_failed_statement_keeps_session_alive(instance_with_sqlite_registry):
    """A syntactically invalid statement leaves the session open for recovery."""
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    with pytest.raises(Exception):
        inst.execute({'sql': 'select broken', 'session_id': sid})
    # Session must still exist: rollback succeeds instead of ValueError.
    assert inst.rollback({'session_id': sid}) == {'ok': True}


# ---------------------------------------------------------------------------
# (d) execute with unknown session_id raises ValueError
# ---------------------------------------------------------------------------


def test_execute_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'session_id': 'no-such-session'})


def test_commit_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.commit({'session_id': 'no-such-session'})


def test_rollback_unknown_session_id_raises_value_error(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='unknown or expired transaction session'):
        instance_with_sqlite_registry.rollback({'session_id': 'no-such-session'})


# ---------------------------------------------------------------------------
# (e) row_mode='array' — positional rows for ORM clients (Drizzle)
# ---------------------------------------------------------------------------


def test_execute_tool_array_row_mode(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (1, 'x')"})
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (2, 'y')"})
    result = inst.execute({'sql': 'SELECT id, v FROM t ORDER BY id', 'row_mode': 'array'})
    assert result['rows'] == [[1, 'x'], [2, 'y']]
    assert all(isinstance(r, list) for r in result['rows'])


def test_execute_tool_session_array_row_mode(instance_with_sqlite_registry):
    inst = instance_with_sqlite_registry
    sid = inst.begin({})['session_id']
    inst.execute({'sql': "INSERT INTO t (id, v) VALUES (1, 'x')", 'session_id': sid})
    result = inst.execute({'sql': 'SELECT id, v FROM t ORDER BY id', 'session_id': sid, 'row_mode': 'array'})
    inst.rollback({'session_id': sid})
    assert result['rows'] == [[1, 'x']]


def test_execute_tool_rejects_bad_row_mode(instance_with_sqlite_registry):
    with pytest.raises(ValueError, match='row_mode'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'row_mode': 'csv'})


def test_execute_tool_rejects_falsy_row_mode(instance_with_sqlite_registry):
    # '' violates the declared enum; only an ABSENT field defaults to 'object'.
    with pytest.raises(ValueError, match='row_mode'):
        instance_with_sqlite_registry.execute({'sql': 'SELECT 1', 'row_mode': ''})


# ---------------------------------------------------------------------------
# (f) _sanitize_value JSON-encodes dicts and lists (psycopg2 json/jsonb parse)
# ---------------------------------------------------------------------------


def test_sanitize_value_json_encodes_dicts():
    """Dict values must be JSON-encoded, not Python repr'd."""
    result = DatabaseInstanceBase._sanitize_value({'a': 1})
    assert result == '{"a": 1}'


def test_sanitize_value_json_encodes_lists():
    """List values must be JSON-encoded, not Python repr'd."""
    result = DatabaseInstanceBase._sanitize_value([1, 'x'])
    assert result == '[1, "x"]'


def test_sanitize_value_json_encodes_nested_with_fallback():
    """Nested non-JSON types fall back to str via default=str."""
    import datetime

    result = DatabaseInstanceBase._sanitize_value({'t': datetime.date(2026, 1, 1)})
    assert '"2026-01-01"' in result


def test_sanitize_value_json_encodes_tuples():
    """Tuple values (psycopg2 composite types) must be JSON-encoded."""
    result = DatabaseInstanceBase._sanitize_value((1, 'x'))
    assert result == '[1, "x"]'
