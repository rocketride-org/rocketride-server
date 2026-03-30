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

import copy

from rocketlib import IInstanceBase, debug
from ai.common.schema import Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Per-thread instance for the Cost Tracker node.

    Intercepts the ``answers`` lane, calculates LLM cost from the
    answer's token-usage metadata, tracks cumulative spend, and
    either warns or blocks when the configured budget is exceeded.
    """

    IGlobal: IGlobal

    def writeAnswers(self, answer: Answer):
        """Process an incoming answer, attach cost metadata, and enforce budget.

        Token usage is read from ``answer.metadata`` (keys
        ``input_tokens``, ``output_tokens``, ``model``).  If the
        metadata is absent the answer is forwarded unchanged.
        """
        tracker = self.IGlobal.tracker
        if tracker is None:
            # Tracker not initialised (e.g. CONFIG mode) -- pass through
            return

        # Deep-copy so downstream mutations never corrupt our accounting
        answer = copy.deepcopy(answer)

        # ----------------------------------------------------------------
        # Extract token-usage metadata from the answer
        # ----------------------------------------------------------------
        metadata = getattr(answer, 'metadata', None) or {}
        if isinstance(metadata, dict):
            input_tokens = metadata.get('input_tokens', 0)
            output_tokens = metadata.get('output_tokens', 0)
            model = metadata.get('model', 'unknown')
        else:
            input_tokens = getattr(metadata, 'input_tokens', 0)
            output_tokens = getattr(metadata, 'output_tokens', 0)
            model = getattr(metadata, 'model', 'unknown')

        # Ensure integers
        try:
            input_tokens = int(input_tokens)
        except (TypeError, ValueError):
            input_tokens = 0
        try:
            output_tokens = int(output_tokens)
        except (TypeError, ValueError):
            output_tokens = 0

        # ----------------------------------------------------------------
        # Calculate and track
        # ----------------------------------------------------------------
        cost_entry = tracker.calculate_cost(model, input_tokens, output_tokens)
        tracker.track(cost_entry)

        # Attach cost metadata onto the answer for downstream consumers
        if not hasattr(answer, 'metadata') or answer.metadata is None:
            answer.metadata = {}
        if isinstance(answer.metadata, dict):
            answer.metadata['cost_usd'] = cost_entry['cost_usd']
            answer.metadata['cumulative_cost_usd'] = tracker.get_total()

        # ----------------------------------------------------------------
        # Budget enforcement
        # ----------------------------------------------------------------
        budget_status = tracker.check_budget()

        if budget_status.get('alert_threshold_reached') and budget_status.get('within_budget'):
            debug(f'Cost Tracker: alert threshold reached -- {budget_status["percent_used"]:.1f}% of budget used (${budget_status["used"]:.6f} / ${budget_status["used"] + budget_status["remaining"]:.6f})')

        if not budget_status.get('within_budget', True):
            if tracker.policy == 'block':
                debug(f'Cost Tracker: BLOCKING answer -- budget exceeded (${budget_status["used"]:.6f} spent, limit ${budget_status["used"] - budget_status["remaining"]:.6f})')
                # Prevent the answer from propagating downstream
                self.preventDefault()
                return
            else:
                debug(f'Cost Tracker: WARNING -- budget exceeded (${budget_status["used"]:.6f} spent)')

        # Forward the (annotated) answer downstream
        self.instance.writeAnswers(answer)
