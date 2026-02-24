# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
AI Question and Chat System for RocketRide.

This module provides classes for asking questions to RocketRide's AI, managing chat conversations,
and handling both text and structured JSON responses. Use these classes to build intelligent
applications that can query your documents and data.

Basic Usage:
    from rocketride.schema import Question, DocFilter

    # Simple question
    question = Question()
    question.addQuestion("What are the key findings in the research papers?")
    response = await client.chat(token="chat_token", question=question)

    # Structured JSON response
    question = Question(expectJson=True)
    question.addQuestion("Extract the sales figures by quarter")
    question.addExample("Show Q1 sales", {"Q1": 100000, "Q2": 150000})
    response = await client.chat(token="chat_token", question=question)

Advanced Usage:
    # Question with context and examples
    question = Question()
    question.addInstruction("Analysis", "Focus on financial metrics and trends")
    question.addExample("Revenue analysis", "Total revenue increased 15% year-over-year")
    question.addContext("This is quarterly financial data from 2024")
    question.addQuestion("What were the main revenue drivers?")
"""

import json
import re
from enum import Enum
from typing import Union, List, Dict, Optional, Any
from pydantic import BaseModel, Field, field_validator
from .doc import Doc
from .doc_filter import DocFilter


class Answer(BaseModel):
    """
    Handles AI responses from RocketRide chat operations.

    The Answer class manages both text and JSON responses from the AI,
    providing automatic parsing and validation. You typically receive
    Answer objects from chat operations rather than creating them directly.

    Supports both simple text responses and structured JSON data,
    with automatic format detection and conversion utilities.

    Example:
        response = await client.chat(token="chat_token", question=question)
        answer = response['data']['answer']

        # Get response as text
        text_response = answer.getText()
        print(text_response)

        # If expecting JSON, get structured data
        if answer.isJson():
            data = answer.getJson()
            print(data['sales_total'])
    """

    answer: Optional[Union[str, dict, list]] = None
    expectJson: bool = False

    @field_validator('answer', mode='before')
    @classmethod
    def prohibit_answer_on_creation(cls, value):
        """Prevent setting answer during object creation - answers come from the AI."""
        if value is not None:
            raise ValueError("Field 'answer' cannot be set during creation")
        return value

    def parseJson(self, value: str) -> Any:
        """
        Parse AI response text into JSON structure.

        Handles common AI response formats including code blocks,
        thinking steps, and various JSON delimiters that AI models
        might use in their responses.

        Args:
            value: Raw text response from AI that should contain JSON

        Returns:
            Parsed JSON object (dict, list, or primitive)

        Raises:
            json.JSONDecodeError: If the text doesn't contain valid JSON
        """
        # Clean up the response text
        value = value.strip()
        value = value.replace('\r', '')
        value = value.replace('\n', '')
        value = value.replace('\t', ' ')

        # Remove JSON code block markers if present
        offset = value.find('```json')
        if offset >= 0:
            value = value[offset + 7 :].strip()
            offset = value.rfind('```')
            if offset >= 0:
                value = value[:offset].strip()

        # Remove generic code block markers
        offset = value.find('```')
        if offset >= 0:
            value = value[offset + 3 :].strip()
            offset = value.rfind('```')
            if offset >= 0:
                value = value[:offset].strip()

        # Remove AI thinking steps (common with some models)
        value = re.sub(r'<think>.*?</think>', '', value, flags=re.DOTALL).strip()

        # Parse the cleaned JSON
        return json.loads(value)

    def parsePython(self, value: str) -> Any:
        """
        Extract Python code from AI response.

        Removes code block markers and returns clean Python code.
        Used when AI returns Python code snippets in responses.

        Args:
            value: AI response containing Python code

        Returns:
            Clean Python code string
        """
        offset = value.find('```python')
        if offset >= 0:
            value = value[offset + 9 :]
            offset = value.rfind('```')
            if offset >= 0:
                value = value[:offset]
        return value

    def setAnswer(self, value: Union[str, dict, list]):
        """
        Set the AI response value (used internally by the system).

        Args:
            value: The response from the AI - text, dict, or list
        """
        if self.expectJson:
            if isinstance(value, (dict, list)):
                self.answer = value
                return
            if isinstance(value, str):
                try:
                    value = self.parseJson(value)
                    self.answer = value
                    return
                except json.JSONDecodeError:
                    raise ValueError('Expected a JSON-compatible answer (dict or list).')
            raise ValueError('Expected a JSON-compatible answer (dict or list).')
        else:
            if isinstance(value, (dict, list)):
                self.answer = json.dumps(value)
                return
            if isinstance(value, str):
                self.answer = value
                return
            raise ValueError('Answer must be text, dict, or list.')

    def getText(self) -> str:
        """
        Get the response as plain text.

        Returns:
            str: Text representation of the answer

        Example:
            response_text = answer.getText()
            print(f"AI said: {response_text}")
        """
        if self.answer is None:
            return ''
        if isinstance(self.answer, (dict, list)):
            return json.dumps(self.answer)
        return str(self.answer)

    def getJson(self) -> Optional[Dict]:
        """
        Get the response as structured JSON data.

        Returns:
            Dict or List: Parsed JSON structure, or None if not JSON

        Raises:
            ValueError: If the answer is not valid JSON

        Example:
            if answer.isJson():
                data = answer.getJson()
                sales_data = data['quarterly_sales']
        """
        if self.answer is None:
            return None
        if isinstance(self.answer, (dict, list)):
            return self.answer
        try:
            return json.loads(self.answer)
        except json.JSONDecodeError:
            raise ValueError('Answer is not in JSON format.')

    def isJson(self) -> bool:
        """
        Check if this answer contains JSON data.

        Returns:
            bool: True if answer is expected to be JSON format
        """
        return self.expectJson


class QuestionHistory(BaseModel):
    """
    Represents a single message in a chat conversation history.

    Used to maintain conversation context across multiple exchanges
    with the AI. Each message has a role (user, system, assistant)
    and content.

    Attributes:
        role: Who sent this message ('user', 'system', or 'assistant')
        content: The actual message content

    Example:
        # Building conversation history
        history = [
            QuestionHistory(role="user", content="What is machine learning?"),
            QuestionHistory(role="assistant", content="Machine learning is..."),
            QuestionHistory(role="user", content="Give me examples")
        ]
    """

    role: str  # 'user', 'system', or 'assistant'
    content: str  # The message content


class QuestionInstruction(BaseModel):
    """
    Provides specific instructions to guide the AI's response.

    Instructions help you get better, more focused answers by telling
    the AI exactly how you want it to respond, what to focus on,
    and what format to use.

    Attributes:
        subtitle: Brief description of what this instruction is about
        instructions: Detailed guidance for the AI

    Example:
        instruction = QuestionInstruction(
            subtitle="Response Format",
            instructions="Provide a concise summary followed by bullet points"
        )
    """

    subtitle: str  # Brief title for this instruction
    instructions: str  # Detailed instruction text


class QuestionExample(BaseModel):
    """
    Shows the AI an example of the kind of response you want.

    Examples are powerful for getting consistent, well-formatted responses.
    The AI will try to match the style and format of your examples.

    Attributes:
        given: Example question or input
        result: Example response you want for that input

    Example:
        example = QuestionExample(
            given="What was Q1 revenue?",
            result='{"Q1_revenue": 1250000, "currency": "USD"}'
        )
    """

    given: str  # Example input/question
    result: str  # Example output/response


class QuestionText(BaseModel):
    """
    Represents a single question with optional AI embeddings.

    Used internally to store questions along with their vector
    representations for semantic search and processing.

    Attributes:
        text: The actual question text
        embedding_model: AI model used for creating embeddings (if any)
        embedding: Vector representation of the question (if any)
    """

    text: str  # The question text
    embedding_model: Optional[str] = None  # Model name for embeddings
    embedding: Optional[List[float]] = None  # Vector representation


class QuestionType(str, Enum):
    """
    Defines different types of questions and queries you can ask.

    Different question types use different processing approaches
    for optimal results.

    Values:
        QUESTION: Basic question-answering
        SEMANTIC: Uses meaning-based search and understanding
        KEYWORD: Uses keyword matching and text search
        GET: Retrieves specific information or data
        PROMPT: Raw prompt without additional processing
    """

    QUESTION = 'question'  # Basic question-answering
    SEMANTIC = 'semantic'  # Semantic search and understanding
    KEYWORD = 'keyword'  # Keyword-based search
    GET = 'get'  # Information retrieval
    PROMPT = 'prompt'  # Raw prompt processing


class Question(BaseModel):
    """
    Main class for asking questions to RocketRide's AI system.

    Use Question to ask the AI about your documents, get analysis,
    extract information, and have conversations. Supports both simple
    text questions and complex queries with examples, context, and
    structured JSON responses.

    The Question class is your primary interface for AI interactions,
    supporting everything from simple queries to sophisticated analysis
    with custom instructions and response formats.

    Basic Usage:
        # Simple question
        q = Question()
        q.addQuestion("What are the main themes in these documents?")

        # Question with JSON response
        q = Question(expectJson=True)
        q.addQuestion("Extract all email addresses")
        q.addExample("Find contacts", ["john@company.com", "mary@corp.org"])

        # Question with context and instructions
        q = Question()
        q.addInstruction("Focus", "Look only at financial data")
        q.addContext("These are quarterly reports from 2024")
        q.addQuestion("What were the revenue trends?")

    Advanced Features:
        - Conversation history for multi-turn chat
        - Custom instructions for response style
        - Examples for consistent formatting
        - Document filtering and search controls
        - JSON schema validation for structured responses

    Attributes:
        type: The type of question/query (semantic, keyword, etc.)
        filter: Controls which documents to search and how
        expectJson: Whether to return structured JSON data
        role: AI role/persona for the conversation
        instructions: List of custom instructions for the AI
        history: Previous conversation messages
        examples: Example question/answer pairs for consistency
        context: Additional context information
        documents: Specific documents to reference
        questions: List of questions to ask
    """

    type: QuestionType = Field(QuestionType.QUESTION, description='Type of question - question uses basic Q&A, semantic uses AI understanding, keyword uses text matching.')
    filter: Optional[DocFilter] = Field(default_factory=DocFilter, description='Controls which documents to search and how to process results.')
    expectJson: Optional[bool] = Field(False, description='Set to True to get structured JSON responses instead of text.')
    role: Optional[str] = Field('', description='AI role or persona for the conversation (e.g., "You are a financial analyst").')
    instructions: Optional[List[QuestionInstruction]] = Field(default_factory=list, description='Custom instructions to guide the AI response.')
    history: Optional[List[QuestionHistory]] = Field(default_factory=list, description='Previous messages in this conversation for context.')
    examples: Optional[List[QuestionExample]] = Field(default_factory=list, description='Example question/answer pairs to show desired response format.')
    context: Optional[List[str]] = Field(default_factory=list, description='Additional context information to help the AI understand your question.')
    documents: Optional[List[Doc]] = Field(default_factory=list, description='Specific documents to reference when answering.')
    questions: Optional[List[QuestionText]] = Field(default_factory=list, description='List of questions to ask (usually just one).')

    def addInstruction(self, title: str, instruction: str):
        """
        Add a custom instruction to guide the AI's response.

        Instructions help you get better answers by telling the AI
        exactly what you want, how to format the response, what to
        focus on, etc.

        Args:
            title: Brief title for this instruction
            instruction: Detailed instruction text

        Example:
            question.addInstruction("Format", "Use bullet points for key findings")
            question.addInstruction("Focus", "Emphasize financial metrics")
        """
        self.instructions.append(QuestionInstruction(subtitle=title, instructions=instruction))

    def addExample(self, given: str, result: Union[dict, list, str]):
        """
        Add an example to show the AI the kind of response you want.

        Examples are very effective for getting consistent, well-formatted
        responses. The AI will try to match your examples.

        Args:
            given: Example question or input
            result: Example response (can be text, dict, or list)

        Example:
            question.addExample("What is the revenue?", "Total revenue was $1.2M")
            question.addExample("Show sales by region", {"North": 500000, "South": 700000})
        """
        if isinstance(result, (dict, list)):
            result = json.dumps(result)
        self.examples.append(QuestionExample(given=given, result=result))

    def addContext(self, context: Union[str, dict, List[str], List[dict]]):
        """
        Add context information to help the AI understand your question better.

        Context helps the AI understand the background, domain, time period,
        or other important information about your question.

        Args:
            context: Context information - can be strings, dicts, or lists

        Example:
            question.addContext("This data is from Q4 2024 financial reports")
            question.addContext({"company": "TechCorp", "year": 2024, "department": "Sales"})
        """
        if not isinstance(context, list):
            context = [context]

        for item in context:
            if isinstance(item, str):
                self.context.append(item)
            elif isinstance(item, (dict, list)):
                self.context.append(str(item))
            else:
                raise Exception(f'Context item must be string, dict, or list, not {type(item).__name__}')

    def addHistory(self, item: QuestionHistory):
        """
        Add a conversation history item for multi-turn chat.

        Use this to maintain context across multiple questions
        in a conversation.

        Args:
            item: A QuestionHistory object with role and content

        Example:
            question.addHistory(QuestionHistory(role="user", content="What is ML?"))
            question.addHistory(QuestionHistory(role="assistant", content="Machine learning is..."))
        """
        self.history.append(item)

    def addQuestion(self, question: str):
        """
        Add a question to ask the AI.

        This is the main question you want answered. Most Question
        objects have just one question.

        Args:
            question: The question text to ask

        Example:
            question.addQuestion("What are the key findings in these reports?")
        """
        self.questions.append(QuestionText(text=question))

    def addDocuments(self, documents: Union[Doc, List[Doc]]):
        """
        Add specific documents for the AI to reference.

        Use this when you want the AI to focus on particular documents
        rather than searching all available content.

        Args:
            documents: Document or list of documents to include

        Example:
            question.addDocuments(search_results[:5])  # Use top 5 results
        """
        if not isinstance(documents, list):
            documents = [documents]

        for item in documents:
            if isinstance(item, str):
                self.documents.append(Doc(chunkId=0, objectId='', page_content=item))
            elif isinstance(item, Doc):
                self.documents.append(item)
            else:
                raise Exception(f'Documents must be Doc objects or strings, not {type(item).__name__}')

    def getPrompt(self, has_previous_json_failed: bool = False) -> str:
        """
        Generate the complete prompt text for the AI (used internally).

        Combines all instructions, examples, context, and questions into
        a formatted prompt that guides the AI to provide the best response.

        Args:
            has_previous_json_failed: Whether a previous JSON parse failed

        Returns:
            str: Complete formatted prompt text
        """
        crlf = '\r\n'
        prompt = ''

        # Helper functions for formatting different sections
        instructionId = 0
        hasOutputInstructions = False

        def addPromptInstruction(instruction: QuestionInstruction):
            nonlocal prompt, instructionId, hasOutputInstructions
            if not hasOutputInstructions:
                prompt += '### Instructions:' + crlf
                hasOutputInstructions = True
            prompt += f'    {instructionId + 1}) **{instruction.subtitle.strip()}**: {instruction.instructions.strip()}' + crlf + crlf
            instructionId += 1

        exampleId = 0

        def addPromptExample(example: QuestionExample):
            nonlocal prompt, exampleId
            json_begin = '```json' + crlf if self.expectJson else ''
            json_end = '```' + crlf if self.expectJson else ''
            prompt += f'    Example {exampleId + 1}' + crlf
            prompt += f'        **Given**: {example.given.strip()}' + crlf
            prompt += f'        **Expected output**: {json_begin}{example.result.strip()}{json_end}'
            exampleId += 1

        contextId = 0
        hasOutputContext = False

        def addPromptContext(context: str):
            nonlocal prompt, contextId, hasOutputContext
            if not hasOutputContext:
                prompt += '### Context:' + crlf
                hasOutputContext = True
            prompt += f'    {contextId + 1}) {context.strip()}' + crlf + crlf
            contextId += 1

        documentId = 0
        hasOutputDocuments = False

        def addPromptDocument(document: Doc):
            nonlocal prompt, documentId, hasOutputDocuments
            if not hasOutputDocuments:
                prompt += '### Documents:' + crlf
                hasOutputDocuments = True
            doc = str(document.toDict()['page_content'])
            prompt += f'    Document {documentId + 1}) Content: {doc.strip()}' + crlf
            documentId += 1

        # Add role if specified
        if self.role:
            prompt += self.role + crlf

        # Add all instructions
        for instruction in self.instructions:
            addPromptInstruction(instruction)

        # Add JSON formatting instructions if needed
        if self.expectJson:
            addPromptInstruction(
                QuestionInstruction(
                    subtitle='JSON Response Format',
                    instructions="""
                    - Respond **only** with a valid JSON structure.
                    - Properly escape all quotes within content strings
                    - No additional text, comments, or explanations.
                    - Ensure your answer is strictly valid JSON format.
                    - Double check the JSON response to ensure it is valid.
                    - Enclose the json with ````json` and ` ``` ` tags.
                    """,
                )
            )

            if has_previous_json_failed:
                addPromptInstruction(
                    QuestionInstruction(
                        subtitle='CRITICAL',
                        instructions="""
                        - Your previous response returned invalid JSON.
                        - Examine your JSON and ensure it is complete and follows the JSON standards.
                        """,
                    )
                )

        # Add examples if provided
        if len(self.examples):
            addPromptInstruction(QuestionInstruction(subtitle='Examples', instructions=''))
            for example in self.examples:
                addPromptExample(example)

        # Add conversation history
        if len(self.history):
            prompt += '### Conversation History:' + crlf
            for item in self.history:
                prompt += f'    {item.role}: {item.content}' + crlf

        # Add questions
        if len(self.questions):
            if len(self.questions) == 1:
                prompt += self.questions[0].text + crlf
            else:
                questionNum = 1
                for question in self.questions:
                    prompt += f'Question {questionNum}: ' + question.text + crlf
                    questionNum += 1

        # Add context
        for context in self.context:
            addPromptContext(context)

        # Add documents
        for document in self.documents:
            addPromptDocument(document)

        return prompt
