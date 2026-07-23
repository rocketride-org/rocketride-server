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
# This class controls the data for each thread of the task.
# It adapts model/agent answers into embeddable documents so that validated,
# self-describing facts can be indexed back into a vector store, while still
# forwarding the original answer downstream.
# ------------------------------------------------------------------------------

from typing import List
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Answer, Doc, DocMetadata
from .IGlobal import IGlobal
from .adapt import answer_contents


class IInstance(IInstanceBase):
    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    # Running chunk counter, reset per input object.
    chunkId: int = 0

    def open(self, obj: Entry):
        """Initialize the instance for a new object.

        Resets the chunk ID so document positions start fresh for this object.

        Args:
            obj (Entry): The object to initialize processing for.
        """
        self.chunkId = 0

    def writeAnswers(self, answer: Answer):
        """Convert an answer into documents while preserving the answers lane.

        - ``documents``: one document per validated fact (a JSON list yields one
          document per item; a JSON object or plain-text answer yields a single
          document). Only built when something downstream consumes ``documents``.
        - ``answers``: the engine's default forwarding passes the original answer
          through so the same pipeline can both index the answer and keep serving
          it (for example to a response node).

        Args:
            answer (Answer): The incoming answer to adapt.
        """
        # Build documents only if a downstream node listens on the documents lane.
        if self.instance.hasListener('documents'):
            documents: List[Doc] = []

            for content in answer_contents(answer):
                # Provenance metadata is auto-populated from the pipeline context.
                metadata = DocMetadata(
                    self,
                    chunkId=self.chunkId,  # Position within this object
                    isTable=False,  # Answers are treated as text content
                    tableId=0,  # No table association
                    isDeleted=False,
                )

                documents.append(Doc(page_content=content, metadata=metadata))

                # Advance to the next chunk position.
                self.chunkId = self.chunkId + 1

            if documents:
                self.instance.writeDocuments(documents)
