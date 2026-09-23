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
Global (connection-level) state for the HydraDB database node.

Reads config, builds the HydraDB REST client, and clears the API key on teardown.
Building the client performs no network I/O, so it is safe in canvas config mode.
"""

from __future__ import annotations

import os
from typing import Optional

from rocketlib import IGlobalBase, warning
from ai.common.config import Config

from .hydradb_client import HydraDBClient


class IGlobal(IGlobalBase):
    """HydraDB-specific global connection state."""

    client: Optional[HydraDBClient] = None
    database: str = ''
    collection: str = 'default'
    max_results: int = 10

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Read config and build the HydraDB client (no network I/O here)."""
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = (config.get('api_key') or os.environ.get('HYDRA_DB_API_KEY') or '').strip()
        self.database = (config.get('database') or '').strip()
        self.collection = (config.get('collection') or 'default').strip() or 'default'

        try:
            self.max_results = max(1, min(100, int(config.get('max_results', 10))))
        except (TypeError, ValueError):
            self.max_results = 10

        self.client = HydraDBClient(api_key, self.database, collection=self.collection)

    def endGlobal(self) -> None:
        """Clear the API key from memory and drop the client."""
        if self.client is not None:
            self.client.api_key = ''
        self.client = None

    def validateConfig(self) -> None:
        """Save-time validation. Must warn(), never raise (runs during canvas editing)."""
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        api_key = (config.get('api_key') or os.environ.get('HYDRA_DB_API_KEY') or '').strip()
        database = (config.get('database') or '').strip()

        if not api_key:
            warning('HydraDB: an API key is required (set the API Key field or the HYDRA_DB_API_KEY env var).')
            return
        if not database:
            warning('HydraDB: a database is required. Create one in the HydraDB dashboard.')
            return
