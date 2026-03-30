# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Bland AI tool node — global (shared) state.

Reads the node configuration (API key, default voice, etc.) and creates a
``BlandDriver`` that exposes make_call, get_call, and analyze_call tools
for agent invocation.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .bland_driver import BlandDriver


class IGlobal(IGlobalBase):
    """Global state for tool_bland_ai."""

    driver: BlandDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = str(cfg.get("apikey") or "").strip()
        if not api_key:
            warning("Bland AI API key is required. Get one at https://www.bland.ai")
            raise ValueError("Bland AI API key not configured")

        server_name = str(cfg.get("serverName") or "bland").strip()
        default_voice = str(cfg.get("voice") or "June").strip()
        max_duration = int(cfg.get("maxDuration") or 5)
        record = bool(cfg.get("record", True))
        language = str(cfg.get("language") or "en").strip()

        try:
            self.driver = BlandDriver(
                server_name=server_name,
                api_key=api_key,
                default_voice=default_voice,
                max_duration=max_duration,
                record=record,
                language=language,
            )
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            api_key = str(cfg.get("apikey") or "").strip()
            if not api_key:
                warning("API key is required")
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
