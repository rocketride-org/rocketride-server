# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
eval_ragas IInstance — per-entry evaluation logic.

Lifecycle per pipeline entry (e.g. one chat turn):
    1. open()         — reset accumulators
    2. writeAnswers() — capture the LLM response; block pass-through
    3. writeText()    — accumulate context chunks from vector DB; block pass-through
    4. writeQuestions() — capture the original question; block pass-through
    5. closing()      — run ragas, emit one score Answer per enabled metric

Output schema per metric:
    {
        "metric":    "faithfulness",
        "score":     0.87,
        "passed":    true,
        "threshold": 0.7
    }
"""

from typing import List

from rocketlib import IInstanceBase, Entry
from ai.common.schema import Answer, Question

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # Accumulators — reset on each open()
    answer_text: str = ''
    question_text: str = ''
    context_chunks: List[str] = []

    def open(self, object: Entry) -> None:
        self.answer_text = ''
        self.question_text = ''
        self.context_chunks = []

    def writeAnswers(self, answer: Answer) -> None:
        """Capture the LLM response. Block it from passing through."""
        self.answer_text = answer.getText()
        self.preventDefault()

    def writeText(self, text: str) -> None:
        """Accumulate context chunks from the vector DB. Block pass-through."""
        if text and text.strip():
            self.context_chunks.append(text)
        self.preventDefault()

    def writeQuestions(self, question: Question) -> None:
        """Capture the original user question. Block pass-through."""
        if question.questions:
            self.question_text = question.questions[0].text
        self.preventDefault()

    def closing(self) -> None:
        """Run ragas evaluation and emit one score Answer per enabled metric."""
        if not self.answer_text:
            return

        if not self.instance.hasListener('answers'):
            return

        from ._llm_bridge import RocketRideChatModel
        from ragas.llms import LangchainLLMWrapper
        from ragas import evaluate, EvaluationDataset
        from ragas.dataset_schema import SingleTurnSample

        # Build the ragas LLM judge from the pipeline's connected LLM
        ragas_llm = LangchainLLMWrapper(RocketRideChatModel(instance=self.instance))

        # Build the single-sample dataset
        sample = SingleTurnSample(
            user_input=self.question_text or 'N/A',
            response=self.answer_text,
            retrieved_contexts=self.context_chunks if self.context_chunks else [],
            reference=self.IGlobal.ground_truth if self.IGlobal.ground_truth else None,
        )
        dataset = EvaluationDataset(samples=[sample])

        # Select metrics based on config + available inputs
        metrics = self._build_metrics(ragas_llm)
        if not metrics:
            return

        result = evaluate(dataset=dataset, metrics=metrics)

        # Emit one score Answer per metric
        thresholds = self._thresholds()
        for metric in metrics:
            metric_name = metric.name
            raw_scores = result[metric_name]
            score_val = float(raw_scores[0]) if raw_scores else 0.0
            threshold = thresholds.get(metric_name, 0.7)

            answer = Answer(expectJson=True)
            answer.setAnswer(
                {
                    'metric': metric_name,
                    'score': round(score_val, 4),
                    'passed': score_val >= threshold,
                    'threshold': threshold,
                }
            )
            self.instance.writeAnswers(answer)

    # -------------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------------

    def _build_metrics(self, ragas_llm: object) -> list:
        """Return the list of ragas metric objects to run, based on config and available inputs."""
        from ragas.metrics import (
            Faithfulness,
            AnswerRelevancy,
            LLMContextPrecisionWithoutReference,
            ContextRecall,
            FactualCorrectness,
        )

        metrics = []
        has_context = bool(self.context_chunks)
        has_question = bool(self.question_text)
        has_ground_truth = bool(self.IGlobal.ground_truth)

        if self.IGlobal.faithfulness and has_context:
            metrics.append(Faithfulness(llm=ragas_llm))

        if self.IGlobal.answer_relevancy and has_question:
            # answer_relevancy also needs an embeddings model for semantic similarity.
            # ragas uses the environment default (e.g. OPENAI_API_KEY → OpenAI embeddings).
            metrics.append(AnswerRelevancy(llm=ragas_llm))

        if self.IGlobal.context_precision and has_context and has_question:
            metrics.append(LLMContextPrecisionWithoutReference(llm=ragas_llm))

        if self.IGlobal.context_recall and has_context and has_question and has_ground_truth:
            metrics.append(ContextRecall(llm=ragas_llm))

        if self.IGlobal.factual_correctness and has_ground_truth:
            metrics.append(FactualCorrectness(llm=ragas_llm))

        return metrics

    def _thresholds(self) -> dict:
        return {
            'faithfulness': self.IGlobal.faithfulness_threshold,
            'answer_relevancy': self.IGlobal.answer_relevancy_threshold,
            'context_precision': self.IGlobal.context_precision_threshold,
            'context_recall': self.IGlobal.context_recall_threshold,
            'factual_correctness': self.IGlobal.factual_correctness_threshold,
        }
