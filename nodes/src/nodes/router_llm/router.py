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

# ------------------------------------------------------------------------------
# ModelRouter - Intelligent LLM model routing engine.
#
# Selects the optimal provider/model based on configurable strategies:
# complexity, cost awareness, latency preference, fallback chains, and A/B
# testing splits.
# ------------------------------------------------------------------------------

import hashlib
import threading
from typing import Any, Dict, List, Optional

# Built-in model tier classification
MODEL_TIERS: Dict[str, Dict[str, Any]] = {
    # Tier 1 - Powerful: best accuracy, highest cost, slower
    'gpt-5': {'provider': 'openai', 'model': 'gpt-5', 'tier': 1},
    'claude-opus': {'provider': 'anthropic', 'model': 'claude-opus', 'tier': 1},
    'gemini-ultra': {'provider': 'google', 'model': 'gemini-ultra', 'tier': 1},
    # Tier 2 - Balanced: good accuracy, moderate cost
    'gpt-5-mini': {'provider': 'openai', 'model': 'gpt-5-mini', 'tier': 2},
    'claude-sonnet': {'provider': 'anthropic', 'model': 'claude-sonnet', 'tier': 2},
    'gemini-pro': {'provider': 'google', 'model': 'gemini-pro', 'tier': 2},
    # Tier 3 - Fast/Cheap: fastest response, lowest cost
    'gpt-5-nano': {'provider': 'openai', 'model': 'gpt-5-nano', 'tier': 3},
    'claude-haiku': {'provider': 'anthropic', 'model': 'claude-haiku', 'tier': 3},
    'gemini-flash': {'provider': 'google', 'model': 'gemini-flash', 'tier': 3},
}

# Keywords that suggest a complex query requiring a powerful model
COMPLEXITY_KEYWORDS = [
    'explain',
    'analyze',
    'compare',
    'evaluate',
    'synthesize',
    'contrast',
    'elaborate',
    'critique',
    'justify',
    'derive',
    'prove',
    'debate',
    'summarize in detail',
    'multi-step',
    'trade-off',
    'implications',
    'comprehensive',
    'nuanced',
    'in-depth',
]


def _get_model_info(model_name: str) -> Dict[str, Any]:
    """Resolve a model name to its provider/model/tier dict.

    If the model is not in MODEL_TIERS, return a best-effort dict with
    tier 2 (balanced) as the default.
    """
    if model_name in MODEL_TIERS:
        return dict(MODEL_TIERS[model_name])
    return {'provider': 'unknown', 'model': model_name, 'tier': 2}


def _get_default_model_for_tier(tier: int) -> Dict[str, Any]:
    """Return the first model in MODEL_TIERS that matches the given tier."""
    for entry in MODEL_TIERS.values():
        if entry['tier'] == tier:
            return dict(entry)
    return _get_model_info('claude-sonnet')


