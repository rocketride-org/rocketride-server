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
tool_pipe node — global (shared) state.

Reads the tool configuration at startup so IInstance can route tool
invocations to the correct output lane on every call.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


VALID_RETURN_TYPES = {'text', 'answers', 'documents', 'table', 'image'}


class IGlobal(IGlobalBase):
    """Global state for tool_pipe."""

    tool_description: str = ''
    return_type: str = 'text'

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.tool_description = str(cfg.get('tool_description') or '').strip()
        self.return_type = str(cfg.get('return_type') or 'text').strip()

        if self.return_type not in VALID_RETURN_TYPES:
            raise Exception(f'tool_pipe: return_type must be one of {sorted(VALID_RETURN_TYPES)}')

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            return_type = str(cfg.get('return_type') or 'text').strip()
            if return_type and return_type not in VALID_RETURN_TYPES:
                warning(f'tool_pipe: return_type must be one of {sorted(VALID_RETURN_TYPES)}')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        pass
