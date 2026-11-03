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

"""The runtime pool survives a short outage and fails fast on a long one.

Covers ``DatabaseGlobalBase.beginGlobal``'s engine options (``pool_pre_ping`` and
the connect timeout) and ``connect_retry``: a bounded, jittered retry of the
*opening* of a connection, installed on SQLAlchemy's ``do_connect`` hook.

The property that matters most is negative: nothing is retried once a statement
has been sent, so a write is never duplicated. Connection errors are simulated
on a real SQLite engine by replacing ``dialect.connect`` (the call the hook
makes) and ``dialect.do_execute`` (the call that sends a statement).
"""

from __future__ import annotations

import sqlite3
import threading

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError

import ai.common.database.db_global_base as db_global_base_module
from ai.common.database.connect_retry import (
    ConnectRetryPolicy,
    connect_timeout_args,
    install_connect_retry,
    is_transient_connect_error,
    policy_from_config,
    timeout_from_config,
)
from ai.common.database.db_global_base import DatabaseGlobalBase

REFUSED = 'connection to server at "10.0.0.7", port 5432 failed: Connection refused'


class _Clock:
    """A fake clock: ``sleep`` advances it, so a test sees elapsed time without waiting."""

    def __init__(self):
        self.now = 0.0
        self.sleeps: list[float] = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def __call__(self):
        return self.now


def _policy(clock, **overrides):
    values = dict(
        attempts=3, budget=10.0, base_delay=0.25, max_delay=2.0, sleep=clock.sleep, clock=clock, rand=lambda: 1.0
    )
    values.update(overrides)
    return ConnectRetryPolicy(**values)


def _engine(clock=None, **policy):
    """A SQLite engine with the retry installed and ``connect`` counted."""
    engine = create_engine('sqlite://')
    clock = clock or _Clock()
    install_connect_retry(engine, _policy(clock, **policy))
    engine.connects = 0
    engine.script = []  # exceptions to raise on successive connects, then real connects
    real_connect = engine.dialect.connect

    def counted_connect(*args, **kwargs):
        engine.connects += 1
        if engine.script:
            raise engine.script.pop(0)
        return real_connect(*args, **kwargs)

    engine.dialect.connect = counted_connect
    return engine, clock


# ---------------------------------------------------------------------------
# Connection-establishment errors are retried, boundedly
# ---------------------------------------------------------------------------


def test_a_connect_that_fails_twice_then_succeeds_is_retried_to_success():
    engine, clock = _engine()
    engine.script = [sqlite3.OperationalError(REFUSED), sqlite3.OperationalError(REFUSED)]

    with engine.connect() as conn:
        assert conn.exec_driver_sql('SELECT 1').scalar() == 1

    assert engine.connects == 3
    assert len(clock.sleeps) == 2


def test_the_waits_are_jittered_exponential_and_capped():
    engine, clock = _engine(attempts=5, budget=100.0, base_delay=0.25, max_delay=1.0, rand=lambda: 1.0)
    engine.script = [sqlite3.OperationalError(REFUSED)] * 4

    with engine.connect():
        pass

    # Ceilings 0.25, 0.5, 1.0, 1.0 (capped) at full jitter.
    assert clock.sleeps == [0.25, 0.5, 1.0, 1.0]


def test_the_jitter_scales_each_wait_between_zero_and_its_ceiling():
    values = iter([0.0, 0.5])
    engine, clock = _engine(rand=lambda: next(values))
    engine.script = [sqlite3.OperationalError(REFUSED)] * 2

    with engine.connect():
        pass

    assert clock.sleeps == [0.0, 0.25]


def test_a_connect_that_always_fails_stops_after_the_attempt_limit():
    engine, clock = _engine(attempts=3)
    engine.script = [sqlite3.OperationalError(REFUSED)] * 50

    with pytest.raises(OperationalError, match='Connection refused'):
        engine.connect()

    assert engine.connects == 3
    assert len(clock.sleeps) == 2


def test_the_time_budget_stops_the_retries_before_the_attempt_limit():
    engine, clock = _engine(attempts=50, budget=1.0, base_delay=0.5, max_delay=0.5)
    engine.script = [sqlite3.OperationalError(REFUSED)] * 100

    with pytest.raises(OperationalError):
        engine.connect()

    assert engine.connects < 50
    # No wait was taken that would carry the total past the budget.
    assert clock.now < 1.0


def test_one_attempt_means_no_retry():
    engine, clock = _engine(attempts=1)
    engine.script = [sqlite3.OperationalError(REFUSED)]

    with pytest.raises(OperationalError):
        engine.connect()

    assert engine.connects == 1 and clock.sleeps == []


@pytest.mark.parametrize(
    'message',
    [
        'FATAL:  password authentication failed for user "tenant"',
        'FATAL:  database "gone" does not exist',
        'FATAL:  role "tenant" does not exist',
    ],
)
def test_a_configuration_error_is_not_retried(message):
    engine, clock = _engine()
    engine.script = [sqlite3.OperationalError(message)] * 5

    with pytest.raises(OperationalError):
        engine.connect()

    assert engine.connects == 1 and clock.sleeps == []


# ---------------------------------------------------------------------------
# Nothing is retried once a statement has been sent
# ---------------------------------------------------------------------------


