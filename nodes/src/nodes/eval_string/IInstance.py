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

import json

from rocketlib import IInstanceBase, debug
from ai.common.schema import Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialise per-request accumulators."""
        super().__init__()
        self._answer = ''
        self._expected = ''

    def writeAnswers(self, answer: Answer):
        """Collect the LLM-generated answer to evaluate."""
        if answer.isJson():
            self._answer = json.dumps(answer.getJson())
        else:
            self._answer = answer.getText() or ''

    def writeText(self, text: str):
        """Collect the expected/ground-truth answer."""
        self._expected = text or ''

    def closing(self):
        """Run metric once all inputs are collected, emit score on answers lane."""
        try:
            result = self.IGlobal.driver.score(
                answer=self._answer,
                expected=self._expected,
            )
            debug(f'eval_string result: {result}')
            if self.instance.hasListener('answers'):
                ans = Answer()
                ans.setAnswer(json.dumps(result))
                self.instance.writeAnswers(ans)
        except Exception as e:
            debug(f'eval_string closing error: {e}')
