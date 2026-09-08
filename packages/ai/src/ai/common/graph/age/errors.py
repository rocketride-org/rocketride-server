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

"""Error taxonomy for the Cypher -> Apache AGE translation layer.

All three fail loud (per the design): callers surface the message to the
LLM-repair loop or to the user rather than degrading silently.
"""


class AgeTranslationError(Exception):
    """The Cypher text could not be translated (e.g. it does not parse)."""


class AgeUnsupportedFeature(AgeTranslationError):
    """The Cypher uses a feature this AGE version cannot run (capability REJECT)."""

    def __init__(self, feature: str, detail: str = ''):
        self.feature = feature
        message = f'Unsupported on Apache AGE: {feature}'
        if detail:
            message += f' — {detail}'
        super().__init__(message)


class AgeFirewallRejected(AgeTranslationError):
    """The query violates a firewall rule (resource cap or write on the safe path)."""

    def __init__(self, rule: str, detail: str = ''):
        self.rule = rule
        message = f'Query rejected by firewall ({rule})'
        if detail:
            message += f': {detail}'
        super().__init__(message)
