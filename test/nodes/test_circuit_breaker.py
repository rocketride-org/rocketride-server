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

"""Comprehensive tests for the LLM resilience module (circuit breaker + retry).

Tests cover:
    - Circuit breaker state transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
    - Failure counting and threshold enforcement
    - Recovery timeout behaviour
    - Thread safety under concurrent access
    - Retry with exponential backoff and jitter
    - Non-retryable exception passthrough
    - LLMResiliencePolicy end-to-end execution
    - Per-provider isolation
    - Resilience configuration from environment variables
"""

import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Path setup – ensure nodes/src/nodes is importable
# ---------------------------------------------------------------------------
NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'nodes' / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

# Provide a stub ``rocketlib`` so imports inside the resilience module work
# without the real C++ engine runtime.
if 'rocketlib' not in sys.modules:
    _mock_rocketlib = type(sys)('rocketlib')
    _mock_rocketlib.debug = lambda *a, **kw: None
    _mock_rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    sys.modules['rocketlib'] = _mock_rocketlib

    _mock_rocketlib_types = type(sys)('rocketlib.types')
    _mock_rocketlib_types.IInvokeLLM = type('IInvokeLLM', (), {})
    sys.modules['rocketlib.types'] = _mock_rocketlib_types

if 'ai' not in sys.modules:
    _mock_ai = type(sys)('ai')
    sys.modules['ai'] = _mock_ai
    _mock_ai_common = type(sys)('ai.common')
    sys.modules['ai.common'] = _mock_ai_common
    _mock_ai_common_schema = type(sys)('ai.common.schema')
    _mock_ai_common_schema.Question = type('Question', (), {})
    _mock_ai_common_schema.Answer = type('Answer', (), {})
    sys.modules['ai.common.schema'] = _mock_ai_common_schema

from llm_base.resilience import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    CircuitState,
    LLMResiliencePolicy,
    _is_retryable,
    reset_all_breakers,
    retry_with_backoff,
)
from llm_base.resilience_config import (
    ResilienceConfig,
    create_resilience_policy,
    get_default_config,
    get_provider_config,
)


# ---------------------------------------------------------------------------
# Helpers – custom exception types that mimic SDK errors by name
# ---------------------------------------------------------------------------


class RateLimitError(Exception):
    pass


class APIConnectionError(Exception):
    pass


class APITimeoutError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class InvalidRequestError(Exception):
    pass


class BadRequestError(Exception):
    pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_breakers():
    """Ensure every test starts with a clean breaker registry."""
    reset_all_breakers()
    yield
    reset_all_breakers()


# ===========================================================================
# Circuit Breaker – State Transitions
# ===========================================================================


class TestCircuitBreakerStates:
    def test_initial_state_is_closed(self):
        cb = CircuitBreaker(provider_name='test')
        assert cb.state is CircuitState.CLOSED

    def test_stays_closed_below_threshold(self):
        cb = CircuitBreaker(failure_threshold=5, provider_name='test')
        for _ in range(4):
            cb.record_failure()
        assert cb.state is CircuitState.CLOSED

    def test_opens_at_threshold(self):
        cb = CircuitBreaker(failure_threshold=3, provider_name='test')
        for _ in range(3):
            cb.record_failure()
        assert cb.state is CircuitState.OPEN

    def test_open_rejects_requests(self):
        cb = CircuitBreaker(failure_threshold=1, provider_name='test')
        cb.record_failure()
        assert cb.state is CircuitState.OPEN
        assert cb.allow_request() is False

    def test_transitions_to_half_open_after_recovery(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1, provider_name='test')
        cb.record_failure()
        assert cb.state is CircuitState.OPEN
        time.sleep(0.15)
        assert cb.state is CircuitState.HALF_OPEN

    def test_half_open_allows_limited_calls(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.05, half_open_max_calls=1, provider_name='test')
        cb.record_failure()
        time.sleep(0.1)
        assert cb.allow_request() is True  # first call allowed
        assert cb.allow_request() is False  # second call rejected

    def test_half_open_success_closes_breaker(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.05, provider_name='test')
        cb.record_failure()
        time.sleep(0.1)
        cb.allow_request()
        cb.record_success()
        assert cb.state is CircuitState.CLOSED
        assert cb.failure_count == 0

    def test_half_open_failure_reopens_breaker(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.05, provider_name='test')
        cb.record_failure()
        time.sleep(0.1)
        cb.allow_request()
        cb.record_failure()
        assert cb.state is CircuitState.OPEN

    def test_full_cycle_closed_open_half_open_closed(self):
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.05, provider_name='test')
        # CLOSED
        assert cb.state is CircuitState.CLOSED
        cb.record_failure()
        cb.record_failure()
        # OPEN
        assert cb.state is CircuitState.OPEN
        time.sleep(0.1)
        # HALF_OPEN
        assert cb.state is CircuitState.HALF_OPEN
        cb.allow_request()
        cb.record_success()
        # CLOSED again
        assert cb.state is CircuitState.CLOSED

    def test_success_resets_failure_count(self):
        cb = CircuitBreaker(failure_threshold=5, provider_name='test')
        cb.record_failure()
        cb.record_failure()
        assert cb.failure_count == 2
        cb.record_success()
        assert cb.failure_count == 0

    def test_recovery_remaining_when_open(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=10.0, provider_name='test')
        cb.record_failure()
        remaining = cb.recovery_remaining()
        assert remaining > 9.0
        assert remaining <= 10.0

    def test_recovery_remaining_when_not_open(self):
        cb = CircuitBreaker(provider_name='test')
        assert cb.recovery_remaining() == 0.0

    def test_reset(self):
        cb = CircuitBreaker(failure_threshold=1, provider_name='test')
        cb.record_failure()
        assert cb.state is CircuitState.OPEN
        cb.reset()
        assert cb.state is CircuitState.CLOSED
        assert cb.failure_count == 0


