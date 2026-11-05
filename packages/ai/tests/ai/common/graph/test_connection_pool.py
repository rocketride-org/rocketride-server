# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the bounded, exclusive-checkout connection pool (no database)."""

from __future__ import annotations

import threading
import time

import pytest

from ai.common.graph import connection_pool as pool_mod


class FakeConn:
    _next = 0

    def __init__(self):
        FakeConn._next += 1
        self.serial = FakeConn._next
        self.closed = False
        self.resets = 0
        self.fail_reset = False

    def reset(self):
        if self.fail_reset:
            raise RuntimeError('reset failed')
        self.resets += 1


def make_pool(max_size=2, timeout=1.0, connect=None, **kwargs):
    opened = []

    def _connect():
        conn = (connect or FakeConn)()
        opened.append(conn)
        return conn

    pool = pool_mod.ConnectionPool(
        _connect,
        max_size=max_size,
        acquire_timeout_s=timeout,
        reset=lambda c: c.reset(),
        is_usable=lambda c: not c.closed,
        close=lambda c: setattr(c, 'closed', True),
        **kwargs,
    )
    return pool, opened


def warm(pool, count):
    """Check out ``count`` connections at once, then return them all to the idle list."""
    held = [pool.connection() for _ in range(count)]
    conns = [cm.__enter__() for cm in held]
    for cm in held:
        cm.__exit__(None, None, None)
    return conns


def test_checkout_is_exclusive_and_bounded():
    pool, opened = make_pool(max_size=2)
    barrier = threading.Barrier(4)
    held = []
    lock = threading.Lock()
    peak = [0]
    active = [0]

    def worker():
        barrier.wait()
        with pool.connection() as conn:
            with lock:
                assert conn not in held, 'a connection was handed to two callers at once'
                held.append(conn)
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            with lock:
                held.remove(conn)
                active[0] -= 1

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert peak[0] == 2
    assert len(opened) == 2
    assert pool.size == 2 and pool.idle == 2


def test_connections_are_reset_and_reused():
    pool, opened = make_pool(max_size=1)
    with pool.connection() as first:
        pass
    with pool.connection() as second:
        pass
    assert first is second
    assert first.resets == 2
    assert len(opened) == 1


def test_exception_in_block_still_resets_and_reuses():
    pool, opened = make_pool(max_size=1)
    with pytest.raises(ValueError):
        with pool.connection():
            raise ValueError('query failed')
    with pool.connection() as conn:
        assert conn is opened[0]
    assert opened[0].resets == 2


def test_discarded_connection_is_closed_not_reused():
    pool, opened = make_pool(max_size=1)
    with pool.connection() as conn:
        pool.discard(conn)
    assert conn.closed
    assert pool.size == 0
    with pool.connection() as fresh:
        assert fresh is not conn
    assert len(opened) == 2


def test_failed_reset_drops_connection():
    pool, opened = make_pool(max_size=1)
    with pool.connection() as conn:
        conn.fail_reset = True
    assert conn.closed and pool.size == 0


def test_dead_idle_connection_is_replaced_on_checkout():
    pool, opened = make_pool(max_size=1)
    with pool.connection() as conn:
        pass
    conn.closed = True  # server dropped it while idle
    with pool.connection() as fresh:
        assert fresh is not conn
    assert pool.size == 1


def test_acquire_times_out_when_exhausted():
    pool, _ = make_pool(max_size=1, timeout=0.1)
    with pool.connection():
        started = time.monotonic()
        with pytest.raises(pool_mod.PoolTimeout):
            with pool.connection():
                pass
        assert time.monotonic() - started >= 0.09


def test_waiter_gets_connection_when_one_is_returned():
    pool, opened = make_pool(max_size=1, timeout=2.0)
    got = []
    with pool.connection() as conn:
        t = threading.Thread(target=lambda: got.append(pool.connection().__enter__()))
        t.start()
        time.sleep(0.05)
        assert not got
    t.join(2)
    assert got == [conn]


def test_connect_failure_releases_the_slot():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OSError('connection refused')
        return FakeConn()

    pool, _ = make_pool(max_size=1, connect=flaky)
    with pytest.raises(OSError):
        with pool.connection():
            pass
    with pool.connection() as conn:
        assert isinstance(conn, FakeConn)


def test_close_closes_idle_now_and_in_use_on_return():
    pool, opened = make_pool(max_size=2)
    with pool.connection():
        pass
    idle_conn = opened[0]
    with pool.connection() as busy:
        assert busy is idle_conn
        with pool.connection() as other:
            pass
        pool.close()
        assert other.closed  # was idle at close time
        assert not busy.closed
    assert busy.closed
    with pytest.raises(pool_mod.PoolClosed):
        with pool.connection():
            pass


def test_close_wakes_waiters():
    pool, _ = make_pool(max_size=1, timeout=5.0)
    errors = []

    def waiter():
        try:
            with pool.connection():
                pass
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    with pool.connection():
        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.05)
        pool.close()
        t.join(2)
    assert errors and isinstance(errors[0], pool_mod.PoolClosed)


def test_invalid_size_rejected():
    with pytest.raises(ValueError):
        make_pool(max_size=0)


