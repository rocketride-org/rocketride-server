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
Token-bucket rate limiter with concurrency control for HTTP requests.

Enforces three independent limits:
  - requests per second  (token bucket, refills every second)
  - requests per minute  (token bucket, refills every minute)
  - max concurrent requests  (semaphore)

All limits are configurable via services.json; sensible defaults are provided.
Thread-safe: uses a single ``threading.Lock`` for the token buckets and a
``threading.Semaphore`` for concurrency.
"""

from __future__ import annotations

import threading
import time


class RateLimitError(Exception):
    """Raised when a request is rejected due to rate limiting."""


# Defaults used when services.json omits the fields.
DEFAULT_MAX_PER_SECOND = 10
DEFAULT_MAX_PER_MINUTE = 100
DEFAULT_MAX_CONCURRENT = 5


class RateLimiter:
    """Token-bucket rate limiter with concurrent-request semaphore."""

    def __init__(
        self,
        *,
        max_per_second: int = DEFAULT_MAX_PER_SECOND,
        max_per_minute: int = DEFAULT_MAX_PER_MINUTE,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT,
    ) -> None:
        """Initialise token buckets and concurrency semaphore."""
        # --- per-second bucket ---
        self._ps_capacity = max(max_per_second, 1)
        self._ps_tokens = float(self._ps_capacity)
        self._ps_refill_rate = float(self._ps_capacity)  # tokens / second

        # --- per-minute bucket ---
        self._pm_capacity = max(max_per_minute, 1)
        self._pm_tokens = float(self._pm_capacity)
        self._pm_refill_rate = self._pm_capacity / 60.0  # tokens / second

        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

        # --- concurrency semaphore ---
        self._max_concurrent = max(max_concurrent, 1)
        self._semaphore = threading.Semaphore(self._max_concurrent)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def acquire(self) -> None:
        """Acquire a rate-limit slot, or raise ``RateLimitError``."""
        # 1. Check concurrency limit first (non-blocking) so we never
        #    consume tokens for a request that would be rejected anyway.
        if not self._semaphore.acquire(blocking=False):
            raise RateLimitError(
                f'Too many concurrent requests: max {self._max_concurrent} in-flight. Please wait for an ongoing request to complete.'
            )

        # 2. Check token buckets (per-second + per-minute).
        try:
            with self._lock:
                self._refill()
                if self._ps_tokens < 1.0:
                    raise RateLimitError(
                        f'Rate limit exceeded: max {self._ps_capacity} requests per second. Please retry after a short delay.'
                    )
                if self._pm_tokens < 1.0:
                    raise RateLimitError(
                        f'Rate limit exceeded: max {self._pm_capacity} requests per minute. Please retry after a short delay.'
                    )
                self._ps_tokens -= 1.0
                self._pm_tokens -= 1.0
        except RateLimitError:
            self._semaphore.release()
            raise

    def release(self) -> None:
        """Release the concurrency slot after a request completes."""
        self._semaphore.release()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _refill(self) -> None:
        """Refill both token buckets based on elapsed time.  Caller holds ``_lock``."""
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._last_refill = now

        self._ps_tokens = min(self._ps_capacity, self._ps_tokens + elapsed * self._ps_refill_rate)
        self._pm_tokens = min(self._pm_capacity, self._pm_tokens + elapsed * self._pm_refill_rate)
