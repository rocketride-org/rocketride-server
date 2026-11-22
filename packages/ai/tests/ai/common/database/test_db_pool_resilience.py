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

import os
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
    install_clickhouse_connect_retry,
    install_connect_retry,
    install_mysql_handshake_timeout,
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


def test_no_connection_starts_after_a_sleep_that_overran_the_budget():
    """A wait that returned late (a loaded host) must not be followed by one more attempt past the budget."""
    clock = _Clock()
    engine, _ = _engine(
        clock,
        attempts=5,
        budget=1.0,
        base_delay=0.25,
        max_delay=0.25,
        sleep=lambda seconds: clock.sleep(seconds + 5.0),  # the sleep itself overruns the budget
    )
    engine.script = [sqlite3.OperationalError(REFUSED)] * 10

    with pytest.raises(OperationalError):
        engine.connect()

    assert engine.connects == 1  # no second attempt after the overrunning wait


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
        'connection to server at "db", port 5432 failed: FATAL:  too many connections for database "tenant"',
        'connection to server at "db", port 5432 failed: FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute',
        "(1040, 'Too many connections')",
        '(1203, "User tenant already has more than \'max_user_connections\' active connections")',
        "(1226, \"User 'tenant' has exceeded the 'max_user_connections' resource (current value: 10)\")",
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
    assert connect_timeout_args('mysql', 7.4) == {'connect_timeout': 7, 'read_timeout': 7, 'write_timeout': 7}
    assert connect_timeout_args('mariadb', 5) == {'connect_timeout': 5, 'read_timeout': 5, 'write_timeout': 5}
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

        return psycopg2.extensions.libpq_version() >= 120000
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

    assert seen['kwargs']['connect_args'] == {'connect_timeout': 5, 'read_timeout': 5, 'write_timeout': 5}


@pytest.mark.parametrize('libpq, has_tcp_user_timeout', [(110000, False), (120000, True), (160000, True)])
def test_tcp_user_timeout_is_sent_only_to_a_libpq_that_knows_it(monkeypatch, libpq, has_tcp_user_timeout):
    """An older libpq rejects an unknown connection option, which would fail every connection."""
    import sys
    import types

    stub = types.SimpleNamespace(
        extensions=types.SimpleNamespace(libpq_version=lambda: libpq), __libpq_version__=999999
    )
    monkeypatch.setitem(sys.modules, 'psycopg2', stub)

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


@pytest.mark.skipif(
    not connect_retry_module.PING_WATCHDOG_SUPPORTED, reason='Windows cannot duplicate a socket, so no watchdog there'
)
def test_the_abort_shuts_down_the_socket_so_a_blocked_read_returns():
    """The mechanism: shutting down the descriptor frees a thread blocked reading from a silent peer."""
    import socket

    ours, theirs = socket.socketpair()  # `theirs` never writes: a peer that keeps the link open and says nothing
    received = []
    reader = threading.Thread(target=lambda: received.append(ours.recv(10)), daemon=True)
    reader.start()
    try:
        time.sleep(0.1)
        assert reader.is_alive()

        _abort_connection(types.SimpleNamespace(fileno=ours.fileno))
        reader.join(2)

        assert not reader.is_alive() and received == [b'']
    finally:
        # a failed assert must not leave a thread blocked in recv or a socket open
        for sock in (ours, theirs):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        reader.join(2)
        ours.close()
        theirs.close()


def test_the_abort_ignores_a_connection_with_no_descriptor():
    _abort_connection(types.SimpleNamespace())  # no fileno: nothing to shut down, and no error


class _Handle:
    """Stands in for the duplicated socket the ping takes before it arms the watchdog."""

    def __init__(self, connection):
        self.connection = connection
        self.closed = False

    def close(self):
        self.closed = True


def _fake_duplicates(monkeypatch):
    """Patch the duplicate/abort seams; return (handles taken, handles shut down)."""
    taken, aborted = [], []

    def duplicate(connection):
        handle = _Handle(connection)
        taken.append(handle)
        return handle

    monkeypatch.setattr(connect_retry_module, '_duplicate_socket', duplicate)
    monkeypatch.setattr(connect_retry_module, '_abort_socket', aborted.append)
    return taken, aborted


