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

from unittest.mock import MagicMock
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool
import pytest
from ai.common.database.tx_registry import TransactionRegistry, shape_execute_result, to_sqlalchemy_text


def _engine_shared():
    e = create_engine(
        'sqlite://',
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def test_commit_persists_rows():
    reg = TransactionRegistry(_engine_shared(), max_rows=1000)
    sid = reg.begin()
    reg.execute(sid, 'INSERT INTO t (v) VALUES ($1)', ['hello'])
    reg.commit(sid)
    # new session sees the committed row
    sid2 = reg.begin()
    out = reg.execute(sid2, 'SELECT v FROM t')
    reg.commit(sid2)
    assert out['rows'] == [{'v': 'hello'}]


def test_rollback_discards_rows():
    reg = TransactionRegistry(_engine_shared(), max_rows=1000)
    sid = reg.begin()
    reg.execute(sid, 'INSERT INTO t (v) VALUES ($1)', ['x'])
    reg.rollback(sid)
    sid2 = reg.begin()
    out = reg.execute(sid2, 'SELECT count(*) AS n FROM t')
    reg.commit(sid2)
    assert out['rows'][0]['n'] == 0


def test_unknown_session_raises():
    reg = TransactionRegistry(_engine_shared(), max_rows=1000)
    with pytest.raises(KeyError):
        reg.execute('nope', 'SELECT 1')


def test_max_sessions_enforced():
    reg = TransactionRegistry(_engine_shared(), max_sessions=1, max_rows=1000)
    reg.begin()
    with pytest.raises(RuntimeError):
        reg.begin()


def test_reap_idle_rolls_back():
    t = {'now': 0.0}
    reg = TransactionRegistry(
        _engine_shared(),
        idle_timeout=10,
        max_rows=1000,
        clock=lambda: t['now'],
    )
    sid = reg.begin()
    reg.execute(sid, 'INSERT INTO t (v) VALUES ($1)', ['y'])
    t['now'] = 100.0
    assert reg.reap_idle() == 1
    with pytest.raises(KeyError):
        reg.execute(sid, 'SELECT 1')


def test_reaper_skips_in_flight_session():
    """The idle reaper must not drop a session whose per-session lock is held."""
    t = {'now': 0.0}
    reg = TransactionRegistry(
        _engine_shared(),
        idle_timeout=10,
        max_rows=1000,
        clock=lambda: t['now'],
    )
    sid = reg.begin()
    held = reg._sessions[sid]
    t['now'] = 100.0  # session is now past the idle timeout
    # Simulate an in-flight execute by holding the session lock.
    held.lock.acquire()
    try:
        assert reg.reap_idle() == 0  # skipped, not blocked on
        assert sid in reg._sessions
    finally:
        held.lock.release()
    # Once free, the same idle session is reaped.
    assert reg.reap_idle() == 1
    assert sid not in reg._sessions


def test_failed_statement_still_refreshes_last_used():
    """A failed statement leaves the session in a recoverable state (the caller
    can roll back or retry), so it must not age toward the idle reaper the same
    way a session with no activity at all does.
    """
    t = {'now': 0.0}
    reg = TransactionRegistry(
        _engine_shared(),
        idle_timeout=10,
        max_rows=1000,
        clock=lambda: t['now'],
    )
    sid = reg.begin()
    t['now'] = 5.0
    with pytest.raises(Exception):
        reg.execute(sid, 'SELECT * FROM nonexistent_table')
    assert reg._sessions[sid].last_used == 5.0
    t['now'] = 12.0  # 7s since the failed statement — still under idle_timeout=10
    assert reg.reap_idle() == 0
    assert sid in reg._sessions
    reg.rollback(sid)


def test_to_sqlalchemy_text_maps_placeholders():
    clause, binds = to_sqlalchemy_text('INSERT INTO t (a,b) VALUES ($1,$2)', ['p', 7])
    assert binds == {'b1': 'p', 'b2': 7}
    assert ':b1' in str(clause) and ':b2' in str(clause)

    # Multi-digit placeholders ($1..$11) must each map to their own bind and not
    # collapse $1 into $10/$11 (greedy \\d+ handles this — regression guard).
    params = list(range(1, 12))  # 11 values -> $1..$11
    cols = ', '.join(f'c{i}' for i in range(1, 12))
    vals = ', '.join(f'${i}' for i in range(1, 12))
    clause2, binds2 = to_sqlalchemy_text(f'INSERT INTO t ({cols}) VALUES ({vals})', params)
    assert binds2 == {f'b{i}': i for i in range(1, 12)}
    rendered = str(clause2)
    for i in range(1, 12):
        assert f':b{i}' in rendered
    # $1 keeps value 1; $10/$11 are distinct binds, not swallowed.
    assert binds2['b1'] == 1 and binds2['b10'] == 10 and binds2['b11'] == 11


@pytest.mark.parametrize(
    'sql,params,expected_sql,expected_binds',
    [
        ('select $1', [5], 'select :b1', {'b1': 5}),
        (
            "update t set note = 'costs $1 per unit' where id = $1",
            [7],
            "update t set note = 'costs $1 per unit' where id = :b1",
            {'b1': 7},
        ),
        ("select 'it''s $1' , $1", [3], "select 'it''s $1' , :b1", {'b1': 3}),
        ('select $$body $1$$, $1', [2], 'select $$body $1$$, :b1', {'b1': 2}),
        ('select $tag$x $1$tag$, $1', [2], 'select $tag$x $1$tag$, :b1', {'b1': 2}),
        ('select $1 -- not $2\n', [1], 'select :b1 -- not $2\n', {'b1': 1}),
        ('select /* $2 /* $3 */ */ $1', [1], 'select /* $2 /* $3 */ */ :b1', {'b1': 1}),
        ('select "col$1", $1', [4], 'select "col$1", :b1', {'b1': 4}),
        ("select E'\\' $1' , $1", [9], "select E'\\' $1' , :b1", {'b1': 9}),
    ],
)
def test_placeholder_rewrite_skips_quoted_regions(sql, params, expected_sql, expected_binds):
    clause, binds = to_sqlalchemy_text(sql, params)
    assert str(clause) == str(text(expected_sql)) or clause.text == expected_sql
    assert binds == expected_binds


def test_placeholder_out_of_range_raises():
    with pytest.raises(ValueError, match=r'\$3'):
        to_sqlalchemy_text('select $3', [1])


def test_begin_conn_leak_on_begin_failure():
    """If conn.begin() raises, conn.close() must be called and nothing stored."""
    boom = RuntimeError('begin failed')

    fake_conn = MagicMock()
    fake_conn.begin.side_effect = boom

    fake_engine = MagicMock()
    fake_engine.connect.return_value = fake_conn

    reg = TransactionRegistry(fake_engine, max_rows=1000)

    with pytest.raises(RuntimeError, match='begin failed'):
        reg.begin()

    # connection must have been returned to the pool
    fake_conn.close.assert_called_once()
    # registry must be empty — no leak
    assert reg._sessions == {}


def test_global_creates_and_closes_registry():
    """endGlobal() calls tx_registry.close_all() before engine.dispose()."""
    from unittest.mock import MagicMock
    from ai.common.database.db_global_base import DatabaseGlobalBase

    # Minimal concrete subclass — only the two abstract methods are implemented.
    class _ConcreteDB(DatabaseGlobalBase):
        def _connection_params(self, config):
            return {}

        def _build_connection_url(self, params):
            return ''

    instance = _ConcreteDB.__new__(_ConcreteDB)

    call_order = []

    mock_registry = MagicMock()
    mock_registry.close_all.side_effect = lambda: call_order.append('close_all')

    mock_engine = MagicMock()
    mock_engine.dispose.side_effect = lambda: call_order.append('dispose')

    instance.tx_registry = mock_registry
    instance.engine = mock_engine

    instance.endGlobal()

    mock_registry.close_all.assert_called_once()
    mock_engine.dispose.assert_called_once()
    assert call_order == ['close_all', 'dispose'], f'Expected close_all before dispose, got: {call_order}'


def _engine_with_rows():
    e = _engine_shared()
    with e.begin() as c:
        c.execute(text("INSERT INTO t (id, v) VALUES (1, 'x'), (2, 'y')"))
    return e


def test_shape_execute_result_array_mode():
    engine = _engine_with_rows()
    with engine.connect() as conn:
        result = conn.execute(text('SELECT id, v FROM t ORDER BY id'))
        shaped = shape_execute_result(result, 10, row_mode='array')
    assert shaped == {'rows': [[1, 'x'], [2, 'y']], 'affected_rows': 0}


def test_shape_execute_result_default_stays_object():
    engine = _engine_with_rows()
    with engine.connect() as conn:
        result = conn.execute(text('SELECT id, v FROM t ORDER BY id'))
        shaped = shape_execute_result(result, 10)
    assert shaped == {'rows': [{'id': 1, 'v': 'x'}, {'id': 2, 'v': 'y'}], 'affected_rows': 0}


def test_registry_execute_array_mode():
    reg = TransactionRegistry(_engine_with_rows(), max_rows=100)
    sid = reg.begin()
    try:
        shaped = reg.execute(sid, 'SELECT id, v FROM t ORDER BY id', row_mode='array')
        assert shaped['rows'] == [[1, 'x'], [2, 'y']]
    finally:
        reg.rollback(sid)


class _FakeNestedTx:
    """Recording stand-in for a SQLAlchemy NestedTransaction (SAVEPOINT)."""

    def __init__(self):
        self.committed = False
        self.rolled_back = False
        self.is_active = True

    def commit(self):
        self.committed = True
        self.is_active = False

    def rollback(self):
        self.rolled_back = True
        self.is_active = False


class _FakeTrans:
    """Recording stand-in for the root SQLAlchemy transaction."""

    def __init__(self):
        self.committed = False
        self.rolled_back = False

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


class _FakeConn:
    """Recording stand-in for a SQLAlchemy Connection, tracking begin_nested()."""

    def __init__(self):
        self.begin_nested_calls = 0
        self.nested = []
        self.closed = False

    def begin(self):
        return _FakeTrans()

    def begin_nested(self):
        self.begin_nested_calls += 1
        nested = _FakeNestedTx()
        self.nested.append(nested)
        return nested

    def close(self):
        self.closed = True


class _FakeEngine:
    """Recording stand-in for a SQLAlchemy Engine; exposes the last connection."""

    def __init__(self):
        self.last_conn = None

    def connect(self):
        self.last_conn = _FakeConn()
        return self.last_conn


@pytest.fixture
def registry_and_engine():
    eng = _FakeEngine()
    reg = TransactionRegistry(eng, max_rows=1000)
    return reg, eng


def test_savepoint_statement_is_intercepted(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    out = reg.execute(sid, 'savepoint sp1')
    assert out == {'rows': [], 'affected_rows': 0}
    assert eng.last_conn.begin_nested_calls == 1  # not executed as raw SQL


def test_release_savepoint_commits_nested(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'release savepoint sp1')
    assert eng.last_conn.nested[0].committed


def test_rollback_to_savepoint_rolls_back_nested(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'ROLLBACK TO SAVEPOINT sp1;')
    assert eng.last_conn.nested[0].rolled_back


def test_rollback_to_unknown_savepoint_raises(registry_and_engine):
    reg, _ = registry_and_engine
    sid = reg.begin()
    with pytest.raises(ValueError, match='unknown savepoint'):
        reg.execute(sid, 'rollback to savepoint nope')


def test_nested_savepoints_unwind_lifo(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'savepoint sp2')
    reg.execute(sid, 'rollback to savepoint sp1')
    assert eng.last_conn.nested[1].rolled_back and eng.last_conn.nested[0].rolled_back


def test_session_rollback_resolves_open_savepoints(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.rollback(sid)  # must not raise; nested resolved before root rollback
    assert eng.last_conn.closed
    assert eng.last_conn.nested[0].rolled_back


def test_rollback_to_savepoint_keeps_target_rerollbackable(registry_and_engine):
    # Postgres keeps the target savepoint after ROLLBACK TO: a repeated
    # rollback-to must succeed against a freshly re-minted nested transaction.
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'rollback to savepoint sp1')
    reg.execute(sid, 'rollback to savepoint sp1')
    assert eng.last_conn.begin_nested_calls == 3  # original + one re-mint per rollback
    assert eng.last_conn.nested[0].rolled_back and eng.last_conn.nested[1].rolled_back


def test_rollback_to_then_release_succeeds(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'rollback to savepoint sp1')
    reg.execute(sid, 'release savepoint sp1')
    assert eng.last_conn.nested[0].rolled_back
    assert eng.last_conn.nested[1].committed  # the re-minted target releases cleanly


def test_rollback_to_destroys_descendants_but_keeps_target(registry_and_engine):
    reg, eng = registry_and_engine
    sid = reg.begin()
    reg.execute(sid, 'savepoint sp1')
    reg.execute(sid, 'savepoint sp2')
    reg.execute(sid, 'rollback to savepoint sp1')
    with pytest.raises(ValueError, match='unknown savepoint: sp2'):
        reg.execute(sid, 'rollback to savepoint sp2')
    reg.execute(sid, 'release savepoint sp1')  # target survived the rollback