# ---------------------------------------------------------------------------
# fresh checkout (after a lost connection) and idle reaping
# ---------------------------------------------------------------------------


def test_fresh_checkout_closes_every_idle_connection_and_opens_a_new_one():
    """After a lost connection the idle ones likely died with it: never hand one out again."""
    pool, opened = make_pool(max_size=3)
    stale = warm(pool, 3)
    assert pool.idle == 3
    with pool.connection(fresh=True) as conn:
        assert conn not in stale and conn is opened[-1]
        assert all(c.closed for c in stale)
        assert pool.size == 1
    assert pool.idle == 1 and len(opened) == 4


def test_fresh_checkout_stays_within_max_size():
    pool, opened = make_pool(max_size=2)
    warm(pool, 2)
    with pool.connection() as busy:
        with pool.connection(fresh=True) as conn:
            assert conn is not busy and pool.size == 2
    assert pool.size <= 2


def test_close_idle_closes_every_idle_connection_but_not_checked_out_ones():
    """For a path that does not retry: after one lost connection, do not hand out the others."""
    pool, opened = make_pool(max_size=3)
    warm(pool, 3)
    with pool.connection() as busy:
        others = [c for c in opened if c is not busy]
        pool.close_idle()
        assert pool.idle == 0 and pool.size == 1
        assert all(c.closed for c in others) and not busy.closed
    assert pool.idle == 1
    with pool.connection() as again:
        assert again is busy


def test_close_idle_on_a_closed_pool_is_harmless():
    pool, opened = make_pool(max_size=2)
    warm(pool, 2)
    pool.close()
    pool.close_idle()
    assert pool.size == 0 and all(c.closed for c in opened)


@pytest.mark.parametrize('idle_timeout_s,interval', [(60.0, 5.0), (8.0, 4.0), (0.05, 0.025)])
def test_reaper_wakes_often_enough_to_close_soon_after_the_idle_timeout(idle_timeout_s, interval):
    """A connection idle for idle_timeout_s is closed at most min(idle_timeout_s / 2, 5 s) later."""
    pool, _ = make_pool(max_size=1, idle_timeout_s=idle_timeout_s)
    assert pool.reap_interval_s == pytest.approx(interval)
    pool.close()


def test_idle_connections_are_closed_after_the_idle_timeout():
    """An idle node gives its connections back to the pooler without any further call."""
    pool, opened = make_pool(max_size=2, idle_timeout_s=0.05)
    conns = warm(pool, 2)
    deadline = time.monotonic() + 2
    while pool.idle and time.monotonic() < deadline:
        time.sleep(0.02)
    assert pool.idle == 0 and pool.size == 0
    assert all(c.closed for c in conns)
    pool.close()


def test_expired_idle_connection_is_not_reused_on_checkout():
    pool, opened = make_pool(max_size=1, idle_timeout_s=0.05)
    with pool.connection() as first:
        pass
    time.sleep(0.1)
    with pool.connection() as second:
        assert second is not first
    assert first.closed
    pool.close()


def test_recently_used_connection_is_kept_within_the_idle_timeout():
    pool, opened = make_pool(max_size=1, idle_timeout_s=30)
    with pool.connection() as first:
        pass
    with pool.connection() as second:
        assert second is first
    pool.close()


def test_no_reaping_without_an_idle_timeout():
    pool, opened = make_pool(max_size=1)
    with pool.connection() as conn:
        pass
    time.sleep(0.05)
    assert pool.idle == 1 and not conn.closed


def test_close_stops_the_reaper():
    pool, _ = make_pool(max_size=1, idle_timeout_s=0.05)
    warm(pool, 1)
    reaper = pool._reaper
    assert reaper is not None and reaper.is_alive()
    pool.close()
    reaper.join(2)
    assert not reaper.is_alive()


def test_a_caller_can_wait_less_than_the_acquire_timeout():
    """A caller with its own deadline (schema refresh) stops waiting at it."""
    pool, _ = make_pool(max_size=1, timeout=30.0)
    with pool.connection():
        started = time.monotonic()
        with pytest.raises(pool_mod.PoolTimeout, match=r'^Timed out after 0\.2 s waiting for a database connection'):
            with pool.connection(timeout_s=0.2):
                pass
        assert 0.15 <= time.monotonic() - started < 5


def test_a_longer_caller_wait_does_not_extend_the_acquire_timeout():
    pool, _ = make_pool(max_size=1, timeout=0.1)
    with pool.connection():
        started = time.monotonic()
        with pytest.raises(pool_mod.PoolTimeout, match=r'^Timed out after 0\.1 s'):
            with pool.connection(timeout_s=60):
                pass
        assert time.monotonic() - started < 5


@pytest.mark.parametrize('timeout_s', [0, -1])
def test_no_wait_left_still_hands_out_a_free_connection(timeout_s):
    pool, opened = make_pool(max_size=1)
    with pool.connection(timeout_s=timeout_s) as conn:
        assert conn is opened[0]
        with pytest.raises(pool_mod.PoolTimeout, match=r'^Timed out after 0 s'):
            with pool.connection(timeout_s=timeout_s):
                pass
