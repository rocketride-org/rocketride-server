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
from typing import Any

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


_ALL_METRICS = ['answer_relevancy', 'faithfulness', 'hallucination', 'g_eval', 'bias', 'toxicity']


class IGlobal(IGlobalBase):
    driver: Any = None
    threshold: float = 0.5
    answer_relevancy: bool = True
    faithfulness: bool = False
    hallucination: bool = False
    g_eval: bool = False
    bias: bool = False
    toxicity: bool = False
    criteria: str = ''

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.threshold = float(config.get('threshold', 0.5))
        for m in _ALL_METRICS:
            setattr(self, m, bool(config.get(m, m == 'answer_relevancy')))
        self.criteria = config.get('criteria', '')

        from .eval_deepeval import DeepEvalDriver

        self.driver = DeepEvalDriver(self)

    def enabled_metrics(self) -> list:
        return [m for m in _ALL_METRICS if getattr(self, m, False)]

    def endGlobal(self) -> None:
        self.driver = None
