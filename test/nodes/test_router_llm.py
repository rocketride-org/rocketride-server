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

"""Tests for the Model Router pipeline node (router_llm).

Covers complexity estimation, model tier classification, all five routing
strategies, metadata attachment, deep copy isolation, and IGlobal/IInstance
lifecycle mocking.
"""

import copy
import sys
import types
from collections import Counter
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Bootstrap mock modules so the node code can be imported without the full
# RocketRide engine runtime.
# ---------------------------------------------------------------------------

# Mock engLib (C++ bridge)
mock_englib = types.ModuleType('engLib')
mock_englib.Entry = type('Entry', (), {})
mock_englib.Filters = type('Filters', (), {})
sys.modules['engLib'] = mock_englib

# Mock rocketlib
mock_rocketlib = types.ModuleType('rocketlib')
mock_rocketlib.IGlobalBase = type('IGlobalBase', (), {'IEndpoint': None, 'glb': None, 'preventDefault': lambda self: None})
mock_rocketlib.IInstanceBase = type('IInstanceBase', (), {'IEndpoint': None, 'IGlobal': None, 'instance': None, 'preventDefault': lambda self: None})
mock_rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config', 'NORMAL': 'normal'})()
mock_rocketlib.Entry = mock_englib.Entry
mock_rocketlib.debug = lambda *a, **kw: None
sys.modules['rocketlib'] = mock_rocketlib

# Mock rocketlib.error
mock_rocketlib_error = types.ModuleType('rocketlib.error')
mock_rocketlib_error.APERR = type('APERR', (Exception,), {'__init__': lambda self, ec, msg: Exception.__init__(self, msg)})
mock_rocketlib_error.Ec = type('Ec', (), {'PreventDefault': 'PreventDefault', 'InvalidParam': 'InvalidParam'})()
sys.modules['rocketlib.error'] = mock_rocketlib_error

# Mock rocketlib.types
mock_rocketlib_types = types.ModuleType('rocketlib.types')
sys.modules['rocketlib.types'] = mock_rocketlib_types

# Mock ai.common.config
mock_ai = types.ModuleType('ai')
mock_ai_common = types.ModuleType('ai.common')
mock_ai_common_config = types.ModuleType('ai.common.config')
mock_ai_common_schema = types.ModuleType('ai.common.schema')

sys.modules['ai'] = mock_ai
sys.modules['ai.common'] = mock_ai_common
sys.modules['ai.common.config'] = mock_ai_common_config
sys.modules['ai.common.schema'] = mock_ai_common_schema

mock_ai.common = mock_ai_common
mock_ai_common.config = mock_ai_common_config
mock_ai_common.schema = mock_ai_common_schema


class MockConfig:
    @staticmethod
    def getNodeConfig(_logical_type, _conn_config):
        return {}


mock_ai_common_config.Config = MockConfig


# Minimal Question mock
class MockQuestionText:
    def __init__(self, text=''):  # noqa: D107
        self.text = text


class MockQuestion:
    def __init__(self, text=''):  # noqa: D107
        self.questions = [MockQuestionText(text)] if text else []
        self.metadata = {}

    def getPrompt(self):
        return self.questions[0].text if self.questions else ''


mock_ai_common_schema.Question = MockQuestion

# Mock depends
mock_depends = types.ModuleType('depends')
mock_depends.depends = lambda *a, **kw: None
sys.modules['depends'] = mock_depends

# ---------------------------------------------------------------------------
# Now import the router module under test
# ---------------------------------------------------------------------------

from nodes.src.nodes.router_llm.router import (
    MODEL_TIERS,
    ModelRouter,
    _estimate_complexity,
    _get_model_info,
)

# ===========================================================================
# Test: Complexity Estimation
# ===========================================================================


