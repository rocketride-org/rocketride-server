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

from __future__ import annotations

import os
from typing import Any, Dict, List

from rocketlib import IGlobalBase, IJson, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    instructions: List[str] = []
    agent: Any = None

    _MAX_INSTRUCTION_LEN = 1000

    @staticmethod
    def normalize_and_validate_instructions(cfg: Dict[str, Any]) -> List[str]:
        """
        Normalize and validate the LangChain node config instructions.

        Expects an array of instruction strings. Each instruction should be a couple
        of sentences (max 1000 chars).
        """
        cfg = IJson.toDict(cfg)
        if not isinstance(cfg, dict):
            raise ValueError('Config must be an object')

        raw = cfg.get('instructions')
        if not isinstance(raw, list):
            return []

        result: List[str] = []
        for item in raw:
            if not isinstance(item, str):
                continue
            s = item.strip()
            if not s:
                continue
            if len(s) > IGlobal._MAX_INSTRUCTION_LEN:
                raise ValueError(
                    f'Instruction too long (max {IGlobal._MAX_INSTRUCTION_LEN} chars): {s[:50]}...'
                )
            result.append(s)
        return result

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        conn_config = IJson.toDict(self.glb.connConfig) if self.glb.connConfig else {}
        conn_config = conn_config if isinstance(conn_config, dict) else {}
        config = Config.getNodeConfig(self.glb.logicalType, conn_config)
        self.instructions = self.normalize_and_validate_instructions(config)

        from .langchain import LangChainDriver

        self.agent = LangChainDriver()

    def validateConfig(self):
        raw_conn = getattr(getattr(self, 'glb', None), 'connConfig', None)
        conn_config = IJson.toDict(raw_conn) if raw_conn else {}
        conn_config = conn_config if isinstance(conn_config, dict) else {}
        try:
            effective = Config.getNodeConfig(self.glb.logicalType, conn_config)
        except Exception:
            effective = {}

        self.normalize_and_validate_instructions(effective)
        return None

    def endGlobal(self) -> None:
        self.agent = None
        self.instructions = []

