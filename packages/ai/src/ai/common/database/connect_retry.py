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

"""Bounded retry for the *connection-establishment* step of a database engine.

A pooler restart or a database failover refuses connections for a few seconds.
Without this, every statement that needs a new connection in that window fails,
and so does the pipeline step that issued it.

The retry is installed on SQLAlchemy's ``do_connect`` hook, which runs while a
DBAPI connection is being opened and never while a statement is executing. That
placement is the safety property: nothing can have been sent to the server when
an attempt is repeated, so a write is never duplicated. A statement that fails
after it was sent, a dropped connection mid-transaction, an authentication error
or a missing database are not retried, here or anywhere else in this module.

Retries are bounded twice: a maximum number of attempts, and a total time budget
after which no further attempt starts. Each attempt is itself bounded by the
driver's ``connect_timeout``, so the worst case is the budget plus one
``connect_timeout``. Waits use exponential backoff with full jitter so a fleet of
pipelines does not reconnect in lockstep.

What is and is not bounded in time (PostgreSQL through psycopg2):

* opening a connection, handshake and authentication included: ``connect_timeout``
  per attempt, and the retry budget over attempts;
* a peer that stops acknowledging TCP segments (a partition, a black-holed or
  powered-off host): ``tcp_user_timeout`` and the keepalive settings;
* the ``pool_pre_ping`` health check on a pooled connection: ``ping_timeout``, even
  when the peer keeps acknowledging segments but never answers (a frozen pooler
  process), which no TCP setting detects;
* NOT bounded here: a statement already running on a healthy connection. Its limit
  is the server's ``statement_timeout``, if one is set, and the caller's own
  patience. A statement that was sent is never retried.
"""

from __future__ import annotations

import heapq
import itertools
import os
import random
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from rocketlib import warning
from sqlalchemy import event

DEFAULT_CONNECT_TIMEOUT = 5.0
DEFAULT_CONNECT_ATTEMPTS = 3
DEFAULT_CONNECT_BUDGET = 10.0
DEFAULT_BASE_DELAY = 0.25
DEFAULT_MAX_DELAY = 2.0

# Upper bounds applied to the node config, so a typo cannot turn a bounded wait into a
# near-unbounded one.
MAX_CONNECT_TIMEOUT = 60.0
MAX_CONNECT_ATTEMPTS = 10
MAX_CONNECT_BUDGET = 60.0

# Dead-peer detection on a TCP connection that is already open (PostgreSQL only).
DEFAULT_TCP_USER_TIMEOUT = 30.0  # seconds before unacknowledged data drops the connection
DEFAULT_KEEPALIVES_IDLE = 30  # idle seconds before the first keepalive probe
DEFAULT_KEEPALIVES_INTERVAL = 10  # seconds between probes
DEFAULT_KEEPALIVES_COUNT = 3  # unanswered probes before the connection is dropped
DEFAULT_PING_TIMEOUT = 5.0  # seconds the pool_pre_ping health check may take
MAX_NETWORK_SECONDS = 600
# Backends whose driver takes a ``connect_timeout`` connect argument (psycopg2,
# PyMySQL). Others get none; a subclass can supply its own through
# ``DatabaseGlobalBase._connect_args``.
_CONNECT_TIMEOUT_BACKENDS = frozenset({'postgresql', 'mysql', 'mariadb'})

# Fragments of a driver's message that mean "the server could not be reached or
# was not ready to take a connection", matched case-insensitively. Deliberately a
# short allow-list: anything else is a configuration problem that waiting will not
# fix. Matched on the message because psycopg2 sets no SQLSTATE (``pgcode`` is
# ``None``) on a failure while connecting, whatever libpq reported.
_TRANSIENT_FRAGMENTS = (
    'connection refused',
    'could not connect to server',
    "can't connect to mysql server",
    'lost connection to mysql server',
    'connection timed out',
    'timeout expired',
    'timed out',
    'server closed the connection unexpectedly',
    'connection reset by peer',
    'no more connections allowed',  # PgBouncer at max_client_conn
    'pgbouncer cannot connect to server',  # PgBouncer cannot reach its backend
    'server login has been failing',  # PgBouncer after a failed backend login
    'server login retry',  # PgBouncer server_login_retry
    'query_wait_timeout',  # PgBouncer: no server connection became free in time
    'too many connections',  # PostgreSQL 53300 per role or per database; MySQL/MariaDB 1040
    'max_user_connections',  # MySQL/MariaDB 1203, and 1226 when the limit is set on the account
    'remaining connection slots are reserved',  # PostgreSQL 53300: only reserved slots are left
    'sorry, too many clients already',  # PostgreSQL 53300 at max_connections
    'the database system is starting up',
    'the database system is shutting down',
    'temporary failure in name resolution',
)

