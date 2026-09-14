# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit: the custom-profile check for a max_tokens the provider would reject."""

from ai.common.validation import check_output_token_config, hand_supplied_token_fields


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


def test_flags_output_above_the_configured_window():
    # Would be capped down to 32,768 with nothing said.
    problem = check_output_token_config('some-local-model', 131072, 32768, PROFILES)
    assert problem is not None
    assert 'capped at that value' in problem


def test_a_capped_value_the_model_accepts_is_not_called_a_rejection():
    # 128,000 configured under a 16,384 window goes out as 16,384, which
    # gpt-4.1-mini accepts. Reporting a rejection here would be wrong.
    problem = check_output_token_config('gpt-4.1-mini', 128000, 16384, PROFILES)
    assert 'reject' not in problem
    assert 'capped at that value' in problem


def test_catalogue_breach_is_reported_when_the_value_really_goes_out():
    problem = check_output_token_config('gpt-4.1-mini', 128000, 128000, PROFILES)
    assert 'exceeds the 32,768' in problem


class TestHandSuppliedTokenFields:
    def test_top_level_fields(self):
        assert hand_supplied_token_fields({'model': 'x', 'modelTotalTokens': 128000}) is True

    def test_nested_under_a_named_profile(self):
        assert hand_supplied_token_fields({'profile': 'custom', 'custom': {'modelOutputTokens': 32768}}) is True

    def test_nested_under_the_default_profile_name(self):
        # llm_openai_api's default profile is 'custom', so 'profile' is often omitted.
        assert hand_supplied_token_fields({'custom': {'modelTotalTokens': 128000}}) is True

    def test_no_token_fields(self):
        assert hand_supplied_token_fields({'profile': 'gpt-4-1-mini', 'gpt-4-1-mini': {'apikey': ''}}) is False

    def test_none_values_do_not_count(self):
        assert hand_supplied_token_fields({'modelTotalTokens': None}) is False

    def test_non_mapping(self):
        assert hand_supplied_token_fields(None) is False
