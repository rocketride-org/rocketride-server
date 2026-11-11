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
Oura tool node - global (shared) state.

Reads the Oura API bearer token (an OAuth2 access token, or a legacy personal
access token issued before their Dec 2025 deprecation) from the resolved node
config.
"""

from __future__ import annotations

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Global state for tool_oura."""

    token: str = ''

    def beginGlobal(self) -> None:
        """Read the token and install dependencies for execution mode.

        Raises:
            Exception: If the token is blank after stripping, so the pipeline
                fails early with a node-specific message.
        """
        from depends import load_depends

        load_depends(__file__)

        # The token reaches the node through its config (a ${ROCKETRIDE_OURA_TOKEN}
        # reference resolved per call); there is no process-env fallback
        self.token = str(self.config.token or '').strip()
        if not self.token:
            raise Exception(
                'tool_oura: token is required (set it in the node config, a ${ROCKETRIDE_OURA_TOKEN} reference)'
            )

    def endGlobal(self) -> None:
        """Release shared state."""
        self.token = ''
