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

Reads the Exa API key and search configuration from the node config,
then creates an ExaSearchDriver that implements the ToolsBase interface.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .exa_driver import ExaSearchDriver


class IGlobal(IGlobalBase):
    """Global state for tool_exa_search."""

    driver: ExaSearchDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str(cfg.get('apikey') or os.environ.get('EXA_API_KEY', '')).strip()

        if not apikey:
            raise Exception('tool_exa_search: apikey is required')

        num_results = int(cfg.get('numResults') or 10)
        use_autoprompt = bool(cfg.get('useAutoprompt', True))
        search_type = str(cfg.get('searchType') or 'auto').strip()
        include_text = bool(cfg.get('includeText', True))

        try:
            self.driver = ExaSearchDriver(
                server_name='exa',
                apikey=apikey,
                num_results=num_results,
                use_autoprompt=use_autoprompt,
                search_type=search_type,
                include_text=include_text,
            )
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or os.environ.get('EXA_API_KEY', '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
