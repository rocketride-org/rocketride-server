# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

from typing import Dict, List
from rocketlib import IInstanceBase, debug, FLAGS, OPEN_MODE
from ai.common.schema import DocMetadata, Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    A specialized instance that handles text processing and vectorization.
    """

    IGlobal: IGlobal
    chunkId = 0
    tableId = 0

    def _doVectorizing(self) -> bool:
        """
        Determine whether vectorization should proceed based on flags.

        Returns:
            bool: True if vectorization should proceed, False otherwise.
        """
        if self.instance.currentObject.flags & FLAGS.VECTORIZE:
            return True
        else:
            return False

    def _isVectorized(self) -> bool:
        """
        Determine if we have been vectorized.

        Returns:
            bool: True if vectorization should proceed, False otherwise.
        """
        if self.instance.currentObject.vectorBatchId != 0:
            return True
        else:
            return False

    def _add(self, text: str, isTable: bool) -> None:
        """
        Add a document to to the store. Processes the docments and tables into checks, computes the embeddings, etc.
        """
        # If we are not doing vectorizing here
        if not self._doVectorizing():
            return

        # If there is no text, there is nothing to process
        if not text:
            return

        # Determine permission ID
        permissionId = self.instance.currentObject.permissionId if self.instance.currentObject.hasPermissionId else -1

        # Create the metadata
        metadata = DocMetadata(
            self,
            chunkId=self.chunkId,
            isTable=isTable,
            isDeleted=False,
            tableId=0,
            permissionId=permissionId,
        )

        # Split the text
        docTexts = self.IGlobal.preprocessor.process(text)

        # Update the chunk id and the table id
        chunks: List[Doc] = []
        for docText in docTexts:
            doc = Doc(page_content=docText, metadata=metadata.model_copy())

            doc.metadata.chunkId = self.chunkId
            self.chunkId += 1

            # If this is a table, setup the metadata for it
            if isTable:
                doc.metadata.isTable = True
                doc.metadata.tableId = self.tableId

            # Add it to the list
            chunks.append(doc)

        # if no chunks there is nothing to process
        if not chunks:
            debug('Chunks are empty')
            return

        # If this is a table, move to next table
        if isTable:
            self.tableId += 1

        # Create the embeddings
        self.IGlobal.embedding.encodeChunks(chunks)

        # If we are running an instance task, add the chunks directly
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
            # Add the chunks
            self.IGlobal.store.addChunks(chunks)

        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.TRANSFORM:
            # Send them off to the endpoint store driver
            self.instance.writeDocuments(chunks)

    def open(self, obj: Dict):
        """
        Open the processing for a given object.

        Args:
            obj (dict): The object to process.
        """
        # Reset these for the new object
        self.chunkId = 0
        self.tableId = 0

        # If we are vectorizing and we are in instance mode, reset the batch id
        if self._doVectorizing() and self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
            self.instance.currentObject.vectorBatchId = 0

    def writeTable(self, table: str):
        """
        Process a table entry if vectorization is enabled.

        Args:
            table (str): The table data to write.
        """
        # Add the text data to the global store
        self._add(text=table, isTable=True)

    def writeText(self, text: str):
        """
        Process a text entry for vectorization.

        Args:
            text (str): The text data to write.
        """
        # Add the text data to the global store
        self._add(text=text, isTable=False)

    def close(self):
        """
        Close the current instance.
        """
        # If we are vectorizing and we are in instance mode, mark the object as vectorized
        if self._doVectorizing() and self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
            self.instance.currentObject.vectorBatchId = 1

    def renderObject(self, object):
        """
        Render an object by retrieving its stored data and passing it to the text writer.

        Args:
            object: The object to be rendered.
        """

        def callback(text: str) -> None:
            """
            Define the callback function to write retrieved text.

            Args:
                text (str): The text data retrieved from storage.
            """
            self.instance.writeText(text)

        # Check if the object has is vectorize
        if not self._isVectorized():
            return

        # Retrieve and process the stored data
        self.IGlobal.store.render(objectId=object.objectId, callback=callback)

        return self.preventDefault()
