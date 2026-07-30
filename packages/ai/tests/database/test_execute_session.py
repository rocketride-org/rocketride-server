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


def test_session_execute_overflow_releases_session(instance_with_sqlite_registry):
    """A session-bound execute that overflows rolls back and releases the session.

    Otherwise the held connection stays pinned until idle-reaping and the aborted
    statement remains committable.
    """
    inst = instance_with_sqlite_registry
    # 0-row cap so a session RETURNING overflows.
    inst.IGlobal.tx_registry = TransactionRegistry(inst.IGlobal.engine, max_rows=0)
    sid = inst.begin({})['session_id']
    with pytest.raises(RuntimeError, match='max_rows'):
        inst.execute({'sql': "INSERT INTO t (v) VALUES ('x') RETURNING v", 'session_id': sid})
    # The session was rolled back and released: reusing it now errors.
    with pytest.raises(ValueError, match='unknown or expired'):
        inst.commit({'session_id': sid})


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
