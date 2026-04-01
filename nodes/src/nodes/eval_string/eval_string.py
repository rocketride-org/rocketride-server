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

import re

from rocketlib import debug


class StringEvalDriver:
    """Deterministic string-based eval metrics. No LLM calls required."""

    def __init__(self, iglobal):
        """Store reference to IGlobal config."""
        self._g = iglobal

    def score(self, answer: str, expected: str) -> dict:
        metric = self._g.metric
        threshold = self._g.threshold

        if not answer:
            return self._result(0.0, metric, threshold, 'No answer provided.')

        needs_expected = metric in {'exact_match', 'contains', 'regex', 'bleu', 'rouge_l'}
        if needs_expected and not expected:
            return self._result(
                0.0,
                metric,
                threshold,
                f'Metric "{metric}" requires expected output (wire the text lane).',
            )

        try:
            if metric == 'exact_match':
                matched = answer.strip().lower() == expected.strip().lower()
                s = 1.0 if matched else 0.0
                reason = 'Exact match.' if matched else 'Does not match expected output.'

            elif metric == 'contains':
                matched = expected.strip().lower() in answer.strip().lower()
                s = 1.0 if matched else 0.0
                reason = 'Expected string found.' if matched else 'Expected string not found.'

            elif metric == 'regex':
                try:
                    matched = bool(re.search(expected, answer, re.IGNORECASE))
                except re.error as e:
                    return self._result(0.0, metric, threshold, f'Invalid regex: {e}')
                s = 1.0 if matched else 0.0
                reason = 'Pattern matched.' if matched else 'Pattern not matched.'

            elif metric == 'bleu':
                from nltk.translate.bleu_score import sentence_bleu, SmoothingFunction

                reference = [expected.split()]
                hypothesis = answer.split()
                s = float(sentence_bleu(reference, hypothesis, smoothing_function=SmoothingFunction().method1))
                reason = f'BLEU score: {s:.4f}'

            elif metric == 'rouge_l':
                from rouge_score import rouge_scorer as rs

                scorer = rs.RougeScorer(['rougeL'], use_stemmer=True)
                s = float(scorer.score(expected, answer)['rougeL'].fmeasure)
                reason = f'ROUGE-L F1: {s:.4f}'

            else:
                return self._result(0.0, metric, threshold, f'Unknown metric: {metric}')

        except Exception as e:
            debug(f'eval_string score error: {e}')
            return self._result(0.0, metric, threshold, f'Evaluation failed: {e}')

        return self._result(s, metric, threshold, reason)

    def _result(self, score: float, metric: str, threshold: float, reason: str) -> dict:
        return {
            'score': round(score, 4),
            'passed': score >= threshold,
            'metric': metric,
            'threshold': threshold,
            'reason': reason,
        }