# Fragments that mean the configuration is wrong, so waiting cannot help. They win
# over a transient fragment in the same message: a multi-host DSN (or "localhost"
# resolving to both ::1 and 127.0.0.1) reports every address tried in one error, and
# "refused, then role does not exist" is a bad role, not an outage.
_FATAL_FRAGMENTS = (
    'password authentication failed',
    'authentication failed',
    'no pg_hba.conf entry',
    'does not exist',  # role or database
    'permission denied',
    'access denied for user',  # MySQL 1045
    'unknown database',  # MySQL 1049
    'ssl error',
)


def connect_timeout_args(backend: str, timeout: float) -> dict:
    """Return the ``connect_args`` that bound one connection attempt, or ``{}`` for a backend without one."""
    if backend in _CONNECT_TIMEOUT_BACKENDS:
        return {'connect_timeout': max(1, int(timeout))}
    return {}


def is_transient_connect_error(exc: BaseException) -> bool:
    """Return True when ``exc`` from a connection attempt looks like a passing outage.

    Only a driver connection error qualifies (the caller has already limited this
    to the DBAPI's own error classes), and then only when the message names an
    unreachable or not-yet-ready server and nothing in it names a configuration
    error (a bad role, password or database).
    """
    text = str(exc).lower()
    if any(fragment in text for fragment in _FATAL_FRAGMENTS):
        return False
    return any(fragment in text for fragment in _TRANSIENT_FRAGMENTS)


@dataclass
class ConnectRetryPolicy:
    """How many connection attempts to make and how long to keep trying.

    ``attempts`` counts the first try, so ``1`` disables the retry. ``sleep``,
    ``clock`` and ``rand`` are seams for tests.
    """

    attempts: int = DEFAULT_CONNECT_ATTEMPTS
    budget: float = DEFAULT_CONNECT_BUDGET
    base_delay: float = DEFAULT_BASE_DELAY
    max_delay: float = DEFAULT_MAX_DELAY
    sleep: Callable[[float], None] = field(default=time.sleep, repr=False)
    clock: Callable[[], float] = field(default=time.monotonic, repr=False)
    rand: Callable[[], float] = field(default=random.random, repr=False)

    def delay(self, attempt: int) -> float:
        """Full-jitter wait before attempt ``attempt + 1`` (``attempt`` starts at 1)."""
        ceiling = min(self.max_delay, self.base_delay * (2 ** (attempt - 1)))
        return ceiling * self.rand()


def _bounded_int(value: Any, default: int, ceiling: int) -> int:
    try:
        return min(ceiling, max(1, int(value)))
    except (TypeError, ValueError):
        return default


