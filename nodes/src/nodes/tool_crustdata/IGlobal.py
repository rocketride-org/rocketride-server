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
Crustdata tool node - global (shared) state.

Reads the Crustdata API key and default page size from the resolved node
config. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, error


class IGlobal(IGlobalBase):
    """Global state for tool_crustdata."""

    apikey: str = ''
    default_limit: int = 10

    def beginGlobal(self) -> None:
        # The resolved config: defaultLimit arrives an integer within 1-1000,
        # the key a required secret
        cfg = self.config

        # The key reaches the node through its config (a ${ROCKETRIDE_CRUSTDATA_APIKEY}
        # reference resolved per call); there is no process-env fallback
        apikey = str(cfg.apikey or '').strip()
        if not apikey:
            error(
                'tool_crustdata: apikey is required - set it in the node config (a ${ROCKETRIDE_CRUSTDATA_APIKEY} reference)'
            )
            raise ValueError('tool_crustdata: apikey is required')

        self.apikey = apikey
        self.default_limit = cfg.defaultLimit

    def endGlobal(self) -> None:
        self.apikey = ''
