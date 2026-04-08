# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent cross-session memory store with pluggable backends.

Supports Redis for production and an in-memory backend for testing.
All operations are thread-safe and return deep copies to prevent mutation.
"""

from __future__ import annotations

import copy
import json
import re
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Session ID validation
# ---------------------------------------------------------------------------

_SESSION_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]{1,128}$')
_KEY_RE = re.compile(r'^[a-zA-Z0-9_\-\.]{1,256}$')


def _validate_session_id(session_id: str) -> None:
    """Validate session_id to prevent path traversal or injection in Redis keys."""
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise ValueError(f'Invalid session_id: {session_id!r}. Must be 1-128 alphanumeric characters, hyphens, or underscores.')


def _validate_key(key: str) -> None:
    """Validate a memory key."""
    if not isinstance(key, str) or not _KEY_RE.match(key):
        raise ValueError(f'Invalid key: {key!r}. Must be 1-256 alphanumeric characters, hyphens, underscores, or dots.')


# ---------------------------------------------------------------------------
# Backend interface
# ---------------------------------------------------------------------------


class MemoryBackend(ABC):
    """Abstract backend for persistent memory storage."""

    @abstractmethod
    def create_session(self, session_id: str, ttl_seconds: Optional[int] = None) -> Dict[str, Any]:
        """Create a new session. Returns metadata about the session."""

    @abstractmethod
    def resume_session(self, session_id: str) -> Dict[str, Any]:
        """Resume an existing session. Raises if not found."""

    @abstractmethod
    def list_sessions(self) -> List[str]:
        """Return all active session IDs."""

    @abstractmethod
    def delete_session(self, session_id: str) -> Dict[str, Any]:
        """Delete a session and all its data."""

    @abstractmethod
    def put(self, session_id: str, key: str, value: Any) -> Dict[str, Any]:
        """Store a value under a key in the given session."""

    @abstractmethod
    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        """Retrieve a value by key from the given session."""

    @abstractmethod
    def list_keys(self, session_id: str) -> Dict[str, Any]:
        """List all keys in the given session."""

    @abstractmethod
    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        """Clear a specific key or all keys in a session."""

    @abstractmethod
    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        """Return the most recent history entries for a session."""

    @abstractmethod
    def replace_history(self, session_id: str, entries: List[Dict[str, Any]]) -> None:
        """Replace all history entries for a session with the given list."""

    def increment(self, session_id: str, key: str, amount: int = 1) -> Dict[str, Any]:
        """Atomically increment a numeric value. Default uses get+put; backends may override."""
        result = self.get(session_id, key)
        current = result.get('value', 0) if result.get('ok') else 0
        new_value = current + amount
        return self.put(session_id, key, new_value)

    def close(self) -> None:
        """Release any resources held by the backend. No-op by default."""


# ---------------------------------------------------------------------------
# InMemory backend (for testing)
# ---------------------------------------------------------------------------

_MAX_INMEMORY_SESSIONS = 1000


class InMemoryBackend(MemoryBackend):
    """Thread-safe in-memory backend for testing and development."""

    def __init__(self) -> None:
        """Initialize empty session stores with a threading lock."""
        self._lock = threading.Lock()
        # {session_id: {key: value}}
        self._sessions: Dict[str, Dict[str, Any]] = {}
        # {session_id: [history_entry, ...]}
        self._history: Dict[str, List[Dict[str, Any]]] = {}
        # {session_id: created_at_timestamp}
        self._metadata: Dict[str, Dict[str, Any]] = {}

    def _expire_if_needed(self, session_id: str) -> bool:
        """Check and remove an expired session. Must be called while holding ``_lock``.

        Returns ``True`` if the session was expired and removed.
        """
        meta = self._metadata.get(session_id)
        if meta and meta.get('expires_at') and time.time() > meta['expires_at']:
            self._sessions.pop(session_id, None)
            self._history.pop(session_id, None)
            self._metadata.pop(session_id, None)
            return True
        return False

    def create_session(self, session_id: str, ttl_seconds: Optional[int] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if session_id in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} already exists'}
            if len(self._sessions) >= _MAX_INMEMORY_SESSIONS:
                return {'ok': False, 'error': f'Maximum sessions ({_MAX_INMEMORY_SESSIONS}) reached'}
            now = time.time()
            self._sessions[session_id] = {}
            self._history[session_id] = []
            self._metadata[session_id] = {
                'created_at': now,
                'ttl_seconds': ttl_seconds,
                'expires_at': (now + ttl_seconds) if ttl_seconds else None,
            }
            return {'ok': True, 'session_id': session_id}

    def resume_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            meta = self._metadata[session_id]
            if meta.get('expires_at') and time.time() > meta['expires_at']:
                # Session expired — clean it up
                self._sessions.pop(session_id, None)
                self._history.pop(session_id, None)
                self._metadata.pop(session_id, None)
                return {'ok': False, 'error': f'Session {session_id!r} has expired'}
            return {'ok': True, 'session_id': session_id, 'key_count': len(self._sessions[session_id])}

    def list_sessions(self) -> List[str]:
        with self._lock:
            # Prune expired sessions
            now = time.time()
            expired = [sid for sid, meta in self._metadata.items() if meta.get('expires_at') and now > meta['expires_at']]
            for sid in expired:
                self._sessions.pop(sid, None)
                self._history.pop(sid, None)
                self._metadata.pop(sid, None)
            return sorted(self._sessions.keys())

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            keys_cleared = sorted(self._sessions[session_id].keys())
            self._sessions.pop(session_id, None)
            self._history.pop(session_id, None)
            self._metadata.pop(session_id, None)
            return {'ok': True, 'session_id': session_id, 'keys_cleared': keys_cleared}

    def put(self, session_id: str, key: str, value: Any) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            self._sessions[session_id][key] = copy.deepcopy(value)
            self._history[session_id].append(
                {
                    'op': 'put',
                    'key': key,
                    'timestamp': time.time(),
                }
            )
            return {'ok': True, 'session_id': session_id, 'key': key}

    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            store = self._sessions[session_id]
            if key not in store:
                return {'ok': False, 'session_id': session_id, 'key': key, 'value': None}
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': copy.deepcopy(store[key])}

    def list_keys(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            return {'ok': True, 'session_id': session_id, 'keys': sorted(self._sessions[session_id].keys())}

    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        if key is not None:
            _validate_key(key)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            store = self._sessions[session_id]
            if key:
                removed = key in store
                store.pop(key, None)
                cleared = [key] if removed else []
            else:
                cleared = sorted(store.keys())
                store.clear()
            self._history[session_id].append(
                {
                    'op': 'clear',
                    'key': key,
                    'cleared': cleared,
                    'timestamp': time.time(),
                }
            )
            return {'ok': True, 'session_id': session_id, 'cleared': cleared}

    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            history = self._history.get(session_id, [])
            # Return most recent entries (tail)
            entries = history[-limit:] if limit > 0 else history
            return {'ok': True, 'session_id': session_id, 'entries': copy.deepcopy(entries)}

    def increment(self, session_id: str, key: str, amount: int = 1) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if self._expire_if_needed(session_id) or session_id not in self._sessions:
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            current = self._sessions[session_id].get(key, 0)
            new_value = current + amount
            self._sessions[session_id][key] = new_value
            self._history[session_id].append(
                {
                    'op': 'put',
                    'key': key,
                    'timestamp': time.time(),
                }
            )
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': new_value}

    def replace_history(self, session_id: str, entries: List[Dict[str, Any]]) -> None:
        with self._lock:
            if session_id in self._history:
                self._history[session_id] = copy.deepcopy(entries)


# ---------------------------------------------------------------------------
# Redis backend
# ---------------------------------------------------------------------------

_REDIS_PREFIX = 'rr:memory'
_REDIS_SESSIONS_KEY = f'{_REDIS_PREFIX}:__sessions__'


class RedisBackend(MemoryBackend):
    """Redis-backed persistent memory store.

    Key layout:
        rr:memory:{session_id}:{key}   — stored values (JSON-serialized)
        rr:memory:{session_id}:__keys__  — set of keys in session
        rr:memory:{session_id}:__history__ — list of history entries
        rr:memory:{session_id}:__meta__   — hash with session metadata
        rr:memory:__sessions__            — set of all session IDs
    """

    def __init__(self, host: str = 'localhost', port: int = 6379, password: Optional[str] = None, **kwargs: Any) -> None:
        """Connect to Redis with the given host, port, and optional password."""
        import redis as redis_lib

        self._client = redis_lib.Redis(
            host=host,
            port=port,
            password=password,
            decode_responses=True,
            **kwargs,
        )
        self._lock = threading.Lock()

    def _data_key(self, session_id: str, key: str) -> str:
        return f'{_REDIS_PREFIX}:{session_id}:{key}'

    def _keys_key(self, session_id: str) -> str:
        return f'{_REDIS_PREFIX}:{session_id}:__keys__'

    def _history_key(self, session_id: str) -> str:
        return f'{_REDIS_PREFIX}:{session_id}:__history__'

    def _meta_key(self, session_id: str) -> str:
        return f'{_REDIS_PREFIX}:{session_id}:__meta__'

    def _set_ttl(self, session_id: str, ttl_seconds: Optional[int]) -> None:
        """Apply TTL to all keys belonging to a session."""
        if ttl_seconds is None or ttl_seconds <= 0:
            return
        keys_to_expire = [
            self._keys_key(session_id),
            self._history_key(session_id),
            self._meta_key(session_id),
        ]
        # Also expire all data keys
        members = self._client.smembers(self._keys_key(session_id))
        keys_to_expire.extend(self._data_key(session_id, member) for member in members)
        for k in keys_to_expire:
            self._client.expire(k, ttl_seconds)

    def _get_ttl_seconds(self, session_id: str) -> Optional[int]:
        """Retrieve the TTL for a session from metadata."""
        raw = self._client.hget(self._meta_key(session_id), 'ttl_seconds')
        if raw and raw != 'None':
            return int(raw)
        return None

    def create_session(self, session_id: str, ttl_seconds: Optional[int] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} already exists'}
            now = time.time()
            pipe = self._client.pipeline()
            pipe.sadd(_REDIS_SESSIONS_KEY, session_id)
            pipe.hset(
                self._meta_key(session_id),
                mapping={
                    'created_at': str(now),
                    'ttl_seconds': str(ttl_seconds) if ttl_seconds else 'None',
                },
            )
            pipe.execute()
            if ttl_seconds:
                self._set_ttl(session_id, ttl_seconds)
            return {'ok': True, 'session_id': session_id}

    def resume_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            # Check if meta key still exists (TTL may have expired it)
            if not self._client.exists(self._meta_key(session_id)):
                # Clean up stale session reference
                self._client.srem(_REDIS_SESSIONS_KEY, session_id)
                return {'ok': False, 'error': f'Session {session_id!r} has expired'}
            key_count = self._client.scard(self._keys_key(session_id))
            return {'ok': True, 'session_id': session_id, 'key_count': key_count}

    def list_sessions(self) -> List[str]:
        with self._lock:
            members = self._client.smembers(_REDIS_SESSIONS_KEY)
            # Prune sessions whose metadata has expired
            active = []
            stale = []
            for sid in members:
                if self._client.exists(self._meta_key(sid)):
                    active.append(sid)
                else:
                    stale.append(sid)
            if stale:
                self._client.srem(_REDIS_SESSIONS_KEY, *stale)
            return sorted(active)

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            # Gather all data keys
            members = self._client.smembers(self._keys_key(session_id))
            keys_to_delete = [
                *[self._data_key(session_id, m) for m in members],
                self._keys_key(session_id),
                self._history_key(session_id),
                self._meta_key(session_id),
            ]
            pipe = self._client.pipeline()
            for k in keys_to_delete:
                pipe.delete(k)
            pipe.srem(_REDIS_SESSIONS_KEY, session_id)
            pipe.execute()
            return {'ok': True, 'session_id': session_id, 'keys_cleared': sorted(members)}

    def put(self, session_id: str, key: str, value: Any) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            # Guard against reviving an expired session whose meta key has
            # already been evicted by Redis TTL but whose session ID is still
            # in the global sessions set.
            remaining_ms = self._client.pttl(self._meta_key(session_id))
            if remaining_ms == -2:
                self._client.srem(_REDIS_SESSIONS_KEY, session_id)
                return {'ok': False, 'error': f'Session {session_id!r} has expired'}
            serialized = json.dumps(value)
            pipe = self._client.pipeline()
            pipe.set(self._data_key(session_id, key), serialized)
            pipe.sadd(self._keys_key(session_id), key)
            pipe.rpush(
                self._history_key(session_id),
                json.dumps(
                    {
                        'op': 'put',
                        'key': key,
                        'timestamp': time.time(),
                    }
                ),
            )
            pipe.execute()
            # Align new key's expiry with the session metadata key's
            # remaining TTL so it doesn't outlive the session.
            remaining_ms = self._client.pttl(self._meta_key(session_id))
            if remaining_ms and remaining_ms > 0:
                self._client.pexpire(self._data_key(session_id, key), remaining_ms)
                self._client.pexpire(self._keys_key(session_id), remaining_ms)
                self._client.pexpire(self._history_key(session_id), remaining_ms)
            return {'ok': True, 'session_id': session_id, 'key': key}

    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            raw = self._client.get(self._data_key(session_id, key))
            if raw is None:
                return {'ok': False, 'session_id': session_id, 'key': key, 'value': None}
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': json.loads(raw)}

    def list_keys(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            members = self._client.smembers(self._keys_key(session_id))
            return {'ok': True, 'session_id': session_id, 'keys': sorted(members)}

    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        if key is not None:
            _validate_key(key)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            if key:
                existed = self._client.exists(self._data_key(session_id, key))
                pipe = self._client.pipeline()
                pipe.delete(self._data_key(session_id, key))
                pipe.srem(self._keys_key(session_id), key)
                pipe.rpush(
                    self._history_key(session_id),
                    json.dumps(
                        {
                            'op': 'clear',
                            'key': key,
                            'timestamp': time.time(),
                        }
                    ),
                )
                pipe.execute()
                cleared = [key] if existed else []
            else:
                members = self._client.smembers(self._keys_key(session_id))
                cleared = sorted(members)
                pipe = self._client.pipeline()
                for m in members:
                    pipe.delete(self._data_key(session_id, m))
                pipe.delete(self._keys_key(session_id))
                pipe.rpush(
                    self._history_key(session_id),
                    json.dumps(
                        {
                            'op': 'clear',
                            'key': None,
                            'cleared': cleared,
                            'timestamp': time.time(),
                        }
                    ),
                )
                pipe.execute()
            return {'ok': True, 'session_id': session_id, 'cleared': cleared}

    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            # Get the last N entries
            raw_entries = self._client.lrange(self._history_key(session_id), -limit, -1) if limit > 0 else self._client.lrange(self._history_key(session_id), 0, -1)
            entries = [json.loads(e) for e in raw_entries]
            return {'ok': True, 'session_id': session_id, 'entries': entries}

    def increment(self, session_id: str, key: str, amount: int = 1) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                return {'ok': False, 'error': f'Session {session_id!r} not found'}
            remaining_ms = self._client.pttl(self._meta_key(session_id))
            if remaining_ms == -2:
                self._client.srem(_REDIS_SESSIONS_KEY, session_id)
                return {'ok': False, 'error': f'Session {session_id!r} has expired'}
            # Use native Redis INCRBY for atomic increment
            data_key = self._data_key(session_id, key)
            new_value = self._client.incrby(data_key, amount)
            self._client.sadd(self._keys_key(session_id), key)
            self._client.rpush(
                self._history_key(session_id),
                json.dumps({'op': 'put', 'key': key, 'timestamp': time.time()}),
            )
            # Align TTL with session metadata
            if remaining_ms and remaining_ms > 0:
                self._client.pexpire(data_key, remaining_ms)
                self._client.pexpire(self._keys_key(session_id), remaining_ms)
                self._client.pexpire(self._history_key(session_id), remaining_ms)
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': new_value}

    def replace_history(self, session_id: str, entries: List[Dict[str, Any]]) -> None:
        with self._lock:
            history_key = self._history_key(session_id)
            pipe = self._client.pipeline()
            pipe.delete(history_key)
            if entries:
                pipe.rpush(history_key, *[json.dumps(e) for e in entries])
            pipe.execute()
            # Preserve TTL alignment with session metadata
            remaining_ms = self._client.pttl(self._meta_key(session_id))
            if remaining_ms and remaining_ms > 0:
                self._client.pexpire(history_key, remaining_ms)

    def close(self) -> None:
        """Close the Redis connection explicitly."""
        try:
            self._client.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# PersistentMemoryStore — facade
# ---------------------------------------------------------------------------


class PersistentMemoryStore:
    """Facade over a pluggable backend with auto-summarization support.

    Parameters
    ----------
    backend : str
        ``'redis'`` or ``'memory'`` (in-memory for testing).
    max_history : int
        Maximum history entries before auto-summarization triggers.
    auto_summarize : bool
        Whether to auto-summarize when history exceeds *max_history*.
    redis_host, redis_port, redis_password : str/int
        Redis connection parameters (only used when backend is ``'redis'``).
    session_ttl_hours : float
        Default TTL in hours for new sessions (0 = no expiry).
    """

    def __init__(
        self,
        backend: str = 'memory',
        max_history: int = 100,
        auto_summarize: bool = True,
        redis_host: str = 'localhost',
        redis_port: int = 6379,
        redis_password: Optional[str] = None,
        session_ttl_hours: float = 0,
    ) -> None:
        """Create a PersistentMemoryStore with the specified backend and options."""
        self.max_history = max_history
        self.auto_summarize = auto_summarize
        self.session_ttl_hours = session_ttl_hours
        self._ttl_seconds: Optional[int] = int(session_ttl_hours * 3600) if session_ttl_hours > 0 else None

        if backend == 'redis':
            self._backend: MemoryBackend = RedisBackend(
                host=redis_host,
                port=redis_port,
                password=redis_password,
            )
        elif backend == 'memory':
            self._backend = InMemoryBackend()
        else:
            raise ValueError(f'Unknown backend: {backend!r}. Must be "redis" or "memory".')

    @property
    def backend(self) -> MemoryBackend:
        """Expose the underlying backend for testing."""
        return self._backend

    # -- Session management -------------------------------------------------

    def create_session(self, session_id: str) -> Dict[str, Any]:
        return self._backend.create_session(session_id, ttl_seconds=self._ttl_seconds)

    def resume_session(self, session_id: str) -> Dict[str, Any]:
        return self._backend.resume_session(session_id)

    def list_sessions(self) -> List[str]:
        return self._backend.list_sessions()

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        return self._backend.delete_session(session_id)

    # -- Memory operations --------------------------------------------------

    def put(self, session_id: str, key: str, value: Any) -> Dict[str, Any]:
        result = self._backend.put(session_id, key, value)
        if result.get('ok') and self.auto_summarize:
            self.summarize_if_needed(session_id, self.max_history)
        return result

    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        return self._backend.get(session_id, key)

    def increment(self, session_id: str, key: str, amount: int = 1) -> Dict[str, Any]:
        result = self._backend.increment(session_id, key, amount)
        if result.get('ok') and self.auto_summarize:
            self.summarize_if_needed(session_id, self.max_history)
        return result

    def list_keys(self, session_id: str) -> Dict[str, Any]:
        return self._backend.list_keys(session_id)

    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        return self._backend.clear(session_id, key)

    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        return self._backend.get_history(session_id, limit)

    # -- Auto-summarization -------------------------------------------------

    def summarize_if_needed(self, session_id: str, max_entries: int) -> bool:
        """Compress older history entries into a summary when history exceeds *max_entries*.

        Keeps the most recent ``max_entries // 2`` entries intact and replaces
        everything older with a single summary entry.

        Returns ``True`` if summarization occurred.
        """
        history_result = self._backend.get_history(session_id, limit=0)
        if not history_result.get('ok'):
            return False

        entries = history_result.get('entries', [])
        if len(entries) <= max_entries:
            return False

        # Keep the newest half
        keep_count = max_entries // 2
        old_entries = entries[:-keep_count] if keep_count > 0 else entries
        recent_entries = entries[-keep_count:] if keep_count > 0 else []

        # Build summary
        op_counts: Dict[str, int] = {}
        keys_touched: set = set()
        for entry in old_entries:
            op = entry.get('op', 'unknown')
            op_counts[op] = op_counts.get(op, 0) + 1
            if entry.get('key'):
                keys_touched.add(entry['key'])

        summary_entry = {
            'op': 'summary',
            'summarized_count': len(old_entries),
            'op_counts': op_counts,
            'keys_touched': sorted(keys_touched),
            'timestamp': time.time(),
        }

        # Replace history via backend's public API: summary + recent entries
        self._backend.replace_history(session_id, [summary_entry, *recent_entries])

        return True
