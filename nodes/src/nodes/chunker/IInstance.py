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

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the task
# ------------------------------------------------------------------------------
import copy
from typing import List

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Doc, DocMetadata

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Instance that chunks incoming documents and emits one document per chunk."""

    IGlobal: IGlobal

    chunkId: int = 0

    def open(self, obj: Entry):
        """Reset chunk counter for each new object."""
        self.chunkId = 0

    def writeDocuments(self, documents: List[Doc]):
        """
        Chunk each incoming document and emit multiple documents (one per chunk).

        Each emitted document gets metadata with chunk_index, parent_id, and
        total_chunks so downstream nodes can reconstruct the original document
        if needed.
        """
        if self.IGlobal.strategy is None:
            raise RuntimeError('Chunker strategy not initialized')

        for document in documents:
            # Extract text content
            text = document.page_content or ''
            if not text.strip():
                continue

            # Get the original object ID for parent tracking
            parent_id = ''
            if document.metadata is not None:
                parent_id = getattr(document.metadata, 'objectId', '') or ''

            # Chunk the text
            chunks = self.IGlobal.strategy.chunk(text)
            total_chunks = len(chunks)

            if total_chunks == 0:
                continue

            # Build output documents
            output_docs: List[Doc] = []
            for chunk_data in chunks:
                # Shallow copy of document, explicit copy of metadata only
                chunk_doc = copy.copy(document)
                chunk_doc.metadata = copy.copy(document.metadata) if document.metadata else DocMetadata()
                chunk_doc.page_content = chunk_data['text']

                # Update metadata (always non-None after the copy/create above)
                chunk_doc.metadata.chunkId = self.chunkId
                chunk_doc.metadata.parentId = parent_id

                self.chunkId += 1
                output_docs.append(chunk_doc)

            # Emit all chunks for this document
            if output_docs:
                debug(f'Chunker emitting {len(output_docs)} chunks for document (parent_id={parent_id})')
                self.instance.writeDocuments(output_docs)
