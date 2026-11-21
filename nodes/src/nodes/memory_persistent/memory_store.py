# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Persistent cross-session memory store with pluggable backends.

Two backends: the binding's ``self.state`` (the default: small JSON values the
server keeps per owner, so any replica serves the next call) and the owner's
own Redis. The facade carries one call's knobs (history cap, summarization,
session time to live). Every operation returns copies, never live values.
"""

from __future__ import annotations

import copy
import json
import math
import re
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from rocketlib import warning


# ---------------------------------------------------------------------------
# Session ID validation
# ---------------------------------------------------------------------------

_SESSION_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]{1,128}$')
_KEY_RE = re.compile(r'^[a-zA-Z0-9_\-\.]{1,256}$')


def _validate_session_id(session_id: str) -> None:
    """Validate session_id to prevent path traversal or injection in Redis keys."""
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise ValueError(
            f'Invalid session_id: {session_id!r}. Must be 1-128 alphanumeric characters, hyphens, or underscores.'
        )


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
    def create_session(self, session_id: str, ttl_seconds: Optional[float] = None) -> Dict[str, Any]:
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
        """Increment a numeric value using a default non-atomic get/put sequence.

        Backends that need concurrency safety must override this method with a
        lock-protected or native-atomic implementation.
        """
        result = self.get(session_id, key)
        current = result.get('value', 0) if result.get('ok') else 0
        new_value = current + amount
        return self.put(session_id, key, new_value)

    @abstractmethod
    def close(self) -> None:
        """Release any resources held by the backend. No-op by default."""


# ---------------------------------------------------------------------------
# State backend (the binding's self.state)
# ---------------------------------------------------------------------------

#: The most sessions one owner keeps on one node. A node holds at most 16 live
#: state keys per owner and address (plan 5.7): one per session and the index.
MAX_STATE_SESSIONS = 15

#: The state key of the session index: ``{session_id: expires_at or None}``.
_INDEX_KEY = 'sessions'


def _session_key(session_id: str) -> str:
    """The state key of one session's record (its data, history and expiry)."""
    return f'session:{session_id}'


