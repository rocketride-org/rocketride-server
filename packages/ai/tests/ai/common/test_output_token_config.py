# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit: the custom-profile check for a max_tokens the provider would reject."""

from ai.common.validation import check_output_token_config


PROFILES = {
    'gpt-4-1-mini': {'model': 'gpt-4.1-mini', 'modelTotalTokens': 1047576, 'modelOutputTokens': 32768},
    'gpt-4-turbo': {'model': 'gpt-4-turbo', 'modelTotalTokens': 128000, 'modelOutputTokens': 4096},
    # Its own output equals its window — no limit to compare against.
    'grok-3': {'model': 'grok-3', 'modelTotalTokens': 131072, 'modelOutputTokens': 131072},
    'custom': {'model': '', 'modelTotalTokens': 16384},
}


def test_flags_output_above_the_catalogue_limit():
    problem = check_output_token_config('gpt-4.1-mini', 128000, 128000, PROFILES)
    assert problem is not None
    assert '128,000' in problem
    assert '32,768' in problem
    assert 'gpt-4.1-mini' in problem


def test_silent_when_within_the_catalogue_limit():
    assert check_output_token_config('gpt-4.1-mini', 32768, 1047576, PROFILES) is None
    assert check_output_token_config('gpt-4.1-mini', 4096, 128000, PROFILES) is None


def test_catalogue_limit_wins_over_the_equality_check():
    # Equal to the configured window, but under what the model accepts: not a problem.
    assert check_output_token_config('gpt-4-turbo', 4096, 4096, PROFILES) is None


def test_falls_back_to_equality_for_an_unknown_model():
    problem = check_output_token_config('some-local-model', 128000, 128000, PROFILES)
    assert problem is not None
    assert 'equals modelTotalTokens' in problem


def test_unknown_model_below_the_window_is_silent():
    assert check_output_token_config('some-local-model', 8192, 128000, PROFILES) is None


def test_catalogue_entry_with_its_own_swapped_value_is_not_used():
    # grok-3 states output == window, which is not a limit; fall back to equality.
    assert check_output_token_config('grok-3', 65536, 131072, PROFILES) is None
    problem = check_output_token_config('grok-3', 131072, 131072, PROFILES)
    assert problem is not None
    assert 'equals modelTotalTokens' in problem


def test_no_profiles_available():
    assert check_output_token_config('gpt-4.1-mini', 8192, 128000, None) is None
    problem = check_output_token_config('gpt-4.1-mini', 128000, 128000, {})
    assert problem is not None
