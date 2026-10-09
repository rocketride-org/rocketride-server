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

"""Gate: global state (the parsed rule)."""

from rocketlib import IGlobalBase, OPEN_MODE, warning

from ai.common.config import Config
from ai.common.decision import Rule, RuleConfigError, parse_rule


class IGlobal(IGlobalBase):
    """Parses the Gate's rule once per pipeline."""

    rule: Rule | None = None

    def validateConfig(self):
        """Check the rule's shape only; nothing about upstream nodes (spec §7.1)."""
        try:
            parse_rule(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))
        except RuleConfigError as exc:
            warning(str(exc))

    def beginGlobal(self):
        """Parse the rule (skipped in CONFIG mode)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        self.rule = parse_rule(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))

    def endGlobal(self):
        """Drop the rule."""
        self.rule = None
