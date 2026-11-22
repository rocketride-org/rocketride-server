# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the persistent memory pipeline node.

Covers session CRUD, memory operations, session isolation, backend dispatch,
auto-summarization, history retrieval, TTL enforcement, thread safety,
deep copy mutation prevention, and IGlobal/IInstance lifecycle.
"""

from __future__ import annotations

import contextlib
import math
import sys
import contextvars
import threading
import time
import types
from unittest.mock import MagicMock, patch

import pytest

from nodes.memory_persistent.IGlobal import IGlobal
from nodes.memory_persistent.IInstance import IInstance
from nodes.memory_persistent.memory_store import (
    MAX_STATE_SESSIONS,
    StateBackend,
    PersistentMemoryStore,
    RedisBackend,
    _session_key,
    _validate_key,
    _validate_session_id,
)

from test.mocks.redis_fake import FakeRedis

from ..framework.controls import control_config


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def backend(state) -> StateBackend:
    """Fresh in-memory backend for each test."""
    return StateBackend(state)


@pytest.fixture
def store(state) -> PersistentMemoryStore:
    """Fresh PersistentMemoryStore with in-memory backend."""
    return PersistentMemoryStore(StateBackend(state), max_history=10, auto_summarize=True)


# =============================================================================
# 1. Validation Tests
# =============================================================================


class TestValidation:
    """Tests for session_id and key validation."""

    def test_valid_session_id(self):
        _validate_session_id('my-session_123')

    def test_session_id_rejects_empty(self):
        with pytest.raises(ValueError, match='Invalid session_id'):
            _validate_session_id('')

    def test_session_id_rejects_path_traversal(self):
        with pytest.raises(ValueError, match='Invalid session_id'):
            _validate_session_id('../etc/passwd')

    def test_session_id_rejects_colons(self):
        with pytest.raises(ValueError, match='Invalid session_id'):
            _validate_session_id('session:inject')

    def test_session_id_rejects_spaces(self):
        with pytest.raises(ValueError, match='Invalid session_id'):
            _validate_session_id('has space')

    def test_session_id_rejects_too_long(self):
        with pytest.raises(ValueError, match='Invalid session_id'):
            _validate_session_id('a' * 129)

    def test_session_id_max_length_ok(self):
        _validate_session_id('a' * 128)

    def test_valid_key(self):
        _validate_key('my.key_123')

    def test_key_rejects_empty(self):
        with pytest.raises(ValueError, match='Invalid key'):
            _validate_key('')

    def test_key_rejects_slashes(self):
        with pytest.raises(ValueError, match='Invalid key'):
            _validate_key('path/traversal')

    def test_key_rejects_too_long(self):
        with pytest.raises(ValueError, match='Invalid key'):
            _validate_key('k' * 257)


# =============================================================================
# 2. Session CRUD Tests
# =============================================================================


class TestSessionCRUD:
    """Tests for session create, resume, list, and delete."""

    def test_create_session(self, backend: StateBackend):
        result = backend.create_session('sess-1')
        assert result['ok'] is True
        assert result['session_id'] == 'sess-1'

    def test_create_duplicate_session(self, backend: StateBackend):
        backend.create_session('sess-1')
        result = backend.create_session('sess-1')
        assert result['ok'] is False
        assert 'already exists' in result['error']

    def test_resume_existing_session(self, backend: StateBackend):
        backend.create_session('sess-1')
        result = backend.resume_session('sess-1')
        assert result['ok'] is True
        assert result['key_count'] == 0

    def test_resume_nonexistent_session(self, backend: StateBackend):
        result = backend.resume_session('no-such-session')
        assert result['ok'] is False
        assert 'not found' in result['error']

    def test_list_sessions_empty(self, backend: StateBackend):
        assert backend.list_sessions() == []

    def test_list_sessions_multiple(self, backend: StateBackend):
        backend.create_session('b-sess')
        backend.create_session('a-sess')
        assert backend.list_sessions() == ['a-sess', 'b-sess']

    def test_delete_session(self, backend: StateBackend):
        backend.create_session('sess-1')
        backend.put('sess-1', 'key1', 'val1')
        result = backend.delete_session('sess-1')
        assert result['ok'] is True
        assert 'key1' in result['keys_cleared']
        # Verify session is gone
        assert backend.resume_session('sess-1')['ok'] is False

    def test_delete_nonexistent_session(self, backend: StateBackend):
        result = backend.delete_session('ghost')
        assert result['ok'] is False


# =============================================================================
# 3. Memory Operations Tests
# =============================================================================


class TestMemoryOperations:
    """Tests for put, get, list_keys, and clear."""

    def test_put_and_get(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'color', 'blue')
        result = backend.get('s1', 'color')
        assert result['ok'] is True
        assert result['value'] == 'blue'

    def test_get_missing_key(self, backend: StateBackend):
        backend.create_session('s1')
        result = backend.get('s1', 'nope')
        assert result['ok'] is False
        assert result['value'] is None

    def test_put_overwrites(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'k', 'v1')
        backend.put('s1', 'k', 'v2')
        assert backend.get('s1', 'k')['value'] == 'v2'

    def test_put_complex_value(self, backend: StateBackend):
        backend.create_session('s1')
        val = {'nested': [1, 2, {'deep': True}]}
        backend.put('s1', 'data', val)
        result = backend.get('s1', 'data')
        assert result['value'] == val

    def test_list_keys(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'b', 1)
        backend.put('s1', 'a', 2)
        result = backend.list_keys('s1')
        assert result['keys'] == ['a', 'b']

    def test_clear_single_key(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'keep', 1)
        backend.put('s1', 'drop', 2)
        result = backend.clear('s1', 'drop')
        assert result['cleared'] == ['drop']
        assert backend.get('s1', 'keep')['ok'] is True
        assert backend.get('s1', 'drop')['ok'] is False

    def test_clear_all_keys(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'a', 1)
        backend.put('s1', 'b', 2)
        result = backend.clear('s1')
        assert sorted(result['cleared']) == ['a', 'b']
        assert backend.list_keys('s1')['keys'] == []

    def test_clear_nonexistent_key(self, backend: StateBackend):
        backend.create_session('s1')
        result = backend.clear('s1', 'ghost')
        assert result['cleared'] == []

    def test_operations_on_nonexistent_session(self, backend: StateBackend):
        assert backend.put('nope', 'k', 'v')['ok'] is False
        assert backend.get('nope', 'k')['ok'] is False
        assert backend.list_keys('nope')['ok'] is False
        assert backend.clear('nope')['ok'] is False


# =============================================================================
# 4. Session Isolation Tests
# =============================================================================


class TestSessionIsolation:
    """Verify that sessions cannot see each other's data."""

    def test_session_a_cannot_see_session_b(self, backend: StateBackend):
        backend.create_session('a')
        backend.create_session('b')
        backend.put('a', 'secret', 'alpha-data')
        backend.put('b', 'secret', 'beta-data')

        assert backend.get('a', 'secret')['value'] == 'alpha-data'
        assert backend.get('b', 'secret')['value'] == 'beta-data'

    def test_clearing_one_session_leaves_other(self, backend: StateBackend):
        backend.create_session('a')
        backend.create_session('b')
        backend.put('a', 'data', 1)
        backend.put('b', 'data', 2)
        backend.clear('a')
        assert backend.get('a', 'data')['ok'] is False
        assert backend.get('b', 'data')['value'] == 2

    def test_deleting_one_session_leaves_other(self, backend: StateBackend):
        backend.create_session('a')
        backend.create_session('b')
        backend.put('b', 'key', 'value')
        backend.delete_session('a')
        assert backend.resume_session('b')['ok'] is True
        assert backend.get('b', 'key')['value'] == 'value'


