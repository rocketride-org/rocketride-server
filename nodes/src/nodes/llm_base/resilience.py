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

"""Circuit breaker and retry-with-backoff resilience patterns for LLM provider nodes.

This module provides fault-tolerance primitives that protect the pipeline engine
from cascading failures when upstream LLM providers become unavailable or
rate-limited.

Classes:
    CircuitBreaker          -- Per-provider circuit breaker (CLOSED / OPEN / HALF_OPEN).
    CircuitBreakerOpenError -- Raised when a call is rejected by an open breaker.
    LLMResiliencePolicy     -- Combines circuit breaker + retry into one execute() call.

Functions:
    retry_with_backoff -- Decorator / callable that retries with exponential backoff + jitter.
"""

import asyncio
import functools
import inspect
import random
import threading
import time
from enum import Enum
from typing import Any, Callable, Dict, Optional, Set, Tuple, Type

try:
    import rocketlib

    _debug = getattr(rocketlib, 'debug', None)
except ImportError:
    _debug = None


def _log(msg: str) -> None:
    """Best-effort debug logging via rocketlib.debug."""
    if _debug is not None:
        _debug(msg)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class CircuitBreakerOpenError(Exception):
    """Raised when the circuit breaker is in the OPEN state and rejects a call."""

    def __init__(self, provider: str, recovery_remaining: float):
        """Initialize with the failing provider name and seconds until recovery."""
        self.provider = provider
        self.recovery_remaining = recovery_remaining
        super().__init__(f"Circuit breaker for provider '{provider}' is OPEN. Recovery in {recovery_remaining:.1f}s. Calls are rejected to prevent cascading failures.")


# ---------------------------------------------------------------------------
# Circuit Breaker
# ---------------------------------------------------------------------------


class CircuitState(Enum):
    CLOSED = 'closed'
    OPEN = 'open'
    HALF_OPEN = 'half_open'


