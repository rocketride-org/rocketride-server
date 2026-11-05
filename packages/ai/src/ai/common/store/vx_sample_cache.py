# =============================================================================
# RocketRide Engine
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

"""The node-side cache of a ``sample`` answer, so ``project`` can place new points.

A store keeps the last two samples (least recently used first out) for ten
minutes. An entry holds the sampled keys, their float32 vectors, the PCA mean and
basis, the metric, the dimension and the mode; the raw vectors never leave the
node through it. ``sample`` and ``project`` run one at a time per store: a second
call while one runs is refused with ``BUSY`` instead of queueing.

See ``docs/development/nodes/vector-tool-contract.md`` section 2.5.
"""

import hashlib
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterator, List, Optional, Sequence, Tuple

import numpy as np

from .errors import ToolRefusal
from .vx_defaults import VECTOR_TOOL_DEFAULTS, VECTOR_TOOL_LIMITS

Key = Tuple[str, int]

#: Light mode may hold this many points whatever their width; above it the vectors must fit the byte budget.
LIGHT_FREE_POINTS = VECTOR_TOOL_LIMITS['sample_max']


def make_sample_id(seed: int, keys: Sequence[Key]) -> str:
    """Return ``'s-<seed>-<first 8 hex of sha1 of the keys>'`` (keys joined as ``objectId#chunkId`` by ``|``)."""
    text = '|'.join(f'{key[0]}#{int(key[1])}' for key in keys)
    return f's-{int(seed)}-{hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]}'


def check_light_budget(n: int, dimension: int) -> None:
    """Refuse a light sample whose vectors would not fit the node's memory budget.

    Up to ``sample_max`` points are always allowed; above that the vectors held for
    ``project`` (``dimension x n x 4`` bytes) must fit ``sample_light_max_bytes``.

    :raises ToolRefusal: ``LIMIT_EXCEEDED`` when they would not.
    """
    if int(n) <= LIGHT_FREE_POINTS:
        return
    budget = int(VECTOR_TOOL_DEFAULTS['sample_light_max_bytes'])
    needed = int(dimension) * int(n) * 4
    if needed > budget:
        raise ToolRefusal(
            'LIMIT_EXCEEDED',
            f'A light sample of {int(n)} points of {int(dimension)} values needs {needed // (1024 * 1024)} MB on the node; '
            f'the limit is {budget // (1024 * 1024)} MB. Ask for {LIGHT_FREE_POINTS} points or fewer.',
        )


@dataclass
class SampleEntry:
    """One cached sample."""

    sample_id: str
    keys: List[Key]
    vectors: np.ndarray
    mean: np.ndarray
    basis: np.ndarray
    metric: str
    dimension: int
    mode: str
    point_ids: List[Optional[str]]
    created: float = 0.0
    index: Dict[Key, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Index the keys so ``project`` and ``neighbors`` find a sampled point in O(1)."""
        self.keys = [(str(key[0]), int(key[1])) for key in self.keys]
        self.index = {key: i for i, key in enumerate(self.keys)}


class SampleCache:
    """Least-recently-used cache of :class:`SampleEntry` with a time to live, plus the BUSY gate."""

    def __init__(
        self,
        entries: int = VECTOR_TOOL_DEFAULTS['sample_cache_entries'],
        ttl_s: float = VECTOR_TOOL_DEFAULTS['sample_cache_ttl_s'],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create an empty cache holding at most ``entries`` samples for ``ttl_s`` seconds each."""
        self.entries = max(1, int(entries))
        self.ttl_s = float(ttl_s)
        self._clock = clock
        self._items: 'OrderedDict[str, SampleEntry]' = OrderedDict()
        self._lock = threading.Lock()
        self._busy = threading.Lock()

    def _expired(self, entry: SampleEntry, now: float) -> bool:
        return now - entry.created > self.ttl_s

    def put(self, entry: SampleEntry) -> SampleEntry:
        """Hold ``entry`` (stamped now), evicting the least recently used beyond capacity."""
        with self._lock:
            entry.created = self._clock()
            self._items.pop(entry.sample_id, None)
            self._items[entry.sample_id] = entry
            while len(self._items) > self.entries:
                self._items.popitem(last=False)
        return entry

    def get(self, sample_id: str) -> Optional[SampleEntry]:
        """Return the live entry for ``sample_id`` (marking it recently used), or None."""
        with self._lock:
            entry = self._items.get(sample_id)
            if entry is None:
                return None
            if self._expired(entry, self._clock()):
                del self._items[sample_id]
                return None
            self._items.move_to_end(sample_id)
            return entry

    def latest(self) -> Optional[SampleEntry]:
        """Return the most recently used live entry, or None."""
        with self._lock:
            now = self._clock()
            for sample_id in reversed(list(self._items)):
                entry = self._items[sample_id]
                if not self._expired(entry, now):
                    return entry
            return None

    def clear(self) -> None:
        """Drop every entry."""
        with self._lock:
            self._items.clear()

    @contextmanager
    def exclusive(self) -> Iterator[None]:
        """Run the body as the only ``sample``/``project`` on this store.

        :raises ToolRefusal: ``BUSY`` when another one is running.
        """
        if not self._busy.acquire(blocking=False):
            raise ToolRefusal('BUSY', 'Another sample or projection is running on this store; try again when it ends.')
        try:
            yield
        finally:
            self._busy.release()


__all__ = ['LIGHT_FREE_POINTS', 'SampleCache', 'SampleEntry', 'check_light_budget', 'make_sample_id']
