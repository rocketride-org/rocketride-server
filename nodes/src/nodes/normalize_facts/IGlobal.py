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

from rocketlib import IGlobalBase

from .normalize import build_mapping


class IGlobal(IGlobalBase):
    """Global lifecycle: read the node configuration once per run and pre-merge the mapping."""

    rules = None

    def beginGlobal(self):
        """Build the normalisation rules from the resolved config (types and enums are the schema's)."""
        config = self.config
        self.rules = {
            'label_field': config.label_field,
            'value_field': config.value_field,
            # Written verbatim into normalized.currency, which downstream currency
            # conversion matches on; the schema holds it to three letters, the
            # case is normalised here.
            'default_currency': config.default_currency.upper(),
            'decimal_format': config.decimal_format,
            # Pre-merge the built-in mapping with the user overrides once per run.
            'mapping': build_mapping(config.label_to_metric),
        }

    def endGlobal(self):
        self.rules = None
