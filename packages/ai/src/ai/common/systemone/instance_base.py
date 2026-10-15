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
"""Engine glue for System One nodes: one model call per item, decisions recorded on the object (spec §4).

Standalone: it owns the lanes, asks ``IGlobal.runner`` about each item and records the
answers with ``IInstanceBase.recordDecision``.
"""

from __future__ import annotations

from typing import List

from rocketlib import IInstanceBase, warning
from rocketlib.decisions import component_id, preview

from ai.common.schema import Answer, Doc, DocMetadata, Question

TEXT_DOC_TYPES = frozenset({'Document', 'Text'})
NOT_TEXT = 'System One reads text; convert this content to text first (e.g. OCR or caption)'


def _size_text(size: dict) -> str:
    if 'bytes' in size:
        text = f'{size["bytes"]} bytes, limit {size["limit"]}'
    elif 'tokens' in size:
        text = f'about {size["tokens"]} tokens, limit {size["limit"]}'
    else:
        text = ', '.join(f'{key} {value}' for key, value in size.items())
    return text + (' (rejected by the backend)' if size.get('rejected_by') == 'backend' else '')


class SystemOneInstanceBase(IInstanceBase):
    """Shared IInstance for every System One vendor node: decides each item on every text-based lane."""

    _text: list | None = None
    _text_failed: bool = False

    # ---- helpers --------------------------------------------------------------------------
    def _record(self, answers=None, **kwargs) -> int:
        runner = self.IGlobal.runner
        return self.recordDecision(runner.questions, answers, model=runner.model, **kwargs)

    def _decide(self, state):
        """Ask the runner about one item; the outcome has ``size`` when too long, else ``answers``/``usage``."""
        return self.IGlobal.runner.decide(state, source=component_id(self))

    def _too_long(self, lane: str, preview_text: str, size: dict) -> None:
        warning(
            f'{component_id(self)}: {lane} item too long for the model ({_size_text(size)}); '
            f'recorded as too_long, so every gate blocks it: "{preview_text}"'
        )

    def _too_long_error(self, lane: str, size: dict) -> ValueError:
        return ValueError(
            f'{component_id(self)}: the {lane} input is too long for the model ({_size_text(size)}). '
            'System One never decides on part of an input; split it first '
            '(e.g. a preprocessor, then a System One node on the documents lane).'
        )

    def _document_state(self, doc):
        """Reject non-text or empty documents; return the runner's state for the rest."""
        source = component_id(self)
        if doc.type not in TEXT_DOC_TYPES:
            raise ValueError(f'{source}: document type "{doc.type}": {NOT_TEXT}')
        if not doc.page_content or not doc.page_content.strip():
            chunk = getattr(doc.metadata, 'chunkId', None) if doc.metadata is not None else None
            raise ValueError(f'{source}: a document (chunkId {chunk}) has no text to decide on')
        metadata = doc.metadata.model_dump() if doc.metadata is not None else None
        return self.IGlobal.runner.state(doc.page_content, metadata)

    def _question_state(self, question):
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
                f'{component_id(self)}: question input truncated to fit the model ({_size_text(size)}); '
                'dropped oldest history first, then the last documents'
            )
        return fitted, size

    def _decide_whole(self, lane: str, preview_text: str, state, truncated_size: dict | None = None) -> None:
        outcome = self._decide(state)
        if outcome.size is not None:
            raise self._too_long_error(lane, outcome.size)
        self._record(
            outcome.answers,
            lane=lane,
            preview=preview_text,
            usage=outcome.usage,
            size=truncated_size,
            truncated=truncated_size is not None,
        )

    # ---- lanes ----------------------------------------------------------------------------
    def open(self, obj):
        """Start a new object with an empty text buffer."""
        self._text = None
        self._text_failed = False

    def writeDocuments(self, documents: List[Doc]):
        """Check every document first, decide each, then forward the stamped copies once."""
        states = []
        for doc in documents:
            state = self._document_state(doc)
            states.append((state, self.IGlobal.runner.oversize(state)))
        forwarded = []
        for doc, (state, size) in zip(documents, states):
            copy = doc.model_copy(deep=True)
            if copy.metadata is None:
                copy.metadata = DocMetadata(self, chunkId=0)
            outcome = None if size is not None else self._decide(state)
            if outcome is not None:
                size = outcome.size
            if size is not None:
                self._too_long('documents', preview(doc.page_content), size)
                self._record(status='too_long', doc=copy, size=size)
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
        outcome = self._decide(table)
        if outcome.size is not None:
            self._too_long('table', preview(table), outcome.size)
            self._record(status='too_long', table=table, size=outcome.size)
        else:
            self._record(outcome.answers, table=table, usage=outcome.usage)

    def writeText(self, text: str):
        """Buffer the object's text; nothing goes downstream until ``closing`` has decided."""
        if self._text is None:
            self._text = []
        self._text.append(text)
        size = self.IGlobal.runner.oversize(''.join(self._text))
        if size is not None:
            # The engine still calls closing() for this failed object; closing() must not decide again.
            self._text_failed = True
            raise self._too_long_error('text', size)
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
        state, size = self._question_state(question)
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
