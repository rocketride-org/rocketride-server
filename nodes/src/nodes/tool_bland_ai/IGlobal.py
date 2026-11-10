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
Bland AI tool node - global (shared) state.

Reads the resolved node configuration (API key, default voice, etc.) and
creates a ``BlandDriver`` that exposes make_call, get_call, and analyze_call
tools for agent invocation.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, warning

from .bland_driver import BlandDriver


class IGlobal(IGlobalBase):
    """Global state for tool_bland_ai."""

    driver: BlandDriver | None = None

    def beginGlobal(self) -> None:
        # The resolved config: defaults applied, types and the maxDuration
        # minimum already validated, the key a required secret
        cfg = self.config

        api_key = str(cfg.apikey or '').strip()
        if not api_key:
            warning('Bland AI API key is required. Get one at https://www.bland.ai')
            raise ValueError('Bland AI API key not configured')

        try:
            self.driver = BlandDriver(
                server_name=cfg.serverName,
                api_key=api_key,
                default_voice=cfg.voice,
                max_duration=cfg.maxDuration,
                record=cfg.record,
                language=cfg.language,
            )
        except Exception as e:
            warning(str(e))
            raise

    def endGlobal(self) -> None:
        self.driver = None
