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

Reads the bot token or incoming-webhook URL from the resolved node config and
builds the shared SlackClient. Exactly one of the two auth modes must be
configured; both are optional in the schema, so that check lives here.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from rocketlib import IGlobalBase


def _resolve_auth(cfg: Mapping) -> tuple[str, str]:
    """Return ``(token, webhook_url)`` from the resolved config.

    The credentials reach the node through its config (``${ROCKETRIDE_SLACK_*}``
    references resolved per call); there is no process-env fallback.
    """
    token = str(cfg.get('token') or '').strip()
    webhook_url = str(cfg.get('webhookUrl') or '').strip()
    return token, webhook_url


def _auth_config_error(token: str, webhook_url: str) -> str | None:
    """Return a config error message, or None when exactly one mode is set."""
    if token and webhook_url:
        return 'configure either a bot token or a webhook URL, not both'
    if not token and not webhook_url:
        return 'a bot token or webhook URL is required (set one in the node config, a ${ROCKETRIDE_SLACK_*} reference)'
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
        self._ensure_dependencies()
        from .slack_client import SlackClient

        token, webhook_url = _resolve_auth(self.config)
        problem = _auth_config_error(token, webhook_url)
        if problem:
            raise ValueError(f'tool_slack: {problem}')
        try:
            self._slack = SlackClient(
                self.glb.logicalType,
                {'token': token, 'webhookUrl': webhook_url},
                self.IEndpoint.endpoint.bag,
            )
        except ValueError as e:
            raise ValueError(f'tool_slack: {e}') from e

    def endGlobal(self) -> None:
        self._slack = None