def test_a_ping_that_overruns_is_aborted_and_fails(monkeypatch):
    engine = create_engine('sqlite://')
    released = threading.Event()

    def stuck_ping(dbapi_connection):
        if not released.wait(5):
            raise AssertionError('the watchdog never aborted the ping')
        raise sqlite3.OperationalError('server closed the connection unexpectedly')

    engine.dialect.do_ping = stuck_ping
    install_ping_watchdog(engine, 0.2)
    taken, aborted = _fake_duplicates(monkeypatch)
    monkeypatch.setattr(connect_retry_module, '_abort_socket', lambda handle: (aborted.append(handle), released.set()))

    started = time.monotonic()
    with pytest.raises(sqlite3.OperationalError, match='closed the connection'):
        engine.dialect.do_ping(object())
    elapsed = time.monotonic() - started

    assert aborted == taken and len(aborted) == 1
    assert elapsed < 2


def test_a_ping_that_answers_in_time_is_left_alone(monkeypatch):
    engine = create_engine('sqlite://')
    engine.dialect.do_ping = lambda dbapi_connection: True
    install_ping_watchdog(engine, 5)
    taken, aborted = _fake_duplicates(monkeypatch)

    assert engine.dialect.do_ping(object()) is True
    time.sleep(0.1)

    assert aborted == []
    assert [handle.closed for handle in taken] == [True]  # the duplicate is closed once the ping returned


def test_the_duplicate_is_taken_before_the_ping_and_stays_open_until_it_returns(monkeypatch):
    """The abort must act on a descriptor that cannot have been closed and reused while the ping ran."""
    engine = create_engine('sqlite://')
    seen = {}

    def ping(dbapi_connection):
        seen['open_during_ping'] = [handle.closed for handle in taken]
        return True

    engine.dialect.do_ping = ping
    install_ping_watchdog(engine, 5)
    taken, _aborted = _fake_duplicates(monkeypatch)

    engine.dialect.do_ping(object())

    assert seen['open_during_ping'] == [False]
    assert taken[0].closed


def test_a_connection_with_no_duplicable_socket_is_pinged_unbounded(monkeypatch):
    engine = create_engine('sqlite://')
    engine.dialect.do_ping = lambda dbapi_connection: True
    watchdog = _ManualWatchdog()
    install_ping_watchdog(engine, 5, watchdog)

    assert engine.dialect.do_ping(types.SimpleNamespace()) is True  # no fileno: nothing to abort through
    assert watchdog.armed == []


class _ManualWatchdog:
    """Stands in for the shared watchdog: records each armed callback and lets the test choose when it runs."""

    def __init__(self):
        self.armed = []

    def arm(self, timeout, callback):
        entry = types.SimpleNamespace(timeout=timeout, function=callback, disarmed=False)
        self.armed.append(entry)
        return entry

    def disarm(self, entry):
        entry.disarmed = True  # like the real one: it cannot stop a callback that already started


def _watched_engine(monkeypatch, real_ping):
    engine = create_engine('sqlite://')
    engine.dialect.do_ping = real_ping
    watchdog = _ManualWatchdog()
    monkeypatch.setattr(connect_retry_module, '_PING_WATCHDOG', watchdog)
    _taken, aborted = _fake_duplicates(monkeypatch)
    install_ping_watchdog(engine, 5)
    return engine, aborted, watchdog


def test_a_callback_that_fires_after_the_ping_returned_does_not_shut_the_connection_down(monkeypatch):
    """The race: the callback had already started when the ping finished, so disarm() was too late."""
    engine, aborted, watchdog = _watched_engine(monkeypatch, lambda dbapi_connection: True)

    assert engine.dialect.do_ping('connection') is True
    assert watchdog.armed[0].disarmed
    watchdog.armed[0].function()  # the watchdog thread gets to run it after the ping returned

    assert aborted == []  # before the lock: the healthy connection was shut down under the caller


def test_a_ping_that_returned_true_but_was_aborted_reports_failure(monkeypatch):
    """The abort won the race: the connection is unusable, so the ping must not say it is fine."""
    holder = {}

    def ping_during_which_the_watchdog_fires(dbapi_connection):
        holder['watchdog'].armed[0].function()  # the abort lands while the ping is still running
        return True  # and the ping still answers True

    engine, aborted, watchdog = _watched_engine(monkeypatch, ping_during_which_the_watchdog_fires)
    holder['watchdog'] = watchdog

    assert engine.dialect.do_ping('connection') is False
    assert [handle.connection for handle in aborted] == ['connection']


