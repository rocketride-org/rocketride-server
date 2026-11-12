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
Aparavi AQL tool node — global (shared) state.

Reads configuration and creates the AqlClient HTTP client for Aparavi REST API access.
"""

from __future__ import annotations

from rocketlib import IGlobalBase

from .aql_client import AqlClient


class IGlobal(IGlobalBase):
    """Global state for aparavi_aql.

    Manages the shared AqlClient instance and configuration values
    that are shared across all pipeline instances.
    """

    client: AqlClient | None = None
    db_description: str = ''

    def beginGlobal(self) -> None:
        """Initialize the Aparavi HTTP client from node configuration.

        The resolver has already applied the defaults and refused an empty URL
        (the schema marks it required).
        """
        cfg = self.config

        # Store data description for LLM prompt injection
        self.db_description = cfg.db_description

        # Create the HTTP client
        self.client = AqlClient(
            url=cfg.url.strip(),
            user=cfg.user,
            password=cfg.password or '',
        )

    def endGlobal(self) -> None:
        """Release the HTTP client."""
        self.client = None
