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
from typing import Optional

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
            debug(f'Warning: Prompt ({token_count} tokens) exceeds model context window ({max_tokens} tokens). The request will likely be rejected by the provider.')
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
        raise ValueError(f'Invalid model name: {model!r}. Model names must start with an alphanumeric character and contain only letters, digits, hyphens, dots, underscores, colons, at-signs, or slashes.')

    return model


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
        debug(f'Warning: Output tokens ({output_tokens}) exceeds maximum known limit ({MAX_OUTPUT_TOKENS}). Clamping to {MAX_OUTPUT_TOKENS}.')
        output_tokens = MAX_OUTPUT_TOKENS

    if output_tokens > total_tokens:
        debug(f'Warning: Output tokens ({output_tokens}) exceeds total tokens ({total_tokens}). Clamping to total tokens.')
        output_tokens = total_tokens

    return output_tokens
