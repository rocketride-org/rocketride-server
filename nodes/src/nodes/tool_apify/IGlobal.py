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
Apify tool node - global (shared) state.

Reads the Apify API token from config and creates an ApifyClient.
Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from apify_client import ApifyClient


def _int_or(value, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def _decimal_or(value, default: Decimal) -> Decimal:
    try:
        return Decimal(str(value))
    except (TypeError, ValueError, InvalidOperation):
        return default


class IGlobal(IGlobalBase):
    """Global state for tool_apify."""

    client: ApifyClient | None = None
    # Safety bounds for agent-driven runs; overridable from config.
    max_items: int = 100
    run_timeout_secs: int = 120
    max_cost_usd: Decimal = Decimal('1')

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = str((cfg.get('apikey') or '')).strip()

        if not apikey:
            raise Exception('tool_apify: apikey is required')

        self.max_items = _int_or(cfg.get('max_items'), 100)
        self.run_timeout_secs = _int_or(cfg.get('run_timeout_secs'), 120)
        self.max_cost_usd = _decimal_or(cfg.get('max_cost_usd'), Decimal('1'))

        try:
            self.client = ApifyClient(apikey)
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str((cfg.get('apikey') or '')).strip()
            if not apikey:
                warning('apikey is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.client = None
