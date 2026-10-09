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

from typing import List

from rocketlib import IInstanceBase, warning

from ai.common.decision import fingerprint, preview, record, stamp
from ai.common.schema import Doc, DocMetadata

TEXT_DOC_TYPES = frozenset({'Document', 'Text'})
NOT_TEXT = 'System One reads text; convert this content to text first (e.g. OCR or caption)'


def _size_text(size: dict) -> str:
    if 'bytes' in size:
        text = f'{size["bytes"]} bytes, limit {size["limit"]}'
    else:
        text = f'about {size["tokens"]} tokens, limit {size["limit"]}'
    return text + (' (rejected by the backend)' if size.get('rejected_by') == 'backend' else '')


class SystemOneInstanceBase(IInstanceBase):
    """Shared IInstance for every System One vendor node."""

    _tables: int = 0

    def _source_id(self) -> str:
        """Return the component id (e.g. ``decision_ollama_1``), falling back to the logical type."""
        pipe_type = getattr(self.instance, 'pipeType', None)
        component_id = pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')
        return str(component_id or getattr(getattr(self.IGlobal, 'glb', None), 'logicalType', 'decision'))

    def _record(self, item: dict, usage: dict | None) -> int:
        """Record one item in this node's group on the current object; return its index."""
        runner = self.IGlobal.runner
        return record(
            self.instance.currentObject.response,
            self._source_id(),
            writer=str(self.IGlobal.glb.logicalType),
            questions=runner.questions,
            item=item,
            model=runner.model,
            usage=usage,
        )

    def _too_long(self, item: dict, size: dict) -> dict:
        """Return ``item`` marked too long, and warn (spec §6.3)."""
        warning(
            f'{self._source_id()}: {item["lane"]} item too long for the model ({_size_text(size)}); '
            f'recorded as too_long, so every gate blocks it: "{item.get("preview", "")}"'
        )
        return {**item, 'status': 'too_long', 'size': size}

    def _decide_item(self, item: dict, state) -> tuple[dict, dict | None]:
        """Ask about one per-item input (document or table); too long is recorded, not raised."""
        outcome = self.IGlobal.runner.decide(state, source=self._source_id())
        if outcome.size is not None:
            return self._too_long(item, outcome.size), None
        return {**item, 'status': 'ok', 'answers': outcome.answers}, outcome.usage

    def open(self, obj):
        """Reset the per-object state."""
        self._tables = 0

    def writeDocuments(self, documents: List[Doc]):
        """Pre-check the list, decide each document, then forward stamped copies once (spec §4.2)."""
        runner = self.IGlobal.runner
        source = self._source_id()
        states = []
        for doc in documents:
            if doc.type not in TEXT_DOC_TYPES:
                raise ValueError(f'{source}: document type "{doc.type}": {NOT_TEXT}')
            if not doc.page_content or not doc.page_content.strip():
                chunk = getattr(doc.metadata, 'chunkId', None) if doc.metadata is not None else None
                raise ValueError(f'{source}: a document (chunkId {chunk}) has no text to decide on')
            metadata = doc.metadata.model_dump() if doc.metadata is not None else None
            state = runner.state(doc.page_content, metadata)
            states.append((state, runner.oversize(state)))
        forwarded = []
        for doc, (state, size) in zip(documents, states):
            copy = doc.model_copy(deep=True)
            if copy.metadata is None:
                copy.metadata = DocMetadata(self, chunkId=0)
            item = {
                'lane': 'documents',
                'preview': preview(doc.page_content),
                'item': {'chunkId': copy.metadata.chunkId},
            }
            if size is not None:
                item, usage = self._too_long(item, size), None
            else:
                item, usage = self._decide_item(item, state)
            stamp(copy, source, self._record(item, usage))
            forwarded.append(copy)
        self.instance.writeDocuments(forwarded)
        # Without this the engine also forwards the original, unstamped documents.
        return self.preventDefault()

    def writeTable(self, table: str):
        """Decide one table and record it under its fingerprint; the table is forwarded unchanged."""
        if not table or not table.strip():
            raise ValueError(f'{self._source_id()}: a table has no content to decide on')
        item = {
            'lane': 'table',
            'preview': preview(table),
            'item': {'table_index': self._tables, 'fingerprint': fingerprint(table)},
        }
        self._tables += 1
        item, usage = self._decide_item(item, table)
        self._record(item, usage)
