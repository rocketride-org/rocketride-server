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
from collections.abc import Mapping

from rocketlib import IInstanceBase, Entry, debug
from ai.common.schema import Doc, DocMetadata

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """Instance that chunks incoming documents and emits one document per chunk."""

    IGlobal: IGlobal

    chunkId: int = 0
    _pending_docs: list[Doc]

    def open(self, obj: Entry):
        """Reset chunk counter for each new object."""
        self.chunkId = 0
        self._pending_docs = []

    def closing(self):
        """Emit buffered chunks once the current object has been fully written."""
        pending_docs = getattr(self, '_pending_docs', [])
        if pending_docs:
            debug(f'Chunker emitting {len(pending_docs)} chunks')
            self.instance.writeDocuments(pending_docs)
            self._pending_docs = []

    @staticmethod
    def _coerce_document(document) -> Doc:
        """Normalize runtime-decoded JSON documents to the schema object."""
        if isinstance(document, Mapping):
            if hasattr(Doc, 'model_validate'):
                return Doc.model_validate(document)
            return Doc(**dict(document))

        if not hasattr(document, 'page_content') and hasattr(document, 'items'):
            document_data = dict(document.items())
            if hasattr(Doc, 'model_validate'):
                return Doc.model_validate(document_data)
            return Doc(**document_data)

        return document

    @staticmethod
    def _copy_document(document: Doc) -> Doc:
        """Copy a document without sharing metadata between emitted chunks."""
        if hasattr(document, 'model_copy'):
            return document.model_copy()
        return copy.copy(document)

    @staticmethod
    def _copy_metadata(metadata) -> tuple[DocMetadata, str]:
        """Return mutable document metadata and the original object id."""
        if metadata is None:
            return DocMetadata(objectId='', chunkId=0), ''

        if isinstance(metadata, Mapping):
            metadata_data = dict(metadata)
            metadata_data.setdefault('objectId', '')
            metadata_data.setdefault('chunkId', 0)
            return DocMetadata(**metadata_data), metadata_data.get('objectId', '') or ''

        if hasattr(metadata, 'model_copy'):
            return metadata.model_copy(), getattr(metadata, 'objectId', '') or ''

        return copy.copy(metadata), getattr(metadata, 'objectId', '') or ''

    def writeDocuments(self, documents: list[Doc]):
        """
        Chunk each incoming document and emit multiple documents (one per chunk).

        Each emitted document gets metadata with chunkId, parentId, chunk_index,
        start_char, end_char, and total_chunks so downstream nodes can
        reconstruct the original document if needed.
        """
        if self.IGlobal.strategy is None:
            raise RuntimeError('Chunker strategy not initialized')

        if not hasattr(self, '_pending_docs'):
            self._pending_docs = []

        for raw_document in documents:
            document = self._coerce_document(raw_document)

            # Extract text content
            text = getattr(document, 'page_content', None) or ''
            if not text.strip():
                continue

            # Get the original object ID for parent tracking
            source_metadata, parent_id = self._copy_metadata(getattr(document, 'metadata', None))

            # Chunk the text
            chunks = self.IGlobal.strategy.chunk(text)
            total_chunks = len(chunks)

            if total_chunks == 0:
                continue

            # Build output documents
            output_docs: list[Doc] = []
            for chunk_data in chunks:
                # Copy the document and metadata separately so each chunk is independent.
                chunk_doc = self._copy_document(document)
                chunk_doc.metadata = copy.copy(source_metadata)
                chunk_doc.page_content = chunk_data['text']

                # Update metadata (always non-None after the copy/create above)
                chunk_doc.metadata.chunkId = self.chunkId
                chunk_doc.metadata.parentId = parent_id

                # Propagate strategy metadata (chunk_index, start_char, end_char)
                strategy_meta = chunk_data.get('metadata', {})
                chunk_doc.metadata.chunk_index = strategy_meta.get('chunk_index', 0)
                chunk_doc.metadata.start_char = strategy_meta.get('start_char', 0)
                chunk_doc.metadata.end_char = strategy_meta.get('end_char', 0)
                chunk_doc.metadata.total_chunks = total_chunks

                self.chunkId += 1
                output_docs.append(chunk_doc)

            if output_docs:
                debug(f'Chunker buffered {len(output_docs)} chunks for document (parent_id={parent_id})')
                self._pending_docs.extend(output_docs)
