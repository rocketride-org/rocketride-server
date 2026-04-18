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

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

# Load memory_store.py directly to avoid triggering
# memory_persistent/__init__.py, which imports IGlobal / rocketlib at
# package import time (rocketlib is only available inside the engine).
import importlib.util  # noqa: E402

_ms_path = NODES_SRC / 'memory_persistent' / 'memory_store.py'
_ms_spec = importlib.util.spec_from_file_location('memory_persistent_memory_store_under_test', str(_ms_path))
_memory_store = importlib.util.module_from_spec(_ms_spec)
_ms_spec.loader.exec_module(_memory_store)  # type: ignore[union-attr]
InMemoryBackend = _memory_store.InMemoryBackend
PersistentMemoryStore = _memory_store.PersistentMemoryStore
RedisBackend = _memory_store.RedisBackend


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
    assert result['value'] == num_threads * increments_per_thread, f'Expected {num_threads * increments_per_thread}, got {result["value"]} (race condition — increment is not atomic)'


def test_inmemory_increment_returns_new_value_like_redis_incrby():
    """Contract: increment returns the post-increment value (like INCRBY)."""
    backend = InMemoryBackend()
    backend.create_session('session-returns')
    result_a = backend.increment('session-returns', 'c', 5)
    assert result_a['ok'] and result_a['value'] == 5
    result_b = backend.increment('session-returns', 'c', 3)
    assert result_b['ok'] and result_b['value'] == 8


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
    assert got['ok'] and got['value'] == 'late_value'

    # Wait past the original session TTL
    time.sleep(0.5)

    # Key must have expired with the session, not outlasted it
    got_after = backend.get('session-ttl', 'late_key')
    assert got_after['ok'] is False, 'Late-added key should inherit remaining session TTL and be purged when the session expires; got stragglers instead.'


# ---------------------------------------------------------------------------
# TTL inheritance — Redis backend (via fake redis client)
# ---------------------------------------------------------------------------


class _FakeRedisClient:
    """Minimal fake Redis for verifying TTL-alignment behavior."""

    def __init__(self):
        self._kv = {}
        self._sets = {}
        self._hashes = {}
        self._lists = {}
        self._ttl_ms = {}
        self.close_called = False

    # Key lifetime tracking ------------------------------------------------
    def pexpire(self, key, ms):
        self._ttl_ms[key] = ms
        return 1

    def pttl(self, key):
        if key in self._ttl_ms:
            return self._ttl_ms[key]
        if key in self._kv or key in self._hashes or key in self._sets or key in self._lists:
            return -1
        return -2

    # Sets ----------------------------------------------------------------
    def sadd(self, key, *members):
        self._sets.setdefault(key, set()).update(members)
        return len(members)

    def sismember(self, key, member):
        return member in self._sets.get(key, set())

    def smembers(self, key):
        return set(self._sets.get(key, set()))

    def srem(self, key, *members):
        s = self._sets.get(key, set())
        removed = 0
        for m in members:
            if m in s:
                s.discard(m)
                removed += 1
        return removed

    def scard(self, key):
        return len(self._sets.get(key, set()))

    # Strings -------------------------------------------------------------
    def set(self, key, value):
        self._kv[key] = value
        return True

    def get(self, key):
        return self._kv.get(key)

    def incrby(self, key, amount):
        current = int(self._kv.get(key, 0))
        new = current + amount
        self._kv[key] = str(new)
        return new

    def delete(self, key):
        removed = 0
        for store in (self._kv, self._sets, self._hashes, self._lists, self._ttl_ms):
            if key in store:
                store.pop(key, None)
                removed = 1
        return removed

    def exists(self, key):
        return int(key in self._kv or key in self._sets or key in self._hashes or key in self._lists)

    # Hashes --------------------------------------------------------------
    def hset(self, key, mapping=None, **_kwargs):
        self._hashes.setdefault(key, {}).update(mapping or {})
        return len(mapping or {})

    def hget(self, key, field):
        return self._hashes.get(key, {}).get(field)

    # Lists ---------------------------------------------------------------
    def rpush(self, key, *values):
        self._lists.setdefault(key, []).extend(values)
        return len(self._lists[key])

    def lrange(self, key, start, stop):
        lst = self._lists.get(key, [])
        if stop == -1:
            return lst[start:]
        return lst[start : stop + 1]

    # Pipeline ------------------------------------------------------------
    def pipeline(self):
        return _FakePipeline(self)

    # Cleanup -------------------------------------------------------------
    def close(self):
        self.close_called = True


