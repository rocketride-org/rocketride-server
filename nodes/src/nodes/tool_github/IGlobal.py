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
GitHub tool node - global (shared) state.

Reads node config and creates a GithubDriver that exposes the
``github.get_pr_reviews`` tool for agent invocation.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .github_driver import GithubDriver


class IGlobal(IGlobalBase):
    driver: GithubDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        token = str(cfg.get('token') or '').strip()
        server_name = str(cfg.get('serverName') or 'github').strip()

        if not token:
            warning('tool_github: no API token configured')

        self.driver = GithubDriver(server_name=server_name, token=token)

    def validateConfig(self) -> None:
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        token = str(cfg.get('token') or '').strip()
        if not token:
            warning('tool_github: GitHub API token is required')
            return

        import requests

        resp = requests.get(
            'https://api.github.com/user',
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github+json',
            },
            timeout=10,
        )
        if resp.status_code == 401:
            warning('tool_github: GitHub API token is invalid or expired')
        elif not resp.ok:
            warning(f'tool_github: GitHub API returned {resp.status_code} during validation')

    def endGlobal(self) -> None:
        if self.driver is not None:
            self.driver._session.close()
        self.driver = None
