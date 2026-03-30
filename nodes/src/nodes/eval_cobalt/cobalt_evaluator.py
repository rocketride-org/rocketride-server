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

"""Cobalt AI evaluator wrapper for scoring LLM outputs.

Supports semantic similarity, LLM-as-judge, and custom function evaluators
through the cobalt-ai testing framework.
"""

from typing import Any, Callable, Dict, Optional

from rocketlib import debug

# Lazy imports for cobalt — the dependency may not be installed
_cobalt_available = False
try:
    from cobalt import Evaluator

    _cobalt_available = True
except ImportError:
    Evaluator = None  # type: ignore


_VALID_EVAL_TYPES = ('similarity', 'llm_judge', 'custom')


class CobaltEvaluator:
    """Evaluate LLM outputs using Cobalt AI's testing framework.

    Provides three evaluation strategies:
      - semantic similarity (TF-IDF cosine similarity)
      - LLM-as-judge (GPT-4 / Claude scoring with criteria)
      - custom function (arbitrary Python callable returning a score)
    """

    _eval_type: str
    _threshold: float
    _model: str
    _criteria: str
    _apikey: str
    _custom_fn: Optional[Callable] = None

    def __init__(self, config: Dict[str, Any], bag: Dict[str, Any]) -> None:
        """Initialize the evaluator from node configuration.

        Args:
            config: Node configuration dictionary (eval_type, threshold, model, criteria, apikey).
            bag: Pipeline bag dictionary (shared state across nodes).
        """
        self._eval_type = config.get('eval_type', 'similarity')
        if self._eval_type not in _VALID_EVAL_TYPES:
            debug(f'Unknown eval_type "{self._eval_type}", falling back to similarity')
            self._eval_type = 'similarity'

        self._threshold = float(config.get('threshold', 0.7))
        self._model = config.get('model', 'gpt-4')
        self._criteria = config.get('criteria', 'Is the output correct, complete, and well-structured?')
        self._apikey = config.get('apikey', '')

        debug(f'CobaltEvaluator initialized: type={self._eval_type} threshold={self._threshold}')

    # ------------------------------------------------------------------
    # Evaluation methods
    # ------------------------------------------------------------------

    def evaluate_semantic(self, output: str, expected: str, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Evaluate output against expected text using TF-IDF cosine similarity.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text to compare against.
            threshold: Override the default threshold for this call.

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        threshold = threshold if threshold is not None else self._threshold

        if not output and not expected:
            return self._make_result(1.0, threshold, 'Both output and expected are empty', 'semantic')
        if not output or not expected:
            return self._make_result(0.0, threshold, 'One of output or expected is empty', 'semantic')

        if not _cobalt_available:
            debug('cobalt-ai not installed; falling back to basic similarity')
            return self._fallback_semantic(output, expected, threshold)

        try:
            evaluator = Evaluator()
            result = evaluator.evaluate_similarity(output=output, expected=expected)
            score = float(result.get('score', 0.0)) if isinstance(result, dict) else float(getattr(result, 'score', 0.0))
            reasoning = result.get('reasoning', '') if isinstance(result, dict) else getattr(result, 'reasoning', '')
            return self._make_result(score, threshold, reasoning or 'Semantic similarity evaluated', 'semantic')
        except Exception as e:
            debug(f'Cobalt semantic evaluation failed: {e}')
            return self._fallback_semantic(output, expected, threshold)

    def evaluate_llm_judge(self, output: str, expected: str, criteria: Optional[str] = None, model: Optional[str] = None) -> Dict[str, Any]:
        """Evaluate output using an LLM as a judge (GPT-4, Claude, etc.).

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text for comparison.
            criteria: Custom criteria string for the judge prompt.
            model: Override the default model for this call.

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        criteria = criteria or self._criteria
        model = model or self._model

        if not output:
            return self._make_result(0.0, self._threshold, 'Output is empty', 'llm_judge')

        if not self._apikey:
            debug('API key required for LLM judge evaluator')
            return self._make_result(0.0, self._threshold, 'API key not configured', 'llm_judge')

        if not _cobalt_available:
            debug('cobalt-ai not installed; cannot run LLM judge')
            return self._make_result(0.0, self._threshold, 'cobalt-ai not installed', 'llm_judge')

        try:
            evaluator = Evaluator(api_key=self._apikey)
            result = evaluator.evaluate_llm_judge(output=output, expected=expected, criteria=criteria, model=model)
            score = float(result.get('score', 0.0)) if isinstance(result, dict) else float(getattr(result, 'score', 0.0))
            reasoning = result.get('reasoning', '') if isinstance(result, dict) else getattr(result, 'reasoning', '')
            return self._make_result(score, self._threshold, reasoning or 'LLM judge evaluation complete', 'llm_judge')
        except Exception as e:
            debug(f'Cobalt LLM judge evaluation failed: {e}')
            return self._make_result(0.0, self._threshold, f'Evaluation failed: {type(e).__name__}', 'llm_judge')

    def evaluate_custom(self, output: str, expected: str, eval_fn: Optional[Callable] = None) -> Dict[str, Any]:
        """Evaluate output using a custom Python function.

        The function should accept (output, expected) and return a dict with
        at minimum a 'score' key (float 0-1).

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text for comparison.
            eval_fn: A callable that accepts (output, expected) and returns a score dict.

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        fn = eval_fn or self._custom_fn

        if fn is None:
            debug('No custom evaluation function provided')
            return self._make_result(0.0, self._threshold, 'No custom evaluation function provided', 'custom')

        try:
            result = fn(output, expected)
            if isinstance(result, dict):
                score = float(result.get('score', 0.0))
                reasoning = result.get('reasoning', 'Custom evaluation complete')
            elif isinstance(result, (int, float)):
                score = float(result)
                reasoning = 'Custom evaluation complete'
            else:
                score = 0.0
                reasoning = f'Unexpected return type from custom function: {type(result).__name__}'
            return self._make_result(score, self._threshold, reasoning, 'custom')
        except Exception as e:
            debug(f'Custom evaluation failed: {e}')
            return self._make_result(0.0, self._threshold, f'Custom evaluation failed: {type(e).__name__}', 'custom')

    def evaluate(self, output: str, expected: str, eval_type: Optional[str] = None) -> Dict[str, Any]:
        """Dispatch to the appropriate evaluator based on eval_type.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text for comparison.
            eval_type: Override the configured eval_type for this call.

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        eval_type = eval_type or self._eval_type

        if eval_type == 'llm_judge':
            return self.evaluate_llm_judge(output, expected)
        elif eval_type == 'custom':
            return self.evaluate_custom(output, expected)
        else:
            return self.evaluate_semantic(output, expected)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _make_result(score: float, threshold: float, reasoning: str, evaluator: str) -> Dict[str, Any]:
        """Build a standardized evaluation result dictionary.

        Args:
            score: The evaluation score (0.0 to 1.0).
            threshold: The pass/fail threshold.
            reasoning: Human-readable explanation of the evaluation.
            evaluator: The evaluator type that produced this result.

        Returns:
            Standardized result dict.
        """
        score = max(0.0, min(1.0, score))
        return {
            'score': score,
            'passed': score >= threshold,
            'reasoning': reasoning,
            'evaluator': evaluator,
        }

    @staticmethod
    def _fallback_semantic(output: str, expected: str, threshold: float) -> Dict[str, Any]:
        """Compute a basic Jaccard similarity fallback when cobalt-ai is not available.

        Uses sklearn-style TF-IDF vectorization for a lightweight comparison.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text.
            threshold: The pass/fail threshold.

        Returns:
            Evaluation result dict.
        """
        try:
            # Tokenize into word sets for a simple Jaccard-like similarity
            output_tokens = set(output.lower().split())
            expected_tokens = set(expected.lower().split())

            if not output_tokens and not expected_tokens:
                score = 1.0
            elif not output_tokens or not expected_tokens:
                score = 0.0
            else:
                intersection = output_tokens & expected_tokens
                union = output_tokens | expected_tokens
                score = len(intersection) / len(union) if union else 0.0

            return CobaltEvaluator._make_result(score, threshold, 'Fallback Jaccard similarity (cobalt-ai not installed)', 'semantic')
        except Exception:
            return CobaltEvaluator._make_result(0.0, threshold, 'Fallback similarity computation failed', 'semantic')
