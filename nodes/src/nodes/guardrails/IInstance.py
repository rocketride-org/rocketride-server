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

import json

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Question, Answer
from .IGlobal import IGlobal


def _turn_input(question: Question) -> list:
    """Return the text a turn-mode Question adds: its last user message's text and tool results.

    The rest of `messages` is history, which the legacy path does not check either: the
    input-length and topic rules would trip on a long conversation, and each earlier user
    message was the last one on the turn that sent it.
    """
    if not question.messages:
        return []
    content = question.messages[-1].content
    if isinstance(content, str):
        return [content]
    return [block.text if block.type == 'text' else block.content for block in content]


def _turn_output(answer: Answer) -> str:
    """Return the arguments of a turn's tool calls as one text, or '' when it made none.

    They leave through the client like answer text does, and a turn that stops to
    call a tool usually has no text, so the text check alone never sees them.
    """
    calls = answer.toolCalls() if answer is not None else []
    text = '\n'.join(
        call.args if isinstance(call.args, str) else json.dumps(call.args, ensure_ascii=False) for call in calls
    )
    # JSON writes a line break as backslash-n, which hides the word boundary the patterns need
    return text.replace('\\n', ' ').replace('\\r', ' ').replace('\\t', ' ')


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
        either blocks, warns (logs + forwards), or passes (forwards
        silently) depending on the policy mode.

        Args:
            question: The incoming Question object.
        """
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_question(question)
            return

        # Collect question text for evaluation: the turn's new input, not the whole history
        text_parts = _turn_input(question)
        if question.questions:
            text_parts.extend(q.text for q in question.questions)
        if question.context:
            text_parts.extend(question.context)

        full_text = ' '.join(text_parts)

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

        Runs output-mode evaluation on the answer text, with any collected
        source documents as context, and tool-call evaluation on the
        arguments of a turn's tool calls, then applies the configured policy.

        Args:
            answer: The incoming Answer object.
        """
        engine = self.IGlobal.engine
        if engine is None:
            self._forward_answer(answer)
            return

        results = []
        text = answer.getText() if answer else ''
        if text.strip():
            results.append(engine.evaluate(text, mode='output', context={'source_documents': self.source_documents}))
        calls = _turn_output(answer)
        if calls:
            results.append(engine.evaluate(calls, mode='tool_call'))

        # With nothing to check, both are empty and the answer goes on as-is
        violations = [violation for result in results for violation in result['violations']]
        actions = {result['action'] for result in results}

        if 'block' in actions:
            for violation in violations:
                warning(f'Guardrails output blocked: {violation["rule"]} \u2014 {violation["details"]}')
            self.preventDefault()
            return

        if 'warn' in actions:
            for violation in violations:
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
