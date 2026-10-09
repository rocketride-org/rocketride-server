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

from ai.common.decision import DecisionError, NotDecided, evaluate, fingerprint, preview, resolve, snapshot

from .IGlobal import IGlobal


def _refs(doc) -> dict | None:
    refs = getattr(doc.metadata, 'decision_refs', None) if doc.metadata is not None else None
    return dict(refs) if isinstance(refs, dict) else None


class IInstance(IInstanceBase):
    """Filters data writes; open, closing and close always continue."""

    IGlobal: IGlobal

    def _passes(self, decisions, lane: str, text, *, refs=None, table_key=None) -> bool:
        """Resolve every question the rule reads, then evaluate it; a non-ok item always blocks."""
        rule = self.IGlobal.rule
        answers = {}
        for question in rule.questions:
            found = resolve(decisions, lane, question, refs=refs, table_key=table_key)
            if found is None:
                raise DecisionError(
                    f'Gate: no decision for "{question}" on the {lane} lane (item: "{preview(text)}"). '
                    f'Put the Gate downstream of the node that answers "{question}", on the same path.'
                )
            if isinstance(found, NotDecided):
                warning(
                    f'Gate: blocked a {lane} item ("{preview(text)}"): {found.group} recorded "{found.status}" for it'
                )
                return False
            answers[question] = found
        return evaluate(rule, answers)

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
        """Forward only the documents whose decision passes, as one list."""
        decisions = snapshot(self.instance.currentObject.response)
        passed = [d for d in documents if self._passes(decisions, 'documents', d.page_content, refs=_refs(d))]
        if passed:
            self.instance.writeDocuments(passed)
        return self.preventDefault()
