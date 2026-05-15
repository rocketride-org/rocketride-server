"""
Unit tests for ai.common.validation.

This module guards LLM-driver entry points by sanitising raw prompts (control
characters, empty inputs), validating model identifiers, and clamping output
token requests to known safe maxima. Each function here is pure / regex-based,
so tests are simple parametrized assertions.
"""

import pytest

from ai.common.validation import (
    MAX_OUTPUT_TOKENS,
    sanitize_prompt,
    validate_max_tokens,
    validate_model_name,
    validate_prompt,
)


# ---------------------------------------------------------------------------
# sanitize_prompt
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw, expected',
    [
        ('hello', 'hello'),
        ('hello\tworld', 'hello\tworld'),  # tab kept
        ('hello\nworld', 'hello\nworld'),  # newline kept
        ('hello\rworld', 'hello\rworld'),  # CR kept
        ('hi\x00there', 'hithere'),  # NUL stripped
        ('a\x07b', 'ab'),  # bell stripped
        ('a\x1fb', 'ab'),  # unit separator stripped
        ('a\x7fb', 'ab'),  # DEL stripped
        ('a\x9fb', 'ab'),  # C1 control stripped
        ('', ''),
    ],
)
def test_sanitize_prompt_strips_control_chars(raw, expected):
    """C0/C1 control chars are removed; tab / newline / CR are preserved."""
    assert sanitize_prompt(raw) == expected


# ---------------------------------------------------------------------------
# validate_prompt
# ---------------------------------------------------------------------------


def _zero_tokens(_text):
    """
    Token counter that always returns 0; used to disable the token-limit warning path.

    Args:
        _text: Ignored.

    Returns:
        int: zero, regardless of input.
    """
    return 0


def _huge_tokens(_text):
    """
    Token counter that always returns a number above any plausible limit.

    Args:
        _text: Ignored.

    Returns:
        int: a value bigger than any model context window.
    """
    return 10**9


def _raising_counter(_text):
    """
    Token counter that always raises; used to confirm validate_prompt swallows errors.

    Args:
        _text: Ignored.

    Raises:
        RuntimeError: always.
    """
    raise RuntimeError('counter blew up')


def test_validate_prompt_returns_sanitised_text():
    """A valid prompt with control chars comes back stripped."""
    assert validate_prompt('hello\x00world', 100, _zero_tokens) == 'helloworld'


def test_validate_prompt_rejects_empty():
    """Empty string raises ValueError."""
    with pytest.raises(ValueError, match='empty'):
        validate_prompt('', 100, _zero_tokens)


def test_validate_prompt_rejects_whitespace_only():
    """Whitespace-only input raises ValueError before reaching sanitisation."""
    with pytest.raises(ValueError, match='whitespace'):
        validate_prompt('   \n\t  ', 100, _zero_tokens)


def test_validate_prompt_rejects_control_only_after_sanitisation():
    """A prompt that becomes empty after stripping controls raises ValueError."""
    with pytest.raises(ValueError, match='after sanitization'):
        validate_prompt('\x00\x01\x02', 100, _zero_tokens)


def test_validate_prompt_does_not_raise_when_token_count_too_high():
    """Exceeding the model context window only logs a warning, never raises."""
    # Should not raise even though token count > max_tokens.
    assert validate_prompt('hello', 10, _huge_tokens) == 'hello'


def test_validate_prompt_swallows_token_counter_failures():
    """If the token counter raises, validate_prompt continues silently."""
    # Should not raise even though _raising_counter throws.
    assert validate_prompt('hello', 100, _raising_counter) == 'hello'


# ---------------------------------------------------------------------------
# validate_model_name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'name',
    [
        'gpt-4',
        'gpt-4o-mini',
        'claude-3-opus-20240229',
        'us.anthropic.claude-3',
        'meta-llama/Llama-3-70b',
        'org@model',
        'a',
        'A1_b.c-d:e/f@g',
    ],
)
def test_validate_model_name_accepts_valid(name):
    """All documented well-formed model identifiers are accepted unchanged."""
    assert validate_model_name(name) == name


def test_validate_model_name_strips_whitespace():
    """Surrounding whitespace is trimmed before validation."""
    assert validate_model_name('  gpt-4  ') == 'gpt-4'


def test_validate_model_name_none_passes_through():
    """None means 'not yet configured' and is allowed."""
    assert validate_model_name(None) is None


def test_validate_model_name_rejects_non_string():
    """A non-string non-None value raises ValueError."""
    with pytest.raises(ValueError, match='must be a string'):
        validate_model_name(123)


def test_validate_model_name_rejects_empty_string():
    """An empty / whitespace-only model name is rejected."""
    with pytest.raises(ValueError, match='empty'):
        validate_model_name('   ')


@pytest.mark.parametrize(
    'name',
    [
        '-gpt-4',  # leading hyphen
        '.gpt-4',  # leading dot
        'gpt 4',  # space
        'gpt+4',  # plus
        'gpt#4',  # hash
        'gpt\n4',  # newline
        'модель',  # non-ASCII
    ],
)
def test_validate_model_name_rejects_invalid_chars(name):
    """Names with disallowed characters or starts raise ValueError."""
    with pytest.raises(ValueError, match='Invalid model name'):
        validate_model_name(name)


# ---------------------------------------------------------------------------
# validate_max_tokens
# ---------------------------------------------------------------------------


def test_validate_max_tokens_passes_through_normal_value():
    """A reasonable output-token request below the context window is returned as-is."""
    assert validate_max_tokens(1000, 8000) == 1000


def test_validate_max_tokens_clamps_to_total():
    """Output tokens above the model's total context are clamped to total."""
    assert validate_max_tokens(20_000, 8000) == 8000


def test_validate_max_tokens_clamps_to_global_max():
    """Output tokens above MAX_OUTPUT_TOKENS are clamped, then re-clamped to total."""
    # First the global cap pulls it down to MAX_OUTPUT_TOKENS,
    # then the per-model cap pulls it down further to total_tokens.
    result = validate_max_tokens(MAX_OUTPUT_TOKENS + 1_000_000, 50_000)
    assert result == 50_000


def test_validate_max_tokens_global_cap_applies_when_total_is_huge():
    """When total_tokens is larger than MAX_OUTPUT_TOKENS, the global cap wins."""
    result = validate_max_tokens(MAX_OUTPUT_TOKENS + 1, MAX_OUTPUT_TOKENS + 100)
    assert result == MAX_OUTPUT_TOKENS


@pytest.mark.parametrize('output_tokens', [0, -1, 1.5, '100', None, True, False])
def test_validate_max_tokens_rejects_bad_output_value(output_tokens):
    """Non-int, non-positive, or bool output_tokens values raise ValueError."""
    with pytest.raises(ValueError, match='Output tokens'):
        validate_max_tokens(output_tokens, 8000)


@pytest.mark.parametrize('total_tokens', [0, -1, 1.5, '100', None, True, False])
def test_validate_max_tokens_rejects_bad_total_value(total_tokens):
    """Non-int, non-positive, or bool total_tokens values raise ValueError."""
    with pytest.raises(ValueError, match='Total tokens'):
        validate_max_tokens(100, total_tokens)
