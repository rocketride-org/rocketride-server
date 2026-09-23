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
Guild.ai tool node - global (shared) state.

Reads the Guild API endpoint, trigger API key, workspace coordinates, and run
options from the node config. Tool logic lives on IInstance via @tool_function;
the pipeline lane handlers live there too (dual node).
"""

from __future__ import annotations

import os
import threading

from ai.common.config import Config
from ai.common.utils import config_int, parse_bool
from rocketlib import IGlobalBase, OPEN_MODE, warning

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
GUILD_URL_ENV = 'ROCKETRIDE_GUILD_URL'
GUILD_KEY_ID_ENV = 'ROCKETRIDE_GUILD_KEY_ID'
GUILD_KEY_SECRET_ENV = 'ROCKETRIDE_GUILD_KEY_SECRET'
GUILD_OWNER_ENV = 'ROCKETRIDE_GUILD_OWNER'
GUILD_WORKSPACE_ENV = 'ROCKETRIDE_GUILD_WORKSPACE'
GUILD_AGENT_ENV = 'ROCKETRIDE_GUILD_AGENT'

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
        # Opened only to render the config UI — never touch the network or read
        # secrets here (the contract/test harness opens nodes in CONFIG mode).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # NOTE: deliberately NOT validated via validate_public_url — Guild offers
        # enterprise / self-hosted deployments which may sit on a private host,
        # which that SSRF guard rejects. The host only ever comes from config;
        # agent-supplied values are confined to path segments by
        # guild_client.safe_segment.
        base_url = str(cfg.get('baseUrl') or '').strip() or os.environ.get(GUILD_URL_ENV, '').strip()
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip('/')

        self.key_id = str(cfg.get('apiKeyId') or '').strip() or os.environ.get(GUILD_KEY_ID_ENV, '').strip()
        self.key_secret = str(cfg.get('apiKeySecret') or '').strip() or os.environ.get(GUILD_KEY_SECRET_ENV, '').strip()
        self.owner = str(cfg.get('owner') or '').strip() or os.environ.get(GUILD_OWNER_ENV, '').strip()
        self.workspace = str(cfg.get('workspace') or '').strip() or os.environ.get(GUILD_WORKSPACE_ENV, '').strip()
        self.default_agent = str(cfg.get('agent') or '').strip() or os.environ.get(GUILD_AGENT_ENV, '').strip()

        self.result_mode = 'start' if str(cfg.get('resultMode') or 'wait').strip().lower() == 'start' else 'wait'
        # config_int treats a non-numeric or <= 0 value as "unspecified" and
        # returns the default, then clamps — a slider left at 0 means "use the
        # default", not "5 seconds".
        self.timeout = config_int(cfg, 'timeout', DEFAULT_TIMEOUT, min_value=5, max_value=3600)
        self.max_sessions = config_int(cfg, 'maxSessions', DEFAULT_MAX_SESSIONS, min_value=1, max_value=1000)
        self.verify_tls = parse_bool(cfg.get('verifyTls'), True)

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
                    'per run" if this is expected — each session is a billed Guild automation.'
                )
            self._sessions_started += 1

    def validateConfig(self) -> None:
        # Config-only checks (no network) so this is safe to run during canvas
        # config rendering. Catches the misconfigs that would otherwise only
        # surface at runtime.
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            def _value(key: str, env: str) -> str:
                return str(cfg.get(key) or '').strip() or os.environ.get(env, '').strip()

            key_id = _value('apiKeyId', GUILD_KEY_ID_ENV)
            key_secret = _value('apiKeySecret', GUILD_KEY_SECRET_ENV)
            if bool(key_id) != bool(key_secret):
                warning(
                    'Guild: only half of the API key is set — Guild authenticates with HTTP Basic '
                    'and needs both the API Key ID and the API Key Secret.'
                )
            if not _value('owner', GUILD_OWNER_ENV):
                warning(
                    'Guild: Workspace owner is empty — sessions are started at /api/workspaces/<owner>/<workspace>.'
                )
            if not _value('workspace', GUILD_WORKSPACE_ENV):
                warning('Guild: Workspace is empty — set the workspace name as it appears in the Guild app URL.')
            if not _value('agent', GUILD_AGENT_ENV):
                warning(
                    'Guild: no Agent configured — the pipeline step needs one. An agent calling '
                    '<node-id>.run_agent can still pass an agent per call.'
                )
            if str(cfg.get('resultMode') or 'wait').strip().lower() == 'start':
                warning(
                    'Guild: Result mode "start" returns a session id without waiting. The pipeline step '
                    'always waits regardless — a session id is of no use to downstream nodes.'
                )
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.key_id = ''
        self.key_secret = ''