# ===========================================================================
# Circuit Breaker – Thread Safety
# ===========================================================================


class TestCircuitBreakerThreadSafety:
    def test_concurrent_failures_do_not_corrupt_state(self):
        cb = CircuitBreaker(failure_threshold=100, provider_name='thread-test')
        errors = []

        def hammer():
            try:
                for _ in range(50):
                    cb.record_failure()
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=hammer) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert cb.failure_count == 500

    def test_concurrent_success_and_failure(self):
        cb = CircuitBreaker(failure_threshold=1000, provider_name='thread-test')
        errors = []

        def mixed():
            try:
                for i in range(100):
                    if i % 2 == 0:
                        cb.record_failure()
                    else:
                        cb.record_success()
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=mixed) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        # State should be deterministic — either CLOSED or OPEN depending on
        # the final operation. The important assertion is no exception/deadlock.
        assert cb.state in (CircuitState.CLOSED, CircuitState.OPEN)


# ===========================================================================
# Retryable exception classification
# ===========================================================================


class TestIsRetryable:
    def test_rate_limit_is_retryable(self):
        assert _is_retryable(RateLimitError()) is True

    def test_connection_error_is_retryable(self):
        assert _is_retryable(APIConnectionError()) is True

    def test_timeout_error_is_retryable(self):
        assert _is_retryable(APITimeoutError()) is True

    def test_auth_error_is_not_retryable(self):
        assert _is_retryable(AuthenticationError()) is False

    def test_invalid_request_is_not_retryable(self):
        assert _is_retryable(InvalidRequestError()) is False

    def test_bad_request_is_not_retryable(self):
        assert _is_retryable(BadRequestError()) is False

    def test_generic_connection_error_is_retryable(self):
        assert _is_retryable(ConnectionError()) is True

    def test_generic_timeout_error_is_retryable(self):
        assert _is_retryable(TimeoutError()) is True

    def test_unknown_error_is_not_retryable(self):
        assert _is_retryable(ValueError('oops')) is False

    def test_explicit_retryable_types_override(self):
        assert _is_retryable(ValueError('oops'), retryable_types=(ValueError,)) is True
        assert _is_retryable(RateLimitError(), retryable_types=(ValueError,)) is False


# ===========================================================================
# Retry with backoff
# ===========================================================================


