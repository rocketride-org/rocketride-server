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

    chunkId: int = 0  # Identifier for the current data chunk
    tableId: int = 0  # Identifier for the table being processed

    def open(self, obj: Entry):
        """
        Initialize the instance with a given entry.

        Args:
            obj (Entry): The entry to initialize the instance with.
        """
        self.chunkId = 0  # Reset chunk identifier
        self.tableId = 0  # Reset table identifier

    def writeDocuments(self, documents: List[Doc]):
        """
        Encode and processes a list of documents.

        Args:
            documents (List[Doc]): A list of documents to encode.
        """
        self.IGlobal.embedding.encodeChunks(documents)  # Encode document chunks

    def writeQuestions(self, question: Question):
        """
        Encode a single question.

        Args:
            question (Question): The question to encode.
        """
        self.IGlobal.embedding.encodeQuestion(question)  # Encode the question
