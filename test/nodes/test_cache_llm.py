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

"""Unit tests for cache_llm node -- no real Redis required."""

import sys
import threading
import time
import types
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

# ---------------------------------------------------------------------------
# Mock external dependencies that are not available in test environment
# ---------------------------------------------------------------------------

# Mock rocketlib
_mock_rocketlib = types.ModuleType('rocketlib')
_mock_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
_mock_rocketlib.IGlobalBase = type('IGlobalBase', (), {})
_mock_rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'CONFIG'})()
_mock_rocketlib.warning = lambda msg: None
sys.modules.setdefault('rocketlib', _mock_rocketlib)

# Mock ai.common.schema
_mock_ai = types.ModuleType('ai')
_mock_ai_common = types.ModuleType('ai.common')
_mock_ai_common_schema = types.ModuleType('ai.common.schema')
_mock_ai_common_schema.Question = MagicMock
_mock_ai_common_schema.Answer = MagicMock
_mock_ai_common_config = types.ModuleType('ai.common.config')
_mock_ai_common_config.Config = MagicMock()
_mock_ai.common = _mock_ai_common
_mock_ai_common.schema = _mock_ai_common_schema
_mock_ai_common.config = _mock_ai_common_config
sys.modules.setdefault('ai', _mock_ai)
sys.modules.setdefault('ai.common', _mock_ai_common)
sys.modules.setdefault('ai.common.schema', _mock_ai_common_schema)
sys.modules.setdefault('ai.common.config', _mock_ai_common_config)

# Add source paths so we can import the node directly
NODES_SRC = Path(__file__).parent.parent.parent / 'nodes' / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


# =============================================================================
# Cache key generation tests
# =============================================================================


class TestCacheKeyGeneration:
    """Tests for CacheClient._generate_key determinism and edge cases."""

    def _generate_key(self, *args, **kwargs):
        from cache_llm.cache_client import CacheClient

        return CacheClient._generate_key(*args, **kwargs)

    def test_same_inputs_produce_same_key(self):
        """Identical inputs must always produce the same cache key."""
        key1 = self._generate_key('What is AI?', 'gpt-5', 0.7, 'You are helpful.')
        key2 = self._generate_key('What is AI?', 'gpt-5', 0.7, 'You are helpful.')
        assert key1 == key2

    def test_different_queries_produce_different_keys(self):
        """Different query text must produce different keys."""
        key1 = self._generate_key('What is AI?', 'gpt-5', 0.7)
        key2 = self._generate_key('What is ML?', 'gpt-5', 0.7)
        assert key1 != key2

    def test_different_models_produce_different_keys(self):
        """Different model names must produce different keys."""
        key1 = self._generate_key('Hello', 'gpt-5', 0.7)
        key2 = self._generate_key('Hello', 'gpt-4o', 0.7)
        assert key1 != key2

    def test_different_temperatures_produce_different_keys(self):
        """Different temperatures must produce different keys."""
        key1 = self._generate_key('Hello', 'gpt-5', 0.0)
        key2 = self._generate_key('Hello', 'gpt-5', 1.0)
        assert key1 != key2

    def test_different_system_prompts_produce_different_keys(self):
        """Different system prompts must produce different keys."""
        key1 = self._generate_key('Hello', 'gpt-5', 0.7, 'Be brief.')
        key2 = self._generate_key('Hello', 'gpt-5', 0.7, 'Be verbose.')
        assert key1 != key2

    def test_none_values_handled(self):
        """None values should not raise and should produce a valid key."""
        key = self._generate_key(None, None, None, None)
        assert isinstance(key, str)
        assert len(key) == 64  # SHA256 hex length

    def test_empty_strings_handled(self):
        """Empty strings should produce a valid key."""
        key = self._generate_key('', '', 0.0, '')
        assert isinstance(key, str)
        assert len(key) == 64

    def test_unicode_inputs(self):
        """Unicode text should produce deterministic keys."""
        key1 = self._generate_key("Qu'est-ce que l'IA?", 'gpt-5', 0.7)
        key2 = self._generate_key("Qu'est-ce que l'IA?", 'gpt-5', 0.7)
        assert key1 == key2

    def test_whitespace_normalization(self):
        """Extra whitespace should be normalized so equivalent queries match."""
        key1 = self._generate_key('What  is   AI?', 'gpt-5', 0.7)
        key2 = self._generate_key('What is AI?', 'gpt-5', 0.7)
        assert key1 == key2

    def test_leading_trailing_whitespace_normalized(self):
        """Leading/trailing whitespace should be stripped."""
        key1 = self._generate_key('  Hello  ', 'gpt-5', 0.7)
        key2 = self._generate_key('Hello', 'gpt-5', 0.7)
        assert key1 == key2

    def test_key_is_sha256_hex(self):
        """Key should be a 64-char lowercase hex string (SHA256)."""
        key = self._generate_key('test', 'model', 0.5, 'prompt')
        assert len(key) == 64
        assert all(c in '0123456789abcdef' for c in key)

    def test_float_temperature_stability(self):
        """Floating point representations should produce stable keys."""
        key1 = self._generate_key('Hello', 'gpt-5', 0.7)
        key2 = self._generate_key('Hello', 'gpt-5', 0.70)
        assert key1 == key2


