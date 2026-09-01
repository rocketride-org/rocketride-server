"""
Input validation and sanitization utilities for LLM chat drivers.

This module provides functions to validate and sanitize user input before
it is sent to LLM provider APIs. It guards against:

- Control characters that cause API errors or undefined behavior
- Prompts that exceed provider context windows
- Empty or whitespace-only prompts
- Model name strings that contain unexpected characters
- Output token values that exceed known safe maximums
"""

import re
from typing import Any, Dict, Optional

from rocketlib import debug

# Matches C0/C1 control characters EXCEPT common whitespace (\t \n \r)
_CONTROL_CHAR_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]')

# Model names should be alphanumeric with hyphens, dots, slashes, colons, at-signs, and underscores
# e.g. "gpt-4", "claude-3-opus-20240229", "us.anthropic.claude-3", "meta-llama/Llama-3", "org@model"
_MODEL_NAME_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$')

# Absolute upper bound for output tokens across all known providers (as of 2026)
MAX_OUTPUT_TOKENS = 1_000_000


def sanitize_prompt(prompt: str) -> str:
    """Strip control characters from a prompt string.

    Removes C0/C1 control characters that are known to cause errors or
    undefined behavior in LLM APIs while preserving normal whitespace
    (tabs, newlines, carriage returns).

    Args:
        prompt: The raw prompt string.

    Returns:
        The sanitized prompt with control characters removed.
    """
    sanitized = _CONTROL_CHAR_RE.sub('', prompt)
    if sanitized != prompt:
        removed_count = len(prompt) - len(sanitized)
        debug(f'Sanitized {removed_count} control character(s) from prompt')
    return sanitized


def validate_prompt(prompt: str, max_tokens: int, token_counter) -> str:
    """Validate and sanitize a prompt before sending to an LLM API.

    Performs the following checks in order:
    1. Rejects empty / whitespace-only prompts
    2. Strips dangerous control characters
    3. Warns if the prompt likely exceeds the model's context window

    Args:
        prompt: The raw prompt string.
        max_tokens: The model's total token limit (context window).
        token_counter: A callable that estimates token count for a string.

    Returns:
        The sanitized prompt string, ready for the API call.

    Raises:
        ValueError: If the prompt is empty or whitespace-only.
    """
    if not prompt or not prompt.strip():
        raise ValueError('Prompt is empty or contains only whitespace.')

    # Sanitize control characters
    prompt = sanitize_prompt(prompt)

    # Re-check after sanitization to catch control-only prompts
    if not prompt.strip():
        raise ValueError('Prompt is empty after sanitization.')

    # Check token count - warn but don't block (ChatBase.chat_string already
    # has a softer check; this catches the truly egregious cases early)
    try:
        token_count = token_counter(prompt)
        if token_count > max_tokens:
            debug(
                f'Warning: Prompt ({token_count} tokens) exceeds model context window ({max_tokens} tokens). The request will likely be rejected by the provider.'
            )
    except Exception:
        # Token counting failures should not block the request
        pass

    return prompt


def validate_model_name(model: Optional[str]) -> Optional[str]:
    """Validate that a model name is well-formed.

    Args:
        model: The model identifier string, or None if not yet configured.

    Returns:
        The validated model name (stripped of leading/trailing whitespace),
        or None if model was None (not yet configured).

    Raises:
        ValueError: If the model name is non-None but empty or contains
            invalid characters.
    """
    if model is None:
        return None

    if not isinstance(model, str):
        raise ValueError(f'Model name must be a string, got {type(model).__name__}.')

    if not model.strip():
        raise ValueError('Model name was provided but is empty.')

    model = model.strip()

    if not _MODEL_NAME_RE.match(model):
        raise ValueError(
            f'Invalid model name: {model!r}. Model names must start with an alphanumeric character and contain only letters, digits, hyphens, dots, underscores, colons, at-signs, or slashes.'
        )

    return model


_TOKEN_FIELDS = ('modelTotalTokens', 'modelOutputTokens')