def test_the_callback_runs_the_abort_at_most_once_per_ping(monkeypatch):
    engine, aborted, watchdog = _watched_engine(monkeypatch, lambda dbapi_connection: True)
    engine.dialect.do_ping('connection')

    callback = watchdog.armed[0].function
    callback()
    callback()

    assert aborted == []


def test_each_ping_arms_the_shared_watchdog_with_the_ping_timeout(monkeypatch):
    engine, _aborted, watchdog = _watched_engine(monkeypatch, lambda dbapi_connection: True)
    for _ in range(3):
        engine.dialect.do_ping('connection')

    assert [entry.timeout for entry in watchdog.armed] == [5, 5, 5]
    assert all(entry.disarmed for entry in watchdog.armed)


# ---------------------------------------------------------------------------
# The shared deadline thread
# ---------------------------------------------------------------------------


def test_the_watchdog_runs_every_ping_on_one_thread_not_one_per_checkout():
    """A checkout used to start a threading.Timer; now all deadlines share one thread."""
    watchdog = connect_retry_module._DeadlineWatchdog()
    started = threading.active_count()
    entries = [watchdog.arm(5, lambda: None) for _ in range(200)]
    for entry in entries:
        watchdog.disarm(entry)

    assert threading.active_count() - started <= 1
    assert watchdog._thread is not None and watchdog._thread.daemon


def test_the_watchdog_fires_an_expired_deadline_and_skips_a_disarmed_one():
    watchdog = connect_retry_module._DeadlineWatchdog()
    fired = []
    done = threading.Event()
    kept = watchdog.arm(0.1, lambda: fired.append('kept') or done.set())
    dropped = watchdog.arm(0.03, lambda: fired.append('dropped'))
    watchdog.disarm(dropped)

    assert done.wait(2)
    time.sleep(0.05)
    assert fired == ['kept']
    assert kept[2] is not None  # handed to the thread, not disarmed


def test_a_watchdog_thread_that_fails_to_start_is_retried_on_the_next_arm(monkeypatch):
    """A failed ``Thread.start`` must not leave a never-started thread recorded, or no later arm would ever start one."""
    watchdog = connect_retry_module._DeadlineWatchdog()
    real_start = threading.Thread.start
    calls = []

    def start_fails_once(self):
        calls.append(self)
        if len(calls) == 1:
            raise RuntimeError("can't start new thread")
        return real_start(self)

    monkeypatch.setattr(threading.Thread, 'start', start_fails_once)

    with pytest.raises(RuntimeError, match="can't start new thread"):
        watchdog.arm(0.05, lambda: None)
    assert watchdog._thread is None  # before: the dead thread object stayed recorded
    assert watchdog._heap == []  # and its entry stayed in the heap

    fired = threading.Event()
    watchdog.arm(0.05, fired.set)  # the next arm starts a thread, which runs the callback
    assert fired.wait(2)


@pytest.mark.skipif(
    not connect_retry_module.PING_WATCHDOG_SUPPORTED, reason='Windows cannot duplicate a socket, so no watchdog there'
)
def test_a_watchdog_that_cannot_arm_does_not_leak_the_duplicated_socket(monkeypatch):
    engine = create_engine('sqlite://')
    pinged = []
    engine.dialect.do_ping = lambda dbapi_connection: pinged.append(True) or True
    watchdog = connect_retry_module._DeadlineWatchdog()

    def cannot_arm(timeout, callback):
        raise RuntimeError("can't start new thread")

    watchdog.arm = cannot_arm
    install_ping_watchdog(engine, 5, watchdog)
    taken, _aborted = _fake_duplicates(monkeypatch)

    with pytest.raises(RuntimeError, match="can't start new thread"):
        engine.dialect.do_ping(object())

    assert len(taken) == 1 and taken[0].closed  # before: the duplicate descriptor leaked
    assert pinged == []  # the ping itself never ran unbounded


def test_an_earlier_deadline_wakes_the_watchdog_that_sleeps_toward_a_later_one():
    watchdog = connect_retry_module._DeadlineWatchdog()
    watchdog.arm(30, lambda: None)  # the thread now sleeps for 30 s
    done = threading.Event()
    started = time.monotonic()
    watchdog.arm(0.05, done.set)

    assert done.wait(2)
    assert time.monotonic() - started < 1


