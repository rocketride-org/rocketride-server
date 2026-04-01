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

from rocketlib import debug

_REQUIRES_CONTEXTS = {'faithfulness', 'hallucination'}


def _build_host_llm(pSelf: Any):
    """Wrap the engine's connected LLM as a DeepEvalBaseLLM for judge calls."""
    from deepeval.models import DeepEvalBaseLLM
    from ai.common.schema import Question
    from rocketlib.types import IInvokeLLM

    class HostInvokeLLM(DeepEvalBaseLLM):
        def __init__(self, pself):
            self._pSelf = pself

        def load_model(self):
            return self

        def generate(self, prompt: str, schema: Any = None) -> str:
            q = Question()
            q.addQuestion(prompt)
            answer = self._pSelf.instance.invoke('llm', IInvokeLLM(op='ask', question=q))
            return answer.getText() if answer else ''

        async def a_generate(self, prompt: str, schema: Any = None) -> str:
            return self.generate(prompt, schema)

        def get_model_name(self) -> str:
            return 'RocketRide-Host-LLM'

    return HostInvokeLLM(pSelf)


def _probe_llm_channel(pSelf: Any) -> bool:
    """Return True if an LLM control channel is connected."""
    from rocketlib.types import IInvokeLLM

    try:
        pSelf.instance.invoke('llm', IInvokeLLM(op='getContextLength'))
        return True
    except Exception:
        return False


class DeepEvalDriver:
    """DeepEval-based eval metrics for general LLM and agentic pipelines."""

    def __init__(self, iglobal):
        """Store reference to IGlobal config."""
        self._g = iglobal

    def score(self, pSelf: Any, metric_name: str, query: str, answer: str, contexts: list, expected: str) -> dict:
        threshold = self._g.threshold

        if not answer:
            return self._result(0.0, metric_name, threshold, 'No answer provided.')

        if metric_name in _REQUIRES_CONTEXTS and not contexts:
            return self._result(
                0.0,
                metric_name,
                threshold,
                f'Metric "{metric_name}" requires retrieved context (wire the documents lane).',
            )

        try:
            if _probe_llm_channel(pSelf):
                debug('eval_deepeval: using connected LLM channel for judge')
                host_llm = _build_host_llm(pSelf)
            else:
                debug('eval_deepeval: using configured API key for judge')
                if self._g.api_key:
                    os.environ['OPENAI_API_KEY'] = self._g.api_key
                host_llm = None

            from deepeval.test_case import LLMTestCase

            metric = self._build_metric(metric_name, host_llm)
            if metric is None:
                return self._result(0.0, metric_name, threshold, f'Unknown metric: {metric_name}')

            test_case = LLMTestCase(
                input=query or '',
                actual_output=answer,
                retrieval_context=contexts if contexts else None,
                expected_output=expected if expected else None,
            )

            metric.measure(test_case)
            s = float(metric.score) if metric.score is not None else 0.0
            reason = metric.reason or f'{metric_name}: {s:.4f}'
            return self._result(s, metric_name, threshold, reason)

        except Exception as e:
            debug(f'eval_deepeval score error: {e}')
            return self._result(0.0, metric_name, threshold, f'Evaluation failed: {e}')

    def _build_metric(self, metric_name: str, host_llm: Any = None):
        model = host_llm
        threshold = self._g.threshold

        if metric_name == 'answer_relevancy':
            from deepeval.metrics import AnswerRelevancyMetric

            return AnswerRelevancyMetric(threshold=threshold, model=model)

        if metric_name == 'faithfulness':
            from deepeval.metrics import FaithfulnessMetric

            return FaithfulnessMetric(threshold=threshold, model=model)

        if metric_name == 'hallucination':
            from deepeval.metrics import HallucinationMetric

            return HallucinationMetric(threshold=threshold, model=model)

        if metric_name == 'g_eval':
            from deepeval.metrics import GEval
            from deepeval.test_case import LLMTestCaseParams

            criteria = self._g.criteria or 'The response is helpful and accurate.'
            return GEval(
                name='CustomCriteria',
                criteria=criteria,
                evaluation_params=[
                    LLMTestCaseParams.INPUT,
                    LLMTestCaseParams.ACTUAL_OUTPUT,
                ],
                threshold=threshold,
                model=model,
            )

        if metric_name == 'bias':
            from deepeval.metrics import BiasMetric

            return BiasMetric(threshold=threshold, model=model)

        if metric_name == 'toxicity':
            from deepeval.metrics import ToxicityMetric

            return ToxicityMetric(threshold=threshold, model=model)

        return None

    def _result(self, score: float, metric: str, threshold: float, reason: str) -> dict:
        return {
            'score': round(score, 4),
            'passed': score >= threshold,
            'metric': metric,
            'threshold': threshold,
            'reason': reason,
        }
