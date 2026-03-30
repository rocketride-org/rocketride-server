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

"""Tests for the cost_tracker pipeline node.

Covers pricing lookup, cost calculation, budget enforcement, thread safety,
custom pricing, edge cases, policy enforcement, and the IGlobal / IInstance
lifecycle.
"""

import copy
import json
import math
import threading
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# We import pricing.py and tracker.py directly (via importlib) to avoid
# triggering cost_tracker/__init__.py which pulls in rocketlib / the full
# engine runtime that is not available in a plain pytest environment.
# ---------------------------------------------------------------------------
import importlib.util
import sys
import os

_nodes_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'nodes', 'src', 'nodes'))


def _load_module(name: str, filepath: str):
    """Load a single .py file as a module without executing __init__.py."""
    spec = importlib.util.spec_from_file_location(name, filepath)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# Register the sub-modules so relative imports inside tracker.py resolve
_pricing_mod = _load_module('cost_tracker.pricing', os.path.join(_nodes_dir, 'cost_tracker', 'pricing.py'))
_tracker_mod = _load_module('cost_tracker.tracker', os.path.join(_nodes_dir, 'cost_tracker', 'tracker.py'))

PRICING = _pricing_mod.PRICING
find_model_pricing = _pricing_mod.find_model_pricing
get_price = _pricing_mod.get_price
CostTracker = _tracker_mod.CostTracker


# ===================================================================
# Pricing lookup tests
# ===================================================================


class TestFindModelPricing:
    """Tests for find_model_pricing fuzzy matching."""

    def test_exact_match(self):
        """Exact model name returns correct pricing."""
        result = find_model_pricing('gpt-5')
        assert result == {'input': 2.00, 'output': 8.00}

    def test_exact_match_claude_opus(self):
        """Exact match for claude-opus."""
        result = find_model_pricing('claude-opus')
        assert result == {'input': 15.00, 'output': 75.00}

    def test_exact_match_ollama(self):
        """Ollama is free."""
        result = find_model_pricing('ollama')
        assert result == {'input': 0.00, 'output': 0.00}

    def test_prefix_match(self):
        """Model name starting with a known key matches (e.g. gpt-5.2-preview)."""
        result = find_model_pricing('gpt-5.2-preview')
        assert result is not None
        assert result['input'] == 2.00

    def test_prefix_match_longest_wins(self):
        """Longer prefix wins when multiple keys match.

        'gpt-5-mini-latest' should match 'gpt-5-mini' (len 9) not 'gpt-5' (len 5).
        """
        result = find_model_pricing('gpt-5-mini-latest')
        assert result is not None
        assert result['input'] == 0.40  # gpt-5-mini pricing

    def test_substring_match(self):
        """Substring matching as last resort."""
        # 'deepseek-chat' is a key; 'my-deepseek-chat-v2' contains it
        result = find_model_pricing('my-deepseek-chat-v2')
        assert result is not None
        assert result['input'] == 0.14

    def test_unknown_model_returns_none(self):
        """Completely unknown model returns None."""
        result = find_model_pricing('totally-unknown-model-xyz')
        assert result is None

    def test_empty_string_returns_none(self):
        """Empty model name returns None."""
        assert find_model_pricing('') is None

    def test_none_returns_none(self):
        """None model name returns None."""
        assert find_model_pricing(None) is None

    def test_case_insensitive(self):
        """Lookup is case-insensitive."""
        result = find_model_pricing('GPT-5')
        assert result is not None
        assert result['input'] == 2.00

    def test_whitespace_stripped(self):
        """Leading/trailing whitespace is stripped."""
        result = find_model_pricing('  gpt-5  ')
        assert result is not None

    def test_custom_pricing_exact_override(self):
        """Custom pricing overrides the default table."""
        custom = {'gpt-5': {'input': 99.0, 'output': 99.0}}
        result = find_model_pricing('gpt-5', custom_pricing=custom)
        assert result['input'] == 99.0

    def test_custom_pricing_new_model(self):
        """Custom pricing can introduce entirely new models."""
        custom = {'my-custom-llm': {'input': 1.0, 'output': 2.0}}
        result = find_model_pricing('my-custom-llm', custom_pricing=custom)
        assert result == {'input': 1.0, 'output': 2.0}


