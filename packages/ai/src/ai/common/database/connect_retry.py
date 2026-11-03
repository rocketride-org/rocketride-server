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
"""

from __future__ import annotations

import random
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

# Backends whose driver takes a ``connect_timeout`` connect argument (psycopg2,
# PyMySQL). Others get none; a subclass can supply its own through
# ``DatabaseGlobalBase._connect_args``.
_CONNECT_TIMEOUT_BACKENDS = frozenset({'postgresql', 'mysql', 'mariadb'})

# Fragments of a driver's message that mean "the server could not be reached or
# was not ready to take a connection", matched case-insensitively. Deliberately a
# short allow-list: anything else (a bad password, an unknown database, a
# permission error) is a configuration problem that waiting will not fix.
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
    'the database system is starting up',
    'the database system is shutting down',
    'temporary failure in name resolution',
)

# PostgreSQL SQLSTATEs for "cannot accept a connection right now":
# 57P03 cannot_connect_now, 53300 too_many_connections, 57P01 admin_shutdown.
_TRANSIENT_SQLSTATES = frozenset({'57P03', '53300', '57P01'})


def connect_timeout_args(backend: str, timeout: float) -> dict:
    """Return the ``connect_args`` that bound one connection attempt, or ``{}`` for a backend without one."""
    if backend in _CONNECT_TIMEOUT_BACKENDS:
        return {'connect_timeout': max(1, int(timeout))}
    return {}


def is_transient_connect_error(exc: BaseException) -> bool:
    """Return True when ``exc`` from a connection attempt looks like a passing outage.

    Only a driver connection error qualifies (the caller has already limited this
    to the DBAPI's own error classes), and then only when the message or the
    SQLSTATE names an unreachable or not-yet-ready server.
    """
    code = getattr(exc, 'pgcode', None)
    if code in _TRANSIENT_SQLSTATES:
        return True
    text = str(exc).lower()
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


def _positive_int(value: Any, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def _positive_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def timeout_from_config(raw: dict) -> float:
    """Per-attempt connect timeout in seconds from node config (``connect_timeout``), default 5."""
    return _positive_float(raw.get('connect_timeout'), DEFAULT_CONNECT_TIMEOUT)


def policy_from_config(raw: dict) -> ConnectRetryPolicy:
    """Build the retry policy from node config: ``connect_retries`` (attempts) and ``connect_retry_budget`` (seconds)."""
    return ConnectRetryPolicy(
        attempts=_positive_int(raw.get('connect_retries'), DEFAULT_CONNECT_ATTEMPTS),
        budget=_positive_float(raw.get('connect_retry_budget'), DEFAULT_CONNECT_BUDGET),
    )


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