class CircuitBreaker:
    """Thread-safe circuit breaker with CLOSED / OPEN / HALF_OPEN states.

    Parameters:
        failure_threshold   -- Number of consecutive failures before opening (default 5).
        recovery_timeout    -- Seconds to wait in OPEN before transitioning to HALF_OPEN (default 60).
        half_open_max_calls -- Max trial calls allowed while HALF_OPEN (default 1).
        provider_name       -- Human-readable label used in log messages and errors.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max_calls: int = 1,
        provider_name: str = 'unknown',
    ):
        """Create a circuit breaker with the given thresholds and provider label."""
        if failure_threshold < 1:
            raise ValueError('failure_threshold must be >= 1')
        if recovery_timeout < 0:
            raise ValueError('recovery_timeout must be >= 0')
        if half_open_max_calls < 1:
            raise ValueError('half_open_max_calls must be >= 1')
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls
        self.provider_name = provider_name

        self._lock = threading.Lock()
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._last_failure_time: Optional[float] = None
        self._half_open_calls = 0
        self._epoch = 0

    # -- public properties ---------------------------------------------------

    @property
    def state(self) -> CircuitState:
        with self._lock:
            self._maybe_transition_to_half_open()
            return self._state

    @property
    def failure_count(self) -> int:
        with self._lock:
            return self._failure_count

    # -- state transitions ---------------------------------------------------

    def _maybe_transition_to_half_open(self) -> None:
        """Must be called while holding ``self._lock``."""
        if self._state is CircuitState.OPEN and self._last_failure_time is not None:
            elapsed = time.monotonic() - self._last_failure_time
            if elapsed >= self.recovery_timeout:
                _log(f'[CircuitBreaker:{self.provider_name}] OPEN -> HALF_OPEN after {elapsed:.1f}s')
                self._state = CircuitState.HALF_OPEN
                self._half_open_calls = 0
                self._epoch += 1

    # -- public interface ----------------------------------------------------

    def allow_request(self) -> Tuple[bool, int]:
        """Return ``(allowed, epoch)``; callers pass the epoch back to record methods.

        The epoch prevents stale in-flight completions from affecting a breaker
        that has already moved to a different phase.
        """
        with self._lock:
            self._maybe_transition_to_half_open()
            if self._state is CircuitState.CLOSED:
                return True, self._epoch
            if self._state is CircuitState.HALF_OPEN:
                if self._half_open_calls < self.half_open_max_calls:
                    self._half_open_calls += 1
                    return True, self._epoch
                return False, self._epoch
            # OPEN
            return False, self._epoch

    def record_success(self, epoch: Optional[int] = None) -> None:
        """Record a successful call and reset the breaker to CLOSED if needed.

        If *epoch* is supplied and does not match the current epoch the call is
        silently ignored (the breaker has already moved to a different phase).
        """
        with self._lock:
            if epoch is not None and epoch != self._epoch:
                return
            if self._state is CircuitState.HALF_OPEN:
                _log(f'[CircuitBreaker:{self.provider_name}] HALF_OPEN -> CLOSED (success)')
            self._state = CircuitState.CLOSED
            self._failure_count = 0
            self._half_open_calls = 0
            self._epoch += 1

    def record_failure(self, epoch: Optional[int] = None) -> None:
        """Record a failed call. Opens the breaker when the threshold is reached.

        If *epoch* is supplied and does not match the current epoch the call is
        silently ignored (the breaker has already moved to a different phase).
        """
        with self._lock:
            if epoch is not None and epoch != self._epoch:
                return
            self._failure_count += 1
            self._last_failure_time = time.monotonic()

            if self._state is CircuitState.HALF_OPEN:
                _log(f'[CircuitBreaker:{self.provider_name}] HALF_OPEN -> OPEN (failure)')
                self._state = CircuitState.OPEN
                self._half_open_calls = 0
                self._epoch += 1
            elif self._state is CircuitState.CLOSED and self._failure_count >= self.failure_threshold:
                _log(f'[CircuitBreaker:{self.provider_name}] CLOSED -> OPEN (failures={self._failure_count})')
                self._state = CircuitState.OPEN
                self._epoch += 1

    def recovery_remaining(self) -> float:
        """Seconds remaining before the breaker moves to HALF_OPEN (0 if not OPEN)."""
        with self._lock:
            if self._state is not CircuitState.OPEN or self._last_failure_time is None:
                return 0.0
            elapsed = time.monotonic() - self._last_failure_time
            return max(0.0, self.recovery_timeout - elapsed)

    def reset(self) -> None:
        """Force-reset the breaker to CLOSED (useful for testing or admin overrides)."""
        with self._lock:
            self._state = CircuitState.CLOSED
            self._failure_count = 0
            self._last_failure_time = None
            self._half_open_calls = 0


# ---------------------------------------------------------------------------
# Retryable / non-retryable exception classification
# ---------------------------------------------------------------------------

# Exception class name *keywords* we consider retryable. Matched via substring
# so that prefixed variants (e.g. RerankRateLimitError) also match.
_DEFAULT_RETRYABLE_NAMES: Set[str] = {
    'RateLimitError',
    'APIConnectionError',
    'APITimeoutError',
    'InternalServerError',
    'ServiceUnavailableError',
    'ConnectionError',
    'TimeoutError',
    'Timeout',
}

_DEFAULT_NON_RETRYABLE_NAMES: Set[str] = {
    'AuthenticationError',
    'InvalidRequestError',
    'BadRequestError',
    'PermissionDeniedError',
    'NotFoundError',
}


def _is_retryable(exc: BaseException, retryable_types: Optional[Tuple[Type[BaseException], ...]] = None) -> bool:
    """Classify whether an exception is retryable using class-name heuristics.

    Uses exception class name **substring matching** (e.g., 'RateLimitError' matches
    both 'RateLimitError' and 'RerankRateLimitError') to avoid hard imports of
    provider SDKs. This is a pragmatic choice that works across all LLM providers
    and custom node exception hierarchies without coupling to specific imports.

    Known limitation: If a provider SDK uses a class name that accidentally contains
    a keyword (e.g., a 'NotFoundError' that should be retryable), this heuristic may
    misclassify. In practice, the naming conventions are consistent across providers.

    If *retryable_types* is provided, membership is checked first.  Otherwise
    we fall back to class-name heuristics so that callers don't need to import
    every SDK exception type.
    """
    if retryable_types is not None:
        return isinstance(exc, retryable_types)
    name = type(exc).__name__
    # Use substring matching so that prefixed variants (e.g. RerankRateLimitError)
    # are correctly classified alongside the canonical names (RateLimitError).
    if any(keyword in name for keyword in _DEFAULT_NON_RETRYABLE_NAMES):
        return False
    if any(keyword in name for keyword in _DEFAULT_RETRYABLE_NAMES):
        return True
    # Treat generic connection / timeout errors as retryable.
    return isinstance(exc, (ConnectionError, TimeoutError, OSError))


# ---------------------------------------------------------------------------
# Retry with backoff
# ---------------------------------------------------------------------------


def retry_with_backoff(
    fn: Optional[Callable] = None,
    *,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    retryable_types: Optional[Tuple[Type[BaseException], ...]] = None,
):
    """Retry *fn* with exponential backoff and jitter.

    Can be used as a decorator (``@retry_with_backoff``) or called directly
    (``retry_with_backoff(fn, max_retries=5)``).

    The delay for attempt *n* (0-indexed) is::

        min(base_delay * 2 ^ n + jitter, max_delay)

    where *jitter* is a random float in ``[0, base_delay)``.

    Parameters:
        fn               -- The callable to wrap/invoke.
        max_retries      -- Maximum number of retry attempts (default 3).
        base_delay       -- Initial delay in seconds (default 1.0).
        max_delay        -- Ceiling for computed delay (default 60.0).
        retryable_types  -- Explicit tuple of exception types to retry on.
                            When ``None``, the default name-based heuristic is used.
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            # NOTE: time.sleep() blocks the calling pipeline thread. Since the C++ engine
            # has a finite thread pool, a provider outage causing retries with max_delay=60s
            # could temporarily reduce available threads. This is acceptable for LLM calls
            # (which already take seconds) but should be considered when tuning max_delay.
            last_exc: Optional[BaseException] = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as exc:
                    last_exc = exc
                    if not _is_retryable(exc, retryable_types):
                        raise
                    if attempt == max_retries:
                        raise
                    delay = min(base_delay * (2**attempt) + random.uniform(0, base_delay), max_delay)
                    _log(f'[retry] attempt {attempt + 1}/{max_retries} failed ({type(exc).__name__}), retrying in {delay:.2f}s')
                    time.sleep(delay)
            raise last_exc  # pragma: no cover -- unreachable but keeps mypy happy

        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            last_exc: Optional[BaseException] = None
            for attempt in range(max_retries + 1):
                try:
                    return await func(*args, **kwargs)
                except Exception as exc:
                    last_exc = exc
                    if not _is_retryable(exc, retryable_types):
                        raise
                    if attempt == max_retries:
                        raise
                    delay = min(base_delay * (2**attempt) + random.uniform(0, base_delay), max_delay)
                    _log(f'[retry] attempt {attempt + 1}/{max_retries} failed ({type(exc).__name__}), retrying in {delay:.2f}s')
                    await asyncio.sleep(delay)
            raise last_exc  # pragma: no cover

        if inspect.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    # Allow usage as both @retry_with_backoff and @retry_with_backoff(...)
    if fn is not None:
        return decorator(fn)
    return decorator


