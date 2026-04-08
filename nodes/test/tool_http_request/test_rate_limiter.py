# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
# =============================================================================

"""Unit tests for the token-bucket rate limiter."""

from __future__ import annotations

import threading
import time

import sys
from pathlib import Path

import pytest

# Add the node source directory to sys.path so we can import the module
# without triggering the top-level nodes/__init__.py (which requires the
# engine runtime).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_http_request'))

from rate_limiter import RateLimiter, RateLimitError  # noqa: E402


class TestAcquireRelease:
    """Normal acquire / release cycle."""

    def test_single_acquire_release(self):
        rl = RateLimiter(max_per_second=5, max_per_minute=100, max_concurrent=2)
        rl.acquire()
        rl.release()

    def test_multiple_sequential_acquires(self):
        rl = RateLimiter(max_per_second=3, max_per_minute=100, max_concurrent=3)
        for _ in range(3):
            rl.acquire()
        for _ in range(3):
            rl.release()


class TestPerSecondEnforcement:
    """Per-second token bucket rejects once exhausted."""

    def test_exceeds_per_second_limit(self):
        rl = RateLimiter(max_per_second=2, max_per_minute=100, max_concurrent=10)
        rl.acquire()
        rl.acquire()
        with pytest.raises(RateLimitError, match='per second'):
            rl.acquire()
        # Clean up
        rl.release()
        rl.release()

    def test_per_second_refills_over_time(self):
        rl = RateLimiter(max_per_second=2, max_per_minute=100, max_concurrent=10)
        rl.acquire()
        rl.acquire()
        rl.release()
        rl.release()
        # Wait long enough for tokens to refill
        time.sleep(1.1)
        rl.acquire()
        rl.release()


class TestPerMinuteEnforcement:
    """Per-minute token bucket rejects once exhausted."""

    def test_exceeds_per_minute_limit(self):
        rl = RateLimiter(max_per_second=100, max_per_minute=3, max_concurrent=10)
        rl.acquire()
        rl.acquire()
        rl.acquire()
        with pytest.raises(RateLimitError, match='per minute'):
            rl.acquire()
        for _ in range(3):
            rl.release()


class TestSemaphoreExhaustion:
    """Concurrency semaphore rejects when all slots are occupied."""

    def test_exceeds_concurrent_limit(self):
        rl = RateLimiter(max_per_second=100, max_per_minute=100, max_concurrent=2)
        rl.acquire()
        rl.acquire()
        with pytest.raises(RateLimitError, match='concurrent'):
            rl.acquire()
        rl.release()
        rl.release()

    def test_release_frees_slot(self):
        rl = RateLimiter(max_per_second=100, max_per_minute=100, max_concurrent=1)
        rl.acquire()
        rl.release()
        # Should succeed now that the slot is freed.
        rl.acquire()
        rl.release()


class TestTokenRestorationOnSemaphoreRejection:
    """Tokens must NOT be consumed when the semaphore rejects the request."""

    def test_tokens_preserved_after_semaphore_rejection(self):
        rl = RateLimiter(max_per_second=2, max_per_minute=100, max_concurrent=1)

        # Use up the only concurrency slot.
        rl.acquire()

        # This should fail on the semaphore. Tokens must not be consumed.
        with pytest.raises(RateLimitError, match='concurrent'):
            rl.acquire()

        # Release the held slot.
        rl.release()

        # We should still have 1 per-second token left (only 1 was consumed
        # by the first successful acquire).  If the bug existed (tokens
        # consumed before semaphore check) this second acquire would fail
        # with a per-second error.
        rl.acquire()
        rl.release()

    def test_semaphore_not_leaked_on_token_rejection(self):
        """Semaphore slot is released when token-bucket check fails.

        With max_concurrent=2 and max_per_second=2: after two successful
        acquires exhaust the per-second tokens, a third acquire will pass
        the semaphore but fail on tokens.  The implementation must release
        the semaphore slot in that case.  We verify by releasing all held
        slots, waiting for token refill, then acquiring both concurrent
        slots again — which would fail if one was leaked.
        """
        rl = RateLimiter(max_per_second=2, max_per_minute=100, max_concurrent=2)

        # Exhaust both per-second tokens (each also takes a semaphore slot).
        rl.acquire()
        rl.acquire()

        # Release one semaphore slot so the next acquire can get past the
        # semaphore check and fail on the token bucket instead.
        rl.release()

        # This acquire gets a semaphore slot but fails on per-second tokens.
        with pytest.raises(RateLimitError, match='per second'):
            rl.acquire()

        # Release the remaining held slot.
        rl.release()

        # Wait for per-second tokens to fully refill (capacity=2).
        time.sleep(1.2)

        # Both semaphore slots should be free.  If the failed acquire
        # leaked a slot, the second acquire here would raise a
        # concurrency error.
        rl.acquire()
        rl.acquire()
        rl.release()
        rl.release()


class TestThreadSafety:
    """Basic smoke test for concurrent usage."""

    def test_concurrent_acquires(self):
        rl = RateLimiter(max_per_second=50, max_per_minute=500, max_concurrent=5)
        errors: list[Exception] = []

        def worker():
            try:
                rl.acquire()
                time.sleep(0.01)
                rl.release()
            except RateLimitError:
                pass
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert not errors, f'Unexpected errors in threads: {errors}'