# =============================================================================
# 5. Redis Backend Tests (mocked)
# =============================================================================


class TestRedisBackendMocked:
    """Test Redis backend with a mocked redis.Redis client."""

    @pytest.fixture(autouse=True)
    def _mock_redis(self, monkeypatch):
        """Inject a mock redis module for each test, restored automatically by monkeypatch."""
        self._mock_client = MagicMock()
        mock_redis_module = MagicMock()
        mock_redis_module.Redis.return_value = self._mock_client
        monkeypatch.setitem(sys.modules, 'redis', mock_redis_module)

    def _make_backend(self) -> RedisBackend:
        backend = RedisBackend(host='localhost', port=6379)
        backend._client = self._mock_client
        return backend

    def test_create_session_calls_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = False
        pipe_mock = MagicMock()
        backend._client.pipeline.return_value = pipe_mock

        result = backend.create_session('test-session')
        assert result['ok'] is True
        backend._client.pipeline.assert_called()
        pipe_mock.execute.assert_called()

    def test_create_duplicate_session_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True

        result = backend.create_session('dup-session')
        assert result['ok'] is False
        assert 'already exists' in result['error']

    def test_resume_session_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        backend._client.exists.return_value = True
        backend._client.scard.return_value = 3

        result = backend.resume_session('my-sess')
        assert result['ok'] is True
        assert result['key_count'] == 3

    def test_resume_expired_session_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        backend._client.exists.return_value = False  # meta key expired

        result = backend.resume_session('expired-sess')
        assert result['ok'] is False
        assert 'expired' in result['error']

    def test_put_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        pipe_mock = MagicMock()
        backend._client.pipeline.return_value = pipe_mock
        backend._client.hget.return_value = 'None'
        # pttl returns -1 when the key has no TTL, or -2 when key doesn't exist
        backend._client.pttl.return_value = -1

        result = backend.put('sess', 'mykey', {'data': 42})
        assert result['ok'] is True
        pipe_mock.execute.assert_called()

    def test_put_redis_aligns_ttl_with_session(self):
        """When session has a TTL, new keys should inherit remaining TTL from metadata key."""
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        pipe_mock = MagicMock()
        backend._client.pipeline.return_value = pipe_mock
        # Simulate 5000ms remaining on the metadata key
        backend._client.pttl.return_value = 5000

        result = backend.put('sess', 'mykey', {'data': 42})
        assert result['ok'] is True
        # The TTL should be queued on the pipeline, not applied after execute().
        assert pipe_mock.pexpire.call_count == 3
        assert backend._client.pexpire.call_count == 0

    def test_get_redis_found(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        backend._client.get.return_value = '{"value": 42}'

        result = backend.get('sess', 'mykey')
        assert result['ok'] is True
        assert result['value'] == {'value': 42}

    def test_get_redis_not_found(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        backend._client.get.return_value = None

        result = backend.get('sess', 'mykey')
        assert result['ok'] is False

    def test_list_sessions_redis(self):
        backend = self._make_backend()
        backend._client.smembers.return_value = {'sess-a', 'sess-b'}
        backend._client.exists.return_value = True

        sessions = backend.list_sessions()
        assert 'sess-a' in sessions
        assert 'sess-b' in sessions

    def test_delete_session_redis(self):
        backend = self._make_backend()
        backend._client.sismember.return_value = True
        backend._client.smembers.return_value = {'k1', 'k2'}
        pipe_mock = MagicMock()
        backend._client.pipeline.return_value = pipe_mock

        result = backend.delete_session('sess')
        assert result['ok'] is True
        pipe_mock.execute.assert_called()

    def test_close_redis_calls_client_close(self):
        backend = self._make_backend()
        backend.close()
        backend._client.close.assert_called_once()

    def test_replace_history_redis(self):
        backend = self._make_backend()
        pipe_mock = MagicMock()
        backend._client.pipeline.return_value = pipe_mock
        # No TTL on the session
        backend._client.pttl.return_value = -1

        entries = [{'op': 'summary', 'timestamp': 0}, {'op': 'put', 'key': 'k1', 'timestamp': 1}]
        backend.replace_history('sess', entries)
        pipe_mock.delete.assert_called_once()
        pipe_mock.rpush.assert_called_once()
        pipe_mock.execute.assert_called_once()


# =============================================================================
# 6. Auto-Summarization Tests
# =============================================================================


class TestAutoSummarization:
    """Tests for the auto-summarization feature."""

    def test_no_summarization_under_limit(self, store: PersistentMemoryStore):
        store.create_session('s1')
        for i in range(5):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        # Should have 5 put entries, no summary
        assert all(e['op'] != 'summary' for e in history['entries'])

    def test_summarization_triggers_over_limit(self, state):
        store = PersistentMemoryStore(StateBackend(state), max_history=5, auto_summarize=True)
        store.create_session('s1')
        # Add enough entries to trigger summarization
        for i in range(10):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        entries = history['entries']
        # Should have a summary entry as the first entry
        assert entries[0]['op'] == 'summary'

    def test_summarization_preserves_recent_entries(self, state):
        store = PersistentMemoryStore(StateBackend(state), max_history=6, auto_summarize=True)
        store.create_session('s1')
        for i in range(12):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        entries = history['entries']
        # Recent entries (last max_history//2 = 3) should still be individual
        non_summary = [e for e in entries if e['op'] != 'summary']
        assert len(non_summary) >= 1  # At least some recent entries preserved

    def test_summary_entry_has_correct_fields(self, state):
        store = PersistentMemoryStore(StateBackend(state), max_history=4, auto_summarize=True)
        store.create_session('s1')
        for i in range(8):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        summary = next(e for e in history['entries'] if e['op'] == 'summary')
        assert 'summarized_count' in summary
        assert 'op_counts' in summary
        assert 'keys_touched' in summary
        assert 'timestamp' in summary

    def test_no_summarization_when_disabled(self, state):
        store = PersistentMemoryStore(StateBackend(state), max_history=3, auto_summarize=False)
        store.create_session('s1')
        for i in range(10):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        assert all(e['op'] != 'summary' for e in history['entries'])

    def test_summarize_if_needed_returns_false_under_limit(self, store: PersistentMemoryStore):
        store.create_session('s1')
        store.put('s1', 'k', 'v')
        assert store.summarize_if_needed('s1', 100) is False

    def test_summarize_if_needed_returns_true_over_limit(self, state):
        store = PersistentMemoryStore(StateBackend(state), max_history=3, auto_summarize=False)
        store.create_session('s1')
        for i in range(5):
            store.put('s1', f'k{i}', f'v{i}')
        assert store.summarize_if_needed('s1', 3) is True


# =============================================================================
# 7. History Retrieval Tests
# =============================================================================


class TestHistoryRetrieval:
    """Tests for get_history with limits."""

    def test_replace_history(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.put('s1', 'k2', 'v2')
        # Replace with a single summary entry
        backend.replace_history('s1', [{'op': 'summary', 'timestamp': 0}])
        history = backend.get_history('s1', limit=0)
        assert len(history['entries']) == 1
        assert history['entries'][0]['op'] == 'summary'

    def test_history_records_puts(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.put('s1', 'k2', 'v2')
        history = backend.get_history('s1', limit=50)
        assert history['ok'] is True
        assert len(history['entries']) == 2
        assert history['entries'][0]['op'] == 'put'

    def test_history_records_clears(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.clear('s1', 'k1')
        history = backend.get_history('s1')
        ops = [e['op'] for e in history['entries']]
        assert 'clear' in ops

    def test_history_limit(self, backend: StateBackend):
        backend.create_session('s1')
        for i in range(20):
            backend.put('s1', f'k{i}', f'v{i}')
        history = backend.get_history('s1', limit=5)
        assert len(history['entries']) == 5

    def test_history_returns_most_recent(self, backend: StateBackend):
        backend.create_session('s1')
        for i in range(10):
            backend.put('s1', f'k{i}', f'v{i}')
        history = backend.get_history('s1', limit=3)
        # Last 3 should be k7, k8, k9
        keys = [e['key'] for e in history['entries']]
        assert keys == ['k7', 'k8', 'k9']

    def test_history_nonexistent_session(self, backend: StateBackend):
        result = backend.get_history('nope')
        assert result['ok'] is False


# =============================================================================
# 8. TTL Enforcement Tests
# =============================================================================


class TestTTLEnforcement:
    """Tests for session TTL expiry."""

    def test_expired_session_is_inaccessible(self, backend: StateBackend):
        now = [time.time()]
        with patch('nodes.memory_persistent.memory_store.time') as fake_time:
            fake_time.time = lambda: now[0]
            backend.create_session('s1', ttl_seconds=1)
            backend.put('s1', 'k', 'v')
            # Fast-forward past the session's expiry
            now[0] += 2
            result = backend.resume_session('s1')
        assert result['ok'] is False
        assert 'expired' in result['error']

    def test_expired_session_pruned_from_list(self, backend: StateBackend):
        now = [time.time()]
        with patch('nodes.memory_persistent.memory_store.time') as fake_time:
            fake_time.time = lambda: now[0]
            backend.create_session('keep', ttl_seconds=None)
            backend.create_session('expire', ttl_seconds=1)
            now[0] += 2
            sessions = backend.list_sessions()
        assert 'expire' not in sessions
        assert 'keep' in sessions

    def test_non_expiring_session_persists(self, backend: StateBackend):
        backend.create_session('forever')
        backend.put('forever', 'k', 'v')
        assert backend.resume_session('forever')['ok'] is True

    def test_ttl_from_store_config_preserves_fractional_seconds(self, state):
        now = [1000.0]
        with patch('nodes.memory_persistent.memory_store.time') as fake_time:
            fake_time.time = lambda: now[0]
            store = PersistentMemoryStore(StateBackend(state), session_ttl_hours=0.0001)  # ~0.36 seconds
            assert math.isclose(store._ttl_seconds, 0.36)
            store.create_session('s1')
            store.put('s1', 'k', 'v')
            # Should be accessible immediately
            assert store.resume_session('s1')['ok'] is True
            now[0] += 0.45
            result = store.resume_session('s1')
            assert result['ok'] is False
            assert 'expired' in result['error']


# =============================================================================
# 9. Thread Safety Tests
# =============================================================================


class TestThreadSafety:
    """Tests that concurrent operations don't corrupt state."""

    def test_concurrent_puts(self, backend: StateBackend):
        backend.create_session('s1')
        errors = []

        def writer(key_prefix: str, count: int):
            try:
                for i in range(count):
                    result = backend.put('s1', f'{key_prefix}{i}', i)
                    if not result['ok']:
                        errors.append(f'put failed: {result}')
            except Exception as e:  # noqa: BLE001 - thread worker reports failures through errors.
                errors.append(str(e))

        threads = [
            threading.Thread(target=contextvars.copy_context().run, args=(writer, 'a-', 50)),
            threading.Thread(target=contextvars.copy_context().run, args=(writer, 'b-', 50)),
            threading.Thread(target=contextvars.copy_context().run, args=(writer, 'c-', 50)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f'Thread errors: {errors}'
        keys = backend.list_keys('s1')['keys']
        assert len(keys) == 150

    def test_concurrent_session_creation(self, backend: StateBackend):
        results = []
        lock = threading.Lock()

        def create(name: str):
            r = backend.create_session(name)
            with lock:
                results.append(r)

        threads = [
            threading.Thread(target=contextvars.copy_context().run, args=(create, f'sess-{i}')) for i in range(20)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        ok_count = sum(1 for r in results if r['ok'])
        assert ok_count == MAX_STATE_SESSIONS
        refused = [r for r in results if not r['ok']]
        assert all('Maximum sessions' in r['error'] for r in refused)
        assert sorted(backend.list_sessions()) == sorted(r['session_id'] for r in results if r['ok'])

    def test_concurrent_reads_and_writes(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'shared', 0)
        errors = []

        def reader(count: int):
            try:
                for _ in range(count):
                    result = backend.get('s1', 'shared')
                    if not result['ok']:
                        errors.append(f'get failed: {result}')
            except Exception as e:  # noqa: BLE001 - thread worker reports failures through errors.
                errors.append(str(e))

        def writer(count: int):
            try:
                for i in range(count):
                    result = backend.put('s1', 'shared', i)
                    if not result['ok']:
                        errors.append(f'put failed: {result}')
            except Exception as e:  # noqa: BLE001 - thread worker reports failures through errors.
                errors.append(str(e))

        threads = [
            threading.Thread(target=contextvars.copy_context().run, args=(reader, 100)),
            threading.Thread(target=contextvars.copy_context().run, args=(writer, 100)),
            threading.Thread(target=contextvars.copy_context().run, args=(reader, 100)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []


# =============================================================================
# 10. Deep Copy / Mutation Prevention Tests
# =============================================================================


class TestDeepCopyMutationPrevention:
    """Verify that returned values are deep copies — mutations don't leak back."""

    def test_mutating_put_value_does_not_affect_store(self, backend: StateBackend):
        backend.create_session('s1')
        original = {'items': [1, 2, 3]}
        backend.put('s1', 'data', original)
        # Mutate the original
        original['items'].append(999)
        # Store should be unaffected
        stored = backend.get('s1', 'data')['value']
        assert 999 not in stored['items']

    def test_mutating_get_result_does_not_affect_store(self, backend: StateBackend):
        backend.create_session('s1')
        backend.put('s1', 'data', {'items': [1, 2, 3]})
        retrieved = backend.get('s1', 'data')['value']
        # Mutate the retrieved value
        retrieved['items'].append(999)
        # Re-retrieve — should be untouched
        fresh = backend.get('s1', 'data')['value']
        assert 999 not in fresh['items']

    def test_deep_nested_mutation_prevention(self, backend: StateBackend):
        backend.create_session('s1')
        val = {'a': {'b': {'c': [1]}}}
        backend.put('s1', 'deep', val)
        val['a']['b']['c'].append(2)
        stored = backend.get('s1', 'deep')['value']
        assert stored['a']['b']['c'] == [1]


# =============================================================================
# 11. PersistentMemoryStore Facade Tests
# =============================================================================


class TestPersistentMemoryStoreFacade:
    """Tests for the PersistentMemoryStore facade layer."""

    def test_store_wraps_the_state_backend(self, store: PersistentMemoryStore):
        assert isinstance(store.backend, StateBackend)

    def test_store_session_lifecycle(self, store: PersistentMemoryStore):
        store.create_session('s1')
        store.put('s1', 'k', 'v')
        assert store.get('s1', 'k')['value'] == 'v'
        assert store.list_keys('s1')['keys'] == ['k']
        store.clear('s1', 'k')
        assert store.get('s1', 'k')['ok'] is False
        store.delete_session('s1')
        assert store.resume_session('s1')['ok'] is False

    def test_store_list_sessions(self, store: PersistentMemoryStore):
        store.create_session('a')
        store.create_session('b')
        assert store.list_sessions() == ['a', 'b']

    def test_store_get_history(self, store: PersistentMemoryStore):
        store.create_session('s1')
        store.put('s1', 'k', 'v')
        history = store.get_history('s1')
        assert history['ok'] is True
        assert len(history['entries']) >= 1

    def test_close_inmemory_is_noop(self, store: PersistentMemoryStore):
        """StateBackend.close() should be a safe no-op."""
        store.backend.close()
        # Store should still function after close (no-op for in-memory)
        store.create_session('after-close')
        assert store.resume_session('after-close')['ok'] is True


# =============================================================================
# 12. State Backend Bounds Tests
# =============================================================================


class TestStateBounds:
    """The state backend keeps within the node's 16 state keys: fifteen sessions and the index."""

    def test_max_sessions_enforced(self, state):
        backend = StateBackend(state)
        # Create up to the limit
        for i in range(MAX_STATE_SESSIONS):
            result = backend.create_session(f's{i}')
            assert result['ok'] is True, f'Failed at session {i}: {result}'
        # One more should fail
        result = backend.create_session('overflow')
        assert result['ok'] is False
        assert 'Maximum sessions' in result['error']

    def test_a_deleted_session_frees_its_place(self, state):
        backend = StateBackend(state)
        for i in range(MAX_STATE_SESSIONS):
            backend.create_session(f's{i}')
        assert backend.delete_session('s0')['ok'] is True
        assert backend.create_session('again')['ok'] is True

    def test_a_session_whose_record_expired_is_not_listed(self, state):
        # A session with no ttl is indexed with no expiry, and its record lives
        # a little less than the index: once the record's ttl runs out (the
        # state store drops it), the session is gone everywhere, the listing included
        backend = StateBackend(state)
        backend.create_session('kept')
        backend.create_session('lapsed')
        state.delete(_session_key('lapsed'))
        assert backend.resume_session('lapsed')['ok'] is False
        assert backend.list_sessions() == ['kept']


# =============================================================================
# 12b. Redis: one namespace per owner (plan 12 B)
# =============================================================================


class TestRedisNamespace:
    """One pool, one view per owner namespace: a namespace's keys never meet another's."""

    @staticmethod
    def _pool() -> RedisBackend:
        """One control's pool over a fake Redis client."""
        fake_redis_module = MagicMock()
        fake_redis_module.Redis.return_value = FakeRedis()
        with patch.dict(sys.modules, {'redis': fake_redis_module}):
            return RedisBackend(host='fake', port=0)

    def test_a_view_shares_the_pool_and_keys_inside_its_namespace(self):
        pool = self._pool()
        view = pool.for_namespace('ns:1@x')
        assert view._client is pool._client and view._lock is pool._lock
        view.create_session('s1')
        view.put('s1', 'k', 'v')
        assert view._meta_key('s1') == 'rr:memory:@ns%3A1%40x:s1:__meta__'
        assert view.list_sessions() == ['s1']

        # Another namespace on the same pool sees none of it
        other = pool.for_namespace('ns-2')
        assert other.list_sessions() == []
        assert other.resume_session('s1')['ok'] is False
        assert other.create_session('s1')['ok'] is True
        assert other.get('s1', 'k')['ok'] is False
        assert view.get('s1', 'k')['value'] == 'v'

    def test_a_view_needs_a_namespace(self):
        with pytest.raises(ValueError, match='namespace is required'):
            self._pool().for_namespace('')


# =============================================================================
# 13. IGlobal Lifecycle Tests
# =============================================================================


class TestIGlobalLifecycle:
    """Tests for IGlobal initialization and teardown."""

    def test_the_state_branch_holds_nothing_on_the_control(self):
        """The default backend keeps its sessions in each binding's state: the IGlobal builds nothing."""
        iglobal = IGlobal()
        iglobal._config_restricted = control_config('memory_persistent')
        iglobal.beginGlobal()
        assert iglobal.redis is None
        iglobal.endGlobal()
        assert iglobal.redis is None

    def test_the_redis_branch_connects_once_per_control(self, monkeypatch):
        """The redis branch builds the pool from the control's host, port and password."""
        monkeypatch.setitem(sys.modules, 'depends', types.SimpleNamespace(depends=lambda *_: None))
        built = []
        monkeypatch.setattr(
            'nodes.memory_persistent.IGlobal.RedisBackend', lambda **kwargs: built.append(kwargs) or MagicMock()
        )
        iglobal = IGlobal()
        iglobal._config_restricted = control_config(
            'memory_persistent', {'backend': 'redis', 'redis': {'redis_host': 'cache', 'redis_port': 6380}}
        )
        iglobal.beginGlobal()
        assert built == [{'host': 'cache', 'port': 6380, 'password': None}]
        redis = iglobal.redis
        iglobal.endGlobal()
        redis.close.assert_called_once()
        assert iglobal.redis is None


# =============================================================================
# 14. IInstance Lifecycle Tests
# =============================================================================


class TestIInstanceLifecycle:
    """Tests for IInstance writeQuestions and writeAnswers."""

    def _make_instance(self, store):
        inst = IInstance.__new__(IInstance)
        inst.IGlobal = MagicMock()
        # This call's store (the instance builds it from its settings and its state)
        inst._store = lambda: store
        inst.instance = MagicMock()
        # The real IInstanceBase.preventDefault() raises APERR by design (it's
        # meant to be caught by the C++ engine); stub it so unit tests can call
        # writeQuestions/writeAnswers without a running engine. Note: unlike the
        # real one, this stub does not raise, so code placed after a
        # preventDefault() call will appear to run here but never runs in the
        # engine.
        inst.preventDefault = MagicMock()
        return inst

    def test_write_questions_enriches_with_memory(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        store.create_session('test-sess')
        store.put('test-sess', 'context_key', 'context_value')

        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'test-sess'}

        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()
        inst.preventDefault.assert_called_once_with()

        # The forwarded question should have memory_context
        forwarded = inst.instance.writeQuestions.call_args[0][0]
        assert 'memory_context' in forwarded.metadata
        assert forwarded.metadata['memory_context']['context_key'] == 'context_value'

    def test_write_questions_creates_session_if_missing(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'new-sess'}

        inst.writeQuestions(question)
        # Session should now exist
        assert store.resume_session('new-sess')['ok'] is True

    def test_write_answers_stores_in_session(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        answer = MagicMock()
        answer.metadata = {'session_id': 'test-sess'}
        answer.getText.return_value = 'The answer is 42'

        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()
        inst.preventDefault.assert_called_once_with()

        # Check that answer was stored
        result = store.get('test-sess', 'last_answer')
        assert result['ok'] is True
        assert result['value'] == 'The answer is 42'

    def test_write_answers_uses_session_id_from_previous_question(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'test-sess'}
        inst.writeQuestions(question)

        answer = MagicMock()
        answer.metadata = {}
        answer.getText.return_value = 'Follow-up answer'

        inst.writeAnswers(answer)

        result = store.get('test-sess', 'last_answer')
        assert result['ok'] is True
        assert result['value'] == 'Follow-up answer'
        assert store.get('test-sess', 'answer_count')['value'] == 1
        assert inst.preventDefault.call_count == 2

    def test_write_answers_increments_count(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        for i in range(3):
            answer = MagicMock()
            answer.metadata = {'session_id': 'test-sess'}
            answer.getText.return_value = f'Answer {i}'
            inst.writeAnswers(answer)

        count = store.get('test-sess', 'answer_count')
        assert count['value'] == 3

    def test_open_clears_current_session_state(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'test-sess'}

        inst.writeQuestions(question)
        assert inst._current_session_id == 'test-sess'

        inst.open(MagicMock())
        assert inst._current_session_id is None

    def test_write_questions_no_session_id(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {}

        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()
        inst.preventDefault.assert_called_once_with()

    def test_write_answers_no_session_id(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        answer = MagicMock()
        answer.metadata = {}

        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()
        inst.preventDefault.assert_called_once_with()

    def test_write_questions_invalid_session_id_forwards_once(self, state):
        """A session_id the store rejects is dropped; the question is forwarded once, unenriched."""
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'bad id!'}

        inst.writeQuestions(question)

        inst.instance.writeQuestions.assert_called_once()
        inst.preventDefault.assert_called_once_with()
        assert inst._current_session_id is None
        forwarded = inst.instance.writeQuestions.call_args[0][0]
        assert 'memory_context' not in forwarded.metadata

    def test_write_answers_invalid_session_id_forwards_once(self, state):
        """A session_id the store rejects stops before storing; the answer is forwarded once."""
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        answer = MagicMock()
        answer.metadata = {'session_id': 'bad id!'}
        answer.getText.return_value = 'not stored'

        inst.writeAnswers(answer)

        inst.instance.writeAnswers.assert_called_once()
        inst.preventDefault.assert_called_once_with()

    def test_deep_copy_prevents_question_mutation(self, state):
        store = PersistentMemoryStore(StateBackend(state))
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'key': 'original'}

        inst.writeQuestions(question)
        # Original question metadata should not have memory_context
        # (the deep copy was modified, not the original)
        assert 'memory_context' not in question.metadata


# =============================================================================
# 15. IGlobal Resource Cleanup
# =============================================================================


class TestIGlobalResourceCleanup:
    """endGlobal must release the backend even on exception (try/finally)."""

    def test_endglobal_clears_state_even_if_close_raises(self):
        """The try/finally contract: store and config are nulled even when
        backend.close() raises (e.g. transient Redis disconnect).
        """
        g = IGlobal.__new__(IGlobal)
        mock_backend = MagicMock()
        mock_backend.close.side_effect = RuntimeError('disconnect failed')
        g.redis = mock_backend

        with contextlib.suppress(RuntimeError):
            g.endGlobal()

        assert g.redis is None, 'endGlobal must null the pool in finally block'
        mock_backend.close.assert_called_once()
