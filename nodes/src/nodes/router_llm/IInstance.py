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

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the router node.
# It receives incoming questions, runs them through the ModelRouter to
# determine optimal model selection, attaches routing metadata, and
# forwards the question downstream.
# ------------------------------------------------------------------------------

import copy

from rocketlib import IInstanceBase, Entry
from ai.common.schema import Question
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, obj: Entry):
        """Initialize state for a new object."""
        pass

    def writeQuestions(self, question: Question):
        """Route an incoming question through the model router.

        Deep copies the question to avoid mutating the original, attaches
        routing metadata, then forwards the annotated question downstream.
        """
        # Deep copy to prevent mutation of the original question object
        routed_question = copy.deepcopy(question)

        # Extract the question text for routing analysis
        question_text = ''
        if hasattr(routed_question, 'questions') and routed_question.questions:
            first = routed_question.questions[0]
            if hasattr(first, 'text'):
                question_text = first.text
            else:
                question_text = str(first)
        elif hasattr(routed_question, 'getPrompt'):
            question_text = routed_question.getPrompt()

        # Run the router to select the optimal model
        routing_decision = self.IGlobal.router.select_model(question_text)

        # Attach routing metadata to the question
        if not hasattr(routed_question, 'metadata') or routed_question.metadata is None:
            routed_question.metadata = {}
        routed_question.metadata['routing'] = routing_decision

        # Forward the annotated question downstream
        self.instance.writeQuestions(routed_question)
