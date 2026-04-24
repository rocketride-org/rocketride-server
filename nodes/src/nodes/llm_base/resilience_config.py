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

"""Environment-driven resilience configuration for LLM provider nodes.

All settings can be overridden via environment variables:

    ROCKETRIDE_CIRCUIT_BREAKER_THRESHOLD  -- failures before opening (default 5)
    ROCKETRIDE_CIRCUIT_BREAKER_TIMEOUT    -- seconds in OPEN before HALF_OPEN (default 60)
    ROCKETRIDE_RETRY_MAX_ATTEMPTS         -- max retry attempts (default 3)
    ROCKETRIDE_RETRY_BASE_DELAY           -- initial backoff delay in seconds (default 1.0)
    ROCKETRIDE_RETRY_MAX_DELAY            -- backoff delay ceiling in seconds (default 60.0)
"""

import math
import os
from dataclasses import dataclass
from typing import Dict, Optional

from .resilience import LLMResiliencePolicy


# ---------------------------------------------------------------------------
# Configuration dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResilienceConfig:
    """Immutable snapshot of resilience settings for one provider."""

    failure_threshold: int = 5
    recovery_timeout: float = 60.0
    half_open_max_calls: int = 1
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0


# ---------------------------------------------------------------------------
# Environment variable helpers
# ---------------------------------------------------------------------------


def _env_int(key: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if value < minimum:
        return default
    return value


def _env_float(key: str, default: float, *, minimum: float = 0.0) -> float:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if not math.isfinite(value) or value < minimum:
        return default
    return value


def get_default_config() -> ResilienceConfig:
    """Build a ``ResilienceConfig`` from environment variables (or built-in defaults)."""
    return ResilienceConfig(
        failure_threshold=_env_int('ROCKETRIDE_CIRCUIT_BREAKER_THRESHOLD', 5, minimum=1),
        recovery_timeout=_env_float('ROCKETRIDE_CIRCUIT_BREAKER_TIMEOUT', 60.0, minimum=0.0),
        half_open_max_calls=1,
        max_retries=_env_int('ROCKETRIDE_RETRY_MAX_ATTEMPTS', 3, minimum=0),
        base_delay=_env_float('ROCKETRIDE_RETRY_BASE_DELAY', 1.0, minimum=0.0),
        max_delay=_env_float('ROCKETRIDE_RETRY_MAX_DELAY', 60.0, minimum=0.0),
    )


# ---------------------------------------------------------------------------
# Per-provider overrides
# ---------------------------------------------------------------------------

# Providers with known aggressive rate limits get higher retry counts by default.
_PROVIDER_OVERRIDES: Dict[str, Dict[str, object]] = {
    'openai': {},
    'anthropic': {},
    'gemini': {},
    'mistral': {},
    'ollama': {
        # Local model server -- short recovery, fewer retries.
        'recovery_timeout': 10.0,
        'max_retries': 1,
    },
    'bedrock': {},
    'deepseek': {},
    'perplexity': {},
    'qwen': {},
    'xai': {},
    'ibm_watson': {},
    'vertex': {},
}


def get_provider_config(provider_name: str) -> ResilienceConfig:
    """Return the ``ResilienceConfig`` for *provider_name*.

    Starts from the environment-derived defaults and applies any provider-
    specific overrides defined in ``_PROVIDER_OVERRIDES``.
    """
    base = get_default_config()
    overrides = _PROVIDER_OVERRIDES.get(provider_name, {})
    if not overrides:
        return base
    return ResilienceConfig(
        failure_threshold=overrides.get('failure_threshold', base.failure_threshold),
        recovery_timeout=overrides.get('recovery_timeout', base.recovery_timeout),
        half_open_max_calls=overrides.get('half_open_max_calls', base.half_open_max_calls),
        max_retries=overrides.get('max_retries', base.max_retries),
        base_delay=overrides.get('base_delay', base.base_delay),
        max_delay=overrides.get('max_delay', base.max_delay),
    )


# ---------------------------------------------------------------------------
# Factory helper
# ---------------------------------------------------------------------------


def create_resilience_policy(provider_name: str, config: Optional[ResilienceConfig] = None) -> LLMResiliencePolicy:
    """Create a new ``LLMResiliencePolicy`` for *provider_name*.

    The underlying circuit breaker may still be reused by
    ``LLMResiliencePolicy.__init__`` via the shared provider registry.
    """
    if config is None:
        config = get_provider_config(provider_name)
    return LLMResiliencePolicy(
        provider_name=provider_name,
        failure_threshold=config.failure_threshold,
        recovery_timeout=config.recovery_timeout,
        half_open_max_calls=config.half_open_max_calls,
        max_retries=config.max_retries,
        base_delay=config.base_delay,
        max_delay=config.max_delay,
    )
