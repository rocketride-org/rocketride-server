# =============================================================================
# RocketRide Engine
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

Reads the Tavily API key and search configuration from the node config.
Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
TAVILY_API_KEY_ENV = 'ROCKETRIDE_TAVILY_KEY'


class IGlobal(IGlobalBase):
    """Global state for tool_tavily."""

    apikey: str = ''
    max_results: int = 5
    search_depth: str = 'advanced'
    topic: str = 'general'

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str(cfg.get('apikey') or '').strip() or os.environ.get(TAVILY_API_KEY_ENV, '').strip()

        if not apikey:
            error(f'tool_tavily: apikey is required — set it in node config or the {TAVILY_API_KEY_ENV} env var')
            raise ValueError('tool_tavily: apikey is required')

        self.apikey = apikey
        raw_max = cfg.get('maxResults', 5)
        if raw_max is None:
            raw_max = 5
        try:
            self.max_results = max(1, min(20, int(raw_max)))
        except (ValueError, TypeError):
            error(f'tool_tavily: maxResults must be a number, got {raw_max!r}; using default 5')
            self.max_results = 5
        search_depth = str(cfg.get('searchDepth') or 'advanced').strip()
        self.search_depth = search_depth if search_depth in ('basic', 'advanced') else 'advanced'
        topic = str(cfg.get('topic') or 'general').strip()
        self.topic = topic if topic in ('general', 'news', 'finance') else 'general'

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or '').strip() or os.environ.get(TAVILY_API_KEY_ENV, '').strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.apikey = ''
