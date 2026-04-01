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
        self._query = ''
        self._answer = ''
        self._contexts: list = []
        self._expected = ''

    def writeQuestions(self, question):
        """Collect the original user query."""
        for q in question.questions:
            self._query += q.text

    def writeDocuments(self, documents):
        """Collect retrieved context chunks."""
        for doc in documents:
            if hasattr(doc, 'page_content'):
                self._contexts.append(str(doc.page_content))
            else:
                self._contexts.append(str(doc))

    def writeAnswers(self, answer: Answer):
        """Collect the LLM-generated answer to evaluate."""
        if answer.isJson():
            self._answer = json.dumps(answer.getJson())
        else:
            self._answer = answer.getText() or ''

    def writeText(self, text: str):
        """Collect the expected/ground-truth answer (optional)."""
        self._expected = text or ''

    def closing(self):
        """Run all enabled metrics once inputs are collected, emit one score per metric."""
        enabled = self.IGlobal.enabled_metrics()
        if not enabled:
            debug('eval_ragas: no metrics enabled')
            return
        for metric_name in enabled:
            try:
                result = self.IGlobal.driver.score(
                    pSelf=self,
                    metric_name=metric_name,
                    query=self._query,
                    answer=self._answer,
                    contexts=self._contexts,
                    expected=self._expected,
                )
                debug(f'eval_ragas [{metric_name}]: {result}')
                if self.instance.hasListener('answers'):
                    ans = Answer()
                    ans.setAnswer(json.dumps(result))
                    self.instance.writeAnswers(ans)
            except Exception as e:
                debug(f'eval_ragas [{metric_name}] error: {e}')