def hand_supplied_token_fields(connConfig: Optional[Dict[str, Any]]) -> bool:
    """True if the pipeline author wrote a token limit into this node's config.

    A node's config arrives in several shapes — keyed under a named profile, nested
    under the default profile's name, or as direct top-level fields — and a profile
    named "custom" is only one of them (``llm_openai_api`` has "custom" as its
    default, so an omitted key resolves there too). Rather than matching on the
    profile string, look for the token fields themselves at either level: their
    presence is what makes a value the author's rather than the catalogue's.

    Args:
        connConfig: The node's raw connection config, before profile resolution.

    Returns:
        True when a token field appears at the top level or in a nested block.
    """
    if not hasattr(connConfig, 'get'):
        return False

    def _has(block: Any) -> bool:
        return hasattr(block, 'get') and any(block.get(field) is not None for field in _TOKEN_FIELDS)

    if _has(connConfig):
        return True
    return any(_has(value) for value in connConfig.values())


def check_output_token_config(
    model: str,
    output_tokens: int,
    total_tokens: int,
    profiles: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Report a max_tokens value the provider is likely to reject.

    A hand-written profile carries whatever the author typed, and nothing checks
    it before the request goes out. Providers that cap completions below their
    context window answer with a 400 naming a limit the author never saw.

    Two checks, in order of usefulness:

    1. If the model name matches a catalogue profile that states a completion
       limit, anything above that limit is reported with both numbers. Catalogue
       entries whose own output equals their window are skipped — that value is
       the window, not a limit, and cannot be compared against.
    2. Otherwise, an output limit equal to the context window is reported: it
       sends the whole window as max_tokens. Legitimate where the provider has
       no separate completion limit, hence a warning rather than an error.

    Args:
        model: Configured model name.
        output_tokens: Resolved max output tokens.
        total_tokens: Resolved context window.
        profiles: The node's "preconfig.profiles" mapping, used to look the
            model up. Any mapping of profile-key to a ``.get``-able profile.

    Returns:
        The message to warn with, or None when nothing looks wrong.
    """
    catalogue_limit: Optional[int] = None
    for profile in (profiles or {}).values():
        if not hasattr(profile, 'get') or profile.get('model') != model:
            continue
        limit = profile.get('modelOutputTokens')
        if isinstance(limit, int) and not isinstance(limit, bool) and limit != profile.get('modelTotalTokens'):
            catalogue_limit = limit
            break

    if catalogue_limit is not None and output_tokens > catalogue_limit:
        return (
            f'modelOutputTokens ({output_tokens:,}) exceeds the {catalogue_limit:,} that {model} accepts. '
            'The provider will reject the request.'
        )

    if output_tokens > total_tokens:
        # About to be clamped down to the window. Silent otherwise, and it reads at
        # run time as the model simply refusing to write more.
        return (
            f'modelOutputTokens ({output_tokens:,}) is above modelTotalTokens ({total_tokens:,}) '
            f'and will be capped at the smaller value.'
        )

    if catalogue_limit is not None:
        return None

    if output_tokens == total_tokens:
        return (
            f'modelOutputTokens ({output_tokens:,}) equals modelTotalTokens, so the whole context window is sent '
            f'as max_tokens. Set the real completion limit for {model} unless this provider accepts max_tokens '
            'up to its context window.'
        )
    return None


def validate_max_tokens(output_tokens: int, total_tokens: int) -> int:
    """Validate that the output token limit is within reasonable bounds.

    Args:
        output_tokens: The configured max output tokens.
        total_tokens: The model's total context window.

    Returns:
        The validated output token value (clamped if necessary).

    Raises:
        ValueError: If output_tokens is not a positive integer.
    """
    if not isinstance(output_tokens, int) or isinstance(output_tokens, bool) or output_tokens < 1:
        raise ValueError(f'Output tokens must be a positive integer, got {output_tokens!r}.')

    if not isinstance(total_tokens, int) or isinstance(total_tokens, bool) or total_tokens < 1:
        raise ValueError(f'Total tokens must be a positive integer, got {total_tokens!r}.')

    if output_tokens > MAX_OUTPUT_TOKENS:
        debug(
            f'Warning: Output tokens ({output_tokens}) exceeds maximum known limit ({MAX_OUTPUT_TOKENS}). Clamping to {MAX_OUTPUT_TOKENS}.'
        )
        output_tokens = MAX_OUTPUT_TOKENS

    if output_tokens > total_tokens:
        debug(
            f'Warning: Output tokens ({output_tokens}) exceeds total tokens ({total_tokens}). Clamping to total tokens.'
        )
        output_tokens = total_tokens

    return output_tokens
