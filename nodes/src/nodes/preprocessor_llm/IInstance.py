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

from typing import Callable, Dict
from rocketlib import IInstanceBase, Entry
from rocketlib.types import IInvokeLLM
from .IGlobal import IGlobal
from ai.common.schema import Question, QuestionType, Answer, Doc, DocMetadata


class IInstance(IInstanceBase):
    """
    Instance class for document chunking and processing.

    This class processes documents by breaking them into semantic chunks
    suitable for vector embedding storage, along with extracting topics
    and entities for enhanced searchability.
    """

    # Reference to a global instance providing shared functionality.
    IGlobal: IGlobal

    def beginInstance(self) -> None:
        """
        Begin the instance for processing.

        Initializes the processing state for a new instance.
        """
        self._init: bool = False  # Indicates if the instance has been initialized
        self._maxContextTokens: int = 0
        self._maxOutputTokens: int = 0
        self._tokenCounter: Callable[[str], int] = None
        self._chunkSplitter: Callable[[str], list[str]] = None
        self._baseChunkTokens: int = 0

    def _buildChunkQuestion(self, text: str = '') -> Question:
        """
        Build a question to ask the LLM for document chunking.

        If this is trying to measure the base size of the prompt, you may leave
        the text blank. This will be used to measure the size of the prompt itself.

        Args:
            text (str): The document text to chunk. Leave empty for base size measurement.

        Returns:
            Question: Configured question object for chunking operations.
        """
        # Setup a question to ask the LLM
        question: Question = Question(
            type=QuestionType.QUESTION,
            role='You are a document processing assistant that prepares content for vector embedding storage.',
        )

        # Get the number of tokens per chunk
        tokens = self.IGlobal.numberOfTokens
        words = tokens * 0.75

        # Add the instruction for chunking
        question.addInstruction(
            'Chunking Guidelines',
            f"""
            Break down the provided document into logical, coherent chunks suitable for vector embedding storage.
            Each chunk should:
            - Contain complete thoughts or concepts (don't break mid-sentence or mid-paragraph)
            - Maintain context and meaning when read independently
            - Preserve important relationships between concepts within the chunk
            - Include relevant headers or section titles when applicable
            - Keep the exact text as the input document
            - Logical Boundaries: Respect document structure (paragraphs, sections, lists)
            - If the document does not contain content suitable to chunk, return an empty array
            - Aim for chunk sizes of {tokens} tokens, or {words} words if token count is not available
            - Omit the summary flags for normal content chunks

            Return each chunk as a separate item in the chunks array.
            """,
        )

        question.addInstruction(
            'Document Summary',
            """
            - Add a summary chunk
            - Examine the overall document and provide a short summary of the document which will fit into a single chunk
            - If you don't find any chunks, do not output a summary
            - The summary should be the last chunk
            """,
        )

        question.addExample(
            'Result Format',
            {
                'chunks': [
                    {'content': 'The actual text content of the first chunk'},
                    {'content': 'The actual text content of the next chunk'},
                    {'content': 'Summary of the document', 'summary': True},
                ]
            },
        )

        # Add the context
        question.addContext(text)

        # Indicate we want a JSON response
        question.expectJson = True

        # Return the question
        return question

    def _split_table(self, table_content: str) -> list[str]:
        """
        Split a markdown table into chunks based on token limits.

        This method takes a markdown table string and splits it at line boundaries,
        continuing to add lines until the maximum token count is reached.

        Args:
            table_content (str): The markdown table content to split

        Returns:
            list[str]: List of table chunk strings, each under the token limit

        Note:
            - Splits only at line boundaries to maintain table row integrity
            - Does not preserve headers - caller handles table structure
        """
        if not table_content.strip():
            return []

        tokens = self.IGlobal.numberOfTokens
        lines = table_content.split('\n')
        chunks = []
        current_chunk_lines = []
        current_token_count = 0

        for line in lines:
            # Get base token count for this line
            base_line_tokens = self._tokenCounter(line)

            # Calculate total tokens including separator if needed
            line_tokens = base_line_tokens + (1 if current_chunk_lines else 0)

            # Check if adding this line would exceed the limit
            if current_token_count + line_tokens > tokens and current_chunk_lines:
                # Save current chunk and start new one
                chunks.append('\n'.join(current_chunk_lines))
                current_chunk_lines = [line]
                current_token_count = base_line_tokens  # Use base tokens (no separator for first line)
            else:
                # Add line to current chunk
                current_chunk_lines.append(line)
                current_token_count += line_tokens

        # Add the final chunk if it has content
        if current_chunk_lines:
            chunks.append('\n'.join(current_chunk_lines))

        # Ensure we have at least one chunk
        return chunks if chunks else [table_content]  # Return original if no chunks created

    def _splitText(self, text: str) -> list[str]:
        """
        Split the text into manageable chunks.

        Args:
            text (str): The text to split.

        Returns:
            list[str]: List of text chunks.
        """
        from dataclasses import dataclass

        # Setup the results
        chunks = []

        # Determine how many tokens we can send in a single chunk. It is the
        # smaller of max_tokens - our prompt base or output tokens.
        raw_tokens = min(self._maxContextTokens - self._baseChunkTokens, self._maxOutputTokens)

        # Calculate the maximum tokens, keeping in mind our overhead for json
        # formatting, and text length per chunk
        max_tokens_per_chunk = raw_tokens - 500
        max_text_per_chunk = 64 * 1024

        # Determine the number of tokens for a LF/LF separator and its length
        lf_separator_tokens = self._tokenCounter('\n\n')
        lf_separator_len = 2  # Length of '\n\n'

        @dataclass
        class ChunkControl:
            current_token_accumulator: int = 0
            current_length_accumulator: int = 0
            current_text_chunk: str = ''

        control = ChunkControl()

        def _push_chunk(control: ChunkControl):
            """
            Push the current text chunk to the chunks list and reset accumulators.
            """
            # Append if we have anything - useful for flushing
            if control.current_text_chunk:
                chunks.append(control.current_text_chunk)

            # Reset the accumulators
            control.current_token_accumulator = 0
            control.current_length_accumulator = 0
            control.current_text_chunk = ''

        def _add_text_to_chunk(control: ChunkControl, text: str):
            """
            Actually add text to the current chunk and update accumulators.
            """
            # Get the number of tokens in the current text (without separators)
            curr_tokens = self._tokenCounter(text)
            curr_len = len(text)

            # Calculate the tokens that would be added including separators
            separator_tokens = 0
            separator_len = 0
            if control.current_text_chunk:
                separator_tokens = lf_separator_tokens
                separator_len = lf_separator_len

            total_tokens_needed = curr_tokens + separator_tokens
            total_len_needed = curr_len + separator_len

            # Update accumulators
            control.current_token_accumulator += total_tokens_needed
            control.current_length_accumulator += total_len_needed

            # Add the text to the current chunk
            if control.current_text_chunk:
                control.current_text_chunk += '\n\n' + text
            else:
                control.current_text_chunk = text

        def _add_paragraphs(control: ChunkControl, text: str):
            """
            Split text by paragraphs (double newlines) and add each paragraph.
            """
            paragraphs = text.split('\n\n')
            for paragraph in paragraphs:
                _add_text(control, paragraph)

        def _add_lines(control: ChunkControl, text: str):
            """
            Split text by lines (single newlines) and add each line.

            Note: This changes the original formatting by converting (LF) to (LF)(LF) separators.
            """
            lines = text.split('\n')
            for line in lines:
                _add_text(control, line)

        def _add_sentences(control: ChunkControl, text: str):
            """
            Split text by sentences and add each sentence.
            """
            sentences = text.split('. ')
            for i, sentence in enumerate(sentences):
                # Add period back except for last sentence (unless it already ends with punctuation)
                if i < len(sentences) - 1:
                    sentence += '.'
                elif not sentence.endswith(('.', '!', '?')):
                    sentence += '.'
                _add_text(control, sentence)

        def _add_words(control: ChunkControl, text: str):
            """
            Split text by words and add word groups that fit within chunk limits.

            This is the last resort for very large continuous text.
            """
            words = text.split()
            temp_chunk = ''

            for word in words:
                # Test if adding this word would exceed limits
                test_chunk = temp_chunk + (' ' if temp_chunk else '') + word
                test_tokens = self._tokenCounter(test_chunk)
                test_len = len(test_chunk)

                # Use slightly smaller limits to leave room for separators
                if test_tokens < max_tokens_per_chunk * 0.8 and test_len < max_text_per_chunk * 0.8:
                    temp_chunk = test_chunk
                else:
                    # Current temp_chunk is full, add it and start new one
                    if temp_chunk:
                        _add_text(control, temp_chunk)
                        temp_chunk = word
                    else:
                        # Single word is too large - this shouldn't happen in normal text
                        # but handle it gracefully by adding it anyway
                        _add_text(control, word)

            # Add any remaining words
            if temp_chunk:
                _add_text(control, temp_chunk)

        def _split_oversized_text(control: ChunkControl, text: str):
            """
            Split text that is too large for a single chunk using hierarchical splitting.
            """
            # Try splitting by paragraphs first (double newlines)
            if '\n\n' in text:
                _add_paragraphs(control, text)
            # Try splitting by lines (single newlines)
            elif '\n' in text:
                _add_lines(control, text)
            # Try splitting by sentences
            elif '. ' in text:
                _add_sentences(control, text)
            # Last resort: split by words
            else:
                _add_words(control, text)

        def _add_text(control: ChunkControl, text: str):
            """
            Add a string to the current text chunk, handling overflow by splitting into smaller pieces.
            """
            # Get the number of tokens in the current text (without separators)
            curr_tokens = self._tokenCounter(text)
            curr_len = len(text)

            # Calculate the tokens that would be added including separators
            separator_tokens = 0
            separator_len = 0
            if control.current_text_chunk:
                separator_tokens = lf_separator_tokens
                separator_len = lf_separator_len

            total_tokens_needed = curr_tokens + separator_tokens
            total_len_needed = curr_len + separator_len

            # Check if adding this text would exceed either limit
            if (
                control.current_token_accumulator + total_tokens_needed >= max_tokens_per_chunk
                or control.current_length_accumulator + total_len_needed >= max_text_per_chunk
            ):
                # If current chunk has content, push it first
                if control.current_text_chunk:
                    _push_chunk(control)

                # If this text itself is too large, split it further
                if curr_tokens > max_tokens_per_chunk * 0.9 or curr_len > max_text_per_chunk * 0.9:
                    _split_oversized_text(control, text)
                    return

            # Add the text to the current chunk
            _add_text_to_chunk(control, text)

        # Add the text and split it into chunks if needed
        _add_text(control, text)

        # Save the final chunk
        _push_chunk(control)

        # Return the list of chunks
        return chunks

    def _extractChunks(self, text: str) -> Answer:
        """
        Extract chunks from a document using the LLM.

        Args:
            text (str): Text content of the document to chunk.

        Returns:
            dict: JSON response containing chunks with content, topics, and entities.
        """
        question = self._buildChunkQuestion(text)

        # Trigger the question, returning IAnswer
        result = self.instance.invoke(IInvokeLLM.Ask(question=question))

        return result.getJson()

    def open(self, object: Entry):
        """
        Initialize the instance for a new object.

        Resets text to start accumulating again for the new document.

        Args:
            object (Entry): The object to initialize processing for.
        """
        self.text = ''
        self.chunks = []

    def writeText(self, text: str):
        """
        Add the text to the accumulator so we can chunk a document.

        Args:
            text (str): The input text to process.
        """
        # Accumulate the text so we can see the whole document
        self.text += text

    def writeTable(self, text: str):
        """
        Add the table to the accumulator so we can chunk a document.

        Args:
            text (str): The input text to process.
        """
        # Add the table directly to our chunks list
        self.chunks.append(
            {
                'content': text,
                'table': True,  # Indicate this is a table chunk
            }
        )

    def closing(self):
        """
        Process the accumulated text and extract chunks.

        This method performs the final chunking operation on the accumulated text,
        then outputs the results to appropriate listeners based on their requirements.
        """
        # As of now, we cannot call .invoke within beginFilter so we
        # can do it here instead
        if not self._init:
            # Load the fixed stuff
            self._maxContextTokens = self.instance.invoke(IInvokeLLM.GetContextLength())
            self._maxOutputTokens = self.instance.invoke(IInvokeLLM.GetOutputLength())
            self._tokenCounter = self.instance.invoke(IInvokeLLM.GetTokenCounter())

            # Get an empty prompt and obtain # of tokens in it
            chunkQuestion = self._buildChunkQuestion()
            self._baseChunkTokens = self._tokenCounter(chunkQuestion.getPrompt())

            # We are now initialized
            self._init = True

        # Split into partial documents
        text_chunks = self._splitText(self.text)

        # If we have a listener on our documents lane, write individual chunk documents
        documents = []
        chunk_counter = 0
        table_id = 0

        # For each chunk of the document
        for text_chunk in text_chunks:
            # Extract the vector chunks using the LLM
            results = self._extractChunks(text_chunk)

            # Get the chunks
            chunks = results.get('chunks', [])

            # Now, add each of the returned chunks to our overall chunk list
            for chunk in chunks:
                self.chunks.append(chunk)

        def _add_chunk(chunk: Dict[str, any], table_id: int = 0):
            nonlocal chunk_counter, documents

            # Get all the necessary fields from the chunk
            content = chunk.get('content', '').strip()
            isSummary = chunk.get('summary', False)
            isTable = chunk.get('table', False)

            # Build the metadata
            metadata = DocMetadata(
                self,
                chunkId=chunk_counter,
                isSummary=isSummary,
                isTable=isTable,
                tableId=table_id,
                isDeleted=False,
            )

            # Create the document
            doc = Doc(page_content=content, type='Document', metadata=metadata)
            documents.append(doc)

            # One more chunk
            chunk_counter += 1

        # Process create chunk and create and add it to the documents list
        for chunk in self.chunks:
            # Get all the necessary fields from the chunk
            content = chunk.get('content', '').strip()
            isTable = chunk.get('table', False)

            # If we don't have content, skip this chunk
            if not content:
                continue

            # If we are a table or not...
            if not isTable:
                # Just add this chunk
                _add_chunk(chunk)
            else:
                # We must smart split it
                table_chunks = self._split_table(content)

                # For each table chunk, add a document
                for table_chunk in table_chunks:
                    # Create a new chunk with the table content
                    _add_chunk({'content': table_chunk, 'table': True}, table_id)

                # Move to the next table
                table_id += 1

        # Emit all the chunk documents
        if documents:
            self.instance.writeDocuments(documents)
