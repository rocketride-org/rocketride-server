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

import asyncio
import concurrent.futures
import math
from typing import Any, Callable, Dict, Optional, Tuple

from rocketlib import debug

# Lazy imports for cobalt — the dependency may not be installed
_cobalt_available = False
try:
    from cobalt import Evaluator
    from cobalt.types import EvalContext

    _cobalt_available = True
except ImportError:
    Evaluator = None  # type: ignore
    EvalContext = None  # type: ignore


_VALID_EVAL_TYPES = ('similarity', 'llm_judge', 'custom', 'relevance', 'grounding', 'format')

# cobalt's evaluator registry keys (cobalt/evaluators/*.py call registry.register()).
# The judge is registered as 'llm-judge' with a hyphen; this node's own eval_type
# spelling is 'llm_judge', so the two must not be conflated.
_COBALT_SIMILARITY_TYPE = 'similarity'
_COBALT_LLM_JUDGE_TYPE = 'llm-judge'

# The key under which the reference text is placed in EvalContext.item. cobalt's
# similarity handler reads config['field'] out of context.item
# (cobalt/evaluators/similarity.py:32,36), and its judge prompt template renders
# **context.item, so the same key is what {{expected}} resolves to.
_EXPECTED_FIELD = 'expected'

# The threshold handed to cobalt's similarity handler, which returns
# ``1.0 if sim >= threshold else sim / threshold`` (cobalt/evaluators/similarity.py:53)
# — a threshold-normalised value, not the cosine. At 1.0 the second branch is
# ``sim / 1.0``, so the score that comes back is the raw TF-IDF cosine and this
# node applies its own threshold exactly once, in ``_make_result``.
_COBALT_RAW_COSINE_THRESHOLD = 1.0


