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
"""Engine glue: annotate documents with decisions and forward them once."""

from __future__ import annotations

from typing import List

from rocketlib import IInstanceBase, warning

from ai.common.schema import Answer, Doc, DocMetadata

from .runner import merge_decisions


class SystemOneInstanceBase(IInstanceBase):
    """Shared IInstance for System One Ask nodes (documents lane)."""

    def _source_id(self) -> str:
        """Return the component id (e.g. ``decision_ollama_1``), falling back to the logical type."""
        pipe_type = getattr(self.instance, 'pipeType', None)
        component_id = pipe_type.get('id') if isinstance(pipe_type, dict) else getattr(pipe_type, 'id', '')
        return str(component_id or getattr(getattr(self.IGlobal, 'glb', None), 'logicalType', 'decision'))

    def writeDocuments(self, documents: List[Doc]):
        """Ask every question about each document, then forward the annotated copies once."""
        runner = self.IGlobal.runner
        source = self._source_id()
        enriched, payloads = [], []
        for doc in documents:
            copy = doc.model_copy(deep=True)
            metadata = copy.metadata.model_dump() if copy.metadata is not None else None
            result = runner.decide(copy.page_content, metadata, source=source)
            if not result.skipped:
                if copy.metadata is None:
                    copy.metadata = DocMetadata(self, chunkId=0)
                copy.metadata.decisions = merge_decisions(
                    getattr(copy.metadata, 'decisions', None), result.decisions, warn=warning
                )
                if result.truncated:
                    copy.metadata.decisions_truncated = True
                payloads.append(
                    {
                        'objectId': getattr(copy.metadata, 'objectId', None),
                        'chunkId': getattr(copy.metadata, 'chunkId', None),
                        'parent': getattr(copy.metadata, 'parent', None),
                        'decisions': result.decisions,
                        'usage': result.usage,
                    }
                )
            enriched.append(copy)
        self.instance.writeDocuments(enriched)
        if payloads and self.instance.hasListener('answers'):
            for payload in payloads:
                answer = Answer(expectJson=True)
                answer.setAnswer(payload)
                self.instance.writeAnswers(answer)
        # Without this the engine also forwards the original, unannotated documents.
        return self.preventDefault()