# =============================================================================
# Memory backend tests
# =============================================================================


class TestMemoryBackend:
    """Tests for the in-memory cache backend."""

    def _make_client(self, ttl=3600, max_size=1000):
        from cache_llm.cache_client import CacheClient

        return CacheClient({'backend': 'memory', 'ttl': ttl, 'max_size': max_size})

    def test_set_and_get(self):
        """Basic set/get should store and retrieve a response."""
        client = self._make_client()
        response = {'answer': 'Paris', 'expectJson': False}
        client.set('key1', response)
        result = client.get('key1')
        assert result == response

    def test_get_returns_none_on_miss(self):
        """Get on a nonexistent key should return None."""
        client = self._make_client()
        assert client.get('nonexistent') is None

    def test_invalidate_removes_entry(self):
        """Invalidate should remove a specific cached entry."""
        client = self._make_client()
        client.set('key1', {'answer': 'test'})
        client.invalidate('key1')
        assert client.get('key1') is None

    def test_invalidate_nonexistent_key_does_not_raise(self):
        """Invalidating a key that does not exist should not raise."""
        client = self._make_client()
        client.invalidate('nonexistent')  # Should not raise

    def test_clear_removes_all_entries(self):
        """Clear should flush all cached entries."""
        client = self._make_client()
        client.set('key1', {'answer': 'a'})
        client.set('key2', {'answer': 'b'})
        client.clear()
        assert client.get('key1') is None
        assert client.get('key2') is None

    def test_ttl_expiry(self):
        """Entries should expire after TTL elapses."""
        client = self._make_client(ttl=1)
        client.set('key1', {'answer': 'test'}, ttl=1)

        # Immediately after setting, it should be present
        assert client.get('key1') is not None

        # Wait for TTL to expire
        time.sleep(1.1)
        assert client.get('key1') is None

    def test_max_size_eviction(self):
        """Memory backend should evict oldest entries when at capacity."""
        client = self._make_client(max_size=3)
        client.set('key1', {'answer': '1'})
        client.set('key2', {'answer': '2'})
        client.set('key3', {'answer': '3'})

        # Adding a 4th entry should evict the oldest
        client.set('key4', {'answer': '4'})

        # key1 (oldest) should be evicted
        assert client.get('key1') is None
        assert client.get('key4') is not None

    def test_deep_copy_prevents_mutation(self):
        """Cached responses should be deep copied so mutations don't affect the cache."""
        client = self._make_client()
        original = {'answer': 'test', 'nested': {'key': 'value'}}
        client.set('key1', original)

        # Mutate the original
        original['nested']['key'] = 'mutated'

        # Cached copy should be unaffected
        cached = client.get('key1')
        assert cached['nested']['key'] == 'value'

    def test_get_returns_deep_copy(self):
        """Each get should return a deep copy so callers cannot mutate the cache."""
        client = self._make_client()
        client.set('key1', {'answer': 'test', 'nested': {'key': 'value'}})

        result1 = client.get('key1')
        result1['nested']['key'] = 'mutated'

        result2 = client.get('key1')
        assert result2['nested']['key'] == 'value'

    def test_update_existing_key(self):
        """Updating an existing key should replace the cached value."""
        client = self._make_client()
        client.set('key1', {'answer': 'old'})
        client.set('key1', {'answer': 'new'})
        result = client.get('key1')
        assert result['answer'] == 'new'


