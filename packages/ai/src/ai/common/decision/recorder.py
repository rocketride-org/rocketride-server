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
"""DecisionRecorder: the plug-in for existing nodes (spec A2 §4.1).

Build one per object in ``open()`` and call it where the node already makes its judgement.
It hides the contract: group id, writer, questions header, stamping and fingerprints.
Pure: no engine imports.
"""

from __future__ import annotations

from .contract import DecisionError, check_questions, fingerprint, preview, record, stamp


def component_id(node) -> str:
    """Return the node's component id (e.g. ``decision_ollama_1``), falling back to its logical type."""
    pipe_type = getattr(getattr(node, 'instance', None), 'pipeType', None)
    cid = pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')
    return str(cid or getattr(getattr(getattr(node, 'IGlobal', None), 'glb', None), 'logicalType', 'decision'))


class DecisionRecorder:
    """Records one node's decisions on ``node.instance.currentObject.response``."""

    def __init__(self, node, questions: dict, *, model: str | None = None):
        """Bind to ``node`` with its questions header (checked now) and optional model name."""
        check_questions(questions)
        self._node = node
        self.questions = questions
        self.model = model
        self._tables = 0

    @property
    def group_id(self) -> str:
        """The node's component id, read at use so a pipe id that settles after ``open()`` still counts."""
        return component_id(self._node)

    @property
    def writer(self) -> str:
        """The writer node type (its logical type), falling back to the group id."""
        logical = getattr(getattr(getattr(self._node, 'IGlobal', None), 'glb', None), 'logicalType', None)
        return str(logical or self.group_id)

    def _record(self, item: dict, usage: dict | None = None) -> int:
        return record(
            self._node.instance.currentObject.response,
            self.group_id,
            writer=self.writer,
            questions=self.questions,
            item=item,
            model=self.model,
            usage=usage,
        )

    @staticmethod
    def _base(lane: str, status: str, preview_text: str | None, extra: dict | None) -> dict:
        item = {'lane': lane, 'status': status}
        if preview_text is not None:
            item['preview'] = preview_text
        item.update(extra or {})
        return item

    def _document_item(self, doc, status: str) -> dict:
        if getattr(doc, 'metadata', None) is None:
            raise DecisionError('a document needs metadata to carry its decision_refs; give it metadata first')
        item = self._base('documents', status, preview(doc.page_content), None)
        item['item'] = {'chunkId': doc.metadata.chunkId}
        return item

    def _table_item(self, table: str, status: str) -> dict:
        item = self._base('table', status, preview(table), None)
        item['item'] = {'table_index': self._tables, 'fingerprint': fingerprint(table)}
        self._tables += 1
        return item

    def record_object(self, lane, answers, *, preview=None, usage=None, extra=None) -> int:
        """Record one whole-object decision for ``lane`` (no ``item`` key); return its index."""
        item = self._base(lane, 'ok', preview, extra)
        item['answers'] = answers
        return self._record(item, usage)

    def record_document(self, doc, answers, *, usage=None) -> int:
        """Record a decision for one document and stamp ``doc.metadata.decision_refs``; return its index."""
        item = self._document_item(doc, 'ok')
        item['answers'] = answers
        index = self._record(item, usage)
        stamp(doc, self.group_id, index)
        return index

    def record_table(self, table, answers, *, usage=None) -> int:
        """Record a decision for one table, keyed by its fingerprint; return its index."""
        item = self._table_item(table, 'ok')
        item['answers'] = answers
        return self._record(item, usage)

    def record_status(self, lane, status, *, doc=None, table=None, preview=None, size=None, extra=None) -> int:
        """Record "no decision, and why" (e.g. ``too_long``), linked to ``doc`` or ``table`` when given."""
        if doc is not None:
            item = self._document_item(doc, status)
        elif table is not None:
            item = self._table_item(table, status)
        else:
            item = self._base(lane, status, preview, None)
        if size is not None:
            item['size'] = size
        item.update(extra or {})
        index = self._record(item)
        if doc is not None:
            stamp(doc, self.group_id, index)
        return index
