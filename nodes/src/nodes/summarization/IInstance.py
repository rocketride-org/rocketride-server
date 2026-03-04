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

from rocketlib import IInstanceBase, Entry
from rocketlib.types import IInvokeLLM
from .IGlobal import IGlobal
from ai.common.schema import Question, QuestionType, Answer, Doc, DocMetadata


class IInstance(IInstanceBase):
    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal
    maxTokens: int = 0
    baseSummaryTokens: int = 0
    baseCombineTokens: int = 0

    def beginInstance(self) -> None:
        """
        Begin the instance for processing.
        """
        self.init = False

    def _getSummaryTokens(self, text: str) -> int:
        """
        Get the length of the overall prompt in tokens.

        Args:
            text (str): The text to measure.

        Returns:
            int: The length of the text in tokens.
        """
        # Get the length of the text in tokens
        contextSize = self.tokenCounter(text)

        # Add in the base since it is part of the prompt as well
        return contextSize + self.baseSummaryTokens

    def _buildSummaryQuestion(self, text: str = '') -> Question:
        """
        Build a question to ask the LLM.

        If this is trying to measure the base size of the prompt, you may leave
        the text blank. This will be used to measure the size of the prompt itself.
        """
        # Setup a question to ask the LLM
        question: Question = Question(type=QuestionType.QUESTION, role='You are a document summarizer.')

        # Add the instruction to the question
        if self.IGlobal.numberOfSummaryWords:
            question.addInstruction(
                'Summary',
                f"""
                Provide a concise summary of the document. The summary should be clear
                and focused, no longer than {self.IGlobal.numberOfSummaryWords} words, and
                highlight the most important aspects without unnecessary details in
                paragraph form.
                """,
            )

        if self.IGlobal.numberOfKeyPointWords:
            question.addInstruction(
                'Key Points',
                f"""
                Identify and summarize the most important details and insights
                from the document, using no more than {self.IGlobal.numberOfKeyPointWords}
                for each key point.
                """,
            )

        if self.IGlobal.numberOfEntities:
            question.addInstruction(
                'Entities',
                f"""
                List the main entities (e.g., people, organizations, products, events, dates, locations)
                mentioned in the document. Include only the most significant entities, up to a maximum
                of {self.IGlobal.numberOfEntities} entities, that directly relate to the document's content.
                """,
            )

        question.addInstruction(
            'Important Guidelines',
            """
            - Clarity: Ensure that the summary is easy to understand and follows a logical order.
            - Focus: Avoid including minor details or tangential information. Stick to the most relevant content.
            - Accuracy: Double-check that all entities and key points are accurately represented in the summary.
            - Tone: Keep the tone neutral and informative.
            - Please ensure that the summary and lists are well-organized and provide a clear overview of the document’s content.
            """,
        )

        question.addInstruction(
            'Result Example',
            """"
                {
                    "summary": "This is a summary of the document",
                    "keyPoints": ["key point1", "keypoint2", ...],
                    "entities": [ "entity1", "entity2", ...]
                }
            """,
        )

        # Add the context
        question.addContext(text)

        # Indicate we want a JSON response
        question.expectJson = True

        # Return the question
        return question

    def _extractSummary(self, text: str) -> Answer:
        """
        Extract summary of a document using the LLM.

        Args:
            text (str): Text content of the document.

        Returns:
            JSON summary
        """
        question = self._buildSummaryQuestion(text)

        # Trigger the question, returning IAnswer
        result = self.instance.invoke('llm', IInvokeLLM(op='ask', question=question))

        # Return the json answer
        return result.getJson()

    def open(self, object: Entry):
        """
        Initialize the instance for a new object.

        Resets text to start accumulating again

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.text = ''

    def writeText(self, text: str):
        """
        Add the text to the accumulator so we can summarize a document.

        Args:
            text (str): The input text to process.
        """
        # Accumulate the text so we can see the whole document
        self.text += text

    def writeTable(self, text: str):
        """
        Add the table to the accumulator so we can summarize a document.

        Args:
            text (str): The input text to process.
        """
        # Accumulate the text so we can see the whole document
        self.text += text

    def closing(self):
        """
        Process the accumulated text and extract summaries.
        """
        # As of now, we cannot call .invoke within beginFilter so we
        # can do it here instead
        if not self.init:
            # Load the splitter
            from langchain_text_splitters import RecursiveCharacterTextSplitter

            # Load the fixed stuff
            self.maxTokens = self.instance.invoke('llm', IInvokeLLM(op='getContextLength'))
            self.tokenCounter = self.instance.invoke('llm', IInvokeLLM(op='getTokenCounter'))
            self.summarySplitter = RecursiveCharacterTextSplitter(chunk_size=self.maxTokens, length_function=self._getSummaryTokens)

            # Get an empty prompt and obtain # of tokens in it
            summaryQuestion = self._buildSummaryQuestion()
            self.baseSummaryTokens = self.tokenCounter(summaryQuestion.getPrompt())

            # We are now initialized
            self.init = True

        # Perform the fist pass
        chunks = self.summarySplitter.split_text(self.text)

        # Respect the maximum number of chunks to process
        chunks = chunks[: self.IGlobal.numberOfSummaries]

        # Process all the chunks we have
        results = []
        for chunk in chunks:
            results.append(self._extractSummary(chunk))

        # Get the listening lanes
        lanes = self.instance.getListeners()

        # If we have a text listener on the text lane, convert the results to text
        if 'text' in lanes:
            summaries = ''
            keyPoints = ''
            entities = ''

            # Gather up all the summaries, key points and entities
            for result in results:
                if 'summary' in result and self.IGlobal.numberOfSummaryWords:
                    summaries += '    ' + result['summary'] + '\n\n'

                if 'keyPoints' in result and result['keyPoints'] and self.IGlobal.numberOfKeyPointWords:
                    for keyPoint in result['keyPoints']:
                        if isinstance(keyPoint, dict):
                            title = keyPoint.get('title', '')
                            summary = keyPoint.get('summary', '')
                            keyPoints += f'   - {title}: {summary}\n'
                        else:
                            keyPoints += f'   - {keyPoint}\n'

                if 'entities' in result and result['entities'] and self.IGlobal.numberOfEntities:
                    for entity in result['entities']:
                        entities += '   -' + entity + '\n'

            # Add them all together
            text = ''
            if summaries:
                text += 'Summmary:\n' + summaries + '\n\n'
            if keyPoints:
                text += 'Key Points:\n' + keyPoints + '\n\n'
            if entities:
                text += 'Entities:\n' + entities + '\n\n'

            # Write it
            if text:
                self.instance.writeText(text)

        # If we have a listener on our documents lane, write 3 documents
        if 'documents' in lanes:
            documents = []

            # Prepare metadata for the table being processed.
            metadata = DocMetadata(
                self,
                chunkId=0,
                isTable=False,
                tableId=0,
                isDeleted=False,
            )

            # Output each section as it's own document
            for result in results:
                if 'summary' in result and self.IGlobal.numberOfSummaryWords:
                    text = str('Summary:\n')
                    text += result['summary'] + '\n'

                    doc = Doc(page_content=text, type='Document', metadata=metadata)
                    documents.append(doc)
                    metadata.chunkId = metadata.chunkId + 1

                if 'keyPoints' in result and result['keyPoints'] and self.IGlobal:
                    text = 'Key Points:'
                    for keyPoint in result['keyPoints']:
                        text += '- ' + keyPoint + '\n'

                    doc = Doc(page_content=text, type='Document', metadata=metadata)
                    documents.append(doc)
                    metadata.chunkId = metadata.chunkId + 1

                if 'entities' in result and result['entities'] and self.IGlobal.numberOfEntities:
                    text = 'Entities:\n'
                    for entity in result['entities']:
                        text += '- ' + entity + '\n'

                    doc = Doc(page_content=text, type='Document', metadata=metadata)
                    documents.append(doc)
                    metadata.chunkId = metadata.chunkId + 1

            # Emit the summary
            self.instance.writeDocuments(documents)

        return
