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

"""Thread-safe cost tracker with budget enforcement."""

import json
import threading
from typing import Any, Optional

from .pricing import get_price


class CostTracker:
    """Accumulates per-request LLM costs and enforces budget limits.

    All public methods that mutate state are protected by a
    ``threading.Lock`` so the tracker is safe to use from multiple
    pipeline threads concurrently.
    """

    def __init__(self, config: dict[str, Any]):
        """Initialise the tracker from a node configuration dict."""
        self._lock = threading.Lock()

        # Budget configuration
        self._budget_limit: Optional[float] = config.get('budget_limit_usd')
        if self._budget_limit is not None:
            self._budget_limit = float(self._budget_limit)

        self._alert_threshold_pct: float = float(config.get('alert_threshold_pct', 80))
        self._policy: str = config.get('policy', 'warn')  # 'warn' | 'block'

        # Custom pricing override (JSON string or dict)
        custom_pricing_raw = config.get('custom_pricing_json')
        self._custom_pricing: Optional[dict[str, dict[str, float]]] = None
        if custom_pricing_raw:
            if isinstance(custom_pricing_raw, str):
                self._custom_pricing = json.loads(custom_pricing_raw)
            elif isinstance(custom_pricing_raw, dict):
                self._custom_pricing = custom_pricing_raw

        # Accumulation state
        self._total_cost: float = 0.0
        self._entries: list[dict[str, Any]] = []
        self._per_model: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Cost calculation
    # ------------------------------------------------------------------

    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> dict[str, Any]:
        """Calculate cost for a single request without tracking it.

        Returns:
            A dict with keys ``cost_usd``, ``model``, ``input_tokens``,
            ``output_tokens``.
        """
        cost = get_price(model, input_tokens, output_tokens, self._custom_pricing)
        return {
            'cost_usd': cost,
            'model': model,
            'input_tokens': max(0, input_tokens),
            'output_tokens': max(0, output_tokens),
        }

    # ------------------------------------------------------------------
    # Tracking
    # ------------------------------------------------------------------

    def track(self, cost_entry: dict[str, Any]) -> None:
        """Record a cost entry and accumulate totals.

        ``cost_entry`` should be a dict as returned by
        :meth:`calculate_cost`.
        """
        cost = cost_entry.get('cost_usd', 0.0)
        model = cost_entry.get('model', 'unknown')

        with self._lock:
            self._total_cost += cost
            self._entries.append(cost_entry)

            if model not in self._per_model:
                self._per_model[model] = {
                    'total_cost': 0.0,
                    'total_input_tokens': 0,
                    'total_output_tokens': 0,
                    'request_count': 0,
                }
            summary = self._per_model[model]
            summary['total_cost'] += cost
            summary['total_input_tokens'] += cost_entry.get('input_tokens', 0)
            summary['total_output_tokens'] += cost_entry.get('output_tokens', 0)
            summary['request_count'] += 1

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def get_total(self) -> float:
        """Return the cumulative cost tracked so far (USD)."""
        with self._lock:
            return self._total_cost

    def check_budget(self, budget_limit: Optional[float] = None) -> dict[str, Any]:
        """Check spending against a budget limit.

        Args:
            budget_limit: Optional override; falls back to the limit
                configured at init time.

        Returns:
            A dict with ``within_budget``, ``used``, ``remaining``,
            ``percent_used``, and ``alert_threshold_reached``.
        """
        limit = budget_limit if budget_limit is not None else self._budget_limit

        with self._lock:
            used = self._total_cost

        if limit is None or limit <= 0:
            return {
                'within_budget': True,
                'used': used,
                'limit': None,
                'remaining': float('inf'),
                'percent_used': 0.0,
                'alert_threshold_reached': False,
            }

        remaining = limit - used
        percent_used = (used / limit) * 100.0 if limit > 0 else 0.0

        return {
            'within_budget': used <= limit,
            'used': used,
            'limit': limit,
            'remaining': max(0.0, remaining),
            'percent_used': percent_used,
            'alert_threshold_reached': percent_used >= self._alert_threshold_pct,
        }

    def get_summary(self) -> dict[str, Any]:
        """Return a per-model cost breakdown plus the overall total."""
        with self._lock:
            return {
                'total_cost': self._total_cost,
                'per_model': {k: dict(v) for k, v in self._per_model.items()},
                'request_count': len(self._entries),
            }

    # ------------------------------------------------------------------
    # Policy helpers
    # ------------------------------------------------------------------

    @property
    def policy(self) -> str:
        """Return the configured over-budget policy (``'warn'`` or ``'block'``)."""
        return self._policy

    def is_over_budget(self) -> bool:
        """Return ``True`` when spending has exceeded the configured budget."""
        if self._budget_limit is None:
            return False
        with self._lock:
            return self._total_cost > self._budget_limit