# ---------------------------------------------------------------------------
# LLM Resilience Policy
# ---------------------------------------------------------------------------

# Module-level registry of per-provider circuit breakers.  This ensures that
# all instances of a given provider share one breaker, even when instantiated
# by different pipelines running in parallel threads.
# Provider breaker registry. In practice, bounded by the number of LLM providers
# (openai, anthropic, gemini, etc.) -- typically < 15 entries.
_provider_breakers: Dict[str, CircuitBreaker] = {}
_provider_breakers_lock = threading.Lock()


class LLMResiliencePolicy:
    """Combined circuit-breaker + retry policy scoped to a single LLM provider.

    Parameters:
        provider_name           -- Unique name for the provider (e.g. 'openai').
        failure_threshold       -- Circuit breaker failure threshold.
        recovery_timeout        -- Circuit breaker recovery timeout in seconds.
        half_open_max_calls     -- Max probing calls in HALF_OPEN state.
        max_retries             -- Retry max attempts.
        base_delay              -- Retry base delay in seconds.
        max_delay               -- Retry max delay cap in seconds.
        retryable_types         -- Explicit retryable exception types (or None).
    """

    def __init__(
        self,
        provider_name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max_calls: int = 1,
        max_retries: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        retryable_types: Optional[Tuple[Type[BaseException], ...]] = None,
    ):
        """Create a resilience policy combining circuit breaker and retry for *provider_name*."""
        if max_retries < 0:
            raise ValueError('max_retries must be >= 0')
        if base_delay < 0:
            raise ValueError('base_delay must be >= 0')
        if max_delay < 0:
            raise ValueError('max_delay must be >= 0')
        self.provider_name = provider_name
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.retryable_types = retryable_types

        # Obtain (or create) the shared breaker for this provider.
        with _provider_breakers_lock:
            if provider_name not in _provider_breakers:
                _provider_breakers[provider_name] = CircuitBreaker(
                    failure_threshold=failure_threshold,
                    recovery_timeout=recovery_timeout,
                    half_open_max_calls=half_open_max_calls,
                    provider_name=provider_name,
                )
            else:
                existing = _provider_breakers[provider_name]
                if existing.failure_threshold != failure_threshold or existing.recovery_timeout != recovery_timeout or existing.half_open_max_calls != half_open_max_calls:
                    _log(f'[LLMResiliencePolicy:{provider_name}] reusing existing breaker; ignoring new params (threshold={failure_threshold}, timeout={recovery_timeout}, half_open={half_open_max_calls})')
            self._breaker = _provider_breakers[provider_name]

    @property
    def circuit_breaker(self) -> CircuitBreaker:
        return self._breaker

    def execute(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        """Execute *fn* with circuit-breaker guard and retry-with-backoff.

        Raises ``CircuitBreakerOpenError`` immediately if the breaker is OPEN.
        """
        allowed, epoch = self._breaker.allow_request()
        if not allowed:
            raise CircuitBreakerOpenError(self.provider_name, self._breaker.recovery_remaining())

        @retry_with_backoff(max_retries=self.max_retries, base_delay=self.base_delay, max_delay=self.max_delay, retryable_types=self.retryable_types)
        def _inner() -> Any:
            return fn(*args, **kwargs)

        try:
            result = _inner()
            self._breaker.record_success(epoch)
            return result
        except Exception as exc:
            if _is_retryable(exc, self.retryable_types):
                self._breaker.record_failure(epoch)
            raise

    async def execute_async(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        """Async variant of :meth:`execute`."""
        allowed, epoch = self._breaker.allow_request()
        if not allowed:
            raise CircuitBreakerOpenError(self.provider_name, self._breaker.recovery_remaining())

        @retry_with_backoff(max_retries=self.max_retries, base_delay=self.base_delay, max_delay=self.max_delay, retryable_types=self.retryable_types)
        async def _inner() -> Any:
            return await fn(*args, **kwargs)

        try:
            result = await _inner()
            self._breaker.record_success(epoch)
            return result
        except Exception as exc:
            if _is_retryable(exc, self.retryable_types):
                self._breaker.record_failure(epoch)
            raise


def reset_all_breakers() -> None:
    """Reset every registered circuit breaker. Intended for testing."""
    with _provider_breakers_lock:
        for breaker in _provider_breakers.values():
            breaker.reset()
        _provider_breakers.clear()