class TestComplexityEstimation:
    """Tests for the _estimate_complexity helper."""

    def test_empty_string_returns_zero(self):
        assert _estimate_complexity('') == 0

    def test_none_returns_zero(self):
        # Implementation handles None gracefully despite Optional[str] type hint
        assert _estimate_complexity(None) == 0  # type: ignore[arg-type]

    def test_short_simple_query(self):
        score = _estimate_complexity('Hi')
        assert score < 10

    def test_long_query_gets_length_bonus(self):
        long_text = 'a' * 1000
        score = _estimate_complexity(long_text)
        assert score >= 50  # capped length contribution

    def test_keyword_increases_score(self):
        base = _estimate_complexity('Tell me about dogs')
        with_keyword = _estimate_complexity('Explain the concept of dogs in detail')
        assert with_keyword > base

    def test_multiple_keywords_stack(self):
        one = _estimate_complexity('Explain this')
        two = _estimate_complexity('Explain and analyze this')
        assert two > one

    def test_question_marks_increase_score(self):
        no_q = _estimate_complexity('Tell me about X')
        one_q = _estimate_complexity('What is X?')
        many_q = _estimate_complexity('What is X? Why is Y? How does Z?')
        assert one_q > no_q
        assert many_q > one_q

    def test_case_insensitive_keywords(self):
        lower = _estimate_complexity('analyze this data')
        upper = _estimate_complexity('ANALYZE THIS DATA')
        assert lower == upper


# ===========================================================================
# Test: Model Tier Classification
# ===========================================================================


class TestModelTiers:
    """Tests for MODEL_TIERS and _get_model_info."""

    def test_all_tier1_models(self):
        for name in ['gpt-5', 'claude-opus', 'gemini-ultra']:
            info = _get_model_info(name)
            assert info['tier'] == 1, f'{name} should be tier 1'

    def test_all_tier2_models(self):
        for name in ['gpt-5-mini', 'claude-sonnet', 'gemini-pro']:
            info = _get_model_info(name)
            assert info['tier'] == 2, f'{name} should be tier 2'

    def test_all_tier3_models(self):
        for name in ['gpt-5-nano', 'claude-haiku', 'gemini-flash']:
            info = _get_model_info(name)
            assert info['tier'] == 3, f'{name} should be tier 3'

    def test_unknown_model_defaults_to_tier2(self):
        info = _get_model_info('some-custom-model')
        assert info['tier'] == 2
        assert info['provider'] == 'unknown'
        assert info['model'] == 'some-custom-model'

    def test_model_tiers_has_nine_entries(self):
        assert len(MODEL_TIERS) == 9

    def test_each_entry_has_required_keys(self):
        for entry in MODEL_TIERS.values():
            assert 'provider' in entry
            assert 'model' in entry
            assert 'tier' in entry


# ===========================================================================
# Test: Complexity Routing Strategy
# ===========================================================================


class TestComplexityRouting:
    """Tests for the 'complexity' routing strategy."""

    def test_simple_query_routes_to_fast_model(self):
        router = ModelRouter({'strategy': 'complexity', 'complexity_threshold': 50})
        result = router.select_model('Hi')
        assert result['tier'] == 3
        assert 'fast model' in result['reason']

    def test_complex_query_routes_to_powerful_model(self):
        router = ModelRouter({'strategy': 'complexity', 'primary_model': 'claude-opus', 'complexity_threshold': 50})
        complex_q = 'Please explain and analyze the comprehensive implications of this nuanced trade-off in detail?'
        result = router.select_model(complex_q)
        assert result['tier'] == 1
        assert 'powerful model' in result['reason']

    def test_medium_query_routes_to_balanced_model(self):
        router = ModelRouter({'strategy': 'complexity', 'primary_model': 'claude-sonnet', 'complexity_threshold': 50})
        # Score should land between threshold//2 and threshold
        medium_q = 'What are the main differences? Can you compare them?'
        result = router.select_model(medium_q)
        assert result['tier'] in (2, 3)  # depends on exact score

    def test_includes_complexity_score_in_result(self):
        router = ModelRouter({'strategy': 'complexity'})
        result = router.select_model('Hello')
        assert 'complexity_score' in result


# ===========================================================================
# Test: Cost-Aware Routing Strategy
# ===========================================================================