def _run_sync(coro: Any) -> Any:
    """Run a coroutine from synchronous node code.

    cobalt's ``Evaluator.evaluate`` is a coroutine (cobalt/evaluator.py:71).
    The engine dispatches node lane handlers synchronously, so ``asyncio.run``
    is the common case; this class is also reachable from a thread that already
    drives a loop, where ``asyncio.run`` raises, so fall back to a fresh loop on
    a worker thread. Both shapes follow the repo precedent in
    ``tool_filesystem/IInstance.py`` (``_run_async``) and
    ``agent_crewai/crewai_runner.py``.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _cobalt_score_and_reason(result: Any) -> Tuple[float, str]:
    """Read the score and the reason off whatever cobalt handed back.

    ``cobalt.types.EvalResult`` exposes ``score``/``reason``/``chain_of_thought``
    — there is no ``reasoning`` attribute. Mappings and the older ``reasoning``
    spelling are still accepted so a stubbed evaluator keeps working.
    """
    if isinstance(result, dict):
        return float(result.get('score', 0.0)), result.get('reason') or result.get('reasoning') or ''
    reason = getattr(result, 'reason', None) or getattr(result, 'reasoning', None) or ''
    return float(getattr(result, 'score', 0.0)), reason


class CobaltEvaluator:
    """Evaluate LLM outputs using Cobalt AI's testing framework.

    Provides three evaluation strategies:
      - semantic similarity (Jaccard similarity fallback when cobalt-ai is not
        installed or its call fails; the reasoning names which)
      - LLM-as-judge (GPT-4 / Claude scoring with criteria)
      - custom function (arbitrary Python callable returning a score)
    """

    _eval_type: str
    _threshold: float
    _model: str
    _criteria: str
    _apikey: str
    _keyword_weight: float
    _length_weight: float
    _custom_fn: Optional[Callable] = None

    def __init__(self, config: Dict[str, Any], bag: Dict[str, Any], custom_fn: Optional[Callable] = None) -> None:
        """Initialize the evaluator from node configuration.

        Args:
            config: Node configuration dictionary (eval_type, threshold, model, criteria, apikey).
            bag: Pipeline bag dictionary (shared state across nodes).
            custom_fn: Optional callable for custom evaluation. Should accept (output, expected)
                and return a dict with at minimum a 'score' key (float 0-1), or a numeric score.
        """
        self._eval_type = config.get('eval_type', 'similarity')
        if self._eval_type not in _VALID_EVAL_TYPES:
            debug(f'Unknown eval_type "{self._eval_type}", falling back to similarity')
            self._eval_type = 'similarity'

        try:
            self._threshold = float(config.get('threshold', 0.7))
        except (TypeError, ValueError):
            debug('Invalid threshold configured; falling back to 0.7')
            self._threshold = 0.7
        self._threshold = max(0.0, min(1.0, self._threshold))

        self._model = config.get('model', 'gpt-4')
        self._criteria = config.get('criteria', 'Is the output correct, complete, and well-structured?')
        self._apikey = config.get('apikey', '')
        self._expected_format = config.get('expected_format', 'prose')
        self._keyword_weight = self._parse_float(config.get('keyword_weight', 0.7), 0.7)
        self._length_weight = self._parse_float(config.get('length_weight', 0.3), 0.3)

        # Resolve custom evaluation function: explicit arg > config > bag
        resolved_fn = custom_fn
        if resolved_fn is None:
            resolved_fn = config.get('custom_fn')
        if resolved_fn is None:
            resolved_fn = bag.get('custom_fn')
        if resolved_fn is not None and not callable(resolved_fn):
            debug('Configured custom_fn is not callable; ignoring it')
            resolved_fn = None
        self._custom_fn = resolved_fn

        debug(f'CobaltEvaluator initialized: type={self._eval_type} threshold={self._threshold}')

    @property
    def eval_type(self) -> str:
        """Return the configured evaluation type."""
        return self._eval_type

    # ------------------------------------------------------------------
    # Evaluation methods
    # ------------------------------------------------------------------

    def evaluate_semantic(self, output: str, expected: str, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Evaluate output against expected text using semantic similarity.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text to compare against.
            threshold: Override the default threshold for this call. Clamped to [0.0, 1.0].

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        threshold = self._resolve_threshold(threshold)

        if not output and not expected:
            return self._make_result(1.0, threshold, 'Both output and expected are empty', 'semantic')
        if not output or not expected:
            return self._make_result(0.0, threshold, 'One of output or expected is empty', 'semantic')

        if not _cobalt_available:
            debug('cobalt-ai not installed; falling back to basic similarity')
            return self._fallback_semantic(output, expected, threshold, 'cobalt-ai not installed')

        try:
            # cobalt's similarity handler requires config['field'] and reads the
            # reference from context.item[field] (cobalt/evaluators/similarity.py:32-36);
            # omitting it raises KeyError('field').
            #
            # The threshold is deliberately NOT this node's: cobalt normalises its
            # score by whatever threshold it is given, so passing the node's
            # threshold here and comparing the result with the same threshold in
            # _make_result applied it twice and passed every cosine in
            # [threshold**2, threshold) — a cosine of 0.2606 passed at 0.5.
            # _COBALT_RAW_COSINE_THRESHOLD keeps cobalt's score equal to the
            # cosine; the verdict is the node's, taken once, below.
            evaluator = Evaluator(
                name='semantic-similarity',
                type=_COBALT_SIMILARITY_TYPE,
                field=_EXPECTED_FIELD,
                threshold=_COBALT_RAW_COSINE_THRESHOLD,
            )
            context = EvalContext(item={_EXPECTED_FIELD: expected}, output=output)
            result = _run_sync(evaluator.evaluate(context))
            score, reasoning = _cobalt_score_and_reason(result)
            return self._make_result(score, threshold, reasoning or 'Semantic similarity evaluated', 'semantic')
        except Exception as e:
            # Class name only: the same reasoning applies here as in the judge
            # branch below — a provider or dependency exception can echo a URL.
            debug(f'Cobalt semantic evaluation failed: {type(e).__name__}')
            return self._fallback_semantic(output, expected, threshold, f'cobalt call failed: {type(e).__name__}')

    def evaluate_llm_judge(
        self, output: str, expected: str, criteria: Optional[str] = None, model: Optional[str] = None
    ) -> Dict[str, Any]:
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
            # cobalt's judge handler renders config['prompt'] against
            # {'output': …, 'metadata': …, **context.item} — it has no 'criteria'
            # key (cobalt/evaluators/llm_judge.py:17-24), and it is registered
            # under the hyphenated 'llm-judge'.
            evaluator = Evaluator(
                name='llm-judge',
                type=_COBALT_LLM_JUDGE_TYPE,
                model=model,
                scoring='scale',
                prompt=(
                    f'{criteria}\n\nExpected: {{{{{_EXPECTED_FIELD}}}}}\n'
                    'Actual: {{output}}\n\nRespond with a score between 0.0 and 1.0.'
                ),
            )
            context = EvalContext(item={_EXPECTED_FIELD: expected}, output=output)
            # api_key and model are keyword-only on evaluate (cobalt/evaluator.py:71-77);
            # the config dict never carries the key.
            result = _run_sync(evaluator.evaluate(context, api_key=self._apikey, model=model))
            score, reasoning = _cobalt_score_and_reason(result)
            return self._make_result(score, self._threshold, reasoning or 'LLM judge evaluation complete', 'llm_judge')
        except Exception as e:
            # Only the class name: a provider SDK exception can echo the request URL
            # or the Authorization header, and self._apikey is in scope here.
            debug(f'Cobalt LLM judge evaluation failed: {type(e).__name__}')
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

    def evaluate_relevance(self, output: str, expected: str, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Evaluate response relevance using deterministic keyword + length heuristics.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text to compare against.
            threshold: Override the default threshold for this call. Clamped to [0.0, 1.0].

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        threshold = self._resolve_threshold(threshold)
        try:
            from .evaluators.relevance import evaluate_relevance as _relevance_fn

            result = _relevance_fn(
                output,
                expected,
                keyword_weight=self._keyword_weight,
                length_weight=self._length_weight,
                threshold=threshold,
            )
            return self._make_result(
                float(result.get('score', 0.0)), threshold, result.get('reasoning', ''), 'relevance'
            )
        except Exception as e:
            debug(f'Relevance evaluation failed: {e}')
            return self._make_result(0.0, threshold, f'Relevance evaluation failed: {type(e).__name__}', 'relevance')

    def evaluate_grounding(self, output: str, context: str, threshold: Optional[float] = None) -> Dict[str, Any]:
        """Evaluate whether output is grounded in the provided context.

        Args:
            output: The LLM-generated output text.
            context: The source context (reference passages) the output should be grounded in.
            threshold: Override the default threshold for this call. Clamped to [0.0, 1.0].

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        threshold = self._resolve_threshold(threshold)
        try:
            from .evaluators.grounding import evaluate_grounding as _grounding_fn

            result = _grounding_fn(output, context, threshold=threshold)
            return self._make_result(
                float(result.get('score', 0.0)), threshold, result.get('reasoning', ''), 'grounding'
            )
        except Exception as e:
            debug(f'Grounding evaluation failed: {e}')
            return self._make_result(0.0, threshold, f'Grounding evaluation failed: {type(e).__name__}', 'grounding')

    def evaluate_format(
        self, output: str, expected_format: Optional[str] = None, threshold: Optional[float] = None
    ) -> Dict[str, Any]:
        """Evaluate output formatting against an expected structural format.

        Args:
            output: The LLM-generated output text.
            expected_format: The expected format type (prose, list, code, json).
                If None, uses the configured expected_format.
            threshold: Override the default threshold for this call. Clamped to [0.0, 1.0].

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        threshold = self._resolve_threshold(threshold)
        expected_format = expected_format or self._expected_format
        try:
            from .evaluators.format_check import evaluate_format as _format_fn

            result = _format_fn(output, expected_format=expected_format, threshold=threshold)
            return self._make_result(float(result.get('score', 0.0)), threshold, result.get('reasoning', ''), 'format')
        except Exception as e:
            debug(f'Format evaluation failed: {e}')
            return self._make_result(0.0, threshold, f'Format evaluation failed: {type(e).__name__}', 'format')

    def evaluate(self, output: str, expected: str, eval_type: Optional[str] = None) -> Dict[str, Any]:
        """Dispatch to the appropriate evaluator based on eval_type.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text for comparison. For grounding,
                this is treated as the source context to check grounding against.
                For format, this argument is ignored (expected_format comes from config).
            eval_type: Override the configured eval_type for this call.

        Returns:
            Evaluation result dict with score, passed, reasoning, and evaluator keys.
        """
        eval_type = eval_type or self._eval_type

        if eval_type == 'llm_judge':
            return self.evaluate_llm_judge(output, expected)
        elif eval_type == 'custom':
            return self.evaluate_custom(output, expected, eval_fn=self._custom_fn)
        elif eval_type == 'relevance':
            return self.evaluate_relevance(output, expected)
        elif eval_type == 'grounding':
            return self.evaluate_grounding(output, expected)
        elif eval_type == 'format':
            return self.evaluate_format(output)
        else:
            return self.evaluate_semantic(output, expected)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_float(value: Any, default: float) -> float:
        """Parse a numeric config value, returning a default on invalid input."""
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def _resolve_threshold(self, threshold: Optional[float]) -> float:
        """Resolve a per-call threshold override into a usable threshold.

        The configured threshold is clamped in ``__init__``, but a per-call
        override bypasses that clamp, so it is validated here: unusable values
        (non-numeric or NaN) fall back to the configured threshold and the rest
        are clamped to [0.0, 1.0].

        Args:
            threshold: The per-call override, or None to use the configured one.

        Returns:
            A threshold in [0.0, 1.0].
        """
        if threshold is None:
            return self._threshold
        try:
            value = float(threshold)
        except (TypeError, ValueError):
            debug('Invalid threshold override; using the configured threshold')
            return self._threshold
        if math.isnan(value):
            debug('NaN threshold override; using the configured threshold')
            return self._threshold
        return max(0.0, min(1.0, value))

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
        # A non-finite score must never clamp into a pass: max(0.0, min(1.0, nan))
        # is 1.0 in CPython, which would silently report a perfect result.
        if not isinstance(score, (int, float)) or not math.isfinite(score):
            score = 0.0
        score = max(0.0, min(1.0, float(score)))

        # A NaN threshold cannot be satisfied, so it always fails; anything else
        # is clamped so an out-of-range override cannot invert the verdict.
        if not isinstance(threshold, (int, float)) or math.isnan(threshold):
            passed = False
        else:
            passed = score >= max(0.0, min(1.0, float(threshold)))

        return {
            'score': score,
            'passed': passed,
            'reasoning': reasoning,
            'evaluator': evaluator,
        }

    @staticmethod
    def _fallback_semantic(
        output: str, expected: str, threshold: float, cause: str = 'cobalt-ai not installed'
    ) -> Dict[str, Any]:
        """Compute a basic Jaccard similarity fallback when cobalt cannot score.

        Tokenizes both strings into word sets and computes the Jaccard index
        (intersection over union) for a lightweight comparison.

        Args:
            output: The LLM-generated output text.
            expected: The expected/reference text.
            threshold: The pass/fail threshold.
            cause: Why the fallback ran, quoted verbatim in the reasoning. The
                package being absent and a cobalt call that failed are different
                situations and must not read alike: a mislabelled reason sent an
                acceptance run's readers looking for a missing dependency that
                was in fact installed.

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

            return CobaltEvaluator._make_result(score, threshold, f'Fallback Jaccard similarity ({cause})', 'semantic')
        except Exception:
            return CobaltEvaluator._make_result(0.0, threshold, 'Fallback similarity computation failed', 'semantic')
