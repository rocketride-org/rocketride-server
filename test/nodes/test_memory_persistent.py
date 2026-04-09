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

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Ensure the node source and engine libs are importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
NODES_SRC = PROJECT_ROOT / 'nodes' / 'src' / 'nodes'
ROCKETLIB = PROJECT_ROOT / 'packages' / 'server' / 'engine-lib' / 'rocketlib-python' / 'lib'
AI_SRC = PROJECT_ROOT / 'packages' / 'ai' / 'src'

for p in (NODES_SRC, ROCKETLIB, AI_SRC):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

# Import memory_store directly via importlib to avoid triggering the package
# __init__.py which imports IGlobal/IInstance (requires engine runtime).
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'memory_persistent.memory_store',
    NODES_SRC / 'memory_persistent' / 'memory_store.py',
)
_module = importlib.util.module_from_spec(_spec)
sys.modules['memory_persistent.memory_store'] = _module
_spec.loader.exec_module(_module)

InMemoryBackend = _module.InMemoryBackend
PersistentMemoryStore = _module.PersistentMemoryStore
RedisBackend = _module.RedisBackend
_validate_key = _module._validate_key
_validate_session_id = _module._validate_session_id


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def backend() -> InMemoryBackend:
    """Fresh in-memory backend for each test."""
    return InMemoryBackend()


@pytest.fixture
def store() -> PersistentMemoryStore:
    """Fresh PersistentMemoryStore with in-memory backend."""
    return PersistentMemoryStore(backend='memory', max_history=10, auto_summarize=True)


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

    def test_create_session(self, backend: InMemoryBackend):
        result = backend.create_session('sess-1')
        assert result['ok'] is True
        assert result['session_id'] == 'sess-1'

    def test_create_duplicate_session(self, backend: InMemoryBackend):
        backend.create_session('sess-1')
        result = backend.create_session('sess-1')
        assert result['ok'] is False
        assert 'already exists' in result['error']

    def test_resume_existing_session(self, backend: InMemoryBackend):
        backend.create_session('sess-1')
        result = backend.resume_session('sess-1')
        assert result['ok'] is True
        assert result['key_count'] == 0

    def test_resume_nonexistent_session(self, backend: InMemoryBackend):
        result = backend.resume_session('no-such-session')
        assert result['ok'] is False
        assert 'not found' in result['error']

    def test_list_sessions_empty(self, backend: InMemoryBackend):
        assert backend.list_sessions() == []

    def test_list_sessions_multiple(self, backend: InMemoryBackend):
        backend.create_session('b-sess')
        backend.create_session('a-sess')
        assert backend.list_sessions() == ['a-sess', 'b-sess']

    def test_delete_session(self, backend: InMemoryBackend):
        backend.create_session('sess-1')
        backend.put('sess-1', 'key1', 'val1')
        result = backend.delete_session('sess-1')
        assert result['ok'] is True
        assert 'key1' in result['keys_cleared']
        # Verify session is gone
        assert backend.resume_session('sess-1')['ok'] is False

    def test_delete_nonexistent_session(self, backend: InMemoryBackend):
        result = backend.delete_session('ghost')
        assert result['ok'] is False


# =============================================================================
# 3. Memory Operations Tests
# =============================================================================


class TestMemoryOperations:
    """Tests for put, get, list_keys, and clear."""

    def test_put_and_get(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'color', 'blue')
        result = backend.get('s1', 'color')
        assert result['ok'] is True
        assert result['value'] == 'blue'

    def test_get_missing_key(self, backend: InMemoryBackend):
        backend.create_session('s1')
        result = backend.get('s1', 'nope')
        assert result['ok'] is False
        assert result['value'] is None

    def test_put_overwrites(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'k', 'v1')
        backend.put('s1', 'k', 'v2')
        assert backend.get('s1', 'k')['value'] == 'v2'

    def test_put_complex_value(self, backend: InMemoryBackend):
        backend.create_session('s1')
        val = {'nested': [1, 2, {'deep': True}]}
        backend.put('s1', 'data', val)
        result = backend.get('s1', 'data')
        assert result['value'] == val

    def test_list_keys(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'b', 1)
        backend.put('s1', 'a', 2)
        result = backend.list_keys('s1')
        assert result['keys'] == ['a', 'b']

    def test_clear_single_key(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'keep', 1)
        backend.put('s1', 'drop', 2)
        result = backend.clear('s1', 'drop')
        assert result['cleared'] == ['drop']
        assert backend.get('s1', 'keep')['ok'] is True
        assert backend.get('s1', 'drop')['ok'] is False

    def test_clear_all_keys(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'a', 1)
        backend.put('s1', 'b', 2)
        result = backend.clear('s1')
        assert sorted(result['cleared']) == ['a', 'b']
        assert backend.list_keys('s1')['keys'] == []

    def test_clear_nonexistent_key(self, backend: InMemoryBackend):
        backend.create_session('s1')
        result = backend.clear('s1', 'ghost')
        assert result['cleared'] == []

    def test_operations_on_nonexistent_session(self, backend: InMemoryBackend):
        assert backend.put('nope', 'k', 'v')['ok'] is False
        assert backend.get('nope', 'k')['ok'] is False
        assert backend.list_keys('nope')['ok'] is False
        assert backend.clear('nope')['ok'] is False