def test_a_statement_that_fails_after_it_was_sent_is_not_retried():
    """A write must never run twice: the failure arrives from execute, not from connect."""
    engine, clock = _engine()
    executed = []
    real_do_execute = engine.dialect.do_execute

    def failing_do_execute(cursor, statement, parameters, context=None):
        executed.append(statement)
        raise sqlite3.OperationalError('server closed the connection unexpectedly')

    engine.dialect.do_execute = failing_do_execute

    with pytest.raises(OperationalError, match='server closed the connection unexpectedly'):
        with engine.begin() as conn:
            conn.exec_driver_sql('INSERT INTO lease VALUES (1)')

    assert executed == ['INSERT INTO lease VALUES (1)']  # sent exactly once
    assert engine.connects == 1  # no reconnect-and-resend
    assert clock.sleeps == []
    engine.dialect.do_execute = real_do_execute


def test_the_retry_lives_on_the_connect_hook_not_the_statement_path():
    engine = create_engine('sqlite://')
    install_connect_retry(engine, ConnectRetryPolicy())

    assert len(engine.dialect.dispatch.do_connect) == 1
    assert len(engine.dialect.dispatch.do_execute) == 0


# ---------------------------------------------------------------------------
# What counts as transient
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'message',
    [
        REFUSED,
        'could not connect to server: Connection refused',
        "(2003, \"Can't connect to MySQL server on 'db' ([Errno 111] Connection refused)\")",
        'connection timeout expired',
        'server closed the connection unexpectedly',
        'no more connections allowed (max_client_conn)',
        'FATAL:  the database system is starting up',
    ],
)
def test_unreachable_server_messages_are_transient(message):
    assert is_transient_connect_error(sqlite3.OperationalError(message))


def test_a_cannot_connect_now_sqlstate_is_transient():
    exc = sqlite3.OperationalError('FATAL: something the message does not name')
    exc.pgcode = '57P03'

    assert is_transient_connect_error(exc)


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------


def test_config_values_are_read_and_bad_ones_fall_back_to_the_defaults():
    policy = policy_from_config({'connect_retries': '5', 'connect_retry_budget': '20'})
    assert (policy.attempts, policy.budget) == (5, 20.0)
    assert timeout_from_config({'connect_timeout': '3'}) == 3.0

    fallback = policy_from_config({'connect_retries': 'many', 'connect_retry_budget': -1})
    assert (fallback.attempts, fallback.budget) == (3, 10.0)
    assert timeout_from_config({'connect_timeout': 'x'}) == 5.0
    assert timeout_from_config({}) == 5.0


def test_the_connect_timeout_applies_to_postgres_and_mysql_only():
    assert connect_timeout_args('postgresql', 5) == {'connect_timeout': 5}
    assert connect_timeout_args('mysql', 7.4) == {'connect_timeout': 7}
    assert connect_timeout_args('mariadb', 5) == {'connect_timeout': 5}
    assert connect_timeout_args('sqlite', 5) == {}
    assert connect_timeout_args('clickhouse', 5) == {}


# ---------------------------------------------------------------------------
# beginGlobal builds the engine with pre-ping and the timeout
# ---------------------------------------------------------------------------


class _UrlGlobal(DatabaseGlobalBase):
    url = 'postgresql+psycopg2://tenant:secret@127.0.0.1:5432/tenantdb'

    def _connection_params(self, config):
        return {'database': 'tenantdb', 'table': 'leases'}

    def _build_connection_url(self, params):
        return self.url


def _begin(monkeypatch, config, url=_UrlGlobal.url):
    """Run ``beginGlobal`` with ``create_engine`` spied, over an in-memory SQLite engine."""
    seen = {}
    real = create_engine

    def spy(db_url, **kwargs):
        seen['url'] = db_url
        seen['kwargs'] = kwargs
        return real('sqlite://')

    monkeypatch.setattr(db_global_base_module, 'create_engine', spy)
    monkeypatch.setattr(
        db_global_base_module, 'Config', type('C', (), {'getNodeConfig': staticmethod(lambda *a: dict(config))})
    )
    glb = _UrlGlobal.__new__(_UrlGlobal)
    glb.glb = type('G', (), {'logicalType': 'rocketride_sql', 'connConfig': {}})()
    glb.reflect_lock = threading.Lock()
    glb.url = url
    glb.beginGlobal()
    return glb, seen


def test_begin_global_opens_the_pool_with_pre_ping_and_the_default_connect_timeout(monkeypatch):
    glb, seen = _begin(monkeypatch, {'table': 'leases'})

    assert seen['kwargs']['pool_pre_ping'] is True
    assert seen['kwargs']['connect_args'] == {'connect_timeout': 5}
    assert len(glb.engine.dialect.dispatch.do_connect) == 1


def test_begin_global_takes_the_connect_timeout_from_the_node_config(monkeypatch):
    _, seen = _begin(monkeypatch, {'table': 'leases', 'connect_timeout': 2})

    assert seen['kwargs']['connect_args'] == {'connect_timeout': 2}


def test_begin_global_passes_no_connect_timeout_to_a_driver_without_one(monkeypatch):
    _, seen = _begin(monkeypatch, {'table': 'leases'}, url='sqlite:///:memory:')

    assert seen['kwargs']['connect_args'] == {}
    assert seen['kwargs']['pool_pre_ping'] is True


def test_the_save_time_probe_is_unchanged():
    """The save-time probe in validateConfig keeps its own pre-ping and 5 s connect timeout."""
    import inspect

    source = inspect.getsource(DatabaseGlobalBase.validateConfig)
    assert "'connect_timeout': 5" in source and 'pool_pre_ping=True' in source