class StateBackend(MemoryBackend):
    """
    Sessions in ``self.state``: one record per session plus one index, owned by the binding's control.

    The server keys every value by the control's organization, owner, address
    and node id, so another owner's sessions are out of reach by construction.
    A record is ``{'data': {key: value}, 'history': [...], 'created_at',
    'ttl_seconds', 'expires_at'}``; it is written with the session's remaining
    time to live, and a session with none takes the state store's maximum
    (seven days after its last write). Values are JSON.
    """

    def __init__(self, state: Any) -> None:
        """
        Bind the backend to one binding's state door.

        Args:
            state: The instance's ``self.state`` (``get``/``put``/``delete``/``lock``).
        """
        self._state = state

    # -- records ------------------------------------------------------------

    def _index(self) -> Dict[str, Optional[float]]:
        """The session index with every expired entry left out."""
        now = time.time()
        index = self._state.get(_INDEX_KEY) or {}
        return {sid: expires for sid, expires in index.items() if not expires or expires > now}

    def _record(self, session_id: str) -> Optional[Dict[str, Any]]:
        """A live session's record, or None when it is absent or past its expiry."""
        record = self._state.get(_session_key(session_id))
        if record is None:
            return None
        expires = record.get('expires_at')
        if expires and time.time() > expires:
            return None
        return record

    def _save(self, session_id: str, record: Dict[str, Any]) -> None:
        """Write a record with the session's remaining time to live."""
        expires = record.get('expires_at')
        ttl = max(1.0, expires - time.time()) if expires else None
        self._state.put(_session_key(session_id), record, ttl=ttl)

    def _missing(self, session_id: str) -> Dict[str, Any]:
        """The answer for a session that is not there."""
        return {'ok': False, 'error': f'Session {session_id!r} not found'}

    def _update(self, session_id: str, change) -> Dict[str, Any]:
        """
        Read-modify-write one live session under its lock.

        Args:
            session_id: The session.
            change: ``(record) -> result``; mutates the record, which is then saved.

        Returns:
            The change's result, or the not-found answer.
        """
        with self._state.lock(_session_key(session_id)):
            record = self._record(session_id)
            if record is None:
                return self._missing(session_id)
            result = change(record)
            self._save(session_id, record)
            return result

    # -- sessions -----------------------------------------------------------

    def create_session(self, session_id: str, ttl_seconds: Optional[float] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._state.lock(_INDEX_KEY):
            # Entries whose record is gone (its time to live ran out) free their place
            index = {sid: expires for sid, expires in self._index().items() if self._record(sid) is not None}
            if session_id in index:
                return {'ok': False, 'error': f'Session {session_id!r} already exists'}
            if len(index) >= MAX_STATE_SESSIONS:
                return {'ok': False, 'error': f'Maximum sessions ({MAX_STATE_SESSIONS}) reached'}
            now = time.time()
            expires = (now + ttl_seconds) if ttl_seconds else None
            self._save(
                session_id,
                {'data': {}, 'history': [], 'created_at': now, 'ttl_seconds': ttl_seconds, 'expires_at': expires},
            )
            index[session_id] = expires
            self._state.put(_INDEX_KEY, index)
            return {'ok': True, 'session_id': session_id}

    def resume_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        record = self._record(session_id)
        if record is not None:
            return {'ok': True, 'session_id': session_id, 'key_count': len(record['data'])}
        listed = self._state.get(_INDEX_KEY) or {}
        if session_id in listed:
            return {'ok': False, 'error': f'Session {session_id!r} has expired'}
        return self._missing(session_id)

    def list_sessions(self) -> List[str]:
        return sorted(self._index())

    def delete_session(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._state.lock(_INDEX_KEY):
            record = self._record(session_id)
            index = self._state.get(_INDEX_KEY) or {}
            if record is None and session_id not in index:
                return self._missing(session_id)
            self._state.delete(_session_key(session_id))
            index.pop(session_id, None)
            self._state.put(_INDEX_KEY, index)
            keys_cleared = sorted(record['data']) if record else []
            return {'ok': True, 'session_id': session_id, 'keys_cleared': keys_cleared}

    # -- memory operations ----------------------------------------------------

    def put(self, session_id: str, key: str, value: Any) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)

        def change(record):
            record['data'][key] = copy.deepcopy(value)
            record['history'].append({'op': 'put', 'key': key, 'timestamp': time.time()})
            return {'ok': True, 'session_id': session_id, 'key': key}

        return self._update(session_id, change)

    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        record = self._record(session_id)
        if record is None:
            return self._missing(session_id)
        if key not in record['data']:
            return {'ok': False, 'session_id': session_id, 'key': key, 'value': None}
        return {'ok': True, 'session_id': session_id, 'key': key, 'value': record['data'][key]}

    def list_keys(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        record = self._record(session_id)
        if record is None:
            return self._missing(session_id)
        return {'ok': True, 'session_id': session_id, 'keys': sorted(record['data'])}

    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        if key is not None:
            _validate_key(key)

        def change(record):
            data = record['data']
            if key:
                cleared = [key] if key in data else []
                data.pop(key, None)
            else:
                cleared = sorted(data)
                data.clear()
            record['history'].append({'op': 'clear', 'key': key, 'cleared': cleared, 'timestamp': time.time()})
            return {'ok': True, 'session_id': session_id, 'cleared': cleared}

        return self._update(session_id, change)

    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        _validate_session_id(session_id)
        record = self._record(session_id)
        if record is None:
            return self._missing(session_id)
        history = record['history']
        entries = history[-limit:] if limit > 0 else history
        return {'ok': True, 'session_id': session_id, 'entries': entries}

    def increment(self, session_id: str, key: str, amount: int = 1) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)

        def change(record):
            value = record['data'].get(key, 0) + amount
            record['data'][key] = value
            record['history'].append({'op': 'put', 'key': key, 'timestamp': time.time()})
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': value}

        return self._update(session_id, change)

    def replace_history(self, session_id: str, entries: List[Dict[str, Any]]) -> None:
        _validate_session_id(session_id)

        def change(record):
            record['history'] = copy.deepcopy(entries)

        self._update(session_id, change)

    def close(self) -> None:
        """Nothing to release: the state door belongs to the binding."""


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

    def __init__(
        self, host: str = 'localhost', port: int = 6379, password: Optional[str] = None, **kwargs: Any
    ) -> None:
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

    def _require_live_session(self, session_id: str) -> tuple[Optional[Dict[str, Any]], Optional[int]]:
        """Return an error and TTL for a missing or expired session."""
        if not self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
            return {'ok': False, 'error': f'Session {session_id!r} not found'}, None
        remaining_ms = self._client.pttl(self._meta_key(session_id))
        if remaining_ms == -2:
            self._client.srem(_REDIS_SESSIONS_KEY, session_id)
            return {'ok': False, 'error': f'Session {session_id!r} has expired'}, None
        return None, remaining_ms

    def _set_ttl(self, session_id: str, ttl_seconds: Optional[float]) -> None:
        """Apply TTL to all keys belonging to a session."""
        if ttl_seconds is None or ttl_seconds <= 0:
            return
        ttl_ms = max(1, math.ceil(ttl_seconds * 1000))
        keys_to_expire = [
            self._keys_key(session_id),
            self._history_key(session_id),
            self._meta_key(session_id),
        ]
        # Also expire all data keys
        members = self._client.smembers(self._keys_key(session_id))
        keys_to_expire.extend(self._data_key(session_id, member) for member in members)
        for k in keys_to_expire:
            self._client.pexpire(k, ttl_ms)

    def _get_ttl_seconds(self, session_id: str) -> Optional[float]:
        """Retrieve the TTL for a session from metadata."""
        raw = self._client.hget(self._meta_key(session_id), 'ttl_seconds')
        if raw and raw != 'None':
            return float(raw)
        return None

    def create_session(self, session_id: str, ttl_seconds: Optional[float] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            if self._client.sismember(_REDIS_SESSIONS_KEY, session_id):
                remaining_ms = self._client.pttl(self._meta_key(session_id))
                if remaining_ms == -2:
                    self._client.srem(_REDIS_SESSIONS_KEY, session_id)
                else:
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
            # Prune sessions whose metadata has expired. Use list
            # comprehensions (bulk growth) instead of per-iteration appends.
            liveness = [(sid, bool(self._client.exists(self._meta_key(sid)))) for sid in members]
            active = [sid for sid, alive in liveness if alive]
            stale = [sid for sid, alive in liveness if not alive]
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
            # Keep the newly written key set aligned with the TTL observed
            # before the write, so it cannot outlive the session metadata.
            if remaining_ms and remaining_ms > 0:
                pipe.pexpire(self._data_key(session_id, key), remaining_ms)
                pipe.pexpire(self._keys_key(session_id), remaining_ms)
                pipe.pexpire(self._history_key(session_id), remaining_ms)
            pipe.execute()
            return {'ok': True, 'session_id': session_id, 'key': key}

    def get(self, session_id: str, key: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        _validate_key(key)
        with self._lock:
            err, _ = self._require_live_session(session_id)
            if err is not None:
                return err
            raw = self._client.get(self._data_key(session_id, key))
            if raw is None:
                return {'ok': False, 'session_id': session_id, 'key': key, 'value': None}
            return {'ok': True, 'session_id': session_id, 'key': key, 'value': json.loads(raw)}

    def list_keys(self, session_id: str) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            err, _ = self._require_live_session(session_id)
            if err is not None:
                return err
            members = self._client.smembers(self._keys_key(session_id))
            return {'ok': True, 'session_id': session_id, 'keys': sorted(members)}

    def clear(self, session_id: str, key: Optional[str] = None) -> Dict[str, Any]:
        _validate_session_id(session_id)
        if key is not None:
            _validate_key(key)
        with self._lock:
            err, remaining_ms = self._require_live_session(session_id)
            if err is not None:
                return err
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
                if remaining_ms and remaining_ms > 0:
                    pipe.pexpire(self._history_key(session_id), remaining_ms)
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
                if remaining_ms and remaining_ms > 0:
                    pipe.pexpire(self._history_key(session_id), remaining_ms)
                pipe.execute()
            return {'ok': True, 'session_id': session_id, 'cleared': cleared}

    def get_history(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        _validate_session_id(session_id)
        with self._lock:
            err, _ = self._require_live_session(session_id)
            if err is not None:
                return err
            # Get the last N entries
            raw_entries = (
                self._client.lrange(self._history_key(session_id), -limit, -1)
                if limit > 0
                else self._client.lrange(self._history_key(session_id), 0, -1)
            )
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
        _validate_session_id(session_id)
        with self._lock:
            err, remaining_ms = self._require_live_session(session_id)
            if err is not None:
                return
            history_key = self._history_key(session_id)
            pipe = self._client.pipeline()
            pipe.delete(history_key)
            if entries:
                pipe.rpush(history_key, *[json.dumps(e) for e in entries])
            # Preserve TTL alignment with session metadata
            if remaining_ms and remaining_ms > 0:
                pipe.pexpire(history_key, remaining_ms)
            pipe.execute()

    def close(self) -> None:
        """Close the Redis connection explicitly."""
        try:
            self._client.close()
        except Exception as exc:  # noqa: BLE001 - teardown must not fail if Redis close raises.
            warning(f'memory_persistent: RedisBackend.close failed: {exc}')


# ---------------------------------------------------------------------------
# PersistentMemoryStore — facade
# ---------------------------------------------------------------------------


class PersistentMemoryStore:
    """
    One call's view of a session backend: its history cap, its summarization and its session time to live.

    Args:
        backend: The backend: a ``StateBackend`` over the binding's state, or the control's ``RedisBackend``.
        max_history: Maximum history entries before auto-summarization triggers.
        auto_summarize: Whether to auto-summarize when history exceeds ``max_history``.
        session_ttl_hours: Time to live in hours for sessions this call creates (0 = none).
    """

    def __init__(
        self,
        backend: MemoryBackend,
        max_history: int = 100,
        auto_summarize: bool = True,
        session_ttl_hours: float = 0,
    ) -> None:
        """Wrap ``backend`` with one call's settings."""
        self.max_history = max_history
        self.auto_summarize = auto_summarize
        self.session_ttl_hours = session_ttl_hours
        self._ttl_seconds: Optional[float] = session_ttl_hours * 3600 if session_ttl_hours > 0 else None
        self._backend = backend

    @property
    def backend(self) -> MemoryBackend:
        """The backend this call reads and writes."""
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
