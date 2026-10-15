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
"""DecisionWriterBase: lane plumbing for nodes whose only job is to decide (spec A2 §4.2).

A subclass implements ``questions()`` and ``decide(state, lane)``. Optional hooks let a
writer shape per-lane state and limits without touching the lanes themselves.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from rocketlib import IInstanceBase, warning

from ai.common.schema import Answer, Doc, DocMetadata, Question

from rocketlib.decisions import component_id, preview


@dataclass
class Decided:
    """The answers for one item, plus optional usage numbers that add up across writes."""

    answers: dict
    usage: dict | None = None


@dataclass
class TooLong:
    """The item is over the writer's limits; ``size`` says by how much."""

    size: dict


def _size_text(size: dict) -> str:
    if 'bytes' in size:
        text = f'{size["bytes"]} bytes, limit {size["limit"]}'
    elif 'tokens' in size:
        text = f'about {size["tokens"]} tokens, limit {size["limit"]}'
    else:
        text = ', '.join(f'{key} {value}' for key, value in size.items())
    return text + (' (rejected by the backend)' if size.get('rejected_by') == 'backend' else '')


class DecisionWriterBase(IInstanceBase):
    """Records a decision per item on every text-based lane; subclasses only decide."""

    _text: list | None = None
    _text_failed: bool = False

    # ---- required -------------------------------------------------------------------------
    def questions(self) -> dict:
        """Return the questions header: ``{name: {'kind': ..., 'values': [...]?, ...}}``."""
        raise NotImplementedError

    def decide(self, state, lane: str) -> Decided | TooLong:
        """Decide one item; raise for any failure other than "too long" (it stops the object)."""
        raise NotImplementedError

    # ---- optional hooks -------------------------------------------------------------------
    def model(self) -> str | None:
        """Return the model name recorded on the group, if any."""
        return None

    def oversize(self, state) -> dict | None:
        """Return the measured size when ``state`` is over the writer's limits (checked before deciding)."""
        return None

    def document_state(self, doc):
        """Return the state to decide on for one document; raise ValueError to reject it."""
        return doc.page_content

    def question_state(self, question) -> tuple[object, dict | None]:
        """Return ``(state, truncated_size_or_None)`` for a question; raise ValueError to reject it."""
        text = '\n'.join(q.text for q in question.questions or [] if q.text)
        if not text.strip():
            raise ValueError(f'{component_id(self)}: the question has no text to decide on')
        return text, None

    def size_text(self, size: dict) -> str:
        """Describe ``size`` for messages."""
        return _size_text(size)

    def too_long_message(self, lane: str, size: dict) -> str:
        """The error for a whole-object input (text, question, answer) that is too long."""
        return f'{component_id(self)}: the {lane} input is too long ({self.size_text(size)}).'

    # ---- lanes ----------------------------------------------------------------------------
    def open(self, obj):
        """Start a new object with an empty text buffer."""
        self._text = None
        self._text_failed = False

    def _record(self, answers=None, **kwargs) -> int:
        return self.recordDecision(self.questions(), answers, model=self.model(), **kwargs)

    def _too_long(self, lane: str, preview_text: str, size: dict) -> None:
        warning(
            f'{component_id(self)}: {lane} item too long for the model ({self.size_text(size)}); '
            f'recorded as too_long, so every gate blocks it: "{preview_text}"'
        )

    def writeDocuments(self, documents: List[Doc]):
        """Check every document first, decide each, then forward the stamped copies once."""
        states = []
        for doc in documents:
            state = self.document_state(doc)
            states.append((state, self.oversize(state)))
        forwarded = []
        for doc, (state, size) in zip(documents, states):
            copy = doc.model_copy(deep=True)
            if copy.metadata is None:
                copy.metadata = DocMetadata(self, chunkId=0)
            outcome = TooLong(size) if size is not None else self.decide(state, 'documents')
            if isinstance(outcome, TooLong):
                self._too_long('documents', preview(doc.page_content), outcome.size)
                self._record(status='too_long', doc=copy, size=outcome.size)
            else:
                self._record(outcome.answers, doc=copy, usage=outcome.usage)
            forwarded.append(copy)
        self.instance.writeDocuments(forwarded)
        # Without this the engine also forwards the original, unstamped documents.
        return self.preventDefault()

    def writeTable(self, table: str):
        """Decide one table and record it under its fingerprint; the table is forwarded unchanged."""
        if not table or not table.strip():
            raise ValueError(f'{component_id(self)}: a table has no content to decide on')
        outcome = self.decide(table, 'table')
        if isinstance(outcome, TooLong):
            self._too_long('table', preview(table), outcome.size)
            self._record(status='too_long', table=table, size=outcome.size)
        else:
            self._record(outcome.answers, table=table, usage=outcome.usage)

    def _decide_whole(self, lane: str, preview_text: str, state, truncated_size: dict | None = None) -> None:
        outcome = self.decide(state, lane)
        if isinstance(outcome, TooLong):
            raise ValueError(self.too_long_message(lane, outcome.size))
        self._record(
            outcome.answers,
            lane=lane,
            preview=preview_text,
            usage=outcome.usage,
            size=truncated_size,
            truncated=truncated_size is not None,
        )

    def writeText(self, text: str):
        """Buffer the object's text; nothing goes downstream until ``closing`` has decided."""
        if self._text is None:
            self._text = []
        self._text.append(text)
        size = self.oversize(''.join(self._text))
        if size is not None:
            # The engine still calls closing() for this failed object; closing() must not decide again.
            self._text_failed = True
            raise ValueError(self.too_long_message('text', size))
        return self.preventDefault()

    def closing(self):
        """Decide on the whole text, record it, then replay the buffered text downstream in order.

        Works because the engine binds ``closing`` upstream-first in topological order, so the
        replayed text reaches consumers that have not flushed yet (``endpoint.pipes.cpp``).
        """
        if self._text is None:
            return
        if self._text_failed:
            self._text = None
            return
        buffered, self._text = self._text, None
        content = ''.join(buffered)
        if not content.strip():
            raise ValueError(f"{component_id(self)}: no text to decide on (the object's text is empty)")
        self._decide_whole('text', preview(content), content)
        for text in buffered:
            self.instance.writeText(text)

    def writeQuestions(self, question: Question):
        """Decide on the question; forward it unchanged."""
        text = '\n'.join(q.text for q in question.questions or [] if q.text)
        state, size = self.question_state(question)
        self._decide_whole('questions', preview(text), state, size)

    def writeAnswers(self, answer: Answer):
        """Decide on one answer (JSON when it is JSON, else its text); forward it unchanged."""
        text = answer.getText()
        state = text
        if answer.isJson():
            try:
                state = answer.getJson()
            except (ValueError, TypeError):
                pass  # flagged JSON but not parseable: decide on its text
        if not text.strip() or state in (None, {}, []):
            raise ValueError(f'{component_id(self)}: the answer is empty; nothing to decide on')
        self._decide_whole('answers', preview(text), state)
