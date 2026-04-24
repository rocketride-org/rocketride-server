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

import json
from typing import List
from rocketlib import IInstanceBase, Entry
from ai.common.schema import Doc, DocMetadata, Question, QuestionType, Answer
from ai.common.util import normalize
from .IGlobal import IGlobal
from rocketlib.types import IInvokeLLM


class IInstance(IInstanceBase):
    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    # Class attributes for tracking the current chunk and table IDs.
    chunkId: int = 0
    table: List = []

    def _extractData(self, text: str) -> List[Doc]:
        """
        Extract data from the given text/tables.

        Args:
            metadata (Dict[str, Any]): Metadata associated with the document.
            text (str): Text content of the document.

        Returns:
            List[Doc]: A list of documents with extracted definitions.
        """
        question: Question = Question(type=QuestionType.QUESTION, expectJson=True, role='You are a master at extracting data from text documents.')

        question.addInstruction(
            'Data Extraction',
            normalize("""
            Examine the following context carefully and pull out any fields you may
            find. I am trying to create a table from that data you are retrieving.
            """),
        )

        # Create all the fields declarations
        fields: List[str] = []
        for field in self.IGlobal.fields:
            field_name = field.get('column', '').ljust(32)
            field_type = field.get('type', '').ljust(16)
            field_defval = field.get('defval', '')
            fields.append(f'          Column: {field_name}  Type: {field_type}  Default Value: {field_defval}')

        fieldText = 'The fields you need to be looking for are:\n'
        fieldText += '\n'.join(fields)

        question.addInstruction('Fields', fieldText)

        question.addInstruction(
            'Inference',
            """
            You may not find exact matches on the column names, but you can infer the data
            that may be placed in each column based on your understanding of the documents.
            """,
        )

        question.addInstruction(
            'Multiple Items',
            """
            I am expecting that there could be multiple items that you find. So, always return
            an array of items, or 0 items if you do not find anything.
            """,
        )

        question.addInstruction(
            'Return a List',
            """
            Return a list of json objects that you find and if you don't find any items,
            return an empty list.
            """,
        )

        if self.table:
            question.addInstruction(
                'Context',
                """
                I already have some data that I have retrieved. Add the items in the context to
                your results.
                """,
            )

            question.addInstruction(
                'Duplicates',
                """
                If there are any items in the documents or in the context, merge them together,
                filling in any empty fields in the results.
                """,
            )
            question.addContext(self.table)

        # Add the documents text
        question.addDocuments(text)

        result = self.instance.invoke(IInvokeLLM.Ask(question=question))

        self.writeAnswers(result)

    def open(self, object: Entry):
        """
        Initialize the instance for a new object.

        Resets chunk and table IDs to start fresh for this object's processing.

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.chunkId = 0  # Reset the chunk ID counter
        self.table = []  # Reset the table to an empty list

    def writeText(self, text: str):
        """
        Process and write textual data. Extracts definitions from the text, assigns metadata, and writes the resulting documents.

        Args:
            text (str): The input text to process.
        """
        # Extract structured documents (definitions) from the input text.
        self._extractData(text)

    def writeTable(self, text: str):
        """
        Process and write tabular data. Extracts definitions from the text, assigns metadata for tables, and writes the resulting documents.

        Args:
            text (str): The input text to process.
        """
        self._extractData(text)

    def writeAnswers(self, answer: Answer):
        # Save the new table
        self.table = answer.getJson()

        # The answer was for me, so don't pass it on
        self.preventDefault()

    def closing(self):
        """
        Clean up the instance before closing.
        """
        if self.instance.hasListener('answers'):
            # Write the table as an answer
            answer = Answer(expectJson=True)
            answer.setAnswer(self.table)

            # Send it
            self.instance.writeAnswers(answer)

        if self.instance.hasListener('documents'):
            # Create a list of documents
            documents: List[Doc] = []

            # For each defintion
            for item in self.table:
                # Prepare metadata for the table being processed.
                metadata = DocMetadata(
                    self,
                    chunkId=self.chunkId,
                    isTable=False,
                    tableId=0,
                    isDeleted=False,
                )

                # Create a document from the table item
                doc = Doc(page_content=json.dumps(item), metadata=metadata)

                # Append it to the list of documents
                documents.append(doc)

                # Go to the next chunk
                self.chunkId = self.chunkId + 1

            # And write all our documents
            self.instance.writeDocuments(documents)
