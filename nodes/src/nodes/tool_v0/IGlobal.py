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
v0 by Vercel tool node - global (shared) state.

Reads the v0 API key from the resolved node config and stores it for IInstance
tool methods.
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_v0."""

    apikey: str = ''

    def beginGlobal(self) -> None:
        # The key reaches the node through its config (a ${ROCKETRIDE_V0_APIKEY}
        # reference resolved per call); the schema marks it required
        self.apikey = str(self.config.apikey or '').strip()
        if not self.apikey:
            raise Exception('tool_v0: apikey is required')

    def endGlobal(self) -> None:
        self.apikey = ''
