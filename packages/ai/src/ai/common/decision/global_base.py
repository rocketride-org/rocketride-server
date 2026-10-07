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
"""Engine glue: build a DecisionRunner from the node's merged config."""

from __future__ import annotations

from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from ai.common.config import Config

from .client import SystemOneClient
from .limits import DecisionLimits
from .questions import parse_questions
from .runner import DecisionRunner


class DecisionGlobalBase(IGlobalBase):
    """Shared IGlobal for System One Ask nodes; vendors override the hooks if needed."""

    runner: DecisionRunner | None = None
    _client: SystemOneClient | None = None

    def _base_url(self, config: dict) -> str:
        """Return the backend base URL (vendor services files set ``serverbase``)."""
        url = str(config.get('serverbase', '')).strip()
        if not url:
            raise ValueError('System One node needs a server URL (serverbase)')
        return url

    def _api_key(self, config: dict) -> str | None:
        """Return the API key, or None for keyless backends."""
        return str(config.get('apikey') or '').strip() or None

    def _limits(self, config: dict) -> DecisionLimits:
        """Return this backend's limits (from the profile's ``limits`` block)."""
        return DecisionLimits.from_config(config)

    def beginGlobal(self):
        """Validate the questions and build the runner (skipped in CONFIG mode)."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        model = str(config.get('model', '')).strip()
        if not model:
            raise ValueError('System One node needs a model name')
        limits = self._limits(config)
        specs = parse_questions(config, limits)
        self._client = SystemOneClient(
            self._base_url(config), self._api_key(config), timeout=float(config.get('timeout') or 30)
        )
        state_metadata = tuple(
            line.strip() for line in str(config.get('state_metadata') or '').splitlines() if line.strip()
        )
        self.runner = DecisionRunner(
            self._client,
            model,
            specs,
            limits,
            state_metadata=state_metadata,
            on_error=str(config.get('on_error') or 'fail'),
            warn=warning,
            debug=debug,
        )
        debug(f'    System One: {self._client.endpoint} model={model} questions={len(specs)}')

    def endGlobal(self):
        """Release the HTTP client."""
        if self._client is not None:
            self._client.close()
        self._client = None
        self.runner = None
