# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock Redis client for testing.

Provides a minimal in-process Redis substitute used by ``memory_persistent`` and
``tool_redis`` tests to exercise Redis code paths without a running
Redis server. Mirrors a small surface of redis-py: strings, hashes, sets, lists,
TTL bookkeeping, bounded reads, scans, pipelines, and cleanup. Actual expiry
and concurrency semantics are verified against a live server, not this fake.

Each ``FakeRedis`` instance is independent — there is no shared
process-level storage — so tests must not rely on cross-instance state.
"""

from __future__ import annotations

import fnmatch
import re

from redis.exceptions import ResponseError


class FakeRedis:
    """In-process stand-in for ``redis.Redis``.

    Only the calls needed by the memory and Redis tool tests are
    implemented; unused redis-py methods are intentionally absent so that
    accidental new dependencies surface as ``AttributeError``.
    """

    def __init__(self) -> None:
        self._kv: dict[str, str | int] = {}
        self._sets: dict[str, set] = {}
        self._hashes: dict[str, dict] = {}
        self._lists: dict[str, list] = {}
        self._ttl_ms: dict[str, int] = {}
        self.close_called: bool = False

    # Key lifetime --------------------------------------------------------
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
    def set(self, key, value, ex=None, nx=False, xx=False):
        exists = self.exists(key)
        if (nx and exists) or (xx and not exists):
            return None
        self.delete(key)
        self._kv[key] = value
        if ex is not None:
            self._ttl_ms[key] = ex * 1000
        return True

    def getrange(self, key, start, end):
        if key in self._hashes or key in self._sets or key in self._lists:
            raise ResponseError('WRONGTYPE')
        value = self._kv.get(key, b'')
        raw = value if isinstance(value, bytes) else str(value).encode('utf-8')
        return raw[start : end + 1]

    def ttl(self, key):
        ms = self.pttl(key)
        return ms if ms < 0 else ms // 1000

    def expire(self, key, seconds):
        if not self.exists(key):
            return False
        self._ttl_ms[key] = seconds * 1000
        return True

    def scan(self, cursor=0, match='*', count=10):
        keys = sorted(set(self._kv) | set(self._sets) | set(self._hashes) | set(self._lists))
        page = keys[cursor : cursor + count]
        next_cursor = cursor + count if cursor + count < len(keys) else 0
        return next_cursor, [key.encode('utf-8') for key in page if fnmatch.fnmatchcase(key, match)]

    def get(self, key):
        return self._kv.get(key)

    def incrby(self, key, amount):
        if key in self._hashes or key in self._sets or key in self._lists:
            raise ResponseError('WRONGTYPE')
        raw = self._kv.get(key, '0')
        text = raw.decode('utf-8') if isinstance(raw, bytes) else str(raw)
        if not re.fullmatch(r'-?(0|[1-9][0-9]*)', text):
            raise ResponseError('value is not an integer')
        new = int(text) + amount
        if not -(2**63) <= new <= 2**63 - 1:
            raise ResponseError('increment would overflow')
        self._kv[key] = str(new)
        return new

    def delete(self, *keys):
        removed = 0
        for key in set(keys):
            removed += int(bool(self.exists(key)))
            for store in (self._kv, self._sets, self._hashes, self._lists, self._ttl_ms):
                store.pop(key, None)
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
    def pipeline(self, transaction=True):
        return FakePipeline(self)

    # Cleanup -------------------------------------------------------------
    def close(self):
        self.close_called = True


class FakePipeline:
    """Pipeline stub that queues operations and replays them on ``execute()``."""

    def __init__(self, client: FakeRedis) -> None:
        self._client = client
        self._ops: list[tuple[str, tuple, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
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


__all__ = ['FakeRedis', 'FakePipeline']