def test_a_failing_callback_does_not_stop_the_watchdog():
    watchdog = connect_retry_module._DeadlineWatchdog()
    done = threading.Event()

    def boom():
        raise RuntimeError('callback failed')

    watchdog.arm(0.01, boom)
    watchdog.arm(0.05, done.set)

    assert done.wait(2)


def _open_descriptors():
    return len(os.listdir('/dev/fd'))


@pytest.mark.skipif(not os.path.isdir('/dev/fd'), reason='counts descriptors through /dev/fd')
def test_the_abort_does_not_leak_a_descriptor_when_the_number_is_not_a_socket():
    """The fd number was reused by a regular file: the dup is not a socket, and is still closed."""
    import tempfile

    with tempfile.TemporaryFile() as handle:
        connection = types.SimpleNamespace(fileno=handle.fileno)
        before = _open_descriptors()
        for _ in range(50):
            _abort_connection(connection)

        assert _open_descriptors() == before


def test_the_abort_swallows_the_error_of_an_already_closed_connection():
    """psycopg2 raises InterfaceError, not OSError, from fileno() once the connection is closed."""

    class InterfaceError(Exception):
        pass

    def closed():
        raise InterfaceError('connection already closed')

    _abort_connection(types.SimpleNamespace(fileno=closed))  # must not raise out of the timer thread


@pytest.mark.parametrize('supported, expected', [(True, [5.0]), (False, [])], ids=['posix', 'windows'])
def test_begin_global_installs_the_watchdog_on_a_postgres_engine_except_on_windows(monkeypatch, supported, expected):
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
    monkeypatch.setattr(connect_retry_module, 'PING_WATCHDOG_SUPPORTED', supported)
    glb = _UrlGlobal.__new__(_UrlGlobal)
    glb.glb = types.SimpleNamespace(logicalType='rocketride_sql', connConfig={})
    glb.reflect_lock = threading.Lock()
    glb._getDatabaseSchema = lambda: {}
    glb._getTableSchema = lambda table: None
    glb.beginGlobal()

    assert installed == expected


# ---------------------------------------------------------------------------
# A connect retry does not hold the registry lock
# ---------------------------------------------------------------------------


def _registry_engine(fail=True):
    """An engine whose connect, once ``state['down']`` is set, signals ``entered`` and blocks until ``release`` is set."""
    engine = create_engine(
        'sqlite:///file:rr789reg?mode=memory&cache=shared&uri=true', poolclass=QueuePool, pool_size=5
    )
    state = {'down': False, 'connects': 0, 'entered': threading.Event(), 'release': threading.Event()}
    real_connect = engine.dialect.connect

    def connect(*args, **kwargs):
        if state['down']:
            state['connects'] += 1
            state['entered'].set()
            state['release'].wait(10)
            if fail:
                raise sqlite3.OperationalError(REFUSED)
        return real_connect(*args, **kwargs)

    engine.dialect.connect = connect
    return engine, state


def test_a_healthy_session_is_not_blocked_behind_another_callers_connect_retry():
    engine, state = _registry_engine()
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
    try:
        assert state['entered'].wait(5)  # the newcomer is inside its connect now, and stays there
        registry.execute(healthy, 'SELECT 1')
        # before: it waited out the newcomer's whole connect, which only `release` ends
        assert not state['release'].is_set()
    finally:
        state['release'].set()
        thread.join(5)

    assert newcomer_error and isinstance(newcomer_error[0], OperationalError)
    registry.rollback(healthy)


def test_a_begin_that_is_still_connecting_holds_its_slot_and_a_failed_one_gives_it_back():
    engine, state = _registry_engine()
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
    try:
        assert state['entered'].wait(5)
        with pytest.raises(RuntimeError, match='too many open DB transactions'):
            registry.begin()  # the only slot is reserved by the begin that is still connecting
    finally:
        state['release'].set()
        thread.join(5)
    assert first_error  # its connect failed ...

    state['down'] = False
    sid = registry.begin()  # ... and the slot it reserved is free again
    registry.rollback(sid)


