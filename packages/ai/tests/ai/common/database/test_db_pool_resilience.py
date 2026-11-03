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
import time
import types

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import QueuePool

import ai.common.database.connect_retry as connect_retry_module
import ai.common.database.db_global_base as db_global_base_module
from ai.common.database.connect_retry import (
    ConnectRetryPolicy,
    connect_timeout_args,
    install_connect_retry,
    install_ping_watchdog,
    is_transient_connect_error,
    network_settings_from_config,
    policy_from_config,
    postgres_network_args,
    timeout_from_config,
    _abort_connection,
)
from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.tx_registry import TransactionRegistry

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
        # The exact strings psycopg2 / PgBouncer produce while connecting; psycopg2 sets no
        # SQLSTATE on these, so the message is all there is to go on.
        'connection to server at "127.0.0.1", port 55432 failed: FATAL:  too many connections for role "tenant"',
        'connection to server at "pooler", port 6432 failed: FATAL:  sorry, too many clients already',
        'connection to server at "pooler", port 6432 failed: ERROR:  pgbouncer cannot connect to server',
        'connection to server at "pooler", port 6432 failed: ERROR:  server login has been failing, try again later (server_login_retry)',
        'ERROR:  server login retry',
        'ERROR:  query_wait_timeout',
    ],
)
def test_unreachable_server_messages_are_transient(message):
    assert is_transient_connect_error(sqlite3.OperationalError(message))


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'message',
    [
        # A multi-host DSN, or "localhost" resolving to ::1 and 127.0.0.1, reports every
        # address tried in one error: a refused address followed by a configuration error
        # is a configuration error.
        'connection to server at "127.0.0.1", port 1 failed: Connection refused | Is the server running on that host? | '
        'connection to server at "127.0.0.1", port 55432 failed: FATAL:  role "tenant" does not exist',
        'connection to server at "::1", port 5432 failed: Connection refused | '
        'connection to server at "127.0.0.1", port 5432 failed: FATAL:  database "gone" does not exist',
        'connection to server at "::1", port 5432 failed: Connection refused | '
        'connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "tenant"',
        'FATAL:  no pg_hba.conf entry for host "10.0.0.5", user "tenant", database "db"',
        "(1045, \"Access denied for user 'tenant'@'10.0.0.5'\")",
        '(1049, "Unknown database \'gone\'")',
    ],
)
def test_a_configuration_error_in_the_message_is_fatal_even_beside_a_refused_address(message):
    assert not is_transient_connect_error(sqlite3.OperationalError(message))


def test_config_values_are_clamped_to_a_bounded_wait():
    policy = policy_from_config({'connect_retries': 1000, 'connect_retry_budget': 86400})
    assert (policy.attempts, policy.budget) == (10, 60.0)
    assert timeout_from_config({'connect_timeout': 3600}) == 60.0
    assert policy_from_config({'connect_retries': 0}).attempts == 1

    settings = network_settings_from_config(
        {'tcp_user_timeout': 10**9, 'keepalives_count': 10**6, 'ping_timeout': 10**6}
    )
    assert settings['tcp_user_timeout'] == 600.0
    assert settings['keepalives_count'] == 100
    assert settings['ping_timeout'] == 60.0


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


def _libpq_knows_tcp_user_timeout():
    try:
        import psycopg2

        return getattr(psycopg2, '__libpq_version__', 0) >= 120000
    except ImportError:
        return False


def test_begin_global_opens_the_pool_with_pre_ping_and_the_default_connect_timeout(monkeypatch):
    glb, seen = _begin(monkeypatch, {'table': 'leases'})

    assert seen['kwargs']['pool_pre_ping'] is True
    expected = {
        'connect_timeout': 5,
        'keepalives': 1,
        'keepalives_idle': 30,
        'keepalives_interval': 10,
        'keepalives_count': 3,
    }
    if _libpq_knows_tcp_user_timeout():
        expected['tcp_user_timeout'] = 30000
    assert seen['kwargs']['connect_args'] == expected
    assert len(glb.engine.dialect.dispatch.do_connect) == 1


