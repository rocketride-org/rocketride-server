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
# This class controls the data for each thread of the task.
# It extends `IInstanceBase` and interacts with global definitions,
# handling the processing and metadata of text and table data.
# ------------------------------------------------------------------------------
import json
from rocketlib import IInstanceBase, Entry
from .IGlobal import IGlobal
from typing import List
from ai.common.schema import Doc, DocMetadata, Question, QuestionType, Answer
from rocketlib.types import IInvokeLLM


class IInstance(IInstanceBase):
    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    # Class attributes for tracking the current chunk and table IDs.
    chunkId: int = 0

    def _extractDefinitions(self, text: str) -> List[Doc]:
        """Extract definitions from a document, structure them as JSON objects.

        Add them to the vector database.

        Args:
            metadata (Dict[str, Any]): Metadata associated with the document.
            text (str): Text content of the document.

        Returns:
            List[Doc]: A list of documents with extracted definitions.
        """
        question: Question = Question(type=QuestionType.QUESTION, expectJson=True, role='You are a friendly assistant')

        question.addInstruction(
            'Dictionary Creation',
            """
I am creating a dictionary of terms and ideas that are specific to a company. Use the
following documents and context to pull out company-specific information, lingo, and other information 
that may help in answering a user's question. Make sure you pull out any terms that may 
be ambiguous or are different from what your training indicates.
""",
        )

        question.addInstruction(
            'Company Specific Terms',
            """
You may end up coming accross company specific terms or acronyms. Be sure to include those
in your definitions as well.                                
""",
        )

        question.addInstruction(
            'Multiple definitions',
            """
For multiple documents, merge them into a single Json array. Always return a single Json array 
of definitions.
    """,
        )

        question.addInstruction(
            'Overlap',
            """
Definitions may overlap.
""",
        )

        question.addExample(
            """
So you ask what we define as a red loan? A red loan, according to the Credit Portfolio Marketing 
Division (CPMD) is a loan that the client has a credit score less than 650. The client also has 
to be delinquent on their repayment schedule by 60 days or more.
""",
            [{'term': 'Red loan', 'description': 'Credit score less than 650 and delinquent by 60 days or more'}, {'term': 'CPMD', 'description': 'Credit Portfolio Marketing Division'}],
        )

        # Add the documents text
        question.addDocuments(text)

        result = self.instance.invoke('llm', IInvokeLLM(op='ask', question=question))

        # Process the answer and write documents
        self.writeAnswers(result)

    def open(self, object: Entry):
        """Initialize the instance for a new object.

        Resets chunk and table IDs to start fresh for this object's processing.

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.chunkId = 0  # Reset the chunk ID counter

    def writeText(self, text: str):
        """Process and write textual data.

        Extracts definitions from the text, assigns metadata, and writes the resulting documents.

        Args:
            text (str): The input text to process.
        """
        # Extract structured documents (definitions) from the input text.
        self._extractDefinitions(text)

    def writeTable(self, text: str):
        """Process and write tabular data.

        Extracts definitions from the text, assigns metadata for tables, and writes the resulting documents.

        Args:
            text (str): The input text to process.
        """
        self._extractDefinitions(text)

    def writeAnswers(self, answer: Answer):
        # Iterate over the extracted JSON objects
        definitions = answer.getJson()

        # Create a list of documents
        documents: List[Doc] = []

        # For each defintion
        for definition in definitions:
            # Prepare metadata for the table being processed.
            metadata = DocMetadata(
                self,
                chunkId=self.chunkId,  # Chunk number override
                isTable=False,  # Explicitly mark as text
                tableId=0,  # No table association
            )

            # Create a document from the definition
            doc = Doc(page_content=json.dumps(definition), metadata=metadata)

            # Append it to the list of documents
            documents.append(doc)

            # Go to the next chunk
            self.chunkId = self.chunkId + 1

        # And write all our documents
        self.instance.writeDocuments(documents)
