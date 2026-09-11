"""
Unit tests for the pure-Python SemanticCache core (no engine, no ML deps).

Loads semantic_cache.py directly by path so the cache package __init__ (which
imports engine modules) is not triggered.

Run: pytest nodes/test/cache/test_semantic_cache.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_MODULE_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'cache' / 'semantic_cache.py'
_spec = importlib.util.spec_from_file_location('cache_semantic_cache_under_test', _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)
# Register before exec so @dataclass (under `from __future__ import annotations`)
# can resolve the module via sys.modules.
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)
SemanticCache = _mod.SemanticCache


def test_exact_hit_returns_answer_and_counts():
    c = SemanticCache(threshold=0.92)
    assert c.add([1.0, 0.0], 'q1', 'a1', now=0.0) is True
    assert c.lookup([1.0, 0.0], now=1.0) == 'a1'
    assert c.hits == 1
    assert c.misses == 0
    assert c.lookups == 1
    assert c.hit_rate == 1.0


def test_similar_above_threshold_hits():
    c = SemanticCache(threshold=0.92)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    # cosine([1,0],[0.999,0.01]) ~= 0.99995 -> hit
    assert c.lookup([0.999, 0.01], now=1.0) == 'a'


def test_below_threshold_misses():
    c = SemanticCache(threshold=0.92)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    # cosine([1,0],[1,1]) = 0.707 < 0.92 -> miss
    assert c.lookup([1.0, 1.0], now=1.0) is None
    assert c.misses == 1
    assert c.hits == 0


def test_empty_cache_misses():
    c = SemanticCache()
    assert c.lookup([1.0, 0.0], now=0.0) is None
    assert c.misses == 1


def test_zero_vector_add_rejected():
    c = SemanticCache()
    assert c.add([0.0, 0.0], 'q', 'a', now=0.0) is False
    assert len(c) == 0


def test_empty_answer_rejected():
    c = SemanticCache()
    assert c.add([1.0, 0.0], 'q', '', now=0.0) is False
    assert len(c) == 0


def test_zero_query_vector_misses():
    c = SemanticCache()
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    assert c.lookup([0.0, 0.0], now=0.0) is None


def test_ttl_expiry():
    c = SemanticCache(threshold=0.9, ttl_seconds=10.0)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    assert c.lookup([1.0, 0.0], now=5.0) == 'a'  # within TTL
    assert c.lookup([1.0, 0.0], now=20.0) is None  # expired
    assert len(c) == 0  # purged


def test_ttl_zero_never_expires():
    c = SemanticCache(threshold=0.9, ttl_seconds=0.0)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    assert c.lookup([1.0, 0.0], now=10_000_000.0) == 'a'


def test_ttl_expires_exactly_at_boundary():
    c = SemanticCache(threshold=0.9, ttl_seconds=10.0)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    assert c.lookup([1.0, 0.0], now=9.999) == 'a'  # just before boundary -> hit
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    assert c.lookup([1.0, 0.0], now=10.0) is None  # age == ttl -> expired


def test_lru_eviction_by_size():
    c = SemanticCache(threshold=0.5, max_entries=2)
    c.add([1.0, 0.0, 0.0], 'qA', 'A', now=0.0)
    c.add([0.0, 1.0, 0.0], 'qB', 'B', now=1.0)
    c.add([0.0, 0.0, 1.0], 'qC', 'C', now=2.0)
    assert len(c) == 2
    # A was the oldest and never re-used -> evicted
    assert c.lookup([1.0, 0.0, 0.0], now=3.0) is None
    assert c.lookup([0.0, 0.0, 1.0], now=3.0) == 'C'


def test_lru_hit_protects_entry_from_eviction():
    c = SemanticCache(threshold=0.5, max_entries=2)
    c.add([1.0, 0.0, 0.0], 'qA', 'A', now=0.0)
    c.add([0.0, 1.0, 0.0], 'qB', 'B', now=1.0)
    # Touch A via a hit -> A becomes most-recently-used.
    assert c.lookup([1.0, 0.0, 0.0], now=2.0) == 'A'
    # Insert C -> B (now least-recently-used) is evicted, A retained.
    c.add([0.0, 0.0, 1.0], 'qC', 'C', now=3.0)
    assert c.lookup([1.0, 0.0, 0.0], now=4.0) == 'A'
    assert c.lookup([0.0, 1.0, 0.0], now=4.0) is None


def test_max_entries_zero_is_unbounded():
    c = SemanticCache(threshold=0.5, max_entries=0)
    for i in range(50):
        v = [0.0] * 50
        v[i] = 1.0
        c.add(v, f'q{i}', f'a{i}', now=float(i))
    assert len(c) == 50


def test_dimension_mismatch_skipped():
    c = SemanticCache(threshold=0.5)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    # Different-length query vector cannot match -> miss, no crash.
    assert c.lookup([1.0, 0.0, 0.0], now=1.0) is None


def test_threshold_clamped():
    assert SemanticCache(threshold=5.0).threshold == 1.0
    assert SemanticCache(threshold=-1.0).threshold == 0.0


def test_hit_rate_mixed():
    c = SemanticCache(threshold=0.92)
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    c.lookup([1.0, 0.0], now=1.0)  # hit
    c.lookup([0.0, 1.0], now=1.0)  # miss
    assert c.hits == 1 and c.misses == 1
    assert c.hit_rate == 0.5


def test_clear_keeps_counters():
    c = SemanticCache()
    c.add([1.0, 0.0], 'q', 'a', now=0.0)
    c.lookup([1.0, 0.0], now=1.0)
    c.clear()
    assert len(c) == 0
    assert c.hits == 1  # counters preserved


def test_most_similar_entry_wins():
    c = SemanticCache(threshold=0.5)
    c.add([1.0, 0.0], 'q1', 'a1', now=0.0)
    c.add([0.9, 0.1], 'q2', 'a2', now=1.0)
    # Query closest to [1,0] should return a1 (sim 1.0) over a2.
    assert c.lookup([1.0, 0.0], now=2.0) == 'a1'


def test_concurrent_add_and_lookup_is_safe():
    """Parallel adds/lookups must not crash or corrupt the bounded cache."""
    import threading

    c = SemanticCache(threshold=0.5, max_entries=64)
    errors = []

    def worker(start):
        try:
            for i in range(start, start + 200):
                v = [float((i % 7) + 1), float((i % 5) + 1), float((i % 3) + 1)]
                c.add(v, f'q{i}', f'a{i}', now=float(i))
                c.lookup(v, now=float(i))
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n * 1000,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    # LRU bound is never exceeded despite concurrent inserts.
    assert len(c) <= 64
