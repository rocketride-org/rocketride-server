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

from typing import Any, Dict, Optional

from rocketlib import IGlobalBase, warning


class IGlobal(IGlobalBase):
    """Global lifecycle: read and normalise the node configuration once per run."""

    # The normalised conversion settings convert_fact reads; None outside a run.
    conversion: Optional[Dict[str, Any]] = None

    def beginGlobal(self):
        # The resolver has applied the defaults and typed every value (a
        # numeric rate, an integer decimals, non-empty currency codes); the
        # codes are stripped here because the fact comparison is textual.
        config = self.config

        self.conversion = {
            'source_currency': config.source_currency.strip(),
            'target_currency': config.target_currency.strip(),
            'rate': config.rate,
            'rate_date': config.rate_date.strip(),
            'amount_field': config.amount_field.strip() or 'amount',
            'currency_field': config.currency_field.strip() or 'currency',
            'decimals': config.decimals,
        }

        # Conversion is opt-in: surface a blank code loudly but never crash
        # the pipeline — an unconfigured node simply passes answers through.
        if not self.conversion['source_currency'] or not self.conversion['target_currency']:
            warning(
                'currency_convert_explicit: both source_currency and target_currency '
                'must be set; answers will pass through unchanged.'
            )

    def endGlobal(self):
        self.conversion = None
