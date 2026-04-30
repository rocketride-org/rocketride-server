"""
Smoke tester — validates that a newly discovered model is actually usable
before it is added to services.json.

Each provider type (chat vs embed) has its own minimal call.  The test
uses the raw provider SDK (openai, anthropic, google-genai, mistralai) —
NOT langchain — so the sync script has minimal runtime dependencies.

The ``is_retryable_error`` function from ``ai.common.util`` is reused
here so retry/skip classification is identical to what the engine uses.

Smoke-test outcomes
-------------------
  PASS   — API accepted the model and returned a response
  SKIP   — API rejected the model (403, 400, 404) — do not add
  RETRY  — Transient error (503, 429) — caller may retry; treated as SKIP
            after all retries are exhausted
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from core.util import is_retryable_error


SmokeOutcome = Literal['pass', 'skip', 'error']

_MAX_RETRIES = 3
_BASE_DELAY = 2.0
_MAX_DELAY = 30.0

_SMOKE_PROMPT = [{'role': 'user', 'content': 'Reply with the word OK only.'}]
_SMOKE_EMBED_INPUT = 'smoke test'


@dataclass
class SmokeResult:
    """
    Result of a single smoke test call.

    Attributes:
        outcome: 'pass', 'skip', or 'error'
        reason: Human-readable reason for skip/error outcomes
    """

    outcome: SmokeOutcome
    reason: str = ''

    def passed(self) -> bool:
        return self.outcome == 'pass'


def _smoke_chat_openai_compat(client: object, model_id: str) -> SmokeResult:
    """
    Smoke test for OpenAI-compatible chat endpoints (OpenAI, DeepSeek, xAI,
    Perplexity, Mistral, Qwen).

    Handles the OpenAI o1/o3/gpt-5.x family that requires ``max_completion_tokens``
    instead of ``max_tokens``: if the first attempt fails with that specific 400,
    a second attempt is made with the correct parameter.

    Args:
        client: An openai.OpenAI (or compatible) client instance
        model_id: Model ID to test

    Returns:
        SmokeResult
    """
    # Parameters to try in order. Newer OpenAI models reject max_tokens and
    # require max_completion_tokens; older / other-provider models do not
    # recognise max_completion_tokens.
    token_param_variants = [
        {'max_completion_tokens': 5},
        {'max_tokens': 5},
    ]

    last_error: Exception | None = None

    for token_params in token_param_variants:
        for attempt in range(_MAX_RETRIES):
            try:
                client.chat.completions.create(  # type: ignore[attr-defined]
                    model=model_id,
                    messages=_SMOKE_PROMPT,
                    **token_params,
                )
                return SmokeResult('pass')
            except Exception as e:
                last_error = e
                error_str = str(e).lower()

                # If this parameter variant was rejected, try the next one.
                # OpenAI old models: 400 "unsupported_parameter: max_completion_tokens"
                # Mistral / others:  422 "extra_forbidden: max_completion_tokens not permitted"
                if 'max_completion_tokens' in error_str and ('unsupported' in error_str or 'extra_forbidden' in error_str or 'not permitted' in error_str or 'extra inputs' in error_str):
                    break  # move to next token_params variant

                if is_retryable_error(e) and attempt < _MAX_RETRIES - 1:
                    delay = min(_BASE_DELAY * (2**attempt), _MAX_DELAY)
                    time.sleep(delay)
                    continue

                if is_retryable_error(e):
                    return SmokeResult('error', f'Transient error after {_MAX_RETRIES} attempts: {e}')

                return SmokeResult('skip', str(e))

    # Both variants exhausted
    return SmokeResult('skip', str(last_error))


def _smoke_chat_anthropic(client: object, model_id: str) -> SmokeResult:
    """
    Smoke test for Anthropic messages API.

    Args:
        client: An anthropic.Anthropic client instance
        model_id: Model ID to test

    Returns:
        SmokeResult
    """
    for attempt in range(_MAX_RETRIES):
        try:
            client.messages.create(  # type: ignore[attr-defined]
                model=model_id,
                max_tokens=5,
                messages=_SMOKE_PROMPT,
            )
            return SmokeResult('pass')
        except Exception as e:
            if is_retryable_error(e) and attempt < _MAX_RETRIES - 1:
                delay = min(_BASE_DELAY * (2**attempt), _MAX_DELAY)
                time.sleep(delay)
                continue
            if is_retryable_error(e):
                return SmokeResult('error', f'Transient error after {_MAX_RETRIES} attempts: {e}')
            return SmokeResult('skip', str(e))

    return SmokeResult('error', 'Unexpected exit from retry loop')


def _smoke_chat_gemini(client: object, model_id: str) -> SmokeResult:
    """
    Smoke test for Google Gemini generateContent API.

    Args:
        client: A google.genai.Client instance
        model_id: Model ID to test (may have "models/" prefix)

    Returns:
        SmokeResult
    """
    for attempt in range(_MAX_RETRIES):
        try:
            client.models.generate_content(  # type: ignore[attr-defined]
                model=model_id,
                contents='Reply with the word OK only.',
            )
            return SmokeResult('pass')
        except Exception as e:
            if is_retryable_error(e) and attempt < _MAX_RETRIES - 1:
                delay = min(_BASE_DELAY * (2**attempt), _MAX_DELAY)
                time.sleep(delay)
                continue
            if is_retryable_error(e):
                return SmokeResult('error', f'Transient error after {_MAX_RETRIES} attempts: {e}')
            return SmokeResult('skip', str(e))

    return SmokeResult('error', 'Unexpected exit from retry loop')


def _smoke_embed_openai(client: object, model_id: str) -> SmokeResult:
    """
    Smoke test for OpenAI embedding models.

    Args:
        client: An openai.OpenAI client instance
        model_id: Embedding model ID to test

    Returns:
        SmokeResult
    """
    for attempt in range(_MAX_RETRIES):
        try:
            result = client.embeddings.create(  # type: ignore[attr-defined]
                model=model_id,
                input=_SMOKE_EMBED_INPUT,
            )
            # Verify we got an actual vector back
            if result.data and result.data[0].embedding:
                return SmokeResult('pass')
            return SmokeResult('skip', 'Empty embedding vector returned')
        except Exception as e:
            if is_retryable_error(e) and attempt < _MAX_RETRIES - 1:
                delay = min(_BASE_DELAY * (2**attempt), _MAX_DELAY)
                time.sleep(delay)
                continue
            if is_retryable_error(e):
                return SmokeResult('error', f'Transient error after {_MAX_RETRIES} attempts: {e}')
            return SmokeResult('skip', str(e))

    return SmokeResult('error', 'Unexpected exit from retry loop')


# Registry: smoke_type → callable(client, model_id) -> SmokeResult
_SMOKE_FUNCTIONS = {
    'chat_openai_compat': _smoke_chat_openai_compat,
    'chat_anthropic': _smoke_chat_anthropic,
    'chat_gemini': _smoke_chat_gemini,
    'embed_openai': _smoke_embed_openai,
}


def run(smoke_type: str, client: object, model_id: str) -> SmokeResult:
    """
    Run a smoke test for the given model.

    Args:
        smoke_type: One of the keys in the internal registry
                    ('chat_openai_compat', 'chat_anthropic', 'chat_gemini', 'embed_openai')
        client: Provider SDK client instance
        model_id: Model ID to test

    Returns:
        SmokeResult

    Raises:
        KeyError: If smoke_type is not recognised
    """
    fn = _SMOKE_FUNCTIONS.get(smoke_type)
    if fn is None:
        raise KeyError(f'Unknown smoke_type: {smoke_type!r}. Valid types: {list(_SMOKE_FUNCTIONS)}')
    return fn(client, model_id)
