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

import re

from rocketlib import IGlobalBase, warning
from ai.common.config import Config

from .normalize import build_mapping


class IGlobal(IGlobalBase):
    """Global lifecycle: read and normalise the node configuration once per run."""

    def beginGlobal(self):
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}

        # Label->metric overrides must be an object; ignore (with a warning)
        # anything else so a misconfigured field never fails the run.
        overrides = raw.get('label_to_metric')
        if overrides is not None and not isinstance(overrides, dict):
            warning('normalize_facts: label_to_metric must be an object; ignoring it.')
            overrides = {}

        decimal_format = str(raw.get('decimal_format') or 'auto').strip().lower()
        if decimal_format not in ('auto', 'us', 'eu'):
            warning(f"normalize_facts: unknown decimal_format {decimal_format!r}; using 'auto'.")
            decimal_format = 'auto'

        # default_currency is written verbatim into normalized.currency, which
        # downstream currency conversion matches on — accept only an ISO-4217
        # shape (3 letters) so a value like "dollars" cannot poison the tag.
        default_currency = str(raw.get('default_currency') or '').strip()
        if default_currency and not re.fullmatch(r'[A-Za-z]{3}', default_currency):
            warning(f'normalize_facts: default_currency {default_currency!r} is not a 3-letter ISO code; ignoring it.')
            default_currency = ''

        self.config = {
            'label_field': str(raw.get('label_field') or 'label').strip() or 'label',
            'value_field': str(raw.get('value_field') or 'value').strip() or 'value',
            'default_currency': default_currency.upper(),
            'decimal_format': decimal_format,
            # Pre-merge the built-in mapping with the user overrides once per run.
            'mapping': build_mapping(overrides),
        }

    def endGlobal(self):
        self.config = None
