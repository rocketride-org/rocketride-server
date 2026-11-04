# =============================================================================
# RocketRide Engine
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

"""Abstract IInstance layer shared by every vector store node.

The three pipeline lane handlers are byte-identical across the store drivers:
questions run a search, documents are written as chunks, and rendering rehydrates
an object's chunks. They all delegate to ``self.IGlobal.store`` (a
``DocumentStoreBase``), so they live here once. Subclassing
``VectorStoreToolMixin`` also gives every node the agent tools (``search``,
``objdir``, ``get``, ``stats``, the write tools, and ``list_documents`` where the
driver supports it) uniformly.

A concrete node inherits this class with no per-driver overrides. See
``nodes/src/nodes/store_qdrant/IInstance.py``.
"""

from abc import ABC
from typing import List, Set

from rocketlib import Entry, warning

from ai.common.schema import Doc, Question
from ai.common.transform import IInstanceTransform

from .document_store import DocumentStoreBase, VectorStoreToolMixin
from .store_global_base import StoreGlobalBase


class StoreInstanceBase(VectorStoreToolMixin, IInstanceTransform, ABC):
    """Abstract base for the IInstance layer of any vector store node."""

    IGlobal: StoreGlobalBase

    # Object IDs the documents lane has written since the current object opened; set by open(), which the
    # engine calls on every node of the pipe before any lane writes to it
    _objectIdsWritten: Set[str]

    def open(self, object: Entry) -> None:
        """Start a new object: forget the object IDs the previous one wrote.

        Args:
            object: The object the engine opens.
        """
        super().open(object)
        self._objectIdsWritten = set()

    def writeQuestions(self, question: Question) -> None:
        """Take a question, perform a search, and write the results as documents."""
        # Check it
        if self.IGlobal.store is None:
            raise Exception('No document store')

        # Dispatch to the search handler
        self.IGlobal.store.dispatchSearch(self, question)

    def writeDocuments(self, documents: List[Doc]) -> None:
        """Take a list of documents and add them to the vector store.

        A batch that holds an object's chunk 0 replaces the chunks stored for that object; a later batch of
        the object adds to them (see ``DocumentStoreBase.addChunks``). So chunk 0 must come first: when it
        arrives after other chunks of the same object, the store deletes those too, and this warns (#1986).

        Args:
            documents: The batch from the documents lane.
        """
        # Check it
        if self.IGlobal.store is None:
            raise Exception('No document store')

        self._warnOnLateChunkZero(documents)

        # Add the document chunks
        self.IGlobal.store.addChunks(documents)

    def _warnOnLateChunkZero(self, documents: List[Doc]) -> None:
        """Warn when the batch holds chunk 0 of an object an earlier batch wrote since open(); then note its objects.

        The store deletes those earlier chunks, so say so instead of losing them silently.

        Args:
            documents: The batch about to be written.
        """
        late = [
            objectId
            for objectId in DocumentStoreBase.objectIdsToReplace(documents)
            if objectId in self._objectIdsWritten
        ]
        if late:
            warning(
                f'Chunk 0 of {", ".join(late)} arrived after other chunks of the same object; '
                'the vector store deletes those earlier chunks. Send the batch with chunk 0 first.'
            )
        self._objectIdsWritten.update(document.metadata.objectId for document in documents)

    def renderObject(self, object: Entry) -> None:
        """Output the document text to the writeText lane."""

        def callback(text: str) -> None:
            self.instance.sendText(text)

        # Check it
        if self.IGlobal.store is None:
            raise Exception('No document store')

        # If we do not have a vectorize flag, or we have not vectorized
        # it, allow the next driver to render
        if not object.hasVectorBatchId or not object.vectorBatchId:
            return

        # Render the data on this object from the store and
        # send it to the renderData function
        self.IGlobal.store.render(objectId=object.objectId, callback=callback)

        # Stop right here
        self.preventDefault()
