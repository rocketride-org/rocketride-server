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

"""Gate: pass or block each item on its wire by the decisions recorded on the object (spec §7.2)."""

from __future__ import annotations

from rocketlib import IInstanceBase, warning

from ai.common.decision import (
    DecisionError,
    NotDecided,
    check_values,
    evaluate,
    fingerprint,
    preview,
    resolve_hit,
    snapshot,
)

from .IGlobal import IGlobal


def _refs(doc) -> dict | None:
    refs = getattr(doc.metadata, 'decision_refs', None) if doc.metadata is not None else None
    return dict(refs) if isinstance(refs, dict) else None


_MEDIA_LANES = ('image', 'audio', 'video')


def _missing_message(question: str, lane: str, text) -> str:
    """Explain a missing decision; the media lanes get the text-only-writer hint."""
    head = f'Gate: no decision for "{question}" on the {lane} lane (item: "{preview(text)}"). '
    if lane in _MEDIA_LANES:
        return (
            head + f'No decision was recorded for this object before this {lane} item arrived '
            "(System One decides on text lanes only; text decisions are made when the object's text ends)."
        )
    return head + f'Put the Gate downstream of the node that answers "{question}", on the same path.'


class IInstance(IInstanceBase):
    """Filters data writes; open, closing and close always continue.

    The documents lane returns normally when every document passes; otherwise it forwards the passing subset (if any)
    and prevents the default.
    """

    IGlobal: IGlobal
    # (condition number, group) pairs whose values already passed; replaced, never mutated, so the class default is safe.
    _values_checked: frozenset = frozenset()

    def _passes(self, decisions, lane: str, text, *, refs=None, table_key=None) -> bool:
        """Resolve every question the rule reads, check its values, then evaluate; a non-ok item always blocks."""
        rule = self.IGlobal.rule
        answers = {}
        for question in rule.questions:
            hit = resolve_hit(decisions, lane, question, refs=refs, table_key=table_key)
            if hit is None:
                raise DecisionError(_missing_message(question, lane, text))
            group, found = hit
            self._check_values(decisions, group, question)
            answers[question] = found
        # A missing decision is a wiring error and must surface even when another question blocks the item first.
        undecided = [
            f'{found.group} recorded "{found.status}"' for found in answers.values() if isinstance(found, NotDecided)
        ]
        if undecided:
            warning(f'Gate: blocked a {lane} item ("{preview(text)}"): {"; ".join(undecided)} for it')
            return False
        return evaluate(rule, answers)

    def _check_values(self, decisions, group: str, question: str) -> None:
        """Raise when a condition value is not an answer the group can record; remember only the pairs that passed.

        A failed check is never remembered, so every later item on this (pooled) instance raises again.
        """
        header = ((decisions or {}).get(group) or {}).get('questions', {}).get(question, {})
        for number, condition in enumerate(self.IGlobal.rule.conditions):
            if condition.question != question or (number, group) in self._values_checked:
                continue
            message = check_values(condition, header, group=group)
            if message:
                raise DecisionError(message)
            self._values_checked = self._values_checked | {(number, group)}

    def _gate(self, lane: str, text, **keys):
        if not self._passes(snapshot(self.instance.currentObject.response), lane, text, **keys):
            return self.preventDefault()

    def writeText(self, text: str):
        """Pass or block the text by the object-level decision."""
        return self._gate('text', text)

    def writeTable(self, table: str):
        """Pass or block the table by its fingerprint, else the object-level decision."""
        return self._gate('table', table, table_key=fingerprint(table))

    def writeJson(self, data):
        """Pass or block JSON by the object-level decision."""
        return self._gate('json', str(data))

    def writeQuestions(self, question):
        """Pass or block the question by the object-level decision."""
        return self._gate('questions', ' '.join(q.text for q in question.questions or []))

    def writeAnswers(self, answer):
        """Pass or block the answer by the object-level decision."""
        return self._gate('answers', answer.getText())

    def writeImage(self, action, mimeType, buffer):
        """Pass or block every stream call by the object-level decision."""
        return self._gate('image', mimeType)

    def writeAudio(self, action, mimeType, buffer):
        """Pass or block every stream call by the object-level decision."""
        return self._gate('audio', mimeType)

    def writeVideo(self, action, mimeType, buffer):
        """Pass or block every stream call by the object-level decision."""
        return self._gate('video', mimeType)

    def writeDocuments(self, documents):
        """Pass every document by its decision: all pass -> return normally; else forward the passing ones, if any."""
        decisions = snapshot(self.instance.currentObject.response)
        passed = [d for d in documents if self._passes(decisions, 'documents', d.page_content, refs=_refs(d))]
        if len(passed) == len(documents):
            return None  # the engine forwards the original list
        if passed:
            self.instance.writeDocuments(passed)
        return self.preventDefault()
