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

import threading

from rocketlib import IGlobalBase

DEFAULT_BASE_URL = 'https://app.guild.ai'
DEFAULT_TIMEOUT = 300
DEFAULT_MAX_SESSIONS = 10


class IGlobal(IGlobalBase):
    """Global state for tool_guild."""

    base_url: str = DEFAULT_BASE_URL
    key_id: str = ''
    key_secret: str = ''
    owner: str = ''
    workspace: str = ''
    default_agent: str = ''
    result_mode: str = 'wait'
    timeout: int = DEFAULT_TIMEOUT
    max_sessions: int = DEFAULT_MAX_SESSIONS
    verify_tls: bool = True

    def beginGlobal(self) -> None:
        # The resolved config: the key halves, owner and workspace required by the
        # schema, the integers within their ranges, no process-env fallback (the
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
        self.owner = cfg.owner.strip()
        self.workspace = cfg.workspace.strip()
        self.default_agent = str(cfg.agent or '').strip()

        self.result_mode = cfg.resultMode
        self.timeout = cfg.timeout
        self.max_sessions = cfg.maxSessions
        self.verify_tls = cfg.verifyTls

        # Guild bills per automation (100/month on the free tier), so the node
        # caps how many sessions one pipeline run may start. Shared across every
        # instance of this node in the run, hence the lock.
        self._session_lock = threading.Lock()
        self._sessions_started = 0

    def claim_session_slot(self) -> None:
        """Reserve one session against the per-run budget, or raise."""
        lock = getattr(self, '_session_lock', None)
        if lock is None:
            return
        with lock:
            if self._sessions_started >= self.max_sessions:
                raise ValueError(
                    f'Guild session budget exhausted: this pipeline run has already started '
                    f'{self._sessions_started} session(s), the configured maximum. Raise "Max sessions '
                    'per run" if this is expected - each session is a billed Guild automation.'
                )
            self._sessions_started += 1

    def endGlobal(self) -> None:
        self.key_id = ''
        self.key_secret = ''
