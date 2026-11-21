# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Rate limits for HTTP requests, counted in the control's ``self.state``.

Three independent limits:
  - requests per second  (a one-second window)
  - requests per minute  (a one-minute window)
  - concurrent requests  (an in-flight count)

The counts live in the node's state, which the server keeps per owner, so
every replica serving the control counts against the same limits (a limiter
held per process let N replicas send N times the limit). The window counters
move with the state store's atomic ``incr`` and expire a window after they
close, so the node holds at most seven live keys. The windows are fixed, not
sliding: a burst straddling a boundary can reach twice a limit for an instant.

The in-flight slots are one value, ``{slot id: taken at}``, read and written
under the state lock. Each slot expires on its own, ``_SLOT_TTL`` after it was
taken, so a replica that died mid-request gives its slot back then whatever
traffic follows; a refused attempt writes nothing, so it never keeps a dead
slot alive. A request refused by one limit, or stopped by a failing state
operation, gives back what it took from the others.
"""

from __future__ import annotations

import contextlib
import time
import uuid
from typing import Any, Dict, NamedTuple


class RateLimitError(Exception):
    """Raised when a request is rejected due to rate limiting."""


# Defaults used when services.json omits the fields.
DEFAULT_MAX_PER_SECOND = 10
DEFAULT_MAX_PER_MINUTE = 100
DEFAULT_MAX_CONCURRENT = 5

#: The state key of the in-flight slots: ``{slot id: taken at (epoch seconds)}``.
_INFLIGHT_KEY = 'inflight'

#: A slot outlives the longest request (300 s) by a margin, so a replica that
#: died mid-request gives its slot back this long after it took it.
_SLOT_TTL = 330


class RateLimits(NamedTuple):
    """One call's limits."""

    per_second: int
    per_minute: int
    concurrent: int


class StateRateLimiter:
    """One call's rate limits over the control's state."""

    def __init__(self, state: Any, limits: RateLimits) -> None:
        """
        Bind the limits to a binding's state door.

        Args:
            state: The instance's ``self.state``.
            limits: The call's limits.
        """
        self._state = state
        self._limits = limits

    def acquire(self) -> str:
        """
        Take an in-flight slot and a request from both windows, or raise.

        Returns:
            The slot taken, for ``release``.

        Raises:
            RateLimitError: A limit is reached; nothing stays taken.
            Exception: A state operation failed; what was taken is given back
                (as far as the state store lets it) and the failure is raised.
        """
        # 1. The in-flight slot first, so a refused request never spends a window
        slot = self._take_slot()

        # 2. The two windows; a refusal or a failure gives the slot back
        try:
            self._spend_windows()
        except BaseException:
            # Best effort: a slot that cannot be given back expires on its own
            with contextlib.suppress(Exception):
                self._give_back(slot)
            raise
        return slot

    def release(self, slot: str) -> None:
        """
        Give an in-flight slot back after its request completes.

        Args:
            slot: What ``acquire`` returned.
        """
        self._give_back(slot)

    # ---- The in-flight slots --------------------------------------------------

    def _live_slots(self, now: float) -> Dict[str, float]:
        """The slots not yet expired; the caller holds the slots' lock."""
        slots = self._state.get(_INFLIGHT_KEY) or {}
        return {slot: taken for slot, taken in slots.items() if now - taken < _SLOT_TTL}

    def _take_slot(self) -> str:
        """
        Take an in-flight slot, atomically across every replica.

        Returns:
            The slot's id.

        Raises:
            RateLimitError: Every slot is taken; nothing is written, so no slot's expiry moves.
        """
        state = self._state
        concurrent = self._limits.concurrent
        with state.lock(_INFLIGHT_KEY):
            now = time.time()
            slots = self._live_slots(now)
            if len(slots) >= max(concurrent, 1):
                raise RateLimitError(
                    f'Too many concurrent requests: max {concurrent} in-flight. '
                    'Please wait for an ongoing request to complete.'
                )
            slot = uuid.uuid4().hex
            slots[slot] = now
            # The value outlives its newest slot; each slot expires by its own time
            state.put(_INFLIGHT_KEY, slots, ttl=_SLOT_TTL)
        return slot

    def _give_back(self, slot: str) -> None:
        """Remove one slot (a slot already expired is simply gone)."""
        state = self._state
        with state.lock(_INFLIGHT_KEY):
            slots = self._live_slots(time.time())
            if slots.pop(slot, None) is not None:
                state.put(_INFLIGHT_KEY, slots, ttl=_SLOT_TTL)

    # ---- The windows ----------------------------------------------------------

    def _spend_windows(self) -> None:
        """
        Take one request from the second and the minute window.

        Raises:
            RateLimitError: A window is full.
            Exception: A state operation failed.
            In both cases every window this call counted is given back.
        """
        state = self._state
        limits = self._limits
        now = time.time()
        windows = (
            (
                f'second:{int(now)}',
                2,
                limits.per_second,
                f'Rate limit exceeded: max {limits.per_second} requests per second. Please retry after a short delay.',
            ),
            (
                f'minute:{int(now // 60)}',
                120,
                limits.per_minute,
                f'Rate limit exceeded: max {limits.per_minute} requests per minute. Please retry after a short delay.',
            ),
        )
        counted = []
        try:
            for key, ttl, limit, refusal in windows:
                count = state.incr(key, 1, ttl=ttl)
                counted.append((key, ttl))
                if count > max(limit, 1):
                    raise RateLimitError(refusal)
        except BaseException:
            # Each counted window once, newest first; a window that cannot be
            # given back closes within its own ttl
            for key, ttl in reversed(counted):
                with contextlib.suppress(Exception):
                    state.incr(key, -1, ttl=ttl)
            raise
