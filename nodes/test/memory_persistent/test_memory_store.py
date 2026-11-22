# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for persistent memory node.

Covers the CodeRabbit review follow-ups:
  - Atomic counter under concurrent writes (in-memory threading.Lock)
  - TTL inheritance for keys added after session creation
  - Explicit Redis close() on teardown (no reliance on GC)
and the state store's ceilings: every write within seven days, and an index
of sessions that outlives every session record.
"""

from __future__ import annotations

import sys
import contextvars
import threading
import time
from unittest.mock import MagicMock, patch

from ai.constants import CONST_STATE_MAX_TTL_SECONDS
from test.mocks.redis_fake import FakeRedis
from nodes.memory_persistent.memory_store import (
    StateBackend,
    PersistentMemoryStore,
    RedisBackend,
)


# ---------------------------------------------------------------------------
# Atomic counter (in-memory backend)
# ---------------------------------------------------------------------------


def test_state_increment_is_atomic_under_concurrent_writes(state):
    """The in-memory backend must use a lock that covers read+modify+write.

    Without atomicity, concurrent increments lose updates due to interleaving
    of get(n) -> set(n+1) steps. With the lock held for the whole block, the
    final counter must equal the exact number of increments performed.
    """
    backend = StateBackend(state)
    backend.create_session('session-atomic')

    num_threads = 4
    increments_per_thread = 25

    def worker():
        for _ in range(increments_per_thread):
            backend.increment('session-atomic', 'counter')

    threads = [threading.Thread(target=contextvars.copy_context().run, args=(worker,)) for _ in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    result = backend.get('session-atomic', 'counter')
    assert result['ok'] is True
    assert result['value'] == num_threads * increments_per_thread, (
        f'Expected {num_threads * increments_per_thread}, got {result["value"]} (race condition — increment is not atomic)'
    )


def test_state_increment_returns_new_value_like_redis_incrby(state):
    """Contract: increment returns the post-increment value (like INCRBY)."""
    backend = StateBackend(state)
    backend.create_session('session-returns')
    result_a = backend.increment('session-returns', 'c', 5)
    assert result_a['ok'] is True
    assert result_a['value'] == 5
    result_b = backend.increment('session-returns', 'c', 3)
    assert result_b['ok'] is True
    assert result_b['value'] == 8


# ---------------------------------------------------------------------------
# TTL inheritance — in-memory backend
# ---------------------------------------------------------------------------


def test_state_keys_added_after_session_start_inherit_remaining_ttl(state):
    """A key added after session creation must expire with the session,
    not outlive it. The in-memory backend stores keys in the session's dict,
    so they are purged when _expire_if_needed sees expires_at passed.
    """
    now = [1000.0]
    with patch('nodes.memory_persistent.memory_store.time') as fake_time:
        fake_time.time = lambda: now[0]
        backend = StateBackend(state)
        backend.create_session('session-ttl', ttl_seconds=0.5)

        # Add a key well after creation (but still within TTL)
        now[0] += 0.2
        put_result = backend.put('session-ttl', 'late_key', 'late_value')
        assert put_result['ok'] is True

        # Still within TTL window: key must be retrievable
        got = backend.get('session-ttl', 'late_key')
        assert got['ok'] is True
        assert got['value'] == 'late_value'

        # Move past the original session TTL
        now[0] += 0.5

        # Key must have expired with the session, not outlasted it
        got_after = backend.get('session-ttl', 'late_key')
        assert got_after['ok'] is False, (
            'Late-added key should inherit remaining session TTL and be purged when the session expires; got stragglers instead.'
        )


def test_state_create_prunes_expired_session_before_duplicate_check(state):
    """An expired session ID can be recreated without waiting for list_sessions."""
    now = [time.time()]
    with patch('nodes.memory_persistent.memory_store.time') as fake_time:
        fake_time.time = lambda: now[0]
        backend = StateBackend(state)
        backend.create_session('reusable', ttl_seconds=1)
        now[0] += 2

        result = backend.create_session('reusable')

        assert result['ok'] is True
        assert backend.resume_session('reusable')['ok'] is True


# ---------------------------------------------------------------------------
# The state store's ceilings (every value within seven days; the index last)
# ---------------------------------------------------------------------------


class _RecordingState:
    """The state door, recording the time, key and ttl of every ``put``."""

    def __init__(self, state, clock):
        """Wrap ``state``; ``clock`` names the time each put is recorded at."""
        self._state = state
        self._clock = clock
        self.puts = []

    def put(self, key, value, ttl=None):
        """Record the write, then make it."""
        self.puts.append((self._clock(), key, ttl))
        self._state.put(key, value, ttl=ttl)

    def __getattr__(self, name):
        """Every other operation is the door's own."""
        return getattr(self._state, name)


