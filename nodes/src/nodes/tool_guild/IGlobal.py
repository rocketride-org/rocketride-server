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
Guild.ai tool node - global (shared) state.

Reads the Guild API endpoint, trigger API key, workspace coordinates, and run
options from the resolved node config. Tool logic lives on IInstance via
@tool_function; the pipeline lane handlers live there too (dual node).
"""

from __future__ import annotations


from rocketlib import IGlobalBase

DEFAULT_BASE_URL = 'https://app.guild.ai'


class IGlobal(IGlobalBase):
    """Global state for tool_guild."""

    base_url: str = DEFAULT_BASE_URL
    key_id: str = ''
    key_secret: str = ''
    owner: str = ''
    workspace: str = ''

    def beginGlobal(self) -> None:
        # The resolved config: the key halves, owner and workspace required by the
        # schema (agent, resultMode, timeout, maxSessions and verifyTls are per call),
        # no process-env fallback (the
        # credentials arrive as ${ROCKETRIDE_GUILD_*} references resolved per call)
        cfg = self.config

        # NOTE: deliberately NOT validated via validate_public_url - Guild offers
        # enterprise / self-hosted deployments which may sit on a private host,
        # which that SSRF guard rejects. The host only ever comes from config;
        # agent-supplied values are confined to path segments by
        # guild_client.safe_segment.
        self.base_url = cfg.baseUrl.strip().rstrip('/')

        self.key_id = str(cfg.apiKeyId or '').strip()
        self.key_secret = str(cfg.apiKeySecret or '').strip()
        # Required by the schema, but a whitespace-only value passes `required` and would
        # build /api/workspaces//...: refuse it here, naming the field.
        self.owner = cfg.owner.strip()
        if not self.owner:
            raise ValueError('tool_guild: owner must not be blank')
        self.workspace = cfg.workspace.strip()
        if not self.workspace:
            raise ValueError('tool_guild: workspace must not be blank')

        # Guild bills per automation (100/month on the free tier), so the node
        # caps how many sessions one REQUEST may start (the instance keeps the
        # count, plan 12 B: a budget on the shared global let one caller
        # exhaust every other caller's)

    def endGlobal(self) -> None:
        self.key_id = ''
        self.key_secret = ''
