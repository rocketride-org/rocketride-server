# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock Redis client for testing.

Provides a minimal in-process Redis substitute used by node tests (e.g.
``memory_persistent``) to exercise Redis code paths without a running
Redis server. Mirrors only the small surface of redis-py used by the
memory_persistent backend: strings, hashes, sets, lists, TTL primitives,
pipelines, and cleanup.

Each ``FakeRedis`` instance is independent — there is no shared
process-level storage — so tests must not rely on cross-instance state.
"""

from __future__ import annotations


class FakeRedis:
    """In-process stand-in for ``redis.Redis``.

    Only the calls memory_persistent's RedisBackend actually makes are
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
        return FakePipeline(self)

    # Cleanup -------------------------------------------------------------
    def close(self):
        self.close_called = True


class FakePipeline:
    """Pipeline stub that queues operations and replays them on ``execute()``."""

    def __init__(self, client: FakeRedis) -> None:
        self._client = client
        self._ops: list[tuple[str, tuple, dict]] = []

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
