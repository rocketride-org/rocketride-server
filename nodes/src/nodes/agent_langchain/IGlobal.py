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

from __future__ import annotations

import os
from typing import Any, Dict

from rocketlib import IGlobalBase, IJson, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    instructions: str = ''
    agent: Any = None

    @staticmethod
    def normalize_and_validate_instructions(cfg: Dict[str, Any]) -> str:
        cfg = IJson.toDict(cfg)
        if not isinstance(cfg, dict):
            raise ValueError('Config must be an object')

        raw = cfg.get('instructions')
        try:
            instructions = '' if raw is None else str(raw)
        except Exception:
            instructions = ''
        instructions = instructions.strip()
        if len(instructions) > 8000:
            raise ValueError('instructions is too long (max 8000 characters)')
        return instructions

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.instructions = self.normalize_and_validate_instructions(config)

        from .langchain_agent import LangChainDriver

        self.agent = LangChainDriver(instructions=self.instructions)

    def validateConfig(self):
        raw_conn = getattr(getattr(self, 'glb', None), 'connConfig', None)
        try:
            effective = Config.getNodeConfig(self.glb.logicalType, raw_conn)
        except Exception:
            try:
                effective = IJson.toDict(raw_conn)
            except Exception:
                effective = raw_conn if isinstance(raw_conn, dict) else {}

        self.normalize_and_validate_instructions(effective)
        return None

    def endGlobal(self) -> None:
        self.agent = None
        self.instructions = ''