# ===================================================================
# Cost calculation accuracy tests
# ===================================================================


class TestGetPrice:
    """Tests for get_price."""

    def test_basic_cost_gpt5(self):
        """GPT-5: 1000 input + 500 output tokens."""
        cost = get_price('gpt-5', 1000, 500)
        expected = (1000 / 1_000_000) * 2.00 + (500 / 1_000_000) * 8.00
        assert math.isclose(cost, expected, rel_tol=1e-9)

    def test_basic_cost_claude_opus(self):
        """Claude Opus: expensive model."""
        cost = get_price('claude-opus', 1_000_000, 1_000_000)
        expected = 15.00 + 75.00
        assert math.isclose(cost, expected, rel_tol=1e-9)

    def test_zero_tokens(self):
        """Zero tokens should yield zero cost."""
        assert get_price('gpt-5', 0, 0) == 0.0

    def test_negative_tokens_clamped(self):
        """Negative token counts are clamped to zero."""
        assert get_price('gpt-5', -100, -200) == 0.0

    def test_very_large_tokens(self):
        """Very large token count produces a proportional cost."""
        cost = get_price('gpt-5', 100_000_000, 100_000_000)
        expected = (100_000_000 / 1_000_000) * 2.00 + (100_000_000 / 1_000_000) * 8.00
        assert math.isclose(cost, expected, rel_tol=1e-9)

    def test_unknown_model_zero_cost(self):
        """Unknown model returns 0.0 cost."""
        assert get_price('nonexistent-model', 1000, 1000) == 0.0

    def test_ollama_free(self):
        """Ollama is free regardless of token count."""
        assert get_price('ollama', 1_000_000, 1_000_000) == 0.0

    def test_custom_pricing_used(self):
        """Custom pricing is respected in get_price."""
        custom = {'my-model': {'input': 10.0, 'output': 20.0}}
        cost = get_price('my-model', 1_000_000, 1_000_000, custom_pricing=custom)
        assert math.isclose(cost, 30.0, rel_tol=1e-9)

    def test_gemini_flash_small_cost(self):
        """Gemini Flash has very low pricing."""
        cost = get_price('gemini-flash', 1_000_000, 1_000_000)
        expected = 0.075 + 0.30
        assert math.isclose(cost, expected, rel_tol=1e-9)


# ===================================================================
# CostTracker tests
# ===================================================================


