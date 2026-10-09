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

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Question, Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def __init__(self):
        """Initialize the guardrails instance state."""
        super().__init__()
        self.source_documents = []
        self.retrieval_ran = False
        self.question_text = ''

    def open(self, entry: Entry):
        """Reset per-object state."""
        self.source_documents = []
        self.retrieval_ran = False
        self.question_text = ''

    def writeQuestions(self, question: Question):
        """Run input guardrails on the question before forwarding.

        Extracts the question text, runs input-mode evaluation, then
        either blocks, warns (logs + forwards), or passes (forwards
        silently) depending on the policy mode.

        Args:
            question: The incoming Question object.
        """
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_question(question)
            return

        # Collect question text for evaluation
        text_parts = []
        if question.questions:
            text_parts.extend(q.text for q in question.questions)
        if question.context:
            text_parts.extend(question.context)

        full_text = ' '.join(text_parts)
        # Kept for the output pass: a figure the answer quotes back from the question
        # is a reference, not a claim the model invented.
        self.question_text = full_text

        if not full_text.strip():
            # Nothing to check, forward as-is
            self._forward_question(question)
            return

        # Run input guardrails
        result = engine.evaluate(full_text, mode='input')

        if result['action'] == 'block':
            for violation in result['violations']:
                warning(f'Guardrails input blocked: {violation["rule"]} \u2014 {violation["details"]}')
            self.preventDefault()
            return

        if result['action'] == 'warn':
            for violation in result['violations']:
                warning(f'Guardrails input warning: {violation["rule"]} \u2014 {violation["details"]}')

        # Forward the question downstream
        self._forward_question(question)

    def _forward_question(self, question: Question):
        """Forward a question downstream exactly once.

        `preventDefault()` raises immediately (it's implemented as `raise
        APERR(Ec.PreventDefault, ...)`), so it must come AFTER the explicit
        forward, not before -- otherwise the forward call below would never
        run at all. It must still be called, though: the engine always
        re-runs its own default forward after a Python override returns
        successfully unless preventDefault() was raised during the call, so
        skipping it here would deliver this question a second time.
        """
        self.instance.writeQuestions(question)
        self.preventDefault()

    def writeAnswers(self, answer: Answer):
        """Run output guardrails on the answer before forwarding.

        Extracts the answer text, runs output-mode evaluation with
        any collected source documents as context, then applies the
        configured policy.

        Args:
            answer: The incoming Answer object.
        """
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_answer(answer)
            return

        # Extract answer text
        text = answer.getText() if answer else ''

        if not text.strip():
            # Nothing to check, forward as-is
            self._forward_answer(answer)
            return

        # Build context for output checks. retrieval_ran separates "the store
        # searched and matched nothing" from "this pipeline has no documents lane
        # at all"; an empty source list alone cannot tell them apart, and failing
        # the second would drop correct answers from every non-retrieval pipeline.
        context = {
            'source_documents': self.source_documents,
            'retrieval_ran': self.retrieval_ran,
            'question_text': self.question_text,
        }

        # Run output guardrails
        result = engine.evaluate(text, mode='output', context=context)

        if result['action'] == 'block':
            for violation in result['violations']:
                warning(f'Guardrails output blocked: {violation["rule"]} \u2014 {violation["details"]}')
            self.preventDefault()
            return

        if result['action'] == 'warn':
            for violation in result['violations']:
                warning(f'Guardrails output warning: {violation["rule"]} \u2014 {violation["details"]}')

        # Forward the answer downstream
        self._forward_answer(answer)

    def _forward_answer(self, answer: Answer):
        """Forward an answer downstream exactly once. See `_forward_question`
        for why `preventDefault()` must come after the forward, not before.
        """
        self.instance.writeAnswers(answer)
        self.preventDefault()

    def writeDocuments(self, documents):
        """Collect source documents for hallucination checks.

        Documents received here are stored and used as ground-truth
        context when checking answers for hallucination.

        Args:
            documents: List of Doc objects from the pipeline.
        """
        # Set on dispatch, not on content: a hit whose documents carry no usable
        # text still means retrieval ran, and the loop below skips those.
        self.retrieval_ran = True

        for doc in documents:
            if hasattr(doc, 'page_content'):
                content = doc.page_content
            elif isinstance(doc, dict):
                content = doc.get('page_content')
            else:
                content = doc
            if content and str(content).strip():
                self.source_documents.append(str(content))

        # Forward documents downstream. See `_forward_question` for why
        # preventDefault() must come after the forward, not before -- it
        # still has to be called, or the engine double-delivers these too.
        self.instance.writeDocuments(documents)
        self.preventDefault()

    def close(self):
        """Reset state on close."""
        self.source_documents = []
        self.retrieval_ran = False
        self.question_text = ''