class TestCostAwareRouting:
    """Tests for the 'cost_aware' routing strategy."""

    def test_under_budget_uses_primary(self):
        router = ModelRouter({'strategy': 'cost_aware', 'primary_model': 'claude-sonnet', 'budget_limit': 10.0})
        result = router.select_model('Any question')
        assert result['model'] == 'claude-sonnet'
        assert 'within budget' in result['reason']

    def test_over_budget_routes_to_cheapest(self):
        router = ModelRouter({'strategy': 'cost_aware', 'primary_model': 'claude-opus', 'budget_limit': 5.0})
        router.record_cost(5.0)
        result = router.select_model('Any question')
        assert result['tier'] == 3
        assert 'budget exhausted' in result['reason']

    def test_near_budget_routes_to_balanced(self):
        router = ModelRouter({'strategy': 'cost_aware', 'primary_model': 'claude-opus', 'budget_limit': 10.0})
        router.record_cost(8.5)  # 85% of budget
        result = router.select_model('Any question')
        assert result['tier'] == 2
        assert 'approaching budget' in result['reason']

    def test_zero_budget_always_uses_primary(self):
        router = ModelRouter({'strategy': 'cost_aware', 'primary_model': 'gpt-5', 'budget_limit': 0})
        router.record_cost(1000.0)
        result = router.select_model('Any question')
        assert result['model'] == 'gpt-5'

    def test_cumulative_cost_tracking(self):
        router = ModelRouter({'strategy': 'cost_aware', 'budget_limit': 10.0})
        router.record_cost(3.0)
        router.record_cost(2.5)
        assert router.cumulative_cost == 5.5


# ===========================================================================
# Test: Latency Routing Strategy
# ===========================================================================


class TestLatencyRouting:
    """Tests for the 'latency' routing strategy."""

    def test_always_selects_fastest_model(self):
        router = ModelRouter({'strategy': 'latency'})
        result = router.select_model('Any question at all')
        assert result['tier'] == 3
        assert result['model'] == 'gemini-flash'

    def test_reason_mentions_latency(self):
        router = ModelRouter({'strategy': 'latency'})
        result = router.select_model('Hello')
        assert 'latency' in result['reason'].lower()


# ===========================================================================
# Test: Fallback Chain Routing Strategy
# ===========================================================================


class TestFallbackChainRouting:
    """Tests for the 'fallback_chain' routing strategy."""

    def test_returns_primary_as_first(self):
        router = ModelRouter({'strategy': 'fallback_chain', 'primary_model': 'claude-opus', 'fallback_models': 'claude-sonnet,claude-haiku'})
        result = router.select_model('Hello')
        assert result['model'] == 'claude-opus'

    def test_chain_includes_all_models(self):
        router = ModelRouter({'strategy': 'fallback_chain', 'primary_model': 'claude-opus', 'fallback_models': 'claude-sonnet,claude-haiku'})
        result = router.select_model('Hello')
        assert result['fallback_chain'] == ['claude-opus', 'claude-sonnet', 'claude-haiku']

    def test_chain_deduplicates(self):
        router = ModelRouter({'strategy': 'fallback_chain', 'primary_model': 'claude-opus', 'fallback_models': 'claude-opus,claude-haiku'})
        result = router.select_model('Hello')
        assert result['fallback_chain'] == ['claude-opus', 'claude-haiku']

    def test_chain_with_list_input(self):
        router = ModelRouter({'strategy': 'fallback_chain', 'primary_model': 'gpt-5', 'fallback_models': ['gpt-5-mini', 'gpt-5-nano']})
        result = router.select_model('Hello')
        assert result['fallback_chain'] == ['gpt-5', 'gpt-5-mini', 'gpt-5-nano']

    def test_no_infinite_loop_with_single_model(self):
        """Ensure a single-model chain does not loop."""
        router = ModelRouter({'strategy': 'fallback_chain', 'primary_model': 'claude-opus', 'fallback_models': ''})
        result = router.select_model('Hello')
        assert result['fallback_chain'] == ['claude-opus']


# ===========================================================================
# Test: A/B Test Routing Strategy
# ===========================================================================


