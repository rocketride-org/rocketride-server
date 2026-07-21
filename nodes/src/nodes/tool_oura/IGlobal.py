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
Oura tool node - global (shared) state.

Resolves the Oura API bearer token (an OAuth2 access token, or a legacy
personal access token issued before their Dec 2025 deprecation) from node
config, connection config, or the ROCKETRIDE_OURA_TOKEN environment variable.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


class IGlobal(IGlobalBase):
    """Global state for tool_oura."""

    token: str = ''

    @staticmethod
    def _get_token(cfg: dict, conn_config: dict) -> str:
        """Resolve the Oura token from node config, connection config, or env."""
        token = str((cfg.get('token') or '')).strip()
        if token:
            return token
        token = str((conn_config.get('token') or '')).strip()
        if token:
            return token
        return str((os.environ.get('ROCKETRIDE_OURA_TOKEN') or '')).strip()

    def beginGlobal(self) -> None:
        """Validate credentials and install dependencies for execution mode.

        Raises:
            Exception: If no Oura token is available from any source, so the
                pipeline fails early with a node-specific message.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import load_depends

        load_depends(__file__)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.token = self._get_token(cfg, self.glb.connConfig)

        if not self.token:
            raise Exception('tool_oura: token is required (set it in the node config or ROCKETRIDE_OURA_TOKEN)')

    def validateConfig(self) -> None:
        """Surface a missing-token warning in the editor without starting the backend."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            if not self._get_token(cfg, self.glb.connConfig):
                warning('token is required (or set ROCKETRIDE_OURA_TOKEN)')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Release shared state."""
        self.token = ''
