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
from typing import List
from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Doc, DocMetadata, Answer
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Landing.ai Extract processor.

    Accumulates parsed Markdown arriving on the ``text`` lane, runs ADE Extract
    over it once the object closes, and writes the extracted data to the
    ``answers`` / ``documents`` lanes.
    """

    IGlobal: IGlobal

    chunkId: int = 0
    markdown_parts: List[str] = []

    def open(self, obj: Entry):
        """Reset accumulation state for a new object."""
        self.chunkId = 0
        self.markdown_parts = []

    def writeText(self, text: str):
        """Accumulate parsed Markdown arriving on the text lane."""
        if text:
            self.markdown_parts.append(text)

    def closing(self):
        """Run extraction over the accumulated Markdown and write the results."""
        markdown = '\n\n'.join(self.markdown_parts).strip()

        extraction = {}
        if markdown:
            extraction = self.IGlobal.extractor.extract(markdown)
        else:
            debug('Landing.ai Extract: no markdown received, emitting empty result')

        if self.instance.hasListener('answers'):
            answer = Answer(expectJson=True)
            answer.setAnswer(extraction)
            self.instance.writeAnswers(answer)

        if self.instance.hasListener('documents'):
            self.instance.writeDocuments(self._to_documents(extraction))

    def _to_documents(self, extraction) -> List[Doc]:
        """Wrap the extracted data as documents (one per item if it's a list)."""
        items = extraction if isinstance(extraction, list) else [extraction]

        documents: List[Doc] = []
        for item in items:
            metadata = DocMetadata(
                self,
                chunkId=self.chunkId,
                isTable=False,
                tableId=0,
                isDeleted=False,
            )
            documents.append(Doc(page_content=json.dumps(item), metadata=metadata))
            self.chunkId += 1

        return documents
