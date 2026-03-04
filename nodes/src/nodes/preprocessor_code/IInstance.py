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

from rocketlib import IInstanceBase, Entry, warning
from typing import List
from ai.common.schema import Doc, DocMetadata
from . import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    chunkId: int = 0
    tableId: int = 0

    def _writeTableOrText(self, text: str, isTable: bool = False):
        # Fill in the metadata
        metadata = DocMetadata(
            self,
            chunkId=0,
            isTable=isTable,
            tableId=0,
            isDeleted=False,
        )

        # Chunk the document
        textChunks = self.IGlobal.preprocessor.process(text)
        if not textChunks:
            warning(f'The file {self.instance.currentObject.path} could not be processed, because it does not appear to contain supported source code in one of these languages: c/c++, python, javascript, typescript, typescript.')
            return

        # Create the documents
        documents: List[Doc] = []
        for chunk in textChunks:
            # Create the document from it
            document = Doc(page_content=chunk, metadata=metadata.model_copy())

            # Assign the chunk id
            document.metadata.chunkId = self.chunkId
            self.chunkId = self.chunkId + 1

            # If this is a table or not
            if isTable:
                self.tableId = self.tableId
            else:
                self.tableId = 0

            # Append it to the list
            documents.append(document)

        # If there are no documents, done
        if not len(documents):
            return

        # If this is a table
        if isTable:
            metadata.tableId = self.tableId
            self.tableId += 1

        # Write the documents
        self.instance.writeDocuments(documents)

    def open(self, object: Entry):
        self.chunkId = 0
        self.tableId = 0

    def writeTable(self, table: str):
        self._writeTableOrText(table, True)

    def writeText(self, text: str):
        self._writeTableOrText(text, False)
