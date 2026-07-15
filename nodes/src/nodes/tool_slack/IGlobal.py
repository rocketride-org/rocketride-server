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
Slack tool node - global (shared) state.

Reads the bot token or incoming-webhook URL from the node config and builds
the shared SlackClient. Exactly one of the two auth modes must be configured.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
SLACK_TOKEN_ENV = 'ROCKETRIDE_SLACK_TOKEN'
SLACK_WEBHOOK_URL_ENV = 'ROCKETRIDE_SLACK_WEBHOOK_URL'


def _resolve_auth(cfg: dict) -> tuple[str, str]:
    """Resolve ``(token, webhook_url)`` from config with env fallback.

    Explicit node config wins; the ``ROCKETRIDE_SLACK_*`` env vars are only
    consulted when neither config field is set, so a stray env var can never
    conflict with an explicitly configured mode.
    """
    token = str(cfg.get('token') or '').strip()
    webhook_url = str(cfg.get('webhookUrl') or '').strip()
    if not token and not webhook_url:
        token = os.environ.get(SLACK_TOKEN_ENV, '').strip()
        webhook_url = os.environ.get(SLACK_WEBHOOK_URL_ENV, '').strip()
    return token, webhook_url


def _auth_config_error(token: str, webhook_url: str) -> str | None:
    """Return a config error message, or None when exactly one mode is set."""
    if token and webhook_url:
        return 'configure either a bot token or a webhook URL, not both'
    if not token and not webhook_url:
        return f'a bot token or webhook URL is required — set one in the node config or via {SLACK_TOKEN_ENV}/{SLACK_WEBHOOK_URL_ENV}'
    return None


class IGlobal(IGlobalBase):
    """Global state for tool_slack."""

    _slack = None

    def _ensure_dependencies(self) -> None:
        """Install the real SDK unless the test runner has injected mocks."""
        if os.environ.get('ROCKETRIDE_MOCK'):
            return

        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._ensure_dependencies()

        from .slack_client import SlackClient

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        token, webhook_url = _resolve_auth(cfg)
        try:
            self._slack = SlackClient(
                self.glb.logicalType,
                {'token': token, 'webhookUrl': webhook_url},
                self.IEndpoint.endpoint.bag,
            )
        except ValueError as e:
            raise ValueError(f'tool_slack: {e}') from e

    def validateConfig(self) -> None:
        """Check config presence/format ONLY — never makes a live API call."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            token, webhook_url = _resolve_auth(cfg)
            problem = _auth_config_error(token, webhook_url)
            if problem:
                warning(problem)
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self._slack = None
