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
InsForge tool node - global (shared) state.

Resolves the InsForge project URL and API credential from node config,
connection config, or the ROCKETRIDE_INSFORGE_URL / ROCKETRIDE_INSFORGE_KEY
environment variables, and records whether writes are permitted.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from ai.common.utils import parse_bool
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .insforge_client import normalize_base_url


class IGlobal(IGlobalBase):
    """Global state for tool_insforge."""

    base_url: str = ''
    token: str = ''
    allow_writes: bool = False

    @staticmethod
    def _get(cfg: dict, conn_config: dict, key: str, env_var: str) -> str:
        """Resolve one setting from node config, connection config, then env."""
        value = str((cfg.get(key) or '')).strip()
        if value:
            return value
        value = str((conn_config.get(key) or '')).strip()
        if value:
            return value
        return str((os.environ.get(env_var) or '')).strip()

    def _resolve(self, cfg: dict, conn_config: dict) -> tuple[str, str]:
        """Return the (project_url, api_key) pair from all configured sources."""
        return (
            self._get(cfg, conn_config, 'project_url', 'ROCKETRIDE_INSFORGE_URL'),
            self._get(cfg, conn_config, 'api_key', 'ROCKETRIDE_INSFORGE_KEY'),
        )

    def beginGlobal(self) -> None:
        """Validate credentials and install dependencies for execution mode.

        Raises:
            Exception: If the project URL or API key is missing, or the URL is
                malformed, so the pipeline fails early with a node-specific
                message rather than on the first tool call.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import load_depends

        load_depends(__file__)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        project_url, api_key = self._resolve(cfg, self.glb.connConfig)

        if not project_url:
            raise Exception(
                'tool_insforge: project_url is required (set it in the node config or ROCKETRIDE_INSFORGE_URL)'
            )
        if not api_key:
            raise Exception('tool_insforge: api_key is required (set it in the node config or ROCKETRIDE_INSFORGE_KEY)')

        try:
            self.base_url = normalize_base_url(project_url)
        except ValueError as e:
            raise Exception(f'tool_insforge: {e}') from e

        self.token = api_key
        self.allow_writes = parse_bool(cfg.get('allow_writes'))

    def validateConfig(self) -> None:
        """Surface missing or malformed settings in the editor without connecting."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            project_url, api_key = self._resolve(cfg, self.glb.connConfig)

            if not project_url:
                warning('project_url is required (or set ROCKETRIDE_INSFORGE_URL)')
            else:
                try:
                    normalize_base_url(project_url)
                except ValueError as e:
                    warning(str(e))

            if not api_key:
                warning('api_key is required (or set ROCKETRIDE_INSFORGE_KEY)')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Release shared state."""
        self.base_url = ''
        self.token = ''
        self.allow_writes = False
