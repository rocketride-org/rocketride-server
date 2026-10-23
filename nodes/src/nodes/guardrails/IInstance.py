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
from .nonce_fencer import SecurityError

NONCE_FENCE_INSTRUCTION_TITLE = 'Security Directive'


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
        """Run input guardrails and forward an accepted question."""
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_question(question)
            return

        text_parts = []
        if question.questions:
            text_parts.extend(q.text for q in question.questions)
        if question.context:
            text_parts.extend(question.context)
        full_text = ' '.join(text_parts)

        if not full_text.strip():
            self._forward_question(question)
            return

        result = engine.evaluate(full_text, mode='input')
        if result['action'] == 'block':
            for violation in result['violations']:
                warning(f'Guardrails input blocked: {violation["rule"]} — {violation["details"]}')
            self.preventDefault()
            return

        if result['action'] == 'warn':
            for violation in result['violations']:
                warning(f'Guardrails input warning: {violation["rule"]} — {violation["details"]}')

        if self.IGlobal.nonce_fencer is not None and not self._apply_nonce_fencing(question):
            self.preventDefault()
            return

        self._forward_question(question)

    def _apply_nonce_fencing(self, question: Question) -> bool:
        """Fence untrusted question data using one nonce for the whole cycle."""
        if question.instructions:
            warning('[Guardrails] Caller-supplied instructions are rejected when nonce fencing is enabled')
            return False

        fencer = self.IGlobal.nonce_fencer
        all_content = []
        if question.questions:
            all_content.extend(q.text for q in question.questions if q.text)
        if question.context:
            all_content.extend(str(ctx) for ctx in question.context if ctx)

        try:
            nonce = fencer.new_cycle(exclude='\n'.join(all_content))
            if question.questions:
                for item in question.questions:
                    if item.text:
                        item.text = fencer.fence(item.text, nonce)
            if question.context:
                question.context = [fencer.fence(str(ctx), nonce) for ctx in question.context]
            question.addInstruction(
                NONCE_FENCE_INSTRUCTION_TITLE,
                fencer.build_system_addendum(nonce),
            )
        except SecurityError as exc:
            warning(f'[Guardrails] Nonce fencing failed: {exc}; blocking question')
            return False
        return True

    def _forward_question(self, question: Question):
        """Forward a question downstream exactly once."""
        self.instance.writeQuestions(question)
        self.preventDefault()

    def writeAnswers(self, answer: Answer):
        """Run output guardrails on the answer before forwarding."""
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_answer(answer)
            return

        text = answer.getText() if answer else ''
        if not text.strip():
            self._forward_answer(answer)
            return

        result = engine.evaluate(
            text,
            mode='output',
            context={'source_documents': self.source_documents},
        )
        if result['action'] == 'block':
            for violation in result['violations']:
                warning(f'Guardrails output blocked: {violation["rule"]} — {violation["details"]}')
            self.preventDefault()
            return

        if result['action'] == 'warn':
            for violation in result['violations']:
                warning(f'Guardrails output warning: {violation["rule"]} — {violation["details"]}')

        self._forward_answer(answer)

    def _forward_answer(self, answer: Answer):
        """Forward an answer downstream exactly once."""
        self.instance.writeAnswers(answer)
        self.preventDefault()

    def writeDocuments(self, documents):
        """Collect source documents and forward them downstream."""
        for doc in documents:
            if hasattr(doc, 'page_content'):
                content = doc.page_content
            elif isinstance(doc, dict):
                content = doc.get('page_content')
            else:
                content = doc
            if content and str(content).strip():
                self.source_documents.append(str(content))

        self.instance.writeDocuments(documents)
        self.preventDefault()

    def close(self):
        """Reset state on close."""
        self.source_documents = []