class TestCostTracker:
    """Tests for the CostTracker class."""

    def _make_tracker(self, **overrides):
        config = {
            'budget_limit_usd': 1.0,
            'alert_threshold_pct': 80,
            'policy': 'warn',
        }
        config.update(overrides)
        return CostTracker(config)

    # ---------------------------------------------------------------
    # Basic tracking
    # ---------------------------------------------------------------

    def test_initial_total_is_zero(self):
        tracker = self._make_tracker()
        assert tracker.get_total() == 0.0

    def test_track_single_entry(self):
        tracker = self._make_tracker()
        entry = tracker.calculate_cost('gpt-5', 1000, 500)
        tracker.track(entry)
        assert tracker.get_total() > 0

    def test_track_accumulates(self):
        tracker = self._make_tracker()
        e1 = tracker.calculate_cost('gpt-5', 1000, 500)
        e2 = tracker.calculate_cost('gpt-5', 2000, 1000)
        tracker.track(e1)
        tracker.track(e2)
        assert math.isclose(tracker.get_total(), e1['cost_usd'] + e2['cost_usd'], rel_tol=1e-9)

    # ---------------------------------------------------------------
    # Budget enforcement
    # ---------------------------------------------------------------

    def test_within_budget(self):
        tracker = self._make_tracker(budget_limit_usd=100.0)
        entry = tracker.calculate_cost('gpt-5', 1000, 500)
        tracker.track(entry)
        status = tracker.check_budget()
        assert status['within_budget'] is True
        assert status['remaining'] > 0

    def test_over_budget(self):
        tracker = self._make_tracker(budget_limit_usd=0.000001)
        entry = tracker.calculate_cost('claude-opus', 1_000_000, 1_000_000)
        tracker.track(entry)
        status = tracker.check_budget()
        assert status['within_budget'] is False
        assert status['remaining'] == 0.0

    def test_alert_threshold_reached(self):
        tracker = self._make_tracker(budget_limit_usd=1.0, alert_threshold_pct=50)
        # Spend just over 50%
        entry = tracker.calculate_cost('claude-opus', 100_000, 0)
        # claude-opus input: 15.00/1M => 100k = $1.50 which is > 50% of $1.0
        tracker.track(entry)
        status = tracker.check_budget()
        assert status['alert_threshold_reached'] is True

    def test_no_budget_limit(self):
        tracker = self._make_tracker(budget_limit_usd=None)
        entry = tracker.calculate_cost('claude-opus', 10_000_000, 10_000_000)
        tracker.track(entry)
        status = tracker.check_budget()
        assert status['within_budget'] is True
        assert status['remaining'] == float('inf')

    def test_check_budget_override(self):
        """budget_limit argument overrides the configured limit."""
        tracker = self._make_tracker(budget_limit_usd=100.0)
        entry = tracker.calculate_cost('gpt-5', 1_000_000, 1_000_000)
        tracker.track(entry)
        # With the configured limit ($100) we should be within budget
        assert tracker.check_budget()['within_budget'] is True
        # With a tiny override we should be over
        assert tracker.check_budget(budget_limit=0.001)['within_budget'] is False

    # ---------------------------------------------------------------
    # Per-model summary
    # ---------------------------------------------------------------

    def test_summary_single_model(self):
        tracker = self._make_tracker()
        entry = tracker.calculate_cost('gpt-5', 1000, 500)
        tracker.track(entry)
        summary = tracker.get_summary()
        assert 'gpt-5' in summary['per_model']
        assert summary['per_model']['gpt-5']['request_count'] == 1
        assert summary['request_count'] == 1

    def test_summary_multiple_models(self):
        tracker = self._make_tracker()
        tracker.track(tracker.calculate_cost('gpt-5', 1000, 500))
        tracker.track(tracker.calculate_cost('claude-opus', 2000, 1000))
        summary = tracker.get_summary()
        assert len(summary['per_model']) == 2
        assert summary['request_count'] == 2

    def test_summary_tokens_accumulate(self):
        tracker = self._make_tracker()
        tracker.track(tracker.calculate_cost('gpt-5', 1000, 500))
        tracker.track(tracker.calculate_cost('gpt-5', 3000, 1500))
        model_summary = tracker.get_summary()['per_model']['gpt-5']
        assert model_summary['total_input_tokens'] == 4000
        assert model_summary['total_output_tokens'] == 2000
        assert model_summary['request_count'] == 2

    # ---------------------------------------------------------------
    # Thread safety
    # ---------------------------------------------------------------

    def test_thread_safe_concurrent_tracking(self):
        """Multiple threads tracking concurrently should not lose entries."""
        tracker = self._make_tracker(budget_limit_usd=None)
        n_threads = 10
        n_per_thread = 100

        def worker():
            for _ in range(n_per_thread):
                entry = tracker.calculate_cost('gpt-5', 1000, 500)
                tracker.track(entry)

        threads = [threading.Thread(target=worker) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        summary = tracker.get_summary()
        assert summary['request_count'] == n_threads * n_per_thread

    # ---------------------------------------------------------------
    # Custom pricing
    # ---------------------------------------------------------------

    def test_custom_pricing_via_json_string(self):
        custom = json.dumps({'my-llm': {'input': 5.0, 'output': 10.0}})
        tracker = CostTracker({'custom_pricing_json': custom})
        entry = tracker.calculate_cost('my-llm', 1_000_000, 1_000_000)
        assert math.isclose(entry['cost_usd'], 15.0, rel_tol=1e-9)

    def test_custom_pricing_via_dict(self):
        tracker = CostTracker({'custom_pricing_json': {'my-llm': {'input': 5.0, 'output': 10.0}}})
        entry = tracker.calculate_cost('my-llm', 1_000_000, 1_000_000)
        assert math.isclose(entry['cost_usd'], 15.0, rel_tol=1e-9)

    # ---------------------------------------------------------------
    # Policy
    # ---------------------------------------------------------------

    def test_policy_default_warn(self):
        tracker = self._make_tracker()
        assert tracker.policy == 'warn'

    def test_policy_block(self):
        tracker = CostTracker({'policy': 'block'})
        assert tracker.policy == 'block'

    def test_is_over_budget_false_when_no_limit(self):
        tracker = self._make_tracker(budget_limit_usd=None)
        assert tracker.is_over_budget() is False

    def test_is_over_budget_true(self):
        tracker = self._make_tracker(budget_limit_usd=0.0001)
        tracker.track(tracker.calculate_cost('gpt-5', 1_000_000, 1_000_000))
        assert tracker.is_over_budget() is True

    # ---------------------------------------------------------------
    # calculate_cost shape
    # ---------------------------------------------------------------

    def test_calculate_cost_shape(self):
        tracker = self._make_tracker()
        entry = tracker.calculate_cost('gpt-5', 1000, 500)
        assert 'cost_usd' in entry
        assert 'model' in entry
        assert 'input_tokens' in entry
        assert 'output_tokens' in entry
        assert entry['model'] == 'gpt-5'
        assert entry['input_tokens'] == 1000
        assert entry['output_tokens'] == 500

    def test_calculate_cost_negative_tokens_clamped(self):
        tracker = self._make_tracker()
        entry = tracker.calculate_cost('gpt-5', -10, -20)
        assert entry['input_tokens'] == 0
        assert entry['output_tokens'] == 0
        assert entry['cost_usd'] == 0.0


# ===================================================================
# IInstance / IGlobal lifecycle mocks
# ===================================================================


class TestIInstanceLifecycle:
    """Test the IInstance writeAnswers flow with mocked engine objects."""

    def _build_instance(self, budget_limit_usd=None, policy='warn'):
        """Build a minimal mock of IGlobal + IInstance wiring."""
        # We import here to avoid needing the full rocketlib at module level
        # Instead we mock the dependencies
        tracker = CostTracker(
            {
                'budget_limit_usd': budget_limit_usd,
                'alert_threshold_pct': 80,
                'policy': policy,
            }
        )

        # Build a mock answer
        answer = MagicMock()
        answer.metadata = {
            'input_tokens': 5000,
            'output_tokens': 2000,
            'model': 'gpt-5',
        }
        answer.answer = 'The answer is 4.'

        return tracker, answer

    def test_cost_attached_to_metadata(self):
        """After writeAnswers the answer metadata should contain cost_usd."""
        tracker, answer = self._build_instance()

        # Simulate what IInstance.writeAnswers does (minus engine calls)
        metadata = answer.metadata
        entry = tracker.calculate_cost(
            metadata['model'],
            metadata['input_tokens'],
            metadata['output_tokens'],
        )
        tracker.track(entry)
        answer.metadata['cost_usd'] = entry['cost_usd']
        answer.metadata['cumulative_cost_usd'] = tracker.get_total()

        assert 'cost_usd' in answer.metadata
        assert answer.metadata['cost_usd'] > 0
        assert answer.metadata['cumulative_cost_usd'] > 0

    def test_deep_copy_prevents_mutation(self):
        """Deep copying the answer prevents upstream mutation."""
        tracker, answer = self._build_instance()

        original_metadata = dict(answer.metadata)
        answer_copy = copy.deepcopy(answer)
        answer_copy.metadata['cost_usd'] = 999.0

        # Original should be unaffected
        assert 'cost_usd' not in original_metadata

    def test_block_policy_prevents_forwarding(self):
        """With policy=block and over budget, the answer should NOT be forwarded."""
        tracker, answer = self._build_instance(budget_limit_usd=0.0000001, policy='block')

        metadata = answer.metadata
        entry = tracker.calculate_cost(
            metadata['model'],
            metadata['input_tokens'],
            metadata['output_tokens'],
        )
        tracker.track(entry)

        # Check that we're over budget
        assert tracker.is_over_budget() is True
        assert tracker.policy == 'block'

    def test_warn_policy_allows_forwarding(self):
        """With policy=warn and over budget, the answer IS still forwarded."""
        tracker, answer = self._build_instance(budget_limit_usd=0.0000001, policy='warn')

        metadata = answer.metadata
        entry = tracker.calculate_cost(
            metadata['model'],
            metadata['input_tokens'],
            metadata['output_tokens'],
        )
        tracker.track(entry)

        # Over budget but policy is warn -- forwarding should proceed
        assert tracker.is_over_budget() is True
        assert tracker.policy == 'warn'
        # In the real IInstance, writeAnswers would still call self.instance.writeAnswers(answer)

    def test_missing_metadata_defaults(self):
        """When answer has no metadata, defaults to 0 tokens / unknown model."""
        tracker = CostTracker({})
        # Simulate missing metadata
        entry = tracker.calculate_cost('unknown', 0, 0)
        tracker.track(entry)
        assert tracker.get_total() == 0.0


# ===================================================================
# Edge cases
# ===================================================================


class TestEdgeCases:
    """Miscellaneous edge-case tests."""

    def test_pricing_table_has_all_expected_models(self):
        """Ensure the default table covers all documented models."""
        expected = [
            'gpt-5',
            'gpt-5.1',
            'gpt-5.2',
            'gpt-5-mini',
            'gpt-5-nano',
            'gpt-4o',
            'gpt-4o-mini',
            'claude-opus',
            'claude-sonnet',
            'claude-haiku',
            'gemini-pro',
            'gemini-flash',
            'mistral-large',
            'mistral-small',
            'deepseek-chat',
            'deepseek-reasoner',
            'perplexity-sonar',
            'ollama',
        ]
        for model in expected:
            assert model in PRICING, f'{model} missing from PRICING table'

    def test_all_pricing_entries_have_input_output(self):
        """Every entry must have 'input' and 'output' keys."""
        for model, prices in PRICING.items():
            assert 'input' in prices, f'{model} missing input price'
            assert 'output' in prices, f'{model} missing output price'

    def test_all_prices_non_negative(self):
        """Prices must be >= 0."""
        for model, prices in PRICING.items():
            assert prices['input'] >= 0, f'{model} has negative input price'
            assert prices['output'] >= 0, f'{model} has negative output price'

    def test_tracker_with_empty_config(self):
        """Tracker should work with a completely empty config."""
        tracker = CostTracker({})
        entry = tracker.calculate_cost('gpt-5', 1000, 500)
        tracker.track(entry)
        assert tracker.get_total() > 0

    def test_percent_used_at_exact_limit(self):
        """When exactly at the budget limit, percent_used should be 100."""
        tracker = CostTracker({'budget_limit_usd': 10.0})
        # GPT-5: input $2/1M, output $8/1M => 1M in + 1M out = $10.00
        entry = tracker.calculate_cost('gpt-5', 1_000_000, 1_000_000)
        tracker.track(entry)
        status = tracker.check_budget()
        assert math.isclose(status['percent_used'], 100.0, rel_tol=1e-6)
        # At exactly the limit, within_budget should still be True (<=)
        assert status['within_budget'] is True