def test_state_every_write_names_a_ttl_within_the_ceiling(state):
    """A session longer than the state store allows, or with none, is still written within seven days."""
    recording = _RecordingState(state, time.time)
    backend = StateBackend(recording)
    assert backend.create_session('month', ttl_seconds=30 * 24 * 3600)['ok'] is True
    assert backend.create_session('open')['ok'] is True
    assert backend.put('month', 'k', 1)['ok'] is True
    assert backend.put('open', 'k', 2)['ok'] is True
    assert backend.get('month', 'k')['value'] == 1
    ttls = [ttl for _, _, ttl in recording.puts]
    assert ttls and all(ttl is not None and 0 < ttl <= CONST_STATE_MAX_TTL_SECONDS for ttl in ttls)


def test_state_the_index_outlives_every_session_record(state):
    """A session in use for hours keeps the index alive, without rewriting it on every write."""
    now = [time.time()]
    with patch('nodes.memory_persistent.memory_store.time') as fake_time:
        fake_time.time = lambda: now[0]
        recording = _RecordingState(state, lambda: now[0])
        backend = StateBackend(recording)
        backend.create_session('open')
        for _ in range(10):
            # Half an hour between writes, five hours in all
            now[0] += 1800
            assert backend.put('open', 'k', now[0])['ok'] is True

    # No record is written to expire after the index last written before it
    index_until = 0.0
    for at, key, ttl in recording.puts:
        if key == 'sessions':
            index_until = at + ttl
        else:
            assert at + ttl <= index_until, f'the record written at {at} outlives the index'

    # The index: written at creation, then again only when a record would pass
    # it (here every hour and a half of use), not on each of the ten writes
    assert sum(1 for _, key, _ in recording.puts if key == 'sessions') == 4


# ---------------------------------------------------------------------------
# TTL inheritance — Redis backend (via fake redis client)
# ---------------------------------------------------------------------------


def _make_redis_backend_with_fake() -> RedisBackend:
    """Construct a RedisBackend whose client is a ``FakeRedis`` instance."""
    fake_redis_module = MagicMock()
    fake_redis_module.Redis.return_value = FakeRedis()
    with patch.dict(sys.modules, {'redis': fake_redis_module}):
        backend = RedisBackend(host='fake', port=0)
    return backend


def test_redis_put_after_session_start_inherits_remaining_ttl():
    """A key added after creation must have its TTL aligned to the
    session's remaining PTTL, not a fresh TTL and not unbounded.
    """
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    # Create a session with a 10 second TTL
    backend.create_session('sess', ttl_seconds=10.0)

    # Simulate time passing: decrement the meta TTL to 3 seconds (3000 ms)
    client._ttl_ms[backend._meta_key('sess')] = 3000

    # Write a new key. It should inherit ~3000 ms (the remaining TTL),
    # not 10_000 ms (a fresh TTL) and not None/unbounded.
    backend.put('sess', 'late_key', 'hello')

    data_ttl = client.pttl(backend._data_key('sess', 'late_key'))
    assert data_ttl == 3000, f'Expected late-added key TTL to inherit remaining 3000 ms, got {data_ttl}'


