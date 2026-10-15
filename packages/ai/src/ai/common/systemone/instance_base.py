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
"""Engine glue for System One nodes: one model call per item, decisions recorded on the object (spec §4)."""

from __future__ import annotations

from rocketlib import warning

from rocketlib.decisions import component_id
from ai.common.decision.writer import Decided, DecisionWriterBase, TooLong

TEXT_DOC_TYPES = frozenset({'Document', 'Text'})
NOT_TEXT = 'System One reads text; convert this content to text first (e.g. OCR or caption)'


class SystemOneInstanceBase(DecisionWriterBase):
    """Shared IInstance for every System One vendor node: the runner decides, the base does the lanes."""

    def questions(self) -> dict:
        """Return the runner's questions header."""
        return self.IGlobal.runner.questions

    def model(self) -> str | None:
        """Return the runner's model name."""
        return self.IGlobal.runner.model

    def oversize(self, state) -> dict | None:
        """Return the measured size when ``state`` exceeds the model's limits."""
        return self.IGlobal.runner.oversize(state)

    def decide(self, state, lane: str):
        """Ask the runner about one item; map its outcome onto the base's result types."""
        outcome = self.IGlobal.runner.decide(state, source=component_id(self))
        if outcome.size is not None:
            return TooLong(outcome.size)
        return Decided(outcome.answers, outcome.usage)

    def document_state(self, doc):
        """Reject non-text or empty documents; return the runner's state for the rest."""
        source = component_id(self)
        if doc.type not in TEXT_DOC_TYPES:
            raise ValueError(f'{source}: document type "{doc.type}": {NOT_TEXT}')
        if not doc.page_content or not doc.page_content.strip():
            chunk = getattr(doc.metadata, 'chunkId', None) if doc.metadata is not None else None
            raise ValueError(f'{source}: a document (chunkId {chunk}) has no text to decide on')
        metadata = doc.metadata.model_dump() if doc.metadata is not None else None
        return self.IGlobal.runner.state(doc.page_content, metadata)

    def question_state(self, question):
        """Build the question state (history and documents dropped to fit, with a warning)."""
        state = {
            'question': '\n'.join(q.text for q in question.questions or [] if q.text),
            'history': [{'role': h.role, 'content': h.content} for h in question.history or []],
            'context': [str(c) for c in question.context or []],
            'documents': [d.page_content or '' for d in question.documents or []],
        }
        if not state['question'].strip():
            raise ValueError(f'{component_id(self)}: the question has no text to decide on')
        try:
            fitted, size = self.IGlobal.runner.fit_question(state)
        except ValueError as exc:
            raise ValueError(f'{component_id(self)}: {exc}') from exc
        if size is not None:
            warning(
                f'{component_id(self)}: question input truncated to fit the model ({self.size_text(size)}); '
                'dropped oldest history first, then the last documents'
            )
        return fitted, size

    def too_long_message(self, lane: str, size: dict) -> str:
        """The error for a whole-object input that does not fit the model."""
        return (
            f'{component_id(self)}: the {lane} input is too long for the model ({self.size_text(size)}). '
            'System One never decides on part of an input; split it first '
            '(e.g. a preprocessor, then a System One node on the documents lane).'
        )
