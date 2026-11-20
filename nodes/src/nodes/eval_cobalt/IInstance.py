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

"""Instance handler for the Cobalt Evaluator node.

Intercepts answer data flowing through the pipeline, runs Cobalt evaluations,
and enriches the answer with evaluation scores before forwarding it downstream.
"""

import copy
import json

from rocketlib import IInstanceBase, debug
from ai.common.schema import Answer

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Process answers through the Cobalt evaluation framework.

    For each answer received, the evaluator scores it against the configured
    expected output (or empty string if none is provided) using the selected
    evaluator type (semantic similarity, LLM judge, or custom function).

    The original answer is deep-copied to prevent mutation in fan-out
    pipelines. Evaluation results are emitted as a separate JSON answer
    on the answers lane.

    Exactly TWO answers leave this node per incoming answer, and the count is
    now enforced rather than merely documented. ``writeAnswers`` ends with
    ``preventDefault()`` on both of its exits: the engine forwards a lane
    handler's incoming argument after the handler returns unless the handler
    prevented it (``__checkCallParent``, ``engLib/python/call.hpp``), so
    without the suppression the original answer arrived downstream a second
    time and the node emitted THREE answers per input, not two. A live run of
    ``examples/cobalt-evaluation.pipe`` put 18 answers into the sink for the
    six answers that reached this node, where the two-per-input contract allows
    12; with the suppression in place the same run delivers 12.
    """

    IGlobal: IGlobal

    def writeAnswers(self, answer: Answer) -> None:
        """Evaluate an LLM answer using Cobalt evaluators.

        Deep-copies the answer to prevent mutation, extracts the text output,
        runs the configured evaluator, and emits both the original answer
        and a separate evaluation result answer downstream.

        Every exit suppresses the engine's default forward, so the answers
        this node wrote are the only ones that continue downstream.

        Args:
            answer: The Answer object flowing through the pipeline.

        Returns:
            The ``preventDefault()`` result, suppressing the engine's
            post-handler forward of the incoming answer.
        """
        answer = copy.deepcopy(answer)
        evaluator = self.IGlobal._evaluator

        if evaluator is None:
            debug('Cobalt evaluator not initialized; passing answer through')
            # The copy is forwarded once, in place of the original: preventing
            # the default keeps the untouched original from arriving as well.
            self.instance.writeAnswers(answer)
            return self.preventDefault()

        # An answer the LLM node marked as a failed call carries error text,
        # not a model reply. Scoring it would report an ordinary failing score
        # (an error message is never similar to the reference), so a provider
        # outage would read as lower answer quality. Keep the pairing and the
        # two-answers-per-input contract, but report the row as unscored.
        metadata = getattr(answer, 'metadata', None)
        llm_error = metadata.get('llm_error') if isinstance(metadata, dict) else None
        if llm_error:
            debug(f'Cobalt evaluator: answer is an LLM error ({llm_error}); not scored')
            self.instance.writeAnswers(answer)
            self.instance.writeAnswers(
                self._score_answer(
                    metadata,
                    score=None,
                    passed=None,
                    # The name a scored row of this run carries, so an unscored
                    # row groups with them (``similarity`` reports ``semantic``).
                    evaluator_name=evaluator.result_name,
                    reasoning=f'Not scored: the LLM call failed ({llm_error}).',
                )
            )
            return self.preventDefault()

        output_text, json_data = self._output_text(answer)
        expected = self._reference_text(evaluator.eval_type, answer, metadata, json_data)

        if not expected and evaluator.eval_type in ('similarity', 'relevance'):
            debug(f'Cobalt evaluator: no expected text found for {evaluator.eval_type} mode; score will be 0')
        if not expected and evaluator.eval_type == 'grounding':
            debug('Cobalt evaluator: no context text found for grounding mode; score will be 0')

        result = evaluator.evaluate(output_text, expected)

        debug(
            f'Cobalt evaluation: score={result["score"]:.3f} passed={result["passed"]} evaluator={result["evaluator"]}'
        )

        # This node emits TWO answers per input on the `answers` lane: the
        # original answer (forwarded unchanged) followed by a synthetic JSON
        # score answer. Downstream consumers therefore see double the answer
        # count. This is intentional — the score travels as a sibling answer so
        # the original payload stays untouched for other consumers — but nodes
        # that assume a 1:1 answer count, or single-answer output sinks, must
        # account for it. TWO, not three: the explicit forward below is paired
        # with the preventDefault() at the end of this method, which stops the
        # engine delivering the incoming answer a second time on its own.
        self.instance.writeAnswers(answer)

        # Emit evaluation result as a separate JSON answer. It carries a copy
        # of the incoming metadata so a consumer can join the score to its
        # dataset item by key rather than by answer order, which is not stable
        # across fan-out or parallel workers.
        self.instance.writeAnswers(
            self._score_answer(
                metadata,
                score=result['score'],
                passed=result['passed'],
                evaluator_name=result['evaluator'],
                reasoning=result.get('reasoning', ''),
            )
        )

        # Both writes above are explicit, so the engine must not add its own.
        return self.preventDefault()

    @staticmethod
    def _output_text(answer: Answer):
        """Return the text to score and the answer's JSON payload.

        A plain-text answer is scored on its text. A JSON answer is scored on
        its serialised payload with the reserved reference fields removed, so
        the evaluator never grades text that contains the reference. That strip
        is shallow and top-level, and applies to dict-shaped payloads only: a
        reference nested inside a sub-object, or carried in a plain-text
        answer, is not removed.

        Args:
            answer: The answer to score.

        Returns:
            An ``(output_text, json_data)`` pair. ``json_data`` is the payload
            as the answer holds it, reference fields included, or None for a
            plain-text answer.
        """
        if not answer.isJson():
            return answer.getText() or '', None

        json_data = answer.getJson()
        eval_payload = json_data
        if isinstance(json_data, dict):
            eval_payload = {k: v for k, v in json_data.items() if k not in {'expected', 'context', 'reference'}}
        output_text = json.dumps(eval_payload) if eval_payload is not None else ''
        return output_text, json_data

    @staticmethod
    def _reference_text(eval_type: str, answer: Answer, metadata, json_data) -> str:
        """Return the text the answer is scored against, or '' when there is none.

        ``grounding`` scores against the evidence the answer should be grounded
        in, so it looks for ``context`` first; every other type looks for the
        expected answer first. Within each order the answer's own attribute and
        its metadata come before its JSON payload. The first candidate that is
        neither None nor an empty string wins, so an explicit falsy value such
        as ``0`` is kept, and a candidate that is not a string is converted
        with ``str``.

        An empty result is not an error: ``llm_judge`` can judge an answer on
        its own, while ``similarity``, ``relevance`` and ``grounding`` then
        score 0.

        Args:
            eval_type: The evaluator's configured type.
            answer: The answer being scored.
            metadata: The answer's metadata; ignored unless it is a dict.
            json_data: The answer's JSON payload; ignored unless it is a dict.

        Returns:
            The reference text, or an empty string.
        """
        context = getattr(answer, 'context', None)
        if eval_type == 'grounding':
            candidates = [
                metadata.get('context') if isinstance(metadata, dict) else None,
                context if isinstance(context, str) else None,
                json_data.get('context') if isinstance(json_data, dict) else None,
                metadata.get('reference') if isinstance(metadata, dict) else None,
                json_data.get('reference') if isinstance(json_data, dict) else None,
                getattr(answer, 'expected', None),
                metadata.get('expected') if isinstance(metadata, dict) else None,
                json_data.get('expected') if isinstance(json_data, dict) else None,
            ]
        else:
            candidates = [
                getattr(answer, 'expected', None),
                metadata.get('expected') if isinstance(metadata, dict) else None,
                metadata.get('reference') if isinstance(metadata, dict) else None,
                metadata.get('context') if isinstance(metadata, dict) else None,
                context if isinstance(context, str) else None,
                json_data.get('expected') if isinstance(json_data, dict) else None,
                json_data.get('reference') if isinstance(json_data, dict) else None,
                json_data.get('context') if isinstance(json_data, dict) else None,
            ]
        for candidate in candidates:
            if candidate is not None and candidate != '':
                return candidate if isinstance(candidate, str) else str(candidate)
        return ''

    @staticmethod
    def _score_answer(metadata, *, score, passed, evaluator_name, reasoning) -> Answer:
        """Build the JSON score answer emitted after each evaluated answer.

        Args:
            metadata: The incoming answer's metadata, copied onto the score.
            score: The evaluator's score, or None when the row was not scored.
            passed: Whether the score met the threshold, or None when unscored.
            evaluator_name: The evaluator that produced (or would produce) it.
            reasoning: Why the evaluator gave this score, or why there is none.

        Returns:
            A JSON ``Answer`` holding the ``cobalt_*`` fields.
        """
        eval_answer = Answer(expectJson=True)
        if isinstance(metadata, dict):
            eval_answer.metadata = copy.deepcopy(metadata)
        eval_answer.setAnswer(
            {
                'cobalt_score': score,
                'cobalt_passed': passed,
                'cobalt_evaluator': evaluator_name,
                'cobalt_reasoning': reasoning,
            }
        )
        return eval_answer
