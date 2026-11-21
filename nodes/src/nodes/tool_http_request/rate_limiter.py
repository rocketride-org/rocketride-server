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

The counters live in the node's state, which the server keeps per owner, so
every replica serving the control counts against the same limits (a limiter
held per process let N replicas send N times the limit). Each counter moves
with the state store's atomic ``incr``; the window counters expire a window
after they close, so the node holds at most seven live keys. The windows are
fixed, not sliding: a burst straddling a boundary can reach twice a limit for
an instant. A request refused by one limit gives back what it took from the
others.
"""

from __future__ import annotations

import time
from typing import Any, NamedTuple


class RateLimitError(Exception):
    """Raised when a request is rejected due to rate limiting."""


# Defaults used when services.json omits the fields.
DEFAULT_MAX_PER_SECOND = 10
DEFAULT_MAX_PER_MINUTE = 100
DEFAULT_MAX_CONCURRENT = 5

#: The state key of the in-flight count.
_INFLIGHT_KEY = 'inflight'

#: The in-flight count outlives the longest request (300 s) by a margin, so a
#: replica that died mid-request gives its slot back when the count expires.
_INFLIGHT_TTL = 330


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

    def acquire(self) -> None:
        """
        Take an in-flight slot and a request from both windows, or raise ``RateLimitError``.

        Raises:
            RateLimitError: A limit is reached; nothing stays taken.
        """
        state = self._state
        limits = self._limits

        # 1. The in-flight count first, so a refused request never spends a window
        if state.incr(_INFLIGHT_KEY, 1, ttl=_INFLIGHT_TTL) > max(limits.concurrent, 1):
            state.incr(_INFLIGHT_KEY, -1, ttl=_INFLIGHT_TTL)
            raise RateLimitError(
                f'Too many concurrent requests: max {limits.concurrent} in-flight. '
                'Please wait for an ongoing request to complete.'
            )

        # 2. The two windows: what one refuses, the other gives back
        now = time.time()
        second = f'second:{int(now)}'
        minute = f'minute:{int(now // 60)}'
        try:
            if state.incr(second, 1, ttl=2) > max(limits.per_second, 1):
                state.incr(second, -1, ttl=2)
                raise RateLimitError(
                    f'Rate limit exceeded: max {limits.per_second} requests per second. Please retry after a short delay.'
                )
            if state.incr(minute, 1, ttl=120) > max(limits.per_minute, 1):
                state.incr(minute, -1, ttl=120)
                state.incr(second, -1, ttl=2)
                raise RateLimitError(
                    f'Rate limit exceeded: max {limits.per_minute} requests per minute. Please retry after a short delay.'
                )
        except RateLimitError:
            state.incr(_INFLIGHT_KEY, -1, ttl=_INFLIGHT_TTL)
            raise

    def release(self) -> None:
        """Give the in-flight slot back after a request completes."""
        self._state.incr(_INFLIGHT_KEY, -1, ttl=_INFLIGHT_TTL)
