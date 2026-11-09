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
Tavily tool node - global (shared) state.

Reads the Tavily API key and search configuration from the resolved node
config. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, error


class IGlobal(IGlobalBase):
    """Global state for tool_tavily."""

    apikey: str = ''
    max_results: int = 5
    search_depth: str = 'advanced'
    topic: str = 'general'

    def beginGlobal(self) -> None:
        # The resolved config: maxResults within 1-20, the depth and topic pinned
        # to their enums, the key a required secret (a ${ROCKETRIDE_TAVILY_KEY}
        # reference resolved per call, no process-env fallback)
        cfg = self.config

        apikey = str(cfg.apikey or '').strip()
        if not apikey:
            error('tool_tavily: apikey is required - set it in the node config (a ${ROCKETRIDE_TAVILY_KEY} reference)')
            raise ValueError('tool_tavily: apikey is required')
        self.apikey = apikey
        self.max_results = cfg.maxResults
        self.search_depth = cfg.searchDepth
        self.topic = cfg.topic

    def endGlobal(self) -> None:
        self.apikey = ''