# =============================================================================
# Redis backend tests (mocked)
# =============================================================================


class TestRedisBackend:
    """Tests for the Redis cache backend with mocked redis client."""

    def _make_client_with_mock(self):
        from cache_llm.cache_client import CacheClient

        mock_redis_instance = MagicMock()
        mock_redis_instance.ping.return_value = True

        mock_redis_module = MagicMock()
        mock_redis_module.Redis.return_value = mock_redis_instance

        with patch.dict('sys.modules', {'redis': mock_redis_module}):
            # Also patch the module-level redis reference in cache_client
            with patch('cache_llm.cache_client.redis', mock_redis_module):
                client = CacheClient({'backend': 'redis', 'host': 'localhost', 'port': 6379, 'db': 0, 'password': ''})

        # Assign the mock so we can inspect calls
        client._redis_client = mock_redis_instance
        return client, mock_redis_instance

    def test_redis_set_calls_setex(self):
        """Setting a value should call setex with the key prefix, TTL, and JSON payload."""
        client, mock_redis = self._make_client_with_mock()
        client.set('abc123', {'answer': 'test'}, ttl=300)
        mock_redis.setex.assert_called_once()
        args = mock_redis.setex.call_args
        assert 'rr:cache_llm:abc123' == args[0][0]
        assert 300 == args[0][1]

    def test_redis_get_returns_parsed_json(self):
        """Getting a value should parse the JSON stored in Redis."""
        client, mock_redis = self._make_client_with_mock()
        mock_redis.get.return_value = '{"answer": "Paris", "expectJson": false}'
        result = client.get('abc123')
        assert result == {'answer': 'Paris', 'expectJson': False}
        mock_redis.get.assert_called_once_with('rr:cache_llm:abc123')

    def test_redis_get_returns_none_on_miss(self):
        """Getting a nonexistent key from Redis should return None."""
        client, mock_redis = self._make_client_with_mock()
        mock_redis.get.return_value = None
        assert client.get('nonexistent') is None

    def test_redis_invalidate_calls_delete(self):
        """Invalidating a key should call delete on the Redis client."""
        client, mock_redis = self._make_client_with_mock()
        client.invalidate('abc123')
        mock_redis.delete.assert_called_once_with('rr:cache_llm:abc123')

    def test_redis_clear_scans_and_deletes(self):
        """Clear should scan for all prefixed keys and delete them."""
        client, mock_redis = self._make_client_with_mock()
        mock_redis.scan.return_value = (0, ['rr:cache_llm:key1', 'rr:cache_llm:key2'])
        client.clear()
        mock_redis.scan.assert_called()
        mock_redis.delete.assert_called_once_with('rr:cache_llm:key1', 'rr:cache_llm:key2')

    def test_redis_connection_failure_falls_back_gracefully(self):
        """If Redis connection fails, the client should fall back to no-cache mode."""
        from cache_llm.cache_client import CacheClient

        mock_redis_module = MagicMock()
        mock_redis_instance = MagicMock()
        mock_redis_instance.ping.side_effect = ConnectionError('Connection refused')
        mock_redis_module.Redis.return_value = mock_redis_instance

        with patch.dict('sys.modules', {'redis': mock_redis_module}):
            with patch('cache_llm.cache_client.redis', mock_redis_module):
                client = CacheClient({'backend': 'redis', 'host': 'badhost', 'port': 6379})

        assert client._redis_client is None
        # Operations should return None / not raise
        assert client.get('key') is None
        client.set('key', {'answer': 'test'})  # Should not raise
        client.invalidate('key')  # Should not raise
        client.clear()  # Should not raise

    def test_redis_get_error_returns_none(self):
        """If Redis raises during get, return None instead of crashing."""
        client, mock_redis = self._make_client_with_mock()
        mock_redis.get.side_effect = Exception('Redis error')
        assert client.get('key') is None