def test_a_begin_that_finishes_connecting_after_close_all_releases_its_connection():
    """close_all never saw the connection (it was opened outside the lock), so begin must not register it."""
    engine, state = _registry_engine(fail=False)
    registry = TransactionRegistry(engine, max_rows=100)
    state['down'] = True  # the connect blocks until released, then succeeds
    outcome = []

    def begin():
        try:
            outcome.append(registry.begin())
        except Exception as exc:
            outcome.append(exc)

    thread = threading.Thread(target=begin)
    thread.start()
    try:
        assert state['entered'].wait(5)  # begin is connecting outside the lock
        registry.close_all()  # endGlobal
    finally:
        state['release'].set()
        thread.join(5)

    assert isinstance(outcome[0], RuntimeError) and 'closed' in str(outcome[0])
    assert len(registry._sessions) == 0
    assert engine.pool.checkedout() == 0


# ---------------------------------------------------------------------------
# MySQL handshake timeout and the ClickHouse transport retry
# ---------------------------------------------------------------------------


def test_the_mysql_handshake_timeouts_are_lifted_once_the_connection_is_open():
    engine = create_engine('sqlite://')
    install_mysql_handshake_timeout(engine)
    connection = types.SimpleNamespace(_read_timeout=5, _write_timeout=5)

    (listener,) = [f for f in engine.pool.dispatch.connect.listeners if f.__name__ == '_clear_handshake_deadline']
    listener(connection, None)  # the pool's connect event, run after the driver's handshake

    assert (connection._read_timeout, connection._write_timeout) == (None, None)


class _FakeClickhouseConnection:
    """The transport of one clickhouse-driver Client: ``connect`` opens the socket."""

    def __init__(self, failures):
        self.failures = failures
        self.connects = 0

    def connect(self):
        self.connects += 1
        if self.failures:
            raise self.failures.pop(0)


def _do_connect_hook(engine):
    (hook,) = engine.dialect.dispatch.do_connect.listeners
    return hook


def _clickhouse_client_factory(clock, failures, **policy):
    """Install the ClickHouse retry on an engine whose dialect hands out a fake native connection.

    Returns the dbapi connection the ``do_connect`` hook produced, the transport (driver connection) its
    client shares, and the list of statements that were actually sent.
    """
    clickhouse_errors = pytest.importorskip('clickhouse_driver.errors')
    engine = create_engine('sqlite://')
    install_clickhouse_connect_retry(engine, _policy(clock, **policy))
    transport = _FakeClickhouseConnection([clickhouse_errors.NetworkError(message) for message in failures])
    sent = []

    def execute(statement):
        transport.connect()  # like clickhouse-driver: the socket opens first, then the statement goes out
        sent.append(statement)

    client = types.SimpleNamespace(connection=transport, connections=[], execute=execute)
    engine.dialect.connect = lambda *args, **kwargs: types.SimpleNamespace(transport=client)
    dbapi = _do_connect_hook(engine)(engine.dialect, None, (), {})
    return dbapi, transport, sent


def test_clickhouse_retries_opening_the_transport_and_sends_the_statement_once():
    clock = _Clock()
    dbapi, transport, sent = _clickhouse_client_factory(clock, ['Code: 210. Connection refused (db:9000)'] * 2)

    dbapi.transport.execute('SELECT 1')

    assert transport.connects == 3  # two refused opens, then the open that worked
    assert sent == ['SELECT 1']  # the statement went out once, after the transport was open
    assert len(clock.sleeps) == 2


def test_clickhouse_does_not_retry_a_configuration_error():
    clock = _Clock()
    dbapi, transport, sent = _clickhouse_client_factory(
        clock, ['Code: 516. DB::Exception: tenant: Authentication failed']
    )
    clickhouse_errors = pytest.importorskip('clickhouse_driver.errors')

    with pytest.raises(clickhouse_errors.NetworkError):
        dbapi.transport.execute('SELECT 1')

    assert transport.connects == 1 and sent == [] and clock.sleeps == []


def test_a_driver_connection_without_a_transport_is_returned_unchanged():
    engine = create_engine('sqlite://')
    install_clickhouse_connect_retry(engine, _policy(_Clock()))
    marker = object()
    engine.dialect.connect = lambda *args, **kwargs: marker

    assert _do_connect_hook(engine)(engine.dialect, None, (), {}) is marker