def test_redis_put_handles_no_ttl_gracefully():
    """If the session has no TTL (PTTL == -1), late-added keys should not
    be forcibly assigned a TTL.
    """
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    backend.create_session('sess-no-ttl')  # no ttl
    backend.put('sess-no-ttl', 'k', 'v')

    data_ttl = client.pttl(backend._data_key('sess-no-ttl', 'k'))
    # -1 means persistent (no TTL). Our fake returns -1 when no TTL is set.
    assert data_ttl == -1, f'Session without TTL should produce persistent keys, got pttl={data_ttl}'


def test_redis_put_rejects_when_session_meta_expired():
    """If PTTL returns -2 (meta key already evicted), put must fail and
    not accidentally create a zombie key.
    """
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    backend.create_session('sess-expired', ttl_seconds=10.0)
    # Manually evict the meta key to simulate Redis TTL expiry
    client.delete(backend._meta_key('sess-expired'))

    result = backend.put('sess-expired', 'k', 'v')
    assert result['ok'] is False
    assert 'expired' in result.get('error', '')


def test_redis_read_paths_reject_when_session_meta_expired():
    """Redis read paths must not return data from a logically expired session."""
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    operations = {
        'stale-get': lambda sid: backend.get(sid, 'k'),
        'stale-list': backend.list_keys,
        'stale-clear': lambda sid: backend.clear(sid, 'k'),
        'stale-history': backend.get_history,
    }
    for session_id, operation in operations.items():
        backend.create_session(session_id, ttl_seconds=10.0)
        backend.put(session_id, 'k', 'v')
        client.delete(backend._meta_key(session_id))
        result = operation(session_id)
        assert result['ok'] is False
        assert 'expired' in result.get('error', '')


def test_redis_replace_history_does_not_recreate_expired_session():
    """replace_history must not create an orphan history key after expiry."""
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    backend.create_session('sess-expired-history', ttl_seconds=10.0)
    backend.put('sess-expired-history', 'k', 'v')
    client.delete(backend._meta_key('sess-expired-history'))
    client.delete(backend._history_key('sess-expired-history'))

    backend.replace_history('sess-expired-history', [{'op': 'summary'}])

    assert client.exists(backend._history_key('sess-expired-history')) == 0


def test_redis_incrby_aligns_ttl_and_returns_new_value():
    """INCRBY path must preserve TTL alignment and return post-increment value."""
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    backend.create_session('sess-c', ttl_seconds=10.0)
    client._ttl_ms[backend._meta_key('sess-c')] = 2000

    first = backend.increment('sess-c', 'counter', amount=1)
    assert first['ok'] is True
    assert first['value'] == 1
    second = backend.increment('sess-c', 'counter', amount=4)
    assert second['ok'] is True
    assert second['value'] == 5

    data_ttl = client.pttl(backend._data_key('sess-c', 'counter'))
    assert data_ttl == 2000, f'Counter TTL must track session remaining TTL, got {data_ttl}'


# ---------------------------------------------------------------------------
# Redis cleanup — explicit close() on teardown
# ---------------------------------------------------------------------------


def test_redis_backend_close_calls_client_close():
    """Explicit close() must call underlying client.close(), not rely on GC."""
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]
    assert client.close_called is False
    backend.close()
    assert client.close_called is True, 'RedisBackend.close() must explicitly release the connection.'


def test_redis_backend_close_logs_errors():
    """close() should not propagate errors, but it should report them through rocketlib."""
    backend = _make_redis_backend_with_fake()
    backend._client.close = MagicMock(side_effect=RuntimeError('boom'))  # type: ignore[attr-defined]
    with patch('nodes.memory_persistent.memory_store.warning') as warned:
        backend.close()
    assert 'RedisBackend.close failed: boom' in warned.call_args.args[0]


def test_store_facade_exposes_backend_close(state):
    """The facade must expose close path so node teardown can release."""
    store = PersistentMemoryStore(StateBackend(state))
    # No-op for in-memory, but must be callable without error
    store.backend.close()


# NOTE: IGlobal lifecycle tests live in test_node.py — that file owns the
# IGlobal/IInstance surface. This module is scoped to the storage layer
# (memory_store.py), which has no rocketlib/ai dependencies.