class TestRetryWithBackoff:
    def test_succeeds_on_first_try(self):
        call_count = 0

        @retry_with_backoff(max_retries=3, base_delay=0.01)
        def succeed():
            nonlocal call_count
            call_count += 1
            return 'ok'

        assert succeed() == 'ok'
        assert call_count == 1

    def test_retries_on_retryable_error(self):
        call_count = 0

        @retry_with_backoff(max_retries=3, base_delay=0.01)
        def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RateLimitError('rate limited')
            return 'recovered'

        assert flaky() == 'recovered'
        assert call_count == 3

    def test_raises_after_max_retries(self):
        call_count = 0

        @retry_with_backoff(max_retries=2, base_delay=0.01)
        def always_fail():
            nonlocal call_count
            call_count += 1
            raise RateLimitError('always')

        with pytest.raises(RateLimitError):
            always_fail()
        # 1 initial + 2 retries = 3 total calls
        assert call_count == 3

    def test_does_not_retry_non_retryable(self):
        call_count = 0

        @retry_with_backoff(max_retries=5, base_delay=0.01)
        def auth_fail():
            nonlocal call_count
            call_count += 1
            raise AuthenticationError('bad key')

        with pytest.raises(AuthenticationError):
            auth_fail()
        assert call_count == 1

    def test_jitter_varies_delay(self):
        """Verify backoff delay includes randomised jitter by checking timing."""
        delays = []

        def recording_sleep(seconds):
            delays.append(seconds)
            # Don't actually sleep to keep tests fast.

        call_count = 0

        @retry_with_backoff(max_retries=3, base_delay=0.5, max_delay=100.0)
        def fail():
            nonlocal call_count
            call_count += 1
            raise RateLimitError()

        with patch('llm_base.resilience.time.sleep', side_effect=recording_sleep):
            with pytest.raises(RateLimitError):
                fail()

        # We should have 3 recorded delays (one per retry).
        assert len(delays) == 3
        # Delays should roughly follow 0.5*2^0 + jitter, 0.5*2^1 + jitter, 0.5*2^2 + jitter.
        # The first delay should be in [0.5, 1.0), the second in [1.0, 1.5), etc.
        assert 0.5 <= delays[0] < 1.0
        assert 1.0 <= delays[1] < 1.5
        assert 2.0 <= delays[2] < 2.5

    def test_max_delay_cap(self):
        """Ensure delay never exceeds max_delay."""
        delays = []

        def recording_sleep(seconds):
            delays.append(seconds)

        call_count = 0

        @retry_with_backoff(max_retries=5, base_delay=10.0, max_delay=15.0)
        def fail():
            nonlocal call_count
            call_count += 1
            raise RateLimitError()

        with patch('llm_base.resilience.time.sleep', side_effect=recording_sleep):
            with pytest.raises(RateLimitError):
                fail()

        for d in delays:
            assert d <= 15.0

    def test_decorator_without_parens(self):
        """@retry_with_backoff (no parens) should also work."""

        @retry_with_backoff
        def identity(x):
            return x

        assert identity(42) == 42

    def test_explicit_retryable_types(self):
        call_count = 0

        @retry_with_backoff(max_retries=2, base_delay=0.01, retryable_types=(ValueError,))
        def fail_value():
            nonlocal call_count
            call_count += 1
            raise ValueError('boom')

        with pytest.raises(ValueError):
            fail_value()
        assert call_count == 3  # 1 + 2 retries


# ===========================================================================
# Async retry
# ===========================================================================


class TestAsyncRetry:
    def test_async_succeeds(self):
        call_count = 0

        @retry_with_backoff(max_retries=3, base_delay=0.01)
        async def succeed():
            nonlocal call_count
            call_count += 1
            return 'ok'

        result = asyncio.run(succeed())
        assert result == 'ok'
        assert call_count == 1

    def test_async_retries(self):
        call_count = 0

        @retry_with_backoff(max_retries=3, base_delay=0.01)
        async def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise RateLimitError()
            return 'recovered'

        result = asyncio.run(flaky())
        assert result == 'recovered'
        assert call_count == 2


# ===========================================================================
# LLMResiliencePolicy – End-to-end
# ===========================================================================


class TestLLMResiliencePolicy:
    def test_successful_call(self):
        policy = LLMResiliencePolicy(provider_name='test-e2e', failure_threshold=3)
        result = policy.execute(lambda: 'hello')
        assert result == 'hello'
        assert policy.circuit_breaker.state is CircuitState.CLOSED

    def test_retries_then_succeeds(self):
        call_count = 0

        def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RateLimitError()
            return 'ok'

        policy = LLMResiliencePolicy(provider_name='test-flaky', failure_threshold=5, max_retries=3, base_delay=0.01)
        result = policy.execute(flaky)
        assert result == 'ok'
        assert policy.circuit_breaker.state is CircuitState.CLOSED

    def test_opens_circuit_after_repeated_failures(self):
        policy = LLMResiliencePolicy(provider_name='test-open', failure_threshold=2, max_retries=0, base_delay=0.01)

        for _ in range(2):
            with pytest.raises(RateLimitError):
                policy.execute(self._always_rate_limit)

        # Circuit should now be OPEN
        assert policy.circuit_breaker.state is CircuitState.OPEN

        # Next call should be rejected immediately
        with pytest.raises(CircuitBreakerOpenError) as exc_info:
            policy.execute(lambda: 'nope')
        assert 'test-open' in str(exc_info.value)

    def test_circuit_breaker_open_error_has_provider_and_remaining(self):
        policy = LLMResiliencePolicy(provider_name='test-err', failure_threshold=1, max_retries=0, recovery_timeout=30.0)
        with pytest.raises(RateLimitError):
            policy.execute(self._always_rate_limit)

        with pytest.raises(CircuitBreakerOpenError) as exc_info:
            policy.execute(lambda: None)
        err = exc_info.value
        assert err.provider == 'test-err'
        assert err.recovery_remaining > 0

    def test_non_retryable_still_records_failure(self):
        policy = LLMResiliencePolicy(provider_name='test-nonretry', failure_threshold=2, max_retries=3, base_delay=0.01)

        with pytest.raises(AuthenticationError):
            policy.execute(self._always_auth_error)
        # Even though we didn't retry, the failure is recorded.
        assert policy.circuit_breaker.failure_count == 1

    @staticmethod
    def _always_rate_limit():
        raise RateLimitError('rate limited')

    @staticmethod
    def _always_auth_error():
        raise AuthenticationError('bad key')


