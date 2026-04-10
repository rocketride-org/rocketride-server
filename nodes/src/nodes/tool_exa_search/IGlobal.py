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
Exa Search tool node - global (shared) state.

Reads the Exa API key and search configuration from the node config.
Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning


class IGlobal(IGlobalBase):
    """Global state for tool_exa_search."""

    apikey: str = ''
    num_results: int = 10
    use_autoprompt: bool = True
    search_type: str = 'auto'
    include_text: bool = True

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str(cfg.get('apikey') or os.environ.get('EXA_API_KEY', '')).strip()

        if not apikey:
            error('tool_exa_search: apikey is required — set it in node config or EXA_API_KEY env var')
            raise ValueError('tool_exa_search: apikey is required')

        self.apikey = apikey
        self.num_results = max(1, min(50, int(cfg.get('numResults') or 10)))
        self.use_autoprompt = bool(cfg.get('useAutoprompt', True))
        self.search_type = str(cfg.get('searchType') or 'auto').strip()
        self.include_text = bool(cfg.get('includeText', True))

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or os.environ.get('EXA_API_KEY', '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.apikey = ''
