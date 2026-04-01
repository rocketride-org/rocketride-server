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

import asyncio
from typing import Any, List, Optional

from rocketlib import debug

# Metrics that require ground-truth expected output
_REQUIRES_EXPECTED = {'context_recall', 'factual_correctness'}

# Metrics that require retrieved context
_REQUIRES_CONTEXTS = {'faithfulness', 'context_precision', 'context_recall'}


def _build_host_llm(pSelf: Any):
    """Wrap the engine's connected LLM as a LangChain BaseChatModel for RAGAS."""
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.messages import AIMessage
    from ai.common.schema import Question
    from rocketlib.types import IInvokeLLM

    class HostInvokeLLM(BaseChatModel):
        _pSelf: Any = None

        def __init__(self, pself):
            super().__init__()
            object.__setattr__(self, '_pSelf', pself)

        def _generate(self, messages: List[Any], stop: Optional[List[str]] = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
            q = Question()
            for msg in messages:
                role = getattr(msg, 'type', '') or ''
                content = str(getattr(msg, 'content', '') or '')
                if role == 'system':
                    q.addInstruction('system', content)
                elif role == 'human':
                    q.addQuestion(content)
                else:
                    q.addContext(content)
            answer = object.__getattribute__(self, '_pSelf').instance.invoke('llm', IInvokeLLM(op='ask', question=q))
            text = answer.getText() if answer else ''
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

        @property
        def _llm_type(self) -> str:
            return 'rocketride-host-llm'

    return HostInvokeLLM(pSelf)


def _probe_llm_channel(pSelf: Any) -> bool:
    """Return True if an LLM control channel is connected."""
    from rocketlib.types import IInvokeLLM

    try:
        pSelf.instance.invoke('llm', IInvokeLLM(op='getContextLength'))
        return True
    except Exception:
        return False


class RagasEvalDriver:
    """RAGAS-based eval metrics for RAG pipelines."""

    def __init__(self, iglobal):
        """Store reference to IGlobal config."""
        self._g = iglobal

    def score(self, pSelf: Any, metric_name: str, query: str, answer: str, contexts: list, expected: str) -> dict:
        threshold = self._g.threshold

        if not answer:
            return self._result(0.0, metric_name, threshold, 'No answer provided.')

        if metric_name in _REQUIRES_EXPECTED and not expected:
            return self._result(
                0.0,
                metric_name,
                threshold,
                f'Metric "{metric_name}" requires ground-truth output (wire the text lane).',
            )

        if metric_name in _REQUIRES_CONTEXTS and not contexts:
            return self._result(
                0.0,
                metric_name,
                threshold,
                f'Metric "{metric_name}" requires retrieved context (wire the documents lane).',
            )

        # answer_relevancy needs OpenAI embeddings regardless of llm channel
        if metric_name == 'answer_relevancy' and not self._g.api_key:
            import os

            if not os.environ.get('OPENAI_API_KEY'):
                return self._result(
                    0.0,
                    metric_name,
                    threshold,
                    'answer_relevancy requires an embeddings API key. Set api_key in the node config or use a metric that is LLM-only (faithfulness, context_precision, factual_correctness).',
                )

        try:
            from ragas import SingleTurnSample
            from ragas.llms import LangchainLLMWrapper

            if _probe_llm_channel(pSelf):
                debug('eval_ragas: using connected LLM channel for judge')
                llm = LangchainLLMWrapper(_build_host_llm(pSelf))
            else:
                debug('eval_ragas: using configured API key for judge')
                from langchain_openai import ChatOpenAI

                llm = LangchainLLMWrapper(
                    ChatOpenAI(
                        model=self._g.evaluator_model,
                        api_key=self._g.api_key or None,
                        base_url=self._g.api_base_url or None,
                    )
                )

            metric = self._build_metric(metric_name, llm)
            if metric is None:
                return self._result(0.0, metric_name, threshold, f'Unknown metric: {metric_name}')

            sample = SingleTurnSample(
                user_input=query or '',
                response=answer,
                retrieved_contexts=contexts if contexts else [],
                reference=expected if expected else None,
            )

            loop = asyncio.new_event_loop()
            try:
                raw = loop.run_until_complete(metric.single_turn_ascore(sample))
            finally:
                loop.close()

            s = float(raw) if raw is not None else 0.0
            return self._result(s, metric_name, threshold, f'{metric_name}: {s:.4f}')

        except Exception as e:
            debug(f'eval_ragas score error: {e}')
            return self._result(0.0, metric_name, threshold, f'Evaluation failed: {e}')

    def _build_metric(self, metric_name: str, llm):
        from ragas.metrics import (
            Faithfulness,
            AnswerRelevancy,
            ContextPrecision,
            ContextRecall,
            FactualCorrectness,
        )
        from ragas.embeddings import LangchainEmbeddingsWrapper
        from langchain_openai import OpenAIEmbeddings

        embeddings = LangchainEmbeddingsWrapper(
            OpenAIEmbeddings(
                model='text-embedding-3-small',
                api_key=self._g.api_key or None,
                base_url=self._g.api_base_url or None,
            )
        )

        metrics = {
            'faithfulness': lambda: Faithfulness(llm=llm),
            'answer_relevancy': lambda: AnswerRelevancy(llm=llm, embeddings=embeddings),
            'context_precision': lambda: ContextPrecision(llm=llm),
            'context_recall': lambda: ContextRecall(llm=llm),
            'factual_correctness': lambda: FactualCorrectness(llm=llm),
        }

        factory = metrics.get(metric_name)
        return factory() if factory else None

    def _result(self, score: float, metric: str, threshold: float, reason: str) -> dict:
        return {
            'score': round(score, 4),
            'passed': score >= threshold,
            'metric': metric,
            'threshold': threshold,
            'reason': reason,
        }