# =============================================================================
# 4. Session Isolation Tests
# =============================================================================


class TestSessionIsolation:
    """Verify that sessions cannot see each other's data."""

    def test_session_a_cannot_see_session_b(self, backend: InMemoryBackend):
        backend.create_session('a')
        backend.create_session('b')
        backend.put('a', 'secret', 'alpha-data')
        backend.put('b', 'secret', 'beta-data')

        assert backend.get('a', 'secret')['value'] == 'alpha-data'
        assert backend.get('b', 'secret')['value'] == 'beta-data'

    def test_clearing_one_session_leaves_other(self, backend: InMemoryBackend):
        backend.create_session('a')
        backend.create_session('b')
        backend.put('a', 'data', 1)
        backend.put('b', 'data', 2)
        backend.clear('a')
        assert backend.get('a', 'data')['ok'] is False
        assert backend.get('b', 'data')['value'] == 2

    def test_deleting_one_session_leaves_other(self, backend: InMemoryBackend):
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

    def test_summarization_triggers_over_limit(self):
        store = PersistentMemoryStore(backend='memory', max_history=5, auto_summarize=True)
        store.create_session('s1')
        # Add enough entries to trigger summarization
        for i in range(10):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        entries = history['entries']
        # Should have a summary entry as the first entry
        assert entries[0]['op'] == 'summary'

    def test_summarization_preserves_recent_entries(self):
        store = PersistentMemoryStore(backend='memory', max_history=6, auto_summarize=True)
        store.create_session('s1')
        for i in range(12):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        entries = history['entries']
        # Recent entries (last max_history//2 = 3) should still be individual
        non_summary = [e for e in entries if e['op'] != 'summary']
        assert len(non_summary) >= 1  # At least some recent entries preserved

    def test_summary_entry_has_correct_fields(self):
        store = PersistentMemoryStore(backend='memory', max_history=4, auto_summarize=True)
        store.create_session('s1')
        for i in range(8):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        summary = next(e for e in history['entries'] if e['op'] == 'summary')
        assert 'summarized_count' in summary
        assert 'op_counts' in summary
        assert 'keys_touched' in summary
        assert 'timestamp' in summary

    def test_no_summarization_when_disabled(self):
        store = PersistentMemoryStore(backend='memory', max_history=3, auto_summarize=False)
        store.create_session('s1')
        for i in range(10):
            store.put('s1', f'key{i}', f'val{i}')
        history = store.get_history('s1', limit=0)
        assert all(e['op'] != 'summary' for e in history['entries'])

    def test_summarize_if_needed_returns_false_under_limit(self, store: PersistentMemoryStore):
        store.create_session('s1')
        store.put('s1', 'k', 'v')
        assert store.summarize_if_needed('s1', 100) is False

    def test_summarize_if_needed_returns_true_over_limit(self):
        store = PersistentMemoryStore(backend='memory', max_history=3, auto_summarize=False)
        store.create_session('s1')
        for i in range(5):
            store.put('s1', f'k{i}', f'v{i}')
        assert store.summarize_if_needed('s1', 3) is True


# =============================================================================
# 7. History Retrieval Tests
# =============================================================================


