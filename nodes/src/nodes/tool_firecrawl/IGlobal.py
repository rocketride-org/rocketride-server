# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

Reads the Firecrawl API key from config, creates a FirecrawlApp client,
and builds a FirecrawlDriver that implements the ToolsBase interface.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from firecrawl import FirecrawlApp

from .firecrawl_driver import FirecrawlDriver


class IGlobal(IGlobalBase):
    """Global state for tool_firecrawl."""

    driver: FirecrawlDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str((cfg.get('apikey') or '')).strip()

        if not apikey:
            raise Exception('tool_firecrawl: apikey is required')

        try:
            app = FirecrawlApp(api_key=apikey)
            self.driver = FirecrawlDriver(server_name='firecrawl', app=app)
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str((cfg.get('apikey') or '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
