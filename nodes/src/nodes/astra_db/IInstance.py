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

# ------------------------------------------------------------------------------
# This class controls the data for each thread of the task
# ------------------------------------------------------------------------------
from rocketlib import Entry
from typing import List
from .IGlobal import IGlobal
from ai.common.schema import Doc, Question
from ai.common.transform import IInstanceTransform


class IInstance(IInstanceTransform):
    IGlobal: IGlobal

    def writeQuestions(self, question: Question):
        """
        Take a question, perform a search, and writes the results as documents.
        """
        # Check if store exists
        if self.IGlobal.store is None:
            raise Exception('No document store')

        # Dispatch to the search handler
        self.IGlobal.store.dispatchSearch(self, question)

    def writeDocuments(self, documents: List[Doc]):
        """
        Take a list of documents and adds them to the vector store.

        Any chunks in the database that have the same object id will
        be removed
        """
        # Check if store exists
        if self.IGlobal.store is None:
            raise Exception('No document store')

        # Add the document chunks
        self.IGlobal.store.addChunks(documents)

    def renderObject(self, object: Entry):
        """
        Output the document text to the writeText lane.
        """

        def callback(text: str) -> None:
            self.instance.sendText(text)

        # Check if store exists
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