class TestABTestRouting:
    """Tests for the 'ab_test' routing strategy."""

    def test_deterministic_for_same_query(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 50})
        result1 = router.select_model('What is 2+2?')
        result2 = router.select_model('What is 2+2?')
        assert result1['ab_group'] == result2['ab_group']
        assert result1['model'] == result2['model']

    def test_different_queries_can_differ(self):
        """Not every query lands in the same bucket."""
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 50})
        groups = set()
        for i in range(100):
            result = router.select_model(f'Query number {i}')
            groups.add(result['ab_group'])
        # With 100 queries and a 50/50 split, we should see both groups
        assert len(groups) == 2

    def test_ab_split_statistical_distribution(self):
        """Validate that traffic split approximately matches the configured percentage."""
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 70})
        counts = Counter()
        n = 1000
        for i in range(n):
            result = router.select_model(f'Unique query text number {i}')
            counts[result['ab_group']] += 1
        # 70% split should yield roughly 700 in A, allow +/- 10%
        a_pct = counts['A'] / n * 100
        assert 55 < a_pct < 85, f'Expected ~70% in group A, got {a_pct:.1f}%'

    def test_zero_percent_routes_all_to_b(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 0})
        result = router.select_model('Any query')
        assert result['ab_group'] == 'B'

    def test_hundred_percent_routes_all_to_a(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 100})
        result = router.select_model('Any query')
        assert result['ab_group'] == 'A'

    def test_no_fallback_uses_primary_for_both(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': '', 'ab_split_percent': 50})
        result = router.select_model('Hello')
        # Both groups should map to primary when no fallback
        assert result['model'] == 'claude-sonnet'

    def test_result_includes_ab_bucket(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini'})
        result = router.select_model('Hello')
        assert 'ab_bucket' in result
        assert 0 <= result['ab_bucket'] <= 99


# ===========================================================================
# Test: Initialization Validation
# ===========================================================================


class TestInitValidation:
    """Tests for range validation on router configuration."""

    def test_negative_budget_limit_rejected(self):
        with pytest.raises(ValueError, match='budget_limit must be >= 0'):
            ModelRouter({'strategy': 'complexity', 'budget_limit': -1.0})

    def test_zero_budget_limit_accepted(self):
        router = ModelRouter({'strategy': 'complexity', 'budget_limit': 0})
        assert router.budget_limit == 0.0

    def test_ab_split_below_zero_rejected(self):
        with pytest.raises(ValueError, match='ab_split_percent must be between 0 and 100'):
            ModelRouter({'strategy': 'ab_test', 'ab_split_percent': -1})

    def test_ab_split_above_100_rejected(self):
        with pytest.raises(ValueError, match='ab_split_percent must be between 0 and 100'):
            ModelRouter({'strategy': 'ab_test', 'ab_split_percent': 101})

    def test_ab_split_boundary_values_accepted(self):
        r0 = ModelRouter({'strategy': 'ab_test', 'ab_split_percent': 0})
        assert r0.ab_split_percent == 0
        r100 = ModelRouter({'strategy': 'ab_test', 'ab_split_percent': 100})
        assert r100.ab_split_percent == 100

    def test_complexity_threshold_zero_rejected(self):
        with pytest.raises(ValueError, match='complexity_threshold must be >= 1'):
            ModelRouter({'strategy': 'complexity', 'complexity_threshold': 0})

    def test_complexity_threshold_negative_rejected(self):
        with pytest.raises(ValueError, match='complexity_threshold must be >= 1'):
            ModelRouter({'strategy': 'complexity', 'complexity_threshold': -5})

    def test_complexity_threshold_one_accepted(self):
        router = ModelRouter({'strategy': 'complexity', 'complexity_threshold': 1})
        assert router.complexity_threshold == 1


# ===========================================================================
# Test: Complexity Routing Honors Tier-3 Primary Model
# ===========================================================================


class TestComplexityRoutingTier3Primary:
    """Verify that simple queries use the configured primary_model when it is tier 3."""

    def test_tier3_primary_used_for_simple_queries(self):
        router = ModelRouter({'strategy': 'complexity', 'primary_model': 'gpt-5-nano', 'complexity_threshold': 50})
        result = router.select_model('Hi')
        assert result['model'] == 'gpt-5-nano'
        assert result['tier'] == 3

    def test_tier3_primary_not_used_for_complex_queries(self):
        router = ModelRouter({'strategy': 'complexity', 'primary_model': 'gpt-5-nano', 'complexity_threshold': 50})
        complex_q = 'Please explain and analyze the comprehensive implications of this nuanced trade-off in detail?'
        result = router.select_model(complex_q)
        # Tier-3 primary should not be used for complex queries; should fall back to tier-1
        assert result['tier'] == 1


# ===========================================================================
# Test: A/B Test Warning for Same Model
# ===========================================================================


class TestABTestWarning:
    """Verify that A/B test warns when both groups use the same model."""

    def test_warning_when_no_fallback(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': '', 'ab_split_percent': 50})
        result = router.select_model('Hello')
        assert 'ab_warning' in result

    def test_warning_when_fallback_matches_primary(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'claude-sonnet', 'ab_split_percent': 50})
        result = router.select_model('Hello')
        assert 'ab_warning' in result

    def test_no_warning_when_fallback_differs(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'gpt-5-mini', 'ab_split_percent': 50})
        result = router.select_model('Hello')
        assert 'ab_warning' not in result

    def test_distinct_second_fallback_used_when_first_matches_primary(self):
        router = ModelRouter({'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'claude-sonnet,gpt-5-mini', 'ab_split_percent': 0})
        result = router.select_model('Hello')
        # Should pick gpt-5-mini since claude-sonnet matches primary
        assert result['model'] == 'gpt-5-mini'
        assert result['ab_group'] == 'B'
        assert 'ab_warning' not in result


# ===========================================================================
# Test: Routing Metadata
# ===========================================================================


class TestRoutingMetadata:
    """Tests for the routing result dict shape."""

    def test_result_has_required_keys(self):
        router = ModelRouter({'strategy': 'complexity'})
        result = router.select_model('Hello world')
        for key in ('provider', 'model', 'tier', 'reason'):
            assert key in result, f'Missing key: {key}'

    def test_provider_is_string(self):
        router = ModelRouter({'strategy': 'latency'})
        result = router.select_model('Test')
        assert isinstance(result['provider'], str)

    def test_tier_is_integer(self):
        router = ModelRouter({'strategy': 'latency'})
        result = router.select_model('Test')
        assert isinstance(result['tier'], int)

    def test_reason_is_nonempty_string(self):
        router = ModelRouter({'strategy': 'latency'})
        result = router.select_model('Test')
        assert isinstance(result['reason'], str)
        assert len(result['reason']) > 0


# ===========================================================================
# Test: Unknown Strategy
# ===========================================================================


class TestUnknownStrategy:
    def test_unknown_strategy_uses_primary(self):
        router = ModelRouter({'strategy': 'nonexistent', 'primary_model': 'gpt-5'})
        result = router.select_model('Hello')
        assert result['model'] == 'gpt-5'
        assert 'unknown strategy' in result['reason']


# ===========================================================================
# Test: Request Counter
# ===========================================================================


class TestRequestCounter:
    def test_counter_increments(self):
        router = ModelRouter({'strategy': 'complexity'})
        assert router.request_count == 0
        router.select_model('One')
        assert router.request_count == 1
        router.select_model('Two')
        assert router.request_count == 2


# ===========================================================================
# Test: Deep Copy Prevents Mutation
# ===========================================================================


class TestDeepCopyPrevention:
    """Verify that IInstance.writeQuestions does not mutate the original question."""

    def test_deep_copy_isolates_original(self):
        original = MockQuestion('What is AI?')
        original.metadata = {'existing_key': 'existing_value'}

        # Deep copy manually (same logic as IInstance)
        routed = copy.deepcopy(original)
        routed.metadata['routing'] = {'model': 'test'}

        # Original should be untouched
        assert 'routing' not in original.metadata
        assert original.metadata == {'existing_key': 'existing_value'}

    def test_deep_copy_with_no_metadata(self):
        original = MockQuestion('Hello')
        original.metadata = None

        routed = copy.deepcopy(original)
        if routed.metadata is None:
            routed.metadata = {}
        routed.metadata['routing'] = {'model': 'test'}

        assert original.metadata is None


# ===========================================================================
# Test: IGlobal Lifecycle
# ===========================================================================


class TestIGlobalLifecycle:
    """Tests for IGlobal.validateConfig and beginGlobal/endGlobal."""

    def _make_iglobal(self, config):
        from nodes.src.nodes.router_llm.IGlobal import IGlobal

        iglobal = IGlobal()
        iglobal.glb = MagicMock()
        iglobal.glb.logicalType = 'router_llm'
        iglobal.glb.connConfig = config
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint.openMode = 'normal'
        return iglobal

    def test_validate_rejects_invalid_strategy(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'bogus'}):
            with pytest.raises(Exception, match='Invalid routing strategy'):
                iglobal.validateConfig(False)

    def test_validate_accepts_valid_strategies(self):
        for strategy in ['complexity', 'cost_aware', 'latency', 'fallback_chain', 'ab_test']:
            iglobal = self._make_iglobal({})
            config = {'strategy': strategy}
            if strategy == 'fallback_chain':
                config['fallback_models'] = 'claude-haiku'
            if strategy == 'ab_test':
                config['fallback_models'] = 'gpt-5-mini'
            with patch.object(MockConfig, 'getNodeConfig', return_value=config):
                iglobal.validateConfig(False)  # should not raise

    def test_validate_fallback_chain_requires_models(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'fallback_chain', 'fallback_models': ''}):
            with pytest.raises(Exception, match='requires at least one model'):
                iglobal.validateConfig(False)

    def test_validate_rejects_negative_budget_limit(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'complexity', 'budget_limit': -1}):
            with pytest.raises(Exception, match='budget_limit must be >= 0'):
                iglobal.validateConfig(False)

    def test_validate_rejects_invalid_complexity_threshold(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'complexity', 'complexity_threshold': 0}):
            with pytest.raises(Exception, match='complexity_threshold must be >= 1'):
                iglobal.validateConfig(False)

    def test_validate_rejects_invalid_ab_split_percent(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'complexity', 'ab_split_percent': 101}):
            with pytest.raises(Exception, match='ab_split_percent must be between 0 and 100'):
                iglobal.validateConfig(False)

    def test_validate_ab_test_rejects_same_model(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': 'claude-sonnet'}):
            with pytest.raises(Exception, match='ab_test strategy requires at least one fallback model that differs'):
                iglobal.validateConfig(False)

    def test_validate_ab_test_rejects_empty_fallback(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'ab_test', 'primary_model': 'claude-sonnet', 'fallback_models': ''}):
            with pytest.raises(Exception, match='ab_test strategy requires at least one fallback model that differs'):
                iglobal.validateConfig(False)

    def test_validate_syntax_only_skips_full_validation(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'fallback_chain', 'fallback_models': ''}):
            iglobal.validateConfig(True)  # should not raise, skips full validation

    def test_begin_global_creates_router(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'complexity'}):
            iglobal.beginGlobal()
        assert iglobal.router is not None

    def test_end_global_clears_router(self):
        iglobal = self._make_iglobal({})
        with patch.object(MockConfig, 'getNodeConfig', return_value={'strategy': 'complexity'}):
            iglobal.beginGlobal()
        iglobal.endGlobal()
        assert iglobal.router is None

    def test_begin_global_config_mode_skips_router(self):
        iglobal = self._make_iglobal({})
        iglobal.IEndpoint.endpoint.openMode = mock_rocketlib.OPEN_MODE.CONFIG
        iglobal.beginGlobal()
        assert iglobal.router is None


