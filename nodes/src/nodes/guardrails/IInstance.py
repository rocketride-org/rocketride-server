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
import logging

from rocketlib import IInstanceBase, Entry
from ai.common.schema import Question, Answer
from .IGlobal import IGlobal
from .guardrails_engine import GuardrailsViolation

logger = logging.getLogger(__name__)


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialize the guardrails instance state."""
        super().__init__()
        self.source_documents = []

    def open(self, entry: Entry):
        """Reset per-object state."""
        self.source_documents = []

    def writeQuestions(self, question: Question):
        """Run input guardrails on the question before forwarding.

        Extracts the question text, runs input-mode evaluation, then
        either blocks (raises), warns (logs + forwards), or passes
        (forwards silently) depending on the policy mode.

        Args:
            question: The incoming Question object.
        """
        engine = self.IGlobal.engine

        # Deep copy to prevent mutation of the original
        question = copy.deepcopy(question)

        # Collect question text for evaluation
        text_parts = []
        if question.questions:
            for q in question.questions:
                text_parts.append(q.text)
        if question.context:
            for ctx in question.context:
                text_parts.append(ctx)

        full_text = ' '.join(text_parts)

        if not full_text.strip():
            # Nothing to check, forward as-is
            self.instance.writeQuestions(question)
            return

        # Run input guardrails
        result = engine.evaluate(full_text, mode='input')

        # Attach guardrails metadata to the question
        question.addContext(f'[guardrails:input] passed={result["passed"]}, action={result["action"]}, violations={len(result["violations"])}')

        if result['action'] == 'block':
            raise GuardrailsViolation(result['violations'])

        if result['action'] == 'warn':
            for violation in result['violations']:
                logger.warning('Guardrails input warning: %s — %s', violation['rule'], violation['details'])

        # Forward the question downstream
        self.instance.writeQuestions(question)

    def writeAnswers(self, answer: Answer):
        """Run output guardrails on the answer before forwarding.

        Extracts the answer text, runs output-mode evaluation with
        any collected source documents as context, then applies the
        configured policy.

        Args:
            answer: The incoming Answer object.
        """
        engine = self.IGlobal.engine

        # Deep copy to prevent mutation of the original
        answer = copy.deepcopy(answer)

        # Extract answer text
        text = answer.getText() if answer else ''

        if not text.strip():
            # Nothing to check, forward as-is
            self.instance.writeAnswers(answer)
            return

        # Build context for output checks
        context = {
            'source_documents': self.source_documents,
        }

        # Run output guardrails
        result = engine.evaluate(text, mode='output', context=context)

        if result['action'] == 'block':
            raise GuardrailsViolation(result['violations'])

        if result['action'] == 'warn':
            for violation in result['violations']:
                logger.warning('Guardrails output warning: %s — %s', violation['rule'], violation['details'])

        # Forward the answer downstream
        self.instance.writeAnswers(answer)

    def writeDocuments(self, documents):
        """Collect source documents for hallucination checks.

        Documents received here are stored and used as ground-truth
        context when checking answers for hallucination.

        Args:
            documents: List of Doc objects from the pipeline.
        """
        for doc in documents:
            if hasattr(doc, 'page_content'):
                self.source_documents.append(str(doc.page_content))
            elif isinstance(doc, dict) and 'page_content' in doc:
                self.source_documents.append(str(doc['page_content']))
            elif isinstance(doc, str):
                self.source_documents.append(doc)

        # Forward documents downstream
        self.instance.writeDocuments(documents)

    def close(self):
        """Reset state on close."""
        self.source_documents = []