# =============================================================================
# Thread safety tests
# =============================================================================


class TestThreadSafety:
    """Tests for thread safety of the in-memory backend."""

    def test_concurrent_set_and_get(self):
        """Concurrent set/get operations should not corrupt the cache."""
        from cache_llm.cache_client import CacheClient

        client = CacheClient({'backend': 'memory', 'ttl': 3600, 'max_size': 10000})
        errors = []

        def writer(thread_id):
            try:
                for i in range(100):
                    key = f'thread-{thread_id}-key-{i}'
                    client.set(key, {'answer': f'response-{thread_id}-{i}'})
            except Exception as e:
                errors.append(e)

        def reader(thread_id):
            try:
                for i in range(100):
                    key = f'thread-{thread_id}-key-{i}'
                    client.get(key)  # May or may not find it
            except Exception as e:
                errors.append(e)

        threads = []
        for tid in range(5):
            threads.append(threading.Thread(target=writer, args=(tid,)))
            threads.append(threading.Thread(target=reader, args=(tid,)))

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0, f'Thread safety errors: {errors}'

    def test_concurrent_set_respects_max_size(self):
        """Concurrent writes should not exceed max_size."""
        from cache_llm.cache_client import CacheClient

        client = CacheClient({'backend': 'memory', 'ttl': 3600, 'max_size': 50})
        barrier = threading.Barrier(5)

        def writer(thread_id):
            barrier.wait()
            for i in range(20):
                client.set(f't{thread_id}-{i}', {'answer': str(i)})

        threads = [threading.Thread(target=writer, args=(tid,)) for tid in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # The store should never exceed max_size
        assert len(client._memory_store) <= 50


# =============================================================================
# Cache hit / miss path tests (IInstance integration)
# =============================================================================


class TestCacheHitPath:
    """Tests for cache hit behavior -- returns cached answer without calling downstream."""

    def test_cache_hit_writes_answer_directly(self):
        """On a cache hit, writeAnswers should be called and writeQuestions should NOT be called downstream."""
        from cache_llm.cache_client import CacheClient
        from cache_llm.IInstance import IInstance

        # Create mock instance
        inst = IInstance()
        iglobal = Mock()
        iglobal.cache = CacheClient({'backend': 'memory', 'ttl': 3600, 'max_size': 1000})
        iglobal.cache_hits = 0
        iglobal.cache_misses = 0
        inst.IGlobal = iglobal
        inst.instance = Mock()

        # Pre-populate cache
        cache_key = CacheClient._generate_key('What is AI?', '', 0.0, '')
        iglobal.cache.set(cache_key, {'answer': 'Artificial Intelligence', 'expectJson': False})

        # Build a mock question
        question = Mock()
        question_text = Mock()
        question_text.text = 'What is AI?'
        question.questions = [question_text]
        question.role = ''

        # Call writeQuestions
        inst.writeQuestions(question)

        # Should have written answers, not questions
        inst.instance.writeAnswers.assert_called_once()
        inst.instance.writeQuestions.assert_not_called()
        assert iglobal.cache_hits == 1
        assert iglobal.cache_misses == 0


class TestCacheMissPath:
    """Tests for cache miss behavior -- passes through and caches response."""

    def test_cache_miss_passes_question_through(self):
        """On a cache miss, the question should be forwarded downstream."""
        from cache_llm.cache_client import CacheClient
        from cache_llm.IInstance import IInstance

        inst = IInstance()
        iglobal = Mock()
        iglobal.cache = CacheClient({'backend': 'memory', 'ttl': 3600, 'max_size': 1000})
        iglobal.cache_hits = 0
        iglobal.cache_misses = 0
        inst.IGlobal = iglobal
        inst.instance = Mock()

        # Build a mock question (cache is empty, so this will be a miss)
        question = Mock()
        question_text = Mock()
        question_text.text = 'What is ML?'
        question.questions = [question_text]
        question.role = ''

        inst.writeQuestions(question)

        # Should have forwarded the question, not written an answer
        inst.instance.writeQuestions.assert_called_once_with(question)
        inst.instance.writeAnswers.assert_not_called()
        assert iglobal.cache_misses == 1
        assert iglobal.cache_hits == 0

    def test_write_answers_caches_response(self):
        """Verify writeAnswers caches the response and forwards it."""
        from cache_llm.cache_client import CacheClient
        from cache_llm.IInstance import IInstance

        inst = IInstance()
        iglobal = Mock()
        cache = CacheClient({'backend': 'memory', 'ttl': 3600, 'max_size': 1000})
        iglobal.cache = cache
        iglobal.cache_hits = 0
        iglobal.cache_misses = 0
        inst.IGlobal = iglobal
        inst.instance = Mock()

        # Simulate the miss path setting a pending cache key
        inst._pending_cache_key = 'test_key_123'

        # Build a mock answer
        answer = Mock()
        answer.answer = 'Machine Learning is a subset of AI.'
        answer.expectJson = False

        inst.writeAnswers(answer)

        # Should have cached and forwarded
        cached = cache.get('test_key_123')
        assert cached is not None
        assert cached['answer'] == 'Machine Learning is a subset of AI.'
        inst.instance.writeAnswers.assert_called_once_with(answer)

        # Pending key should be cleared
        assert inst._pending_cache_key is None

    def test_no_cache_passes_through(self):
        """When cache is None (e.g., Redis failed), questions pass through without error."""
        from cache_llm.IInstance import IInstance

        inst = IInstance()
        iglobal = Mock()
        iglobal.cache = None
        inst.IGlobal = iglobal
        inst.instance = Mock()

        question = Mock()
        question.questions = [Mock(text='test')]
        question.role = ''

        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once_with(question)


# =============================================================================
# IGlobal lifecycle tests
# =============================================================================


class TestIGlobalLifecycle:
    """Tests for IGlobal initialization and cleanup."""

    def test_begin_global_creates_cache_client(self):
        """Verify beginGlobal creates a CacheClient when not in CONFIG mode."""
        from cache_llm.IGlobal import IGlobal

        iglobal = IGlobal()

        # Mock the endpoint
        endpoint_mock = Mock()
        endpoint_mock.endpoint.openMode = 'RUN'  # Not CONFIG
        endpoint_mock.endpoint.bag = {}
        iglobal.IEndpoint = endpoint_mock

        # Mock glb
        iglobal.glb = Mock()
        iglobal.glb.logicalType = 'cache_llm'
        iglobal.glb.connConfig = {'backend': 'memory', 'ttl': '3600', 'max_size': '1000'}

        # Mock Config.getNodeConfig to return our config directly
        with patch('cache_llm.IGlobal.Config') as mock_config:
            mock_config.getNodeConfig.return_value = {'backend': 'memory', 'ttl': '3600', 'max_size': '1000'}
            iglobal.beginGlobal()

        assert iglobal.cache is not None
        assert iglobal.cache_hits == 0
        assert iglobal.cache_misses == 0

    def test_begin_global_config_mode_skips_init(self):
        """Verify beginGlobal in CONFIG mode does not create a CacheClient."""
        from cache_llm.IGlobal import IGlobal

        iglobal = IGlobal()

        endpoint_mock = Mock()
        iglobal.IEndpoint = endpoint_mock

        # Patch OPEN_MODE so we can match the equality check
        with patch('cache_llm.IGlobal.OPEN_MODE') as mock_open_mode:
            endpoint_mock.endpoint.openMode = mock_open_mode.CONFIG
            iglobal.beginGlobal()

        assert iglobal.cache is None

    def test_end_global_cleans_up(self):
        """Verify endGlobal sets cache to None."""
        from cache_llm.IGlobal import IGlobal

        iglobal = IGlobal()
        iglobal.cache = Mock()
        iglobal.endGlobal()
        assert iglobal.cache is None