def test_begin_global_takes_the_connect_and_network_settings_from_the_node_config(monkeypatch):
    _, seen = _begin(
        monkeypatch,
        {
            'table': 'leases',
            'connect_timeout': 2,
            'keepalives_idle': 15,
            'keepalives_interval': 5,
            'keepalives_count': 2,
        },
    )

    args = seen['kwargs']['connect_args']
    assert (args['connect_timeout'], args['keepalives_idle'], args['keepalives_interval']) == (2, 15, 5)
    assert args['keepalives_count'] == 2


def test_the_mysql_engine_gets_a_connect_timeout_and_no_postgres_options(monkeypatch):
    _, seen = _begin(monkeypatch, {'table': 'leases'}, url='mysql+pymysql://u:p@127.0.0.1:3306/db')

    assert seen['kwargs']['connect_args'] == {'connect_timeout': 5}


@pytest.mark.parametrize('libpq, has_tcp_user_timeout', [(110000, False), (120000, True), (160000, True)])
def test_tcp_user_timeout_is_sent_only_to_a_libpq_that_knows_it(monkeypatch, libpq, has_tcp_user_timeout):
    """An older libpq rejects an unknown connection option, which would fail every connection."""
    import sys
    import types

    monkeypatch.setitem(sys.modules, 'psycopg2', types.SimpleNamespace(__libpq_version__=libpq))

    args = postgres_network_args(network_settings_from_config({'tcp_user_timeout': 12}))

    assert ('tcp_user_timeout' in args) is has_tcp_user_timeout
    assert args.get('tcp_user_timeout', 12000) == 12000
    assert args['keepalives'] == 1


def test_begin_global_passes_no_connect_timeout_to_a_driver_without_one(monkeypatch):
    _, seen = _begin(monkeypatch, {'table': 'leases'}, url='sqlite:///:memory:')

    assert seen['kwargs']['connect_args'] == {}
    assert seen['kwargs']['pool_pre_ping'] is True


def test_the_save_time_probe_is_unchanged():
    """The save-time probe in validateConfig keeps its own pre-ping and 5 s connect timeout."""
    import inspect

    source = inspect.getsource(DatabaseGlobalBase.validateConfig)
    assert "'connect_timeout': 5" in source and 'pool_pre_ping=True' in source


# ---------------------------------------------------------------------------
# The pre-ping watchdog
# ---------------------------------------------------------------------------


def test_the_abort_shuts_down_the_socket_so_a_blocked_read_returns():
    """The mechanism: shutting down the descriptor frees a thread blocked reading from a silent peer."""
    import socket

    ours, theirs = socket.socketpair()  # `theirs` never writes: a peer that keeps the link open and says nothing
    received = []
    reader = threading.Thread(target=lambda: received.append(ours.recv(10)))
    reader.start()
    time.sleep(0.1)
    assert reader.is_alive()

    _abort_connection(types.SimpleNamespace(fileno=ours.fileno))
    reader.join(2)

    assert not reader.is_alive() and received == [b'']
    ours.close()
    theirs.close()


def test_the_abort_ignores_a_connection_with_no_descriptor():
    _abort_connection(types.SimpleNamespace())  # no fileno: nothing to shut down, and no error


def test_a_ping_that_overruns_is_aborted_and_fails():
    engine = create_engine('sqlite://')
    released = threading.Event()
    aborted = []

    def stuck_ping(dbapi_connection):
        if not released.wait(5):
            raise AssertionError('the watchdog never aborted the ping')
        raise sqlite3.OperationalError('server closed the connection unexpectedly')

    engine.dialect.do_ping = stuck_ping
    install_ping_watchdog(engine, 0.2)

    def fake_abort(dbapi_connection):
        aborted.append(dbapi_connection)
        released.set()

    original = connect_retry_module._abort_connection
    connect_retry_module._abort_connection = fake_abort
    try:
        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match='closed the connection'):
            engine.dialect.do_ping(object())
        elapsed = time.monotonic() - started
    finally:
        connect_retry_module._abort_connection = original

    assert len(aborted) == 1
    assert elapsed < 2


