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
Firecrawl tool node - global (shared) state.

Reads the Firecrawl API key from the resolved node config and creates a
FirecrawlApp client. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os
from rocketlib import IGlobalBase, warning

from depends import depends

# firecrawl is imported at module scope, so the requirements are installed
# before that happens. This module is only imported on the run path (config mode
# imports the validator alone), so the install never runs while a user is merely
# opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from firecrawl import FirecrawlApp


class IGlobal(IGlobalBase):
    """Global state for tool_firecrawl."""

    app: FirecrawlApp | None = None

    def beginGlobal(self) -> None:
        # The key reaches the node through its config (a ${ROCKETRIDE_FIRECRAWL_APIKEY}
        # reference resolved per call); the schema marks it required
        apikey = str(self.config.apikey or '').strip()
        if not apikey:
            raise Exception('tool_firecrawl: apikey is required')

        try:
            self.app = FirecrawlApp(api_key=apikey)
        except Exception as e:
            warning(str(e))
            raise

    def endGlobal(self) -> None:
        self.app = None