def _estimate_complexity(text: Optional[str], threshold: int = 50) -> int:
    """Return a complexity score for the given text.

    Scoring heuristic:
      - Base score from text length (1 point per 20 chars, capped at 50).
      - +10 for each complexity keyword found.
      - +5 for each question-mark (multiple questions => harder).

    Args:
        text: The query text to evaluate.
        threshold: Not used in scoring; kept for forward-compat.

    Returns:
        An integer complexity score (higher = more complex).
    """
    if not text:
        return 0

    score = 0

    # Length contribution (longer queries tend to be more complex)
    score += min(len(text) // 20, 50)

    # Keyword contribution
    lower = text.lower()
    for keyword in COMPLEXITY_KEYWORDS:
        if keyword in lower:
            score += 10

    # Question-mark contribution
    score += text.count('?') * 5

    return score


class ModelRouter:
    """Intelligent model router that picks the best LLM for each request."""

    def __init__(self, config: Dict[str, Any]) -> None:
        """Initialize the router with the given configuration dict."""
        self.strategy: str = config.get('strategy', 'complexity')
        self.primary_model: str = config.get('primary_model', 'claude-sonnet')

        # Parse fallback models from comma-separated string or list
        fallback_raw = config.get('fallback_models', '')
        if isinstance(fallback_raw, list):
            self.fallback_models: List[str] = [m.strip() for m in fallback_raw if m.strip()]
        elif isinstance(fallback_raw, str) and fallback_raw.strip():
            self.fallback_models = [m.strip() for m in fallback_raw.split(',') if m.strip()]
        else:
            self.fallback_models = []

        self.budget_limit: float = float(config.get('budget_limit', 0.0))
        if self.budget_limit < 0:
            raise ValueError(f'budget_limit must be >= 0, got {self.budget_limit}')

        self.ab_split_percent: int = int(config.get('ab_split_percent', 50))
        if not (0 <= self.ab_split_percent <= 100):
            raise ValueError(f'ab_split_percent must be between 0 and 100, got {self.ab_split_percent}')

        self.complexity_threshold: int = int(config.get('complexity_threshold', 50))
        if self.complexity_threshold < 1:
            raise ValueError(f'complexity_threshold must be >= 1, got {self.complexity_threshold}')

        # Runtime state — guarded by _lock for thread safety across pipeline threads
        self._lock = threading.Lock()
        self._cumulative_cost: float = 0.0
        self._request_count: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def select_model(self, question: Optional[str]) -> Dict[str, Any]:
        """Evaluate routing rules and return the selected model config.

        Args:
            question: The user query text. May be None or empty.

        Returns:
            A dict with keys: provider, model, tier, reason.
        """
        text = question if question else ''

        strategy = self.strategy
        if strategy == 'complexity':
            return self._route_complexity(text)
        elif strategy == 'cost_aware':
            return self._route_cost_aware(text)
        elif strategy == 'latency':
            return self._route_latency(text)
        elif strategy == 'fallback_chain':
            return self._route_fallback_chain(text)
        elif strategy == 'ab_test':
            return self._route_ab_test(text)
        else:
            # Unknown strategy falls back to primary model
            info = _get_model_info(self.primary_model)
            info['reason'] = f'unknown strategy "{strategy}", using primary model'
            return info

    def record_cost(self, amount: float) -> None:
        """Record a cost incurred by a model call (used by cost_aware strategy)."""
        with self._lock:
            self._cumulative_cost += amount

    @property
    def cumulative_cost(self) -> float:
        with self._lock:
            return self._cumulative_cost

    @property
    def request_count(self) -> int:
        with self._lock:
            return self._request_count

    # ------------------------------------------------------------------
    # Strategy implementations
    # ------------------------------------------------------------------

    def _route_complexity(self, text: str) -> Dict[str, Any]:
        """Route based on estimated query complexity."""
        score = _estimate_complexity(text, self.complexity_threshold)
        with self._lock:
            self._request_count += 1

        primary_info = _get_model_info(self.primary_model)

        if score >= self.complexity_threshold:
            # Complex query -> tier 1 (powerful)
            info = primary_info if primary_info['tier'] == 1 else _get_default_model_for_tier(1)
            info['reason'] = f'complexity score {score} >= threshold {self.complexity_threshold}, routed to powerful model'
        elif score >= self.complexity_threshold // 2:
            # Medium complexity -> tier 2 (balanced)
            info = primary_info if primary_info['tier'] == 2 else _get_default_model_for_tier(2)
            info['reason'] = f'complexity score {score}, routed to balanced model'
        else:
            # Simple query -> tier 3 (fast/cheap)
            info = primary_info if primary_info['tier'] == 3 else _get_default_model_for_tier(3)
            info['reason'] = f'complexity score {score} < {self.complexity_threshold // 2}, routed to fast model'

        info['complexity_score'] = score
        return info

    def _route_cost_aware(self, text: str) -> Dict[str, Any]:
        """Route based on cumulative cost against budget.

        Each call records an estimated cost based on the selected model's
        tier so that the budget is consumed even without downstream cost
        reporting.  Downstream nodes may still call ``record_cost()`` to
        refine the running total with actual spend.
        """
        with self._lock:
            self._request_count += 1
            current_cost = self._cumulative_cost

        # Estimated cost per tier (USD) for budget tracking when actual
        # costs are not reported by downstream nodes.
        _tier_estimated_cost = {1: 0.03, 2: 0.01, 3: 0.002}

        if self.budget_limit > 0 and current_cost >= self.budget_limit:
            info = _get_model_info('gemini-flash')
            info['reason'] = f'budget exhausted (spent ${current_cost:.4f} of ${self.budget_limit:.4f}), routed to cheapest model'
            self.record_cost(_tier_estimated_cost.get(info['tier'], 0.01))
            return info

        if self.budget_limit > 0 and current_cost >= self.budget_limit * 0.8:
            info = _get_model_info('claude-sonnet')
            info['reason'] = f'approaching budget limit (spent ${current_cost:.4f} of ${self.budget_limit:.4f}), routed to balanced model'
            self.record_cost(_tier_estimated_cost.get(info['tier'], 0.01))
            return info

        info = _get_model_info(self.primary_model)
        info['reason'] = f'within budget (spent ${current_cost:.4f} of ${self.budget_limit:.4f}), using primary model'
        self.record_cost(_tier_estimated_cost.get(info['tier'], 0.01))
        return info

    def _route_latency(self, text: str) -> Dict[str, Any]:
        """Route to the fastest (lowest-tier) model for real-time use."""
        with self._lock:
            self._request_count += 1
        info = _get_model_info('gemini-flash')
        info['reason'] = 'latency strategy selected fastest model'
        return info

    def _route_fallback_chain(self, text: str) -> Dict[str, Any]:
        """Return the first model in the fallback chain.

        In a real deployment the caller would iterate through the chain
        on failure.  Here we return the primary model with the full
        chain attached so downstream code can retry.
        """
        with self._lock:
            self._request_count += 1

        chain = [self.primary_model] + self.fallback_models
        # Deduplicate while preserving order
        seen = set()
        unique_chain: List[str] = []
        for m in chain:
            if m not in seen:
                seen.add(m)
                unique_chain.append(m)

        info = _get_model_info(unique_chain[0])
        info['reason'] = f'fallback chain: {" -> ".join(unique_chain)}'
        info['fallback_chain'] = unique_chain
        return info

    def _route_ab_test(self, text: str) -> Dict[str, Any]:
        """Deterministically split traffic between primary and first fallback.

        Uses a hash of the query text so the same question always goes
        to the same bucket (deterministic per session/query, not random
        per request).
        """
        with self._lock:
            self._request_count += 1

        # Determine group-B model, ensuring it differs from primary
        fallback = self.fallback_models[0] if self.fallback_models else self.primary_model
        if fallback == self.primary_model and len(self.fallback_models) > 1:
            fallback = self.fallback_models[1]

        # Deterministic bucket via hash
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        bucket = int(digest[:8], 16) % 100  # 0-99

        if bucket < self.ab_split_percent:
            info = _get_model_info(self.primary_model)
            info['reason'] = f'A/B test bucket {bucket} < {self.ab_split_percent}%, assigned to group A (primary)'
            info['ab_group'] = 'A'
        else:
            info = _get_model_info(fallback)
            info['reason'] = f'A/B test bucket {bucket} >= {self.ab_split_percent}%, assigned to group B (fallback)'
            info['ab_group'] = 'B'

        # Warn if A/B test is effectively a no-op (both groups use same model)
        if fallback == self.primary_model:
            info['ab_warning'] = 'group A and group B use the same model; configure a distinct fallback_models entry for meaningful A/B testing'

        info['ab_bucket'] = bucket
        return info
