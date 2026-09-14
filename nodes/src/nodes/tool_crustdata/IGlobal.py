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
Crustdata tool node - global (shared) state.

Reads the Crustdata API key and default page size from the node config.
Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

import os

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning


class IGlobal(IGlobalBase):
    """Global state for tool_crustdata."""

    apikey: str = ''
    default_limit: int = 10

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        apikey = str(cfg.get('apikey') or os.environ.get('CRUSTDATA_API_KEY', '')).strip()

        if not apikey:
            error('tool_crustdata: apikey is required — set it in node config or CRUSTDATA_API_KEY env var')
            raise ValueError('tool_crustdata: apikey is required')

        self.apikey = apikey
        self.default_limit = _coerce_limit(cfg.get('defaultLimit', 10))

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or os.environ.get('CRUSTDATA_API_KEY', '')).strip()
            if not apikey:
                warning('apikey is required')
            raw_limit = cfg.get('defaultLimit')
            if raw_limit is not None and not isinstance(raw_limit, bool):
                try:
                    int(raw_limit)
                except (TypeError, ValueError):
                    warning(f'defaultLimit {raw_limit!r} is not a valid integer; will fall back to 10')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.apikey = ''


def _coerce_limit(raw_limit: object, *, default: int = 10) -> int:
    """Clamp a config value to [1, 1000], falling back to ``default`` on any bad input.

    ``Config.getNodeConfig`` returns whatever is in the (user-editable) pipe
    file verbatim -- the field's declared ``"type": "integer"`` in
    services.json constrains the UI form, not a hand-edited file or an SDK
    caller, so a non-numeric value here must degrade gracefully rather than
    raise out of beginGlobal.
    """
    if raw_limit is None or isinstance(raw_limit, bool):
        raw_limit = default
    try:
        value = int(raw_limit)
    except (TypeError, ValueError):
        value = default
    return max(1, min(1000, value))
