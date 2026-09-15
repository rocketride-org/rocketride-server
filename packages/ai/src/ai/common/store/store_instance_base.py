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
``VectorStoreToolMixin`` also gives every node the ``search``/``upsert``/``delete``
agent tools uniformly.

A concrete node inherits this class with no per-driver overrides. See
``nodes/src/nodes/store_qdrant/IInstance.py``.
"""

from abc import ABC
from typing import List

from rocketlib import Entry

from ai.common.schema import Doc, Question
from ai.common.transform import IInstanceTransform

from .document_store import VectorStoreToolMixin
from .store_global_base import StoreGlobalBase


class StoreInstanceBase(VectorStoreToolMixin, IInstanceTransform, ABC):
    """Abstract base for the IInstance layer of any vector store node."""

    IGlobal: StoreGlobalBase

    def writeQuestions(self, question: Question) -> None:
        """Take a question, perform a search, and write the results as documents."""
        # Check it
        if self.IGlobal.store is None:
            raise Exception('No document store')

        # Dispatch to the search handler
        self.IGlobal.store.dispatchSearch(self, question)

    def writeDocuments(self, documents: List[Doc]) -> None:
        """Take a list of documents and add them to the vector store.

        Any chunks in the database that have the same object id will be removed.

        Raises if any objectId in ``documents`` was already written earlier in
        this task: addChunks() replaces an objectId's existing chunks rather
        than appending to them, so a second call for the same objectId would
        silently discard the earlier batch and keep only this one (#1986).
        Accumulate every chunk for one object and call this once, rather than
        flushing it across multiple calls.
        """
        # Check it
        if self.IGlobal.store is None:
            raise Exception('No document store')

        object_ids = {doc.metadata.objectId for doc in documents}
        with self.IGlobal._written_object_ids_lock:
            repeated = object_ids & self.IGlobal._written_object_ids
            if repeated:
                raise Exception(
                    f'writeDocuments: objectId(s) {sorted(repeated)!r} already written earlier in this '
                    "task. addChunks() replaces all of an objectId's chunks, so writing it again here "
                    'would silently discard the earlier batch. Accumulate every chunk for one object and '
                    'call writeDocuments once, rather than flushing it across multiple calls.'
                )
            self.IGlobal._written_object_ids |= object_ids

        # Add the document chunks
        self.IGlobal.store.addChunks(documents)

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
