# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for persistent memory node.

Covers the CodeRabbit review follow-ups:
  - Atomic counter under concurrent writes (in-memory threading.Lock)
  - TTL inheritance for keys added after session creation
  - Explicit Redis close() on teardown (no reliance on GC)
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from unittest.mock import MagicMock, patch

from test.mocks.redis_fake import FakeRedis
from nodes.memory_persistent.memory_store import (
    InMemoryBackend,
    PersistentMemoryStore,
    RedisBackend,
)


# ---------------------------------------------------------------------------
# Atomic counter (in-memory backend)
# ---------------------------------------------------------------------------


def test_inmemory_increment_is_atomic_under_concurrent_writes():
    """The in-memory backend must use a lock that covers read+modify+write.

    Without atomicity, concurrent increments lose updates due to interleaving
    of get(n) -> set(n+1) steps. With the lock held for the whole block, the
    final counter must equal the exact number of increments performed.
    """
    backend = InMemoryBackend()
    backend.create_session('session-atomic')

    num_threads = 16
    increments_per_thread = 250

    def worker():
        for _ in range(increments_per_thread):
            backend.increment('session-atomic', 'counter')

    threads = [threading.Thread(target=worker) for _ in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    result = backend.get('session-atomic', 'counter')
    assert result['ok'] is True
    assert result['value'] == num_threads * increments_per_thread, (
        f'Expected {num_threads * increments_per_thread}, got {result["value"]} (race condition — increment is not atomic)'
    )


def test_inmemory_increment_returns_new_value_like_redis_incrby():
    """Contract: increment returns the post-increment value (like INCRBY)."""
    backend = InMemoryBackend()
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


def test_inmemory_keys_added_after_session_start_inherit_remaining_ttl():
    """A key added after session creation must expire with the session,
    not outlive it. The in-memory backend stores keys in the session's dict,
    so they are purged when _expire_if_needed sees expires_at passed.
    """
    backend = InMemoryBackend()
    # 0.5 second TTL
    backend.create_session('session-ttl', ttl_seconds=0.5)

    # Add a key well after creation (but still within TTL)
    time.sleep(0.2)
    put_result = backend.put('session-ttl', 'late_key', 'late_value')
    assert put_result['ok'] is True

    # Still within TTL window — key must be retrievable
    got = backend.get('session-ttl', 'late_key')
    assert got['ok'] is True
    assert got['value'] == 'late_value'

    # Wait past the original session TTL
    time.sleep(0.5)

    # Key must have expired with the session, not outlasted it
    got_after = backend.get('session-ttl', 'late_key')
    assert got_after['ok'] is False, (
        'Late-added key should inherit remaining session TTL and be purged when the session expires; got stragglers instead.'
    )


def test_inmemory_create_prunes_expired_session_before_duplicate_check():
    """An expired session ID can be recreated without waiting for list_sessions."""
    backend = InMemoryBackend()
    backend.create_session('reusable', ttl_seconds=1)
    backend._metadata['reusable']['expires_at'] = time.time() - 1

    result = backend.create_session('reusable')

    assert result['ok'] is True
    assert backend.resume_session('reusable')['ok'] is True


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


def test_redis_backend_close_logs_errors(caplog):
    """close() should not propagate errors, but it should log them."""
    backend = _make_redis_backend_with_fake()
    backend._client.close = MagicMock(side_effect=RuntimeError('boom'))  # type: ignore[attr-defined]
    with caplog.at_level(logging.DEBUG):
        backend.close()
    assert 'RedisBackend.close failed: boom' in caplog.text


def test_store_facade_exposes_backend_close():
    """The facade must expose close path so node teardown can release."""
    store = PersistentMemoryStore(backend='memory')
    # No-op for in-memory, but must be callable without error
    store.backend.close()


# NOTE: IGlobal lifecycle tests live in test_node.py — that file owns the
# IGlobal/IInstance surface. This module is scoped to the storage layer
# (memory_store.py), which has no rocketlib/ai dependencies.
