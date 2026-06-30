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

"""
Pure-Python semantic-cache core for the ``cache`` node.

This module is deliberately free of any engine or ML dependencies: it operates
on plain ``list[float]`` vectors, so the cache policy (cosine similarity match,
TTL expiry, LRU eviction) can be unit-tested in isolation without the RocketRide
engine or an embedding model. The engine-facing wiring lives in ``IGlobal`` /
``IInstance``; the embedding model lives in ``IGlobal``.
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class CacheEntry:
    """One cached (query -> answer) pair plus its embedding and bookkeeping."""

    vector: List[float]
    norm: float
    query: str
    answer: str
    created_at: float


def _norm(vector: List[float]) -> float:
    """Euclidean norm of a vector."""
    return math.sqrt(sum(component * component for component in vector))


class SemanticCache:
    """
    A bounded, optionally-expiring semantic cache of LLM answers.

    Entries are matched by cosine similarity of their embedding vectors. A lookup
    returns the answer of the most-similar stored entry whose similarity is at or
    above ``threshold``; otherwise it is a miss.

    Eviction:
      - TTL: entries older than ``ttl_seconds`` are dropped (``0`` disables TTL).
      - LRU: when the entry count exceeds ``max_entries`` the least-recently-used
        entry is evicted (``0`` disables the size bound). A successful lookup and a
        fresh insert both count as "recently used".

    The class is intentionally storage-agnostic and single-process: it holds
    entries in memory for the lifetime of the owning pipe.
    """

    def __init__(self, threshold: float = 0.92, max_entries: int = 1000, ttl_seconds: float = 0.0):
        """
        Args:
            threshold: Minimum cosine similarity (0..1) for a hit. Values are
                clamped defensively to a sane range.
            max_entries: Maximum number of cached entries (0 = unbounded).
            ttl_seconds: Entry lifetime in seconds (0 = never expire).
        """
        # Clamp threshold into [0, 1]; a threshold of exactly 1.0 requires a
        # (near-)identical vector, approximating an exact-match cache.
        self.threshold = max(0.0, min(1.0, float(threshold)))
        self.max_entries = max(0, int(max_entries))
        self.ttl_seconds = max(0.0, float(ttl_seconds))

        # Insertion/most-recent-use order is the OrderedDict order; the newest or
        # most-recently-hit entry sits at the end, the LRU victim at the front.
        self._entries: 'OrderedDict[int, CacheEntry]' = OrderedDict()
        self._next_key = 0

        # The cache is shared (via IGlobal) across all per-object instances of the
        # node, which the engine may run on multiple threads. Guard every read or
        # mutation so concurrent lookups/stores can't corrupt the OrderedDict or
        # its LRU ordering.
        self._lock = threading.Lock()

        # Observability counters (read by the node for logging / SSE).
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def lookups(self) -> int:
        """Total lookups served (hits + misses)."""
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        """Fraction of lookups that were hits (0.0 when no lookups yet)."""
        total = self.lookups
        return (self.hits / total) if total else 0.0

    def _expire(self, now: float) -> None:
        """Drop entries whose TTL has elapsed."""
        if self.ttl_seconds <= 0:
            return
        cutoff = now - self.ttl_seconds
        expired = [key for key, entry in self._entries.items() if entry.created_at < cutoff]
        for key in expired:
            del self._entries[key]

    def lookup(self, vector: List[float], now: float) -> Optional[str]:
        """
        Return the cached answer for the most similar entry at or above
        ``threshold``, or ``None`` on a miss.

        A hit moves the matched entry to the most-recently-used position and
        increments the hit counter; a miss increments the miss counter.

        Args:
            vector: Query embedding.
            now: Current timestamp (seconds); supplied by the caller so the cache
                stays deterministic and testable.
        """
        with self._lock:
            self._expire(now)

            query_norm = _norm(vector)
            if query_norm == 0.0 or not self._entries:
                self.misses += 1
                return None

            best_key: Optional[int] = None
            best_sim = -1.0
            for key, entry in self._entries.items():
                if entry.norm == 0.0 or len(entry.vector) != len(vector):
                    continue
                dot = 0.0
                for a, b in zip(vector, entry.vector):
                    dot += a * b
                sim = dot / (query_norm * entry.norm)
                if sim > best_sim:
                    best_sim = sim
                    best_key = key

            if best_key is not None and best_sim >= self.threshold:
                self._entries.move_to_end(best_key)  # mark most-recently-used
                self.hits += 1
                return self._entries[best_key].answer

            self.misses += 1
            return None

    def add(self, vector: List[float], query: str, answer: str, now: float) -> bool:
        """
        Store a (query -> answer) pair keyed by its embedding.

        Zero-norm vectors are rejected (they can never match meaningfully). After
        inserting, expired entries are purged and the cache is trimmed to
        ``max_entries`` by evicting the least-recently-used entries.

        Args:
            vector: Query embedding.
            query: The query text (kept for debugging/observability).
            answer: The answer text to cache.
            now: Current timestamp (seconds).

        Returns:
            True if the entry was stored, False if it was rejected.
        """
        norm = _norm(vector)
        if norm == 0.0 or not answer:
            return False

        with self._lock:
            key = self._next_key
            self._next_key += 1
            self._entries[key] = CacheEntry(
                vector=list(vector),
                norm=norm,
                query=query,
                answer=answer,
                created_at=now,
            )

            self._expire(now)

            if self.max_entries > 0:
                while len(self._entries) > self.max_entries:
                    self._entries.popitem(last=False)  # evict least-recently-used

        return True

    def clear(self) -> None:
        """Drop all entries (counters are preserved)."""
        with self._lock:
            self._entries.clear()