def _bounded_float(value: Any, default: float, ceiling: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return min(ceiling, parsed) if parsed > 0 else default


def timeout_from_config(raw: dict) -> float:
    """Per-attempt connect timeout in seconds from node config (``connect_timeout``), default 5, at most 60."""
    return _bounded_float(raw.get('connect_timeout'), DEFAULT_CONNECT_TIMEOUT, MAX_CONNECT_TIMEOUT)


def policy_from_config(raw: dict) -> ConnectRetryPolicy:
    """Build the retry policy from node config.

    ``connect_retries`` is the number of attempts in total (default 3, at most 10);
    ``connect_retry_budget`` is the seconds after which no further attempt starts
    (default 10, at most 60).
    """
    return ConnectRetryPolicy(
        attempts=_bounded_int(raw.get('connect_retries'), DEFAULT_CONNECT_ATTEMPTS, MAX_CONNECT_ATTEMPTS),
        budget=_bounded_float(raw.get('connect_retry_budget'), DEFAULT_CONNECT_BUDGET, MAX_CONNECT_BUDGET),
    )


def network_settings_from_config(raw: dict) -> dict:
    """Dead-peer settings for a PostgreSQL connection, from node config, each clamped to a sane range.

    Keys (all optional): ``tcp_user_timeout`` (seconds, default 30), ``keepalives_idle``
    (30), ``keepalives_interval`` (10), ``keepalives_count`` (3) and ``ping_timeout``
    (seconds the ``pool_pre_ping`` check may take, default 5).
    """
    return {
        'tcp_user_timeout': _bounded_float(raw.get('tcp_user_timeout'), DEFAULT_TCP_USER_TIMEOUT, MAX_NETWORK_SECONDS),
        'keepalives_idle': _bounded_int(raw.get('keepalives_idle'), DEFAULT_KEEPALIVES_IDLE, MAX_NETWORK_SECONDS),
        'keepalives_interval': _bounded_int(
            raw.get('keepalives_interval'), DEFAULT_KEEPALIVES_INTERVAL, MAX_NETWORK_SECONDS
        ),
        'keepalives_count': _bounded_int(raw.get('keepalives_count'), DEFAULT_KEEPALIVES_COUNT, 100),
        'ping_timeout': _bounded_float(raw.get('ping_timeout'), DEFAULT_PING_TIMEOUT, MAX_CONNECT_TIMEOUT),
    }


def postgres_network_args(settings: dict) -> dict:
    """Return the libpq keepalive and ``tcp_user_timeout`` parameters for a psycopg2 connection.

    ``tcp_user_timeout`` needs libpq 12 or newer; an older libpq rejects the option
    and the connection would fail, so it is added only when the libpq psycopg2 is
    running with, at run time, knows it. The keepalive parameters are older and always sent.
    """
    args = {
        'keepalives': 1,
        'keepalives_idle': settings['keepalives_idle'],
        'keepalives_interval': settings['keepalives_interval'],
        'keepalives_count': settings['keepalives_count'],
    }
    try:
        import psycopg2

        # The libpq this process loaded, not the one psycopg2 was built against
        # (``__libpq_version__``): they differ with a system libpq or a wheel upgrade.
        if psycopg2.extensions.libpq_version() >= 120000:
            args['tcp_user_timeout'] = int(settings['tcp_user_timeout'] * 1000)
    except ImportError:  # pragma: no cover - psycopg2 is the driver whenever this is called
        pass
    return args


def _abort_connection(dbapi_connection: Any) -> None:
    """Shut down the socket under ``dbapi_connection`` so a blocked read returns with an error.

    Best effort: used from the ping watchdog thread, which must never raise.
    Works on the file descriptor psycopg2 exposes. Where the connection has none
    (already closed: psycopg2 raises ``InterfaceError``), the descriptor is not a
    socket any more, or the platform cannot duplicate it (Windows), nothing happens
    and the ping simply is not bounded. The duplicated descriptor is always closed.
    """
    try:
        descriptor = os.dup(dbapi_connection.fileno())
    except Exception:
        return
    try:
        sock = socket.socket(fileno=descriptor)
    except Exception:
        os.close(descriptor)  # not a socket (the number was reused): the dup is still ours to close
        return
    try:
        with sock:
            sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


# The ping watchdog shuts a socket down from another thread, through a duplicate of
# its descriptor. Windows cannot duplicate a socket with ``os.dup``, so there the
# watchdog would arm a deadline on every checkout and never be able to act on it:
# it is not installed, and the ping is not bounded.
PING_WATCHDOG_SUPPORTED = os.name != 'nt'


class _DeadlineWatchdog:
    """One daemon thread that runs a callback when its deadline passes, unless disarmed first.

    Shared by every engine in the process, so a pool checkout costs a heap push and
    two lock round trips instead of a new thread (``threading.Timer`` starts one per
    call). The thread starts on the first ``arm`` and then lives as long as the
    process; it sleeps while nothing is armed.

    A disarmed entry stays in the heap until it reaches the top, where it is dropped
    without waiting for its deadline. Every ping uses the same timeout, so the oldest
    entry is the next to expire and the heap holds at most the pings armed within
    one timeout.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._cond = threading.Condition()
        self._heap: list = []  # [deadline, sequence, callback or None once disarmed]
        self._sequence = itertools.count()
        self._thread: Optional[threading.Thread] = None

    def arm(self, timeout: float, callback: Callable[[], None]) -> list:
        """Run ``callback`` on the watchdog thread after ``timeout`` seconds; return a handle for ``disarm``."""
        entry = [self._clock() + timeout, next(self._sequence), callback]
        with self._cond:
            heapq.heappush(self._heap, entry)
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name='db-ping-watchdog', daemon=True)
                self._thread.start()
            elif self._heap[0] is entry:
                self._cond.notify()  # the thread sleeps toward a later deadline
        return entry

    def disarm(self, entry: list) -> None:
        """Stop ``entry`` from firing. A callback that is already running is not stopped."""
        with self._cond:
            entry[2] = None

    def _reset_after_fork(self) -> None:
        """In a forked child: the thread did not survive the fork, so start afresh on the next ``arm``."""
        self._cond = threading.Condition()
        self._heap = []
        self._thread = None

    def _due(self) -> Optional[Callable[[], None]]:
        """Pop and return the next expired callback; wait while none is due. Caller holds the lock."""
        while True:
            while self._heap and self._heap[0][2] is None:
                heapq.heappop(self._heap)
            if not self._heap:
                self._cond.wait()
                continue
            wait = self._heap[0][0] - self._clock()
            if wait > 0:
                self._cond.wait(wait)
                continue
            return heapq.heappop(self._heap)[2]

    def _run(self) -> None:
        while True:
            with self._cond:
                callback = self._due()
            try:
                callback()  # outside the lock: an abort can take a moment
            except Exception:  # noqa: BLE001 - the watchdog thread must survive any callback
                pass


_PING_WATCHDOG = _DeadlineWatchdog()
if hasattr(os, 'register_at_fork'):
    os.register_at_fork(after_in_child=_PING_WATCHDOG._reset_after_fork)


def install_ping_watchdog(engine: Any, timeout: float, watchdog: Optional[_DeadlineWatchdog] = None) -> None:
    """Bound the ``pool_pre_ping`` health check on ``engine`` to ``timeout`` seconds.

    No TCP setting detects a pooler that keeps acknowledging segments but has
    stopped answering, and libpq has no read timeout, so the check would block
    forever. The process's watchdog thread shuts the connection's socket down when
    the ping overruns; the ping then fails as a dropped connection and SQLAlchemy
    replaces the pooled connection through the (bounded) connect path. Only the
    ping is bounded, never a statement.

    ``disarm`` does not stop a callback that has already started, so the watchdog
    and the ping agree through a lock: the callback aborts only while holding it
    and only if the ping has not finished, and the ping marks itself finished under
    the same lock before it returns. A ping that returned just before the deadline
    therefore never has its connection shut down after it was handed to the
    caller; and if the abort did happen the ping reports failure, even if
    ``real_ping`` answered, so the connection is replaced and never reused.

    PostgreSQL through psycopg2 on POSIX only: the caller checks
    ``PING_WATCHDOG_SUPPORTED`` first, since on Windows ``os.dup`` cannot duplicate
    the socket and the ping is not bounded there.
    """
    dialect = engine.dialect
    real_ping = dialect.do_ping
    watchdog = watchdog or _PING_WATCHDOG

    def bounded_ping(dbapi_connection):
        lock = threading.Lock()
        state = {'done': False, 'aborted': False}

        def abort():
            with lock:
                if state['done']:
                    return
                state['aborted'] = True
                _abort_connection(dbapi_connection)

        entry = watchdog.arm(timeout, abort)
        try:
            result = real_ping(dbapi_connection)
        finally:
            with lock:
                state['done'] = True
                aborted = state['aborted']
            watchdog.disarm(entry)
        return False if aborted else result

    dialect.do_ping = bounded_ping


def install_connect_retry(engine: Any, policy: Optional[ConnectRetryPolicy] = None) -> None:
    """Make ``engine`` retry *opening* a connection under ``policy``.

    Runs on ``do_connect``, so it also covers the reconnect that ``pool_pre_ping``
    triggers after it finds a pooled connection dead. A non-transient error, or
    the last allowed attempt, re-raises the driver's own exception unchanged.
    """
    policy = policy or ConnectRetryPolicy()

    @event.listens_for(engine, 'do_connect')
    def _connect_with_retry(dialect, conn_rec, cargs, cparams):
        driver_errors = (dialect.loaded_dbapi.Error,)
        started = policy.clock()
        attempt = 1
        while True:
            try:
                return dialect.connect(*cargs, **cparams)
            except driver_errors as exc:
                if attempt >= policy.attempts or not is_transient_connect_error(exc):
                    raise
                wait = policy.delay(attempt)
                if policy.clock() - started + wait >= policy.budget:
                    raise
                # Positional only: rocketlib's logging calls reject keyword arguments.
                warning(
                    f'Database connection attempt {attempt} of {policy.attempts} failed, retrying in {wait:.2f}s: {exc}'
                )
                policy.sleep(wait)
                attempt += 1