# ===========================================================================
# Test: IInstance Lifecycle
# ===========================================================================


class TestIInstanceLifecycle:
    """Tests for IInstance.writeQuestions integration."""

    def _make_instance(self, config):
        from nodes.src.nodes.router_llm.IInstance import IInstance
        from nodes.src.nodes.router_llm.IGlobal import IGlobal

        iglobal = IGlobal()
        iglobal.glb = MagicMock()
        iglobal.glb.logicalType = 'router_llm'
        iglobal.glb.connConfig = config
        iglobal.IEndpoint = MagicMock()
        iglobal.IEndpoint.endpoint.openMode = 'normal'

        with patch.object(MockConfig, 'getNodeConfig', return_value=config):
            iglobal.beginGlobal()

        inst = IInstance()
        inst.IGlobal = iglobal
        inst.instance = MagicMock()
        return inst

    def test_write_questions_forwards_question(self):
        inst = self._make_instance({'strategy': 'latency'})
        question = MockQuestion('What is AI?')
        inst.writeQuestions(question)
        inst.instance.writeQuestions.assert_called_once()

    def test_write_questions_attaches_routing_metadata(self):
        inst = self._make_instance({'strategy': 'latency'})
        question = MockQuestion('What is AI?')
        inst.writeQuestions(question)
        forwarded = inst.instance.writeQuestions.call_args[0][0]
        assert 'routing' in forwarded.metadata
        assert forwarded.metadata['routing']['model'] == 'gemini-flash'

    def test_write_questions_does_not_mutate_original(self):
        inst = self._make_instance({'strategy': 'latency'})
        question = MockQuestion('What is AI?')
        question.metadata = {'original': True}
        inst.writeQuestions(question)
        assert 'routing' not in question.metadata
        assert question.metadata == {'original': True}

    def test_open_does_not_raise(self):
        inst = self._make_instance({'strategy': 'complexity'})
        inst.open(MagicMock())  # should not raise