class _FakePipeline:
    def __init__(self, client):
        self._client = client
        self._ops = []

    def __getattr__(self, name):
        def _queue(*args, **kwargs):
            self._ops.append((name, args, kwargs))
            return self

        return _queue

    def execute(self):
        results = []
        for name, args, kwargs in self._ops:
            fn = getattr(self._client, name)
            results.append(fn(*args, **kwargs))
        self._ops = []
        return results


def _make_redis_backend_with_fake():
    """Construct a RedisBackend whose client is the fake above."""
    fake_redis_module = MagicMock()
    fake_redis_module.Redis.return_value = _FakeRedisClient()
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


def test_redis_incrby_aligns_ttl_and_returns_new_value():
    """INCRBY path must preserve TTL alignment and return post-increment value."""
    backend = _make_redis_backend_with_fake()
    client = backend._client  # type: ignore[attr-defined]

    backend.create_session('sess-c', ttl_seconds=10.0)
    client._ttl_ms[backend._meta_key('sess-c')] = 2000

    first = backend.increment('sess-c', 'counter', amount=1)
    assert first['ok'] and first['value'] == 1
    second = backend.increment('sess-c', 'counter', amount=4)
    assert second['ok'] and second['value'] == 5

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


def test_redis_backend_close_swallows_errors():
    """close() should not propagate errors (teardown must be idempotent)."""
    backend = _make_redis_backend_with_fake()
    backend._client.close = MagicMock(side_effect=RuntimeError('boom'))  # type: ignore[attr-defined]
    # Must not raise
    backend.close()


def test_store_facade_exposes_backend_close():
    """The facade must expose close path so node teardown can release."""
    store = PersistentMemoryStore(backend='memory')
    # No-op for in-memory, but must be callable without error
    store.backend.close()


# ---------------------------------------------------------------------------
# IGlobal teardown — try/finally guarantees resource release
# ---------------------------------------------------------------------------


def test_iglobal_endglobal_clears_state_even_if_close_raises():
    """EndGlobal must null out self.store / self.config even when
    backend.close() raises — this is the try/finally contract that
    prevents leaked references on error paths.
    """
    # Import IGlobal lazily — it depends on rocketlib and ai.common.config,
    # which are not installed in the test environment. We mock those modules
    # just enough to import IGlobal.
    fake_rocketlib = MagicMock()

    class _FakeBase:
        pass

    fake_rocketlib.IGlobalBase = _FakeBase
    fake_rocketlib.OPEN_MODE = MagicMock(CONFIG='CONFIG')
    fake_ai_common_config = MagicMock()

    fake_depends = MagicMock()
    with patch.dict(
        sys.modules,
        {
            'rocketlib': fake_rocketlib,
            'ai.common.config': fake_ai_common_config,
            'ai': MagicMock(),
            'ai.common': MagicMock(),
            'depends': fake_depends,
        },
    ):
        # Load IGlobal.py directly (bypass package __init__)
        iglobal_path = NODES_SRC / 'memory_persistent' / 'IGlobal.py'
        spec = importlib.util.spec_from_file_location('memory_persistent_iglobal_under_test', str(iglobal_path))
        iglobal_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(iglobal_mod)  # type: ignore[union-attr]
        IGlobal = iglobal_mod.IGlobal

        g = IGlobal()
        # Fake a store with a close() that raises
        mock_backend = MagicMock()
        mock_backend.close.side_effect = RuntimeError('disconnect failed')
        mock_store = MagicMock()
        mock_store.backend = mock_backend
        g.store = mock_store
        g.config = {'some': 'config'}

        try:
            g.endGlobal()
        except RuntimeError:
            # Error may propagate; that's fine. Focus: state must be cleared.
            pass

        assert g.store is None, 'endGlobal must null store in finally block'
        assert g.config is None, 'endGlobal must null config in finally block'
        mock_backend.close.assert_called_once()


# ---------------------------------------------------------------------------
# os.path.join cross-platform usage
# ---------------------------------------------------------------------------


def test_iglobal_module_uses_os_path_join_for_requirements():
    """Regression: requirements.txt path must be built with os.path.join, not
    hardcoded '/' separators, for cross-platform consistency on Windows.
    """
    iglobal_path = NODES_SRC / 'memory_persistent' / 'IGlobal.py'
    src = iglobal_path.read_text(encoding='utf-8')
    assert 'os.path.join' in src, 'IGlobal must use os.path.join for path construction'
    # Guard against regressing to hardcoded separators in the requirements path
    assert "'/requirements.txt'" not in src
    assert '"/requirements.txt"' not in src