class TestHistoryRetrieval:
    """Tests for get_history with limits."""

    def test_replace_history(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.put('s1', 'k2', 'v2')
        # Replace with a single summary entry
        backend.replace_history('s1', [{'op': 'summary', 'timestamp': 0}])
        history = backend.get_history('s1', limit=0)
        assert len(history['entries']) == 1
        assert history['entries'][0]['op'] == 'summary'

    def test_history_records_puts(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.put('s1', 'k2', 'v2')
        history = backend.get_history('s1', limit=50)
        assert history['ok'] is True
        assert len(history['entries']) == 2
        assert history['entries'][0]['op'] == 'put'

    def test_history_records_clears(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'k1', 'v1')
        backend.clear('s1', 'k1')
        history = backend.get_history('s1')
        ops = [e['op'] for e in history['entries']]
        assert 'clear' in ops

    def test_history_limit(self, backend: InMemoryBackend):
        backend.create_session('s1')
        for i in range(20):
            backend.put('s1', f'k{i}', f'v{i}')
        history = backend.get_history('s1', limit=5)
        assert len(history['entries']) == 5

    def test_history_returns_most_recent(self, backend: InMemoryBackend):
        backend.create_session('s1')
        for i in range(10):
            backend.put('s1', f'k{i}', f'v{i}')
        history = backend.get_history('s1', limit=3)
        # Last 3 should be k7, k8, k9
        keys = [e['key'] for e in history['entries']]
        assert keys == ['k7', 'k8', 'k9']

    def test_history_nonexistent_session(self, backend: InMemoryBackend):
        result = backend.get_history('nope')
        assert result['ok'] is False


# =============================================================================
# 8. TTL Enforcement Tests
# =============================================================================


class TestTTLEnforcement:
    """Tests for session TTL expiry."""

    def test_expired_session_is_inaccessible(self, backend: InMemoryBackend):
        backend.create_session('s1', ttl_seconds=1)
        backend.put('s1', 'k', 'v')
        # Fast-forward expiry
        backend._metadata['s1']['expires_at'] = time.time() - 1
        result = backend.resume_session('s1')
        assert result['ok'] is False
        assert 'expired' in result['error']

    def test_expired_session_pruned_from_list(self, backend: InMemoryBackend):
        backend.create_session('keep', ttl_seconds=None)
        backend.create_session('expire', ttl_seconds=1)
        backend._metadata['expire']['expires_at'] = time.time() - 1
        sessions = backend.list_sessions()
        assert 'expire' not in sessions
        assert 'keep' in sessions

    def test_non_expiring_session_persists(self, backend: InMemoryBackend):
        backend.create_session('forever')
        backend.put('forever', 'k', 'v')
        assert backend.resume_session('forever')['ok'] is True

    def test_ttl_from_store_config_preserves_fractional_seconds(self):
        store = PersistentMemoryStore(backend='memory', session_ttl_hours=0.0001)  # ~0.36 seconds
        assert store._ttl_seconds == pytest.approx(0.36)
        store.create_session('s1')
        store.put('s1', 'k', 'v')
        # Should be accessible immediately
        assert store.resume_session('s1')['ok'] is True
        time.sleep(0.45)
        result = store.resume_session('s1')
        assert result['ok'] is False
        assert 'expired' in result['error']


# =============================================================================
# 9. Thread Safety Tests
# =============================================================================


class TestThreadSafety:
    """Tests that concurrent operations don't corrupt state."""

    def test_concurrent_puts(self, backend: InMemoryBackend):
        backend.create_session('s1')
        errors = []

        def writer(key_prefix: str, count: int):
            try:
                for i in range(count):
                    result = backend.put('s1', f'{key_prefix}{i}', i)
                    if not result['ok']:
                        errors.append(f'put failed: {result}')
            except Exception as e:
                errors.append(str(e))

        threads = [
            threading.Thread(target=writer, args=('a-', 50)),
            threading.Thread(target=writer, args=('b-', 50)),
            threading.Thread(target=writer, args=('c-', 50)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f'Thread errors: {errors}'
        keys = backend.list_keys('s1')['keys']
        assert len(keys) == 150

    def test_concurrent_session_creation(self, backend: InMemoryBackend):
        results = []
        lock = threading.Lock()

        def create(name: str):
            r = backend.create_session(name)
            with lock:
                results.append(r)

        threads = [threading.Thread(target=create, args=(f'sess-{i}',)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        ok_count = sum(1 for r in results if r['ok'])
        assert ok_count == 20

    def test_concurrent_reads_and_writes(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'shared', 0)
        errors = []

        def reader(count: int):
            try:
                for _ in range(count):
                    result = backend.get('s1', 'shared')
                    if not result['ok']:
                        errors.append(f'get failed: {result}')
            except Exception as e:
                errors.append(str(e))

        def writer(count: int):
            try:
                for i in range(count):
                    result = backend.put('s1', 'shared', i)
                    if not result['ok']:
                        errors.append(f'put failed: {result}')
            except Exception as e:
                errors.append(str(e))

        threads = [
            threading.Thread(target=reader, args=(100,)),
            threading.Thread(target=writer, args=(100,)),
            threading.Thread(target=reader, args=(100,)),
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

    def test_mutating_put_value_does_not_affect_store(self, backend: InMemoryBackend):
        backend.create_session('s1')
        original = {'items': [1, 2, 3]}
        backend.put('s1', 'data', original)
        # Mutate the original
        original['items'].append(999)
        # Store should be unaffected
        stored = backend.get('s1', 'data')['value']
        assert 999 not in stored['items']

    def test_mutating_get_result_does_not_affect_store(self, backend: InMemoryBackend):
        backend.create_session('s1')
        backend.put('s1', 'data', {'items': [1, 2, 3]})
        retrieved = backend.get('s1', 'data')['value']
        # Mutate the retrieved value
        retrieved['items'].append(999)
        # Re-retrieve — should be untouched
        fresh = backend.get('s1', 'data')['value']
        assert 999 not in fresh['items']

    def test_deep_nested_mutation_prevention(self, backend: InMemoryBackend):
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

    def test_unknown_backend_raises(self):
        with pytest.raises(ValueError, match='Unknown backend'):
            PersistentMemoryStore(backend='postgres')

    def test_store_creates_inmemory_backend(self, store: PersistentMemoryStore):
        assert isinstance(store.backend, InMemoryBackend)

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
        """InMemoryBackend.close() should be a safe no-op."""
        store.backend.close()
        # Store should still function after close (no-op for in-memory)
        store.create_session('after-close')
        assert store.resume_session('after-close')['ok'] is True


# =============================================================================
# 12. InMemory Backend Bounds Tests
# =============================================================================


class TestInMemoryBounds:
    """Test that InMemory backend enforces session limits."""

    def test_max_sessions_enforced(self):
        backend = InMemoryBackend()
        # Create up to the limit
        for i in range(1000):
            result = backend.create_session(f's{i}')
            assert result['ok'] is True, f'Failed at session {i}: {result}'
        # One more should fail
        result = backend.create_session('overflow')
        assert result['ok'] is False
        assert 'Maximum sessions' in result['error']


# =============================================================================
# 13. IGlobal Lifecycle Tests
# =============================================================================


def _build_engine_mock_entries() -> dict:
    """Build a dict of mock sys.modules entries for the C++ engine and ai packages.

    Returns a mapping suitable for ``patch.dict(sys.modules, ...)``.
    """
    mock_englib = MagicMock()
    mock_englib.PROTOCOL_CAPS = MagicMock()
    mock_englib.TAG_ID = MagicMock()
    mock_englib.TAG = MagicMock()

    mock_depends_mod = MagicMock()
    mock_depends_mod.depends = MagicMock(return_value=None)

    entries: dict = {
        'engLib': mock_englib,
        'depends': mock_depends_mod,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.schema': MagicMock(),
        'ai.common.config': MagicMock(),
    }
    return entries


@pytest.fixture
def engine_mocks(monkeypatch):
    """Install engine mocks into sys.modules for the duration of the test.

    Yields the mock entries dict so tests can inspect individual mocks.
    Cleanup is automatic via monkeypatch.
    """
    entries = _build_engine_mock_entries()
    for name, mod in entries.items():
        monkeypatch.setitem(sys.modules, name, mod)
    # Clear cached rocketlib modules so they re-import with the mocks
    for key in list(sys.modules.keys()):
        if key.startswith('rocketlib'):
            monkeypatch.delitem(sys.modules, key, raising=False)
    yield entries


def _import_iglobal():
    """Import IGlobal via importlib to avoid triggering package __init__.py.

    Caller must ensure engine mocks are installed (e.g. via the ``engine_mocks`` fixture).
    """
    spec = importlib.util.spec_from_file_location(
        'memory_persistent.IGlobal',
        NODES_SRC / 'memory_persistent' / 'IGlobal.py',
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.IGlobal


def _import_iinstance():
    """Import IInstance via importlib to avoid triggering package __init__.py.

    Caller must ensure engine mocks are installed (e.g. via the ``engine_mocks`` fixture).
    """
    spec = importlib.util.spec_from_file_location(
        'memory_persistent.IInstance',
        NODES_SRC / 'memory_persistent' / 'IInstance.py',
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.IInstance


class TestIGlobalLifecycle:
    """Tests for IGlobal initialization and teardown."""

    def test_iglobal_config_mode_skips_store(self, engine_mocks):
        """In CONFIG mode, store should not be created."""
        IGlobal = _import_iglobal()

        iglobal = IGlobal.__new__(IGlobal)
        iglobal.IEndpoint = MagicMock()
        from rocketlib import OPEN_MODE

        iglobal.IEndpoint.endpoint.openMode = OPEN_MODE.CONFIG

        iglobal.beginGlobal()
        assert iglobal.store is None

    def test_endglobal_clears_store(self, engine_mocks):
        IGlobal = _import_iglobal()

        iglobal = IGlobal.__new__(IGlobal)
        iglobal.store = MagicMock()
        iglobal.config = {'some': 'config'}
        iglobal.endGlobal()
        assert iglobal.store is None
        assert iglobal.config is None


# =============================================================================
# 14. IInstance Lifecycle Tests
# =============================================================================


class TestIInstanceLifecycle:
    """Tests for IInstance writeQuestions and writeAnswers."""

    @pytest.fixture(autouse=True)
    def _setup_engine_mocks(self, engine_mocks):
        """Ensure engine mocks are active for every test in this class."""

    def _make_instance(self, store=None):
        IInstance = _import_iinstance()

        inst = IInstance.__new__(IInstance)
        inst.IGlobal = MagicMock()
        inst.IGlobal.store = store
        inst.instance = MagicMock()
        return inst

    def test_write_questions_forwards_without_store(self):
        inst = self._make_instance(store=None)
        question = MagicMock()
        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()

    def test_write_answers_forwards_without_store(self):
        inst = self._make_instance(store=None)
        answer = MagicMock()
        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()

    def test_write_questions_enriches_with_memory(self):
        store = PersistentMemoryStore(backend='memory')
        store.create_session('test-sess')
        store.put('test-sess', 'context_key', 'context_value')

        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'test-sess'}

        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()

        # The forwarded question should have memory_context
        forwarded = inst.instance.writeQuestions.call_args[0][0]
        assert 'memory_context' in forwarded.metadata
        assert forwarded.metadata['memory_context']['context_key'] == 'context_value'

    def test_write_questions_creates_session_if_missing(self):
        store = PersistentMemoryStore(backend='memory')
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'new-sess'}

        inst.writeQuestions(question)
        # Session should now exist
        assert store.resume_session('new-sess')['ok'] is True

    def test_write_answers_stores_in_session(self):
        store = PersistentMemoryStore(backend='memory')
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        answer = MagicMock()
        answer.metadata = {'session_id': 'test-sess'}
        answer.getText.return_value = 'The answer is 42'

        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()

        # Check that answer was stored
        result = store.get('test-sess', 'last_answer')
        assert result['ok'] is True
        assert result['value'] == 'The answer is 42'

    def test_write_answers_uses_session_id_from_previous_question(self):
        store = PersistentMemoryStore(backend='memory')
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

    def test_write_answers_increments_count(self):
        store = PersistentMemoryStore(backend='memory')
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        for i in range(3):
            answer = MagicMock()
            answer.metadata = {'session_id': 'test-sess'}
            answer.getText.return_value = f'Answer {i}'
            inst.writeAnswers(answer)

        count = store.get('test-sess', 'answer_count')
        assert count['value'] == 3

    def test_open_clears_current_session_state(self):
        store = PersistentMemoryStore(backend='memory')
        store.create_session('test-sess')

        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'session_id': 'test-sess'}

        inst.writeQuestions(question)
        assert inst._current_session_id == 'test-sess'

        inst.open(MagicMock())
        assert inst._current_session_id is None

    def test_write_questions_no_session_id(self):
        store = PersistentMemoryStore(backend='memory')
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {}

        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()

    def test_write_answers_no_session_id(self):
        store = PersistentMemoryStore(backend='memory')
        inst = self._make_instance(store=store)
        answer = MagicMock()
        answer.metadata = {}

        inst.writeAnswers(answer)
        inst.instance.writeAnswers.assert_called_once()

    def test_deep_copy_prevents_question_mutation(self):
        store = PersistentMemoryStore(backend='memory')
        inst = self._make_instance(store=store)
        question = MagicMock()
        question.metadata = {'key': 'original'}

        inst.writeQuestions(question)
        # Original question metadata should not have memory_context
        # (the deep copy was modified, not the original)
        assert 'memory_context' not in question.metadata
