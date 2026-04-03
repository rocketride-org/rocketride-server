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
    """

    IGlobal: IGlobal

    def writeAnswers(self, answer: Answer) -> None:
        """Evaluate an LLM answer using Cobalt evaluators.

        Deep-copies the answer to prevent mutation, extracts the text output,
        runs the configured evaluator, and emits both the original answer
        and a separate evaluation result answer downstream.

        Args:
            answer: The Answer object flowing through the pipeline.
        """
        answer = copy.deepcopy(answer)
        evaluator = self.IGlobal._evaluator

        if evaluator is None:
            debug('Cobalt evaluator not initialized; passing answer through')
            self.instance.writeAnswers(answer)
            return

        # Extract text from the answer
        output_text = ''
        json_data = None
        if answer.isJson():
            import json

            json_data = answer.getJson()
            # Strip reserved reference fields before scoring to prevent
            # the evaluator from grading text that contains the reference.
            eval_payload = json_data
            if isinstance(json_data, dict):
                eval_payload = {k: v for k, v in json_data.items() if k not in {'expected', 'context', 'reference'}}
            output_text = json.dumps(eval_payload) if eval_payload is not None else ''
        else:
            output_text = answer.getText() or ''

        # Try to extract expected text from answer metadata or context.
        # For LLM judge mode, expected can remain empty (judge evaluates
        # standalone quality). For similarity mode, a missing expected
        # value will produce a zero score.
        expected = ''
        if hasattr(answer, 'expected'):
            expected = answer.expected or ''
        elif hasattr(answer, 'metadata') and isinstance(getattr(answer, 'metadata', None), dict):
            expected = answer.metadata.get('expected', '')
        elif hasattr(answer, 'context') and isinstance(getattr(answer, 'context', None), str):
            expected = answer.context
        elif isinstance(json_data, dict):
            expected = json_data.get('expected', '') or json_data.get('context', '')

        if not expected and evaluator._eval_type == 'similarity':
            debug('Cobalt evaluator: no expected text found for similarity mode; score will be 0')

        result = evaluator.evaluate(output_text, expected)

        debug(f'Cobalt evaluation: score={result["score"]:.3f} passed={result["passed"]} evaluator={result["evaluator"]}')

        # Forward the original answer unchanged
        self.instance.writeAnswers(answer)

        # Emit evaluation result as a separate JSON answer
        eval_answer = Answer(expectJson=True)
        eval_answer.setAnswer(
            {
                'cobalt_score': result['score'],
                'cobalt_passed': result['passed'],
                'cobalt_evaluator': result['evaluator'],
                'cobalt_reasoning': result.get('reasoning', ''),
            }
        )
        self.instance.writeAnswers(eval_answer)
