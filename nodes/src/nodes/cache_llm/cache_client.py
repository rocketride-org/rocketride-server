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

"""Cache client with Redis and in-memory backends for LLM response caching."""

import copy
import hashlib
import json
import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    import redis
except ImportError:
    redis = None  # type: ignore[assignment]


class CacheClient:
    """LLM response cache with pluggable Redis or in-memory backends."""

    def __init__(self, config: dict, bag: Any = None):
        """Initialize the cache client based on backend type.

        Args:
            config: Configuration dict with backend, ttl, max_size, and
                    Redis connection parameters (host, port, db, password).
            bag: Pipeline bag object (unused, kept for interface consistency).
        """
        self._backend = config.get('backend', 'memory')
        self._default_ttl = int(config.get('ttl', 3600))
        self._max_size = int(config.get('max_size', 1000))
        self._redis_client = None
        self._memory_store: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._key_prefix = 'rr:cache_llm:'

        if self._backend == 'redis':
            self._init_redis(config)

    def _init_redis(self, config: dict) -> None:
        """Initialize the Redis connection.

        Handles connection errors gracefully by falling back to no-cache mode.
        """
        try:
            if redis is None:
                return

            host = config.get('host', 'localhost')
            port = int(config.get('port', 6379))
            db = int(config.get('db', 0))
            password = config.get('password', None)

            # Treat empty string password as None
            if password == '':
                password = None

            self._redis_client = redis.Redis(
                host=host,
                port=port,
                db=db,
                password=password,
                decode_responses=True,
                socket_connect_timeout=5,
            )
            # Verify connectivity
            self._redis_client.ping()
        except Exception as e:
            logger.warning('Redis connection failed, falling back to no-cache: %s', e)
            self._redis_client = None

    @staticmethod
    def _generate_key(query: str, model: str = '', temperature: float = 0.0, system_prompt: str = '') -> str:
        """Generate a deterministic SHA256 cache key from normalized inputs.

        Note: Cache keys are **case-sensitive** by design. For example,
        "What is AI?" and "what is ai?" produce different keys. This is
        intentional because LLM responses can differ based on casing, and
        normalizing case would risk returning incorrect cached answers.

        Args:
            query: The question/prompt text.
            model: The LLM model name (or pipeline context identifier).
            temperature: The sampling temperature.
            system_prompt: The system prompt.

        Returns:
            A hex-encoded SHA256 hash string.
        """

        # Normalize inputs: convert None to empty string, strip whitespace,
        # collapse internal whitespace (but preserve case -- see docstring)
        def normalize(value: Any) -> str:
            if value is None:
                return ''
            s = str(value).strip()
            # Collapse whitespace sequences to single space
            return ' '.join(s.split())

        normalized_query = normalize(query)
        normalized_model = normalize(model)
        normalized_system = normalize(system_prompt)

        # Round temperature to 2 decimal places for floating point stability
        try:
            normalized_temp = str(round(float(temperature), 2)) if temperature is not None else '0.0'
        except (ValueError, TypeError):
            normalized_temp = '0.0'

        # Build a deterministic key payload with sorted fields
        payload = json.dumps(
            {
                'model': normalized_model,
                'query': normalized_query,
                'system_prompt': normalized_system,
                'temperature': normalized_temp,
            },
            sort_keys=True,
            ensure_ascii=True,
        )

        return hashlib.sha256(payload.encode('utf-8')).hexdigest()

    def get(self, key: str) -> Optional[dict]:
        """Retrieve a cached response.

        Args:
            key: The cache key (SHA256 hash).

        Returns:
            A deep copy of the cached response dict, or None on miss.
        """
        if self._backend == 'redis':
            return self._redis_get(key)
        return self._memory_get(key)

    def set(self, key: str, response: dict, ttl: Optional[int] = None) -> None:
        """Store a response in the cache.

        Args:
            key: The cache key (SHA256 hash).
            response: The response dict to cache.
            ttl: Time-to-live in seconds. Uses default if not specified.
        """
        if ttl is None:
            ttl = self._default_ttl

        if self._backend == 'redis':
            self._redis_set(key, response, ttl)
        else:
            self._memory_set(key, response, ttl)

    def invalidate(self, key: str) -> None:
        """Remove a specific cached entry.

        Args:
            key: The cache key to remove.
        """
        if self._backend == 'redis':
            self._redis_invalidate(key)
        else:
            self._memory_invalidate(key)

    def clear(self) -> None:
        """Flush all cached entries."""
        if self._backend == 'redis':
            self._redis_clear()
        else:
            self._memory_clear()

    # -------------------------------------------------------------------------
    # Redis backend
    # -------------------------------------------------------------------------

    def _redis_get(self, key: str) -> Optional[dict]:
        """Get from Redis, returning None on any error."""
        if self._redis_client is None:
            return None
        try:
            raw = self._redis_client.get(self._key_prefix + key)
            if raw is None:
                return None
            return json.loads(raw)
        except Exception as e:
            logger.warning('Redis GET failed, treating as cache miss: %s', e)
            return None

    def _redis_set(self, key: str, response: dict, ttl: int) -> None:
        """Set in Redis, logging errors but not raising."""
        if self._redis_client is None:
            return
        try:
            serialized = json.dumps(response, ensure_ascii=True)
            self._redis_client.setex(self._key_prefix + key, ttl, serialized)
        except Exception as e:
            logger.warning('Redis SET failed, response will not be cached: %s', e)

    def _redis_invalidate(self, key: str) -> None:
        """Delete a key from Redis."""
        if self._redis_client is None:
            return
        try:
            self._redis_client.delete(self._key_prefix + key)
        except Exception as e:
            logger.warning('Redis DELETE failed: %s', e)

    def _redis_clear(self) -> None:
        """Delete all keys with our prefix from Redis."""
        if self._redis_client is None:
            return
        try:
            cursor = 0
            while True:
                cursor, keys = self._redis_client.scan(cursor, match=self._key_prefix + '*', count=100)
                if keys:
                    self._redis_client.delete(*keys)
                if cursor == 0:
                    break
        except Exception as e:
            logger.warning('Redis CLEAR (SCAN+DELETE) failed: %s', e)

    # -------------------------------------------------------------------------
    # In-memory backend
    # -------------------------------------------------------------------------

    def _memory_get(self, key: str) -> Optional[dict]:
        """Get from in-memory store with lazy TTL eviction."""
        with self._lock:
            entry = self._memory_store.get(key)
            if entry is None:
                return None

            # Check TTL expiry
            if entry['expires_at'] <= time.monotonic():
                del self._memory_store[key]
                return None

            # Return a deep copy to prevent mutation of cached data
            return copy.deepcopy(entry['response'])

    def _memory_set(self, key: str, response: dict, ttl: int) -> None:
        """Set in in-memory store, enforcing max_size with LRU-style eviction."""
        with self._lock:
            # If key already exists, update it in place (no size change)
            if key in self._memory_store:
                self._memory_store[key] = {
                    'response': copy.deepcopy(response),
                    'expires_at': time.monotonic() + ttl,
                    'created_at': time.monotonic(),
                }
                return

            # Evict expired entries first
            self._evict_expired()

            # If still at capacity, evict the oldest entry
            while len(self._memory_store) >= self._max_size:
                oldest_key = min(self._memory_store, key=lambda k: self._memory_store[k]['created_at'])
                del self._memory_store[oldest_key]

            self._memory_store[key] = {
                'response': copy.deepcopy(response),
                'expires_at': time.monotonic() + ttl,
                'created_at': time.monotonic(),
            }

    def _memory_invalidate(self, key: str) -> None:
        """Remove a key from in-memory store."""
        with self._lock:
            self._memory_store.pop(key, None)

    def _memory_clear(self) -> None:
        """Clear all entries from in-memory store."""
        with self._lock:
            self._memory_store.clear()

    def _evict_expired(self) -> None:
        """Remove all expired entries. Must be called under self._lock."""
        now = time.monotonic()
        expired = [k for k, v in self._memory_store.items() if v['expires_at'] <= now]
        for k in expired:
            del self._memory_store[k]
