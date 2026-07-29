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
from ai.common.database.tx_registry import TransactionRegistry, to_sqlalchemy_text


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
