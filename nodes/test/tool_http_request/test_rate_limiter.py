# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the rate limits tool_http_request counts in ``self.state``.

The limiter runs over a real binding's state door: the two-replica harness's
server (the real node-door handlers over an in-process state store), so the
counters move with the store's own atomic ``incr``. The clock the windows are
named from is a hand-driven stand-in.
"""

from __future__ import annotations

import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from rocketlib.doors import NodeState

from test.framework.replicas import Owner, ReplicaServer

# Add the node source directory to sys.path so the module imports without the
# package (whose IGlobal imports the engine's rocketlib bases)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'))

import rate_limiter  # noqa: E402
from rate_limiter import RateLimitError, RateLimits, StateRateLimiter  # noqa: E402

ALICE = Owner(orgId='org-a', userId='alice')
BOB = Owner(orgId='org-a', userId='bob')

#: The component id the pipeline gives the node; the server keys its state by it.
NODE_ID = 'http_1'


class _Clock:
    """A hand-driven stand-in for the ``time`` module the rate limiter reads."""

    def __init__(self):
        self.now = 1_000_020.0

    def time(self) -> float:
        """Return the current fake time in seconds."""
        return self.now

    def advance(self, seconds: float) -> None:
        """Move the fake time forward."""
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    """Freeze the windows' clock so a window closes only when a test advances it."""
    fake = _Clock()
    monkeypatch.setattr(rate_limiter, 'time', fake)
    return fake


@pytest.fixture
def server():
    """The server whose state store every binding of a test reaches."""
    with ReplicaServer() as replica_server:
        yield replica_server


@contextmanager
def _binding(server, owner=ALICE, engine=None):
    """One binding's state door for the node, admitted for the duration of the block (on ``engine``, else a new one)."""
    engine = engine or server.engine()
    binding = uuid.uuid4().hex
    server.admit(engine, binding, owner)
    token = server.serving(engine)
    try:
        yield NodeState(binding, NODE_ID)
    finally:
        server.done(token)
        server.end(engine, binding)


def _limiter(state, per_second=100, per_minute=1000, concurrent=10):
    """A limiter over ``state`` with the given limits."""
    return StateRateLimiter(state, RateLimits(per_second, per_minute, concurrent))


def test_requests_within_the_limits_are_admitted(server, clock):
    with _binding(server) as state:
        limiter = _limiter(state, per_second=3)
        for _ in range(3):
            limiter.acquire()
            limiter.release()


def test_the_per_second_window_refuses_until_it_closes(server, clock):
    with _binding(server) as state:
        limiter = _limiter(state, per_second=2)
        for _ in range(2):
            limiter.acquire()
            limiter.release()
        with pytest.raises(RateLimitError, match='per second'):
            limiter.acquire()
        clock.advance(1)
        limiter.acquire()
        limiter.release()


def test_the_per_minute_window_refuses_until_it_closes(server, clock):
    with _binding(server) as state:
        limiter = _limiter(state, per_minute=3)
        for _ in range(3):
            limiter.acquire()
            limiter.release()
            clock.advance(1)
        with pytest.raises(RateLimitError, match='per minute'):
            limiter.acquire()
        clock.advance(60)
        limiter.acquire()
        limiter.release()


def test_the_in_flight_count_caps_concurrent_requests(server, clock):
    with _binding(server) as state:
        limiter = _limiter(state, concurrent=1)
        limiter.acquire()
        with pytest.raises(RateLimitError, match='concurrent'):
            limiter.acquire()
        limiter.release()
        limiter.acquire()
        limiter.release()


def test_a_refused_request_gives_back_what_it_took(server, clock):
    with _binding(server) as state:
        limiter = _limiter(state, per_second=5, per_minute=1, concurrent=1)
        limiter.acquire()
        limiter.release()
        # Refused by the minute: the second window and the in-flight slot are given back
        with pytest.raises(RateLimitError, match='per minute'):
            limiter.acquire()
        assert state.get('inflight') == 0
        assert state.get(f'second:{int(clock.now)}') == 1
        clock.advance(60)
        limiter.acquire()
        limiter.release()


def test_every_binding_of_one_owner_counts_against_the_same_limits(server, clock):
    # Two bindings stand for two replicas serving one control: one count
    engine = server.engine()
    with _binding(server, engine=engine) as first, _binding(server, engine=engine) as second:
        _limiter(first, per_second=2).acquire()
        _limiter(second, per_second=2).acquire()
        with pytest.raises(RateLimitError, match='concurrent|per second'):
            _limiter(first, per_second=2, concurrent=2).acquire()


def test_another_owner_has_limits_of_its_own(server, clock):
    engine = server.engine()
    with _binding(server, ALICE, engine) as alice, _binding(server, BOB, engine) as bob:
        _limiter(alice, per_second=1).acquire()
        with pytest.raises(RateLimitError):
            _limiter(alice, per_second=1).acquire()
        _limiter(bob, per_second=1).acquire()
