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

import copy

from rocketlib import IInstanceBase
from ai.common.schema import Question, Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _build_data(self, text: str, metadata: dict = None, score: float = 0.0) -> dict:
        """Build a data dict suitable for the branch engine."""
        return {
            'text': text or '',
            'metadata': metadata if metadata is not None else {},
            'score': score,
        }

    def _route_question(self, question: Question) -> None:
        """Evaluate branch conditions against a question and route to the matched output lane."""
        engine = self.IGlobal.engine

        # Extract text from the question for condition evaluation
        text = question.getPrompt() if hasattr(question, 'getPrompt') else str(question)
        metadata = question.model_dump() if hasattr(question, 'model_dump') else {}

        data = self._build_data(text, metadata)
        lane = engine.route(data)

        # Deep copy to prevent mutation across branches
        routed = copy.deepcopy(question)

        if lane == 'answers':
            # Convert question to an answer and route to the answers lane
            answer = Answer()
            answer.setText(text)
            self.instance.writeAnswers(answer)
        else:
            # Default: route to the questions lane
            self.instance.writeQuestions(routed)

    def _route_answer(self, answer: Answer) -> None:
        """Evaluate branch conditions against an answer and route to the matched output lane."""
        engine = self.IGlobal.engine

        # Extract text from the answer for condition evaluation
        text = answer.getText() if hasattr(answer, 'getText') else str(answer)
        metadata = answer.model_dump() if hasattr(answer, 'model_dump') else {}

        data = self._build_data(text, metadata)
        lane = engine.route(data)

        # Deep copy to prevent mutation across branches
        routed = copy.deepcopy(answer)

        if lane == 'questions':
            # Convert answer to a question and route to the questions lane
            question = Question()
            question.addQuestion(text)
            self.instance.writeQuestions(question)
        else:
            # Default: route to the answers lane
            self.instance.writeAnswers(routed)

    def writeQuestions(self, question: Question) -> None:
        """Evaluate branch conditions against question text/metadata and route to matched output lane."""
        self._route_question(question)

    def writeAnswers(self, answer: Answer) -> None:
        """Evaluate branch conditions against answer text/metadata and route to matched output lane."""
        self._route_answer(answer)
