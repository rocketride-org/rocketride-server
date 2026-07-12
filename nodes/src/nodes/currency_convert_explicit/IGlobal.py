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

from rocketlib import IGlobalBase, warning
from ai.common.config import Config

from .convert import _to_decimal


class IGlobal(IGlobalBase):
    """Global lifecycle: read and normalise the node configuration once per run."""

    def beginGlobal(self):
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}

        self.config = {
            'source_currency': str(raw.get('source_currency') or '').strip(),
            'target_currency': str(raw.get('target_currency') or '').strip(),
            'rate': raw.get('rate'),
            'rate_date': str(raw.get('rate_date') or '').strip(),
            'amount_field': str(raw.get('amount_field') or 'amount').strip() or 'amount',
            'currency_field': str(raw.get('currency_field') or 'currency').strip() or 'currency',
            'decimals': raw.get('decimals', 2),
        }

        # Conversion is opt-in: surface misconfiguration loudly but never crash
        # the pipeline — an unconfigured node simply passes answers through.
        if not self.config['source_currency'] or not self.config['target_currency']:
            warning(
                'currency_convert_explicit: both source_currency and target_currency '
                'must be set; answers will pass through unchanged.'
            )
        elif _to_decimal(self.config['rate']) is None:
            warning("currency_convert_explicit: 'rate' is not a valid number; answers will pass through unchanged.")

    def endGlobal(self):
        self.config = None
