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

"""
scraper_beautifulsoup save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is the URL allow-list
grammar, which no schema can express: every pattern must pin the scheme and
host. A bad pattern is reported as a warning while the user is still editing
the node; :func:`allow_patterns` is the same rule ``IGlobal.build_fetcher``
applies, so the source's own validation, its scan and every tool call fail
with the same message. The ``sources`` JSON is checked by the source's
``IEndpoint.validateConfig``: parsing it imports bs4, a requirement of the
node that this import-light module must not depend on.
"""

from __future__ import annotations

import re
from typing import Any, List, Mapping

from ai.common.utils import check_allow_pattern
from rocketlib import IValidatorBase, warning

from .scrape_fetch import compile_patterns


def allow_patterns(cfg: Mapping[str, Any]) -> List[re.Pattern]:
    """Compile the URL allow-list; every pattern must pin the scheme and host (``ValueError`` otherwise)."""
    patterns = compile_patterns(cfg.get('urlAllowList'))
    for pattern in patterns:
        check_allow_pattern(pattern)
    return patterns


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the URL allow-list grammar."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config, then warn about an allow-list pattern that does not pin its host.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        self.config
        if syntaxOnly:
            return
        # urlAllowList is a param of the tool service, which self.config refuses: the stored value is in the full view
        try:
            allow_patterns(self._resolved())
        except Exception as e:
            warning(str(e))
