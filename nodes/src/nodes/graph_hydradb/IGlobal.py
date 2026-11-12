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

Reads the resolved config, builds the HydraDB REST client, and clears the API
key on teardown. Building the client performs no network I/O.
"""

from __future__ import annotations

from typing import Optional

from rocketlib import IGlobalBase

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
        """Build the HydraDB client from the resolved config (no network I/O here).

        The schema marks the API key and database required and bounds
        max_results, so the resolver has refused anything this cannot run with.
        """
        config = self.config

        self.database = config.database.strip()
        self.collection = config.collection.strip()
        self.max_results = config.max_results

        self.client = HydraDBClient(config.api_key.strip(), self.database, collection=self.collection)

    def endGlobal(self) -> None:
        """Clear the API key from memory and drop the client."""
        if self.client is not None:
            self.client.api_key = ''
        self.client = None
