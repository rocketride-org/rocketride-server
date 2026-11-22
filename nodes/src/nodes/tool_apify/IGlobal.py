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
Apify tool node - global (shared) state.

Reads the Apify API token from the resolved node config and creates an
ApifyClient. Tool logic lives on IInstance via @tool_function, and so do the
run bounds (max items, run timeout, max cost): they are per-call parameters
the instance reads from ``self.settings``.
"""

from __future__ import annotations

import os

from rocketlib import IGlobalBase, warning

from depends import depends

# apify_client is imported at module scope, so the requirements are installed
# before that happens. This module is only imported on the run path (config mode
# imports the validator alone), so the install never runs while a user is merely
# opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from apify_client import ApifyClient


class IGlobal(IGlobalBase):
    """Global state for tool_apify."""

    client: ApifyClient | None = None

    def beginGlobal(self) -> None:
        cfg = self.config

        # The token reaches the node through its config (a ${ROCKETRIDE_APIFY_APIKEY}
        # reference resolved per call); the schema marks it required
        apikey = str(cfg.apikey or '').strip()
        if not apikey:
            raise Exception('tool_apify: apikey is required')

        try:
            self.client = ApifyClient(apikey)
        except Exception as e:
            warning(str(e))
            raise

    def endGlobal(self) -> None:
        self.client = None