# ===========================================================================
# Per-provider isolation
# ===========================================================================


class TestProviderIsolation:
    def test_provider_a_failure_does_not_affect_provider_b(self):
        policy_a = LLMResiliencePolicy(provider_name='iso-provider-a', failure_threshold=1, max_retries=0)
        policy_b = LLMResiliencePolicy(provider_name='iso-provider-b', failure_threshold=1, max_retries=0)

        # Fail provider A until open
        with pytest.raises(RateLimitError):
            policy_a.execute(lambda: (_ for _ in ()).throw(RateLimitError()))
        assert policy_a.circuit_breaker.state is CircuitState.OPEN

        # Provider B should still work
        assert policy_b.circuit_breaker.state is CircuitState.CLOSED
        result = policy_b.execute(lambda: 'b-ok')
        assert result == 'b-ok'

    def test_same_provider_shares_breaker(self):
        p1 = LLMResiliencePolicy(provider_name='shared-prov', failure_threshold=5)
        p2 = LLMResiliencePolicy(provider_name='shared-prov', failure_threshold=5)
        assert p1.circuit_breaker is p2.circuit_breaker


# ===========================================================================
# Resilience Config
# ===========================================================================


class TestResilienceConfig:
    def test_default_config_values(self):
        cfg = get_default_config()
        assert cfg.failure_threshold == 5
        assert cfg.recovery_timeout == 60.0
        assert cfg.max_retries == 3
        assert cfg.base_delay == 1.0
        assert cfg.max_delay == 60.0

    def test_env_overrides(self):
        env = {
            'ROCKETRIDE_CIRCUIT_BREAKER_THRESHOLD': '10',
            'ROCKETRIDE_CIRCUIT_BREAKER_TIMEOUT': '120.5',
            'ROCKETRIDE_RETRY_MAX_ATTEMPTS': '7',
            'ROCKETRIDE_RETRY_BASE_DELAY': '2.5',
            'ROCKETRIDE_RETRY_MAX_DELAY': '30.0',
        }
        with patch.dict(os.environ, env):
            cfg = get_default_config()
        assert cfg.failure_threshold == 10
        assert cfg.recovery_timeout == 120.5
        assert cfg.max_retries == 7
        assert cfg.base_delay == 2.5
        assert cfg.max_delay == 30.0

    def test_invalid_env_falls_back_to_default(self):
        with patch.dict(os.environ, {'ROCKETRIDE_CIRCUIT_BREAKER_THRESHOLD': 'not-a-number'}):
            cfg = get_default_config()
        assert cfg.failure_threshold == 5

    def test_ollama_override(self):
        cfg = get_provider_config('ollama')
        assert cfg.recovery_timeout == 10.0
        assert cfg.max_retries == 1

    def test_unknown_provider_gets_defaults(self):
        cfg = get_provider_config('some_new_provider')
        default = get_default_config()
        assert cfg == default

    def test_create_resilience_policy_factory(self):
        policy = create_resilience_policy('factory-test')
        assert isinstance(policy, LLMResiliencePolicy)
        assert policy.provider_name == 'factory-test'

    def test_create_resilience_policy_with_custom_config(self):
        cfg = ResilienceConfig(failure_threshold=99, max_retries=0)
        policy = create_resilience_policy('custom-test', config=cfg)
        assert policy.circuit_breaker.failure_threshold == 99
        assert policy.max_retries == 0
