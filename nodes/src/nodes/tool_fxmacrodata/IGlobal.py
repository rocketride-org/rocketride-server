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
FXMacroData tool node - global (shared) state.

Reads the optional FXMacroData API key from the node config. Without a key
the node runs on the keyless tier. Tool logic lives on IInstance via
@tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

from .fxmacrodata_client import ApiKey

# Pipeline env vars must be ROCKETRIDE_-prefixed (only those are substituted,
# and the node-test framework maps ROCKETRIDE_<PROVIDER>_<ATTR> -> config).
FXMACRODATA_API_KEY_ENV = 'ROCKETRIDE_FXMACRODATA_KEY'


def resolve_api_key(cfg: dict) -> ApiKey:
    """Build the ApiKey from node config, falling back to the env var; empty means keyless."""
    configured = cfg.get('apikey')
    if configured is not None and not isinstance(configured, str):
        raise ValueError('apikey must be a string')
    raw = (configured or '').strip() or os.environ.get(FXMACRODATA_API_KEY_ENV, '')
    return ApiKey(raw)


class IGlobal(IGlobalBase):
    """Global state for tool_fxmacrodata."""

    api_key: ApiKey = ApiKey('')

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        try:
            self.api_key = resolve_api_key(cfg)
        except ValueError as exc:
            error(f'tool_fxmacrodata: {exc}')
            raise ValueError(f'tool_fxmacrodata: {exc}') from None

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            resolve_api_key(cfg)
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.api_key = ApiKey('')