def test_a_ping_that_answers_in_time_is_left_alone():
    engine = create_engine('sqlite://')
    engine.dialect.do_ping = lambda dbapi_connection: True
    install_ping_watchdog(engine, 5)
    aborted = []
    original = connect_retry_module._abort_connection
    connect_retry_module._abort_connection = aborted.append
    try:
        assert engine.dialect.do_ping(object()) is True
        time.sleep(0.1)
    finally:
        connect_retry_module._abort_connection = original

    assert aborted == []


def test_begin_global_installs_the_watchdog_on_a_postgres_engine(monkeypatch):
    real = create_engine

    def spy(db_url, **kwargs):
        engine = real('sqlite://')
        engine.dialect.name = 'postgresql'  # stand-in: the dialect name is what beginGlobal keys on
        return engine

    monkeypatch.setattr(db_global_base_module, 'create_engine', spy)
    monkeypatch.setattr(
        db_global_base_module, 'inspect', lambda *a, **k: types.SimpleNamespace(get_table_names=lambda: [])
    )
    monkeypatch.setattr(
        db_global_base_module, 'Config', type('C', (), {'getNodeConfig': staticmethod(lambda *a: {'table': 'leases'})})
    )
    installed = []
    monkeypatch.setattr(
        connect_retry_module, 'install_ping_watchdog', lambda engine, timeout: installed.append(timeout)
    )
    glb = _UrlGlobal.__new__(_UrlGlobal)
    glb.glb = types.SimpleNamespace(logicalType='rocketride_sql', connConfig={})
    glb.reflect_lock = threading.Lock()
    glb._getDatabaseSchema = lambda: {}
    glb._getTableSchema = lambda table: None
    glb.beginGlobal()

    assert installed == [5.0]


# ---------------------------------------------------------------------------
# A connect retry does not hold the registry lock
# ---------------------------------------------------------------------------


def _registry_engine(connect_seconds, fail=True):
    engine = create_engine(
        'sqlite:///file:rr789reg?mode=memory&cache=shared&uri=true', poolclass=QueuePool, pool_size=5
    )
    state = {'down': False, 'connects': 0}
    real_connect = engine.dialect.connect

    def connect(*args, **kwargs):
        if state['down']:
            state['connects'] += 1
            time.sleep(connect_seconds)
            if fail:
                raise sqlite3.OperationalError(REFUSED)
        return real_connect(*args, **kwargs)

    engine.dialect.connect = connect
    return engine, state


def test_a_healthy_session_is_not_blocked_behind_another_callers_connect_retry():
    engine, state = _registry_engine(0.5)
    registry = TransactionRegistry(engine, max_rows=100)
    healthy = registry.begin()
    state['down'] = True
    newcomer_error = []

    def newcomer():
        try:
            registry.begin()
        except Exception as exc:
            newcomer_error.append(exc)

    thread = threading.Thread(target=newcomer)
    thread.start()
    time.sleep(0.1)  # the newcomer is inside its slow connect now
    started = time.monotonic()
    registry.execute(healthy, 'SELECT 1')
    blocked = time.monotonic() - started
    thread.join(5)

    assert blocked < 0.1  # before: it waited out the newcomer's whole connect
    assert newcomer_error and isinstance(newcomer_error[0], OperationalError)
    registry.rollback(healthy)


def test_a_begin_that_is_still_connecting_holds_its_slot_and_a_failed_one_gives_it_back():
    engine, state = _registry_engine(0.4)
    registry = TransactionRegistry(engine, max_sessions=1, max_rows=100)
    state['down'] = True
    first_error = []

    def first():
        try:
            registry.begin()
        except Exception as exc:
            first_error.append(exc)

    thread = threading.Thread(target=first)
    thread.start()
    time.sleep(0.1)
    with pytest.raises(RuntimeError, match='too many open DB transactions'):
        registry.begin()  # the only slot is reserved by the begin that is still connecting
    thread.join(5)
    assert first_error  # its connect failed ...

    state['down'] = False
    sid = registry.begin()  # ... and the slot it reserved is free again
    registry.rollback(sid)
