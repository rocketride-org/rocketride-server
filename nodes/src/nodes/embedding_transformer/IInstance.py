# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

from typing import List
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Doc, Question
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Represent an instance that processes documents and questions using embeddings.

    It interacts with the global embedding system to encode data.
    """

    IGlobal: IGlobal  # Reference to a global context providing embedding functionality

    documents: List[Doc] = []
    maxDocuments: int = 64

    def open(self, obj: Entry):
        """
        Initialize the instance with a given entry.

        Args:
            obj (Entry): The entry to initialize the instance with.
        """
        self.documents = []

    def _flushDocuments(self):
        """
        Flush the documents to the instance.
        """
        # If we have no documents, stop here
        if len(self.documents) == 0:
            return

        # Encode the documents
        self.IGlobal.embedding.encodeChunks(self.documents)

        # Write the documents to the instance
        self.instance.writeDocuments(self.documents)

        # Clear the documents
        self.documents = []

    def writeDocuments(self, documents: List[Doc]):
        """
        Encode and processes a list of documents.

        Args:
            documents (List[Doc]): A list of documents to encode.
        """
        # Add this set of documents to the list
        self.documents.extend(documents)

        # If we have less than the max documents, stop here
        if len(self.documents) < self.maxDocuments:
            return self.preventDefault()

        # Flush the documents
        self._flushDocuments()

    def writeQuestions(self, question: Question):
        """
        Encode a single question.

        Args:
            question (Question): The question to encode.
        """
        self.IGlobal.embedding.encodeQuestion(question)  # Encode the question

    def close(self):
        # Flush any stragglers
        self._flushDocuments()
