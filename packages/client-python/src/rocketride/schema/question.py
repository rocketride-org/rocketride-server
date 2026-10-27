# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
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
import textwrap
from enum import Enum
from typing import Annotated, Literal, Union, List, Dict, Optional, Any
from pydantic import BaseModel, Field, TypeAdapter, field_validator, model_serializer, model_validator
from .doc import Doc
from .doc_filter import DocFilter


class Tool(BaseModel):
    """
    A tool the model may call in a turn-mode Question.

    The same shape tool nodes publish. `name` is yours and may contain dots
    (`tool_github_1.create_issue`); the engine maps it to a name the provider
    accepts and maps calls back, so you only ever see your own names.
    """

    name: str = Field(min_length=1)
    description: str = ''
    inputSchema: Dict[str, Any] = Field(default_factory=lambda: {'type': 'object', 'properties': {}})


class TextBlock(BaseModel):
    """Plain text inside a message."""

    type: Literal['text'] = 'text'
    text: str


class ToolCallBlock(BaseModel):
    """
    A call the model asked for. Answer it with a ToolResultBlock carrying the same `id`.

    `args` is a dict when the provider returned valid JSON arguments, and the raw string
    when it did not. Answer a string with an error result rather than guessing.
    """

    type: Literal['tool_call'] = 'tool_call'
    id: str
    name: str
    args: Union[Dict[str, Any], str]


class ToolResultBlock(BaseModel):
    """The result of one tool call, sent back in the next user message."""

    type: Literal['tool_result'] = 'tool_result'
    callId: str
    content: str
    isError: bool = False


class ReasoningBlock(BaseModel):
    """
    Model reasoning the provider needs back on the next request.

    `text` is for display. `state` is opaque provider data (an Anthropic thinking
    signature, an OpenAI encrypted reasoning item); keep it unchanged so tool loops
    with reasoning stay valid.
    """

    type: Literal['reasoning'] = 'reasoning'
    text: str = ''
    state: Any = None


UserBlock = Annotated[Union[TextBlock, ToolResultBlock], Field(discriminator='type')]
AssistantBlock = Annotated[Union[TextBlock, ToolCallBlock, ReasoningBlock], Field(discriminator='type')]


class UserMessage(BaseModel):
    """A user turn: text, and the results of the calls in the assistant turn before it."""

    role: Literal['user'] = 'user'
    content: Union[str, List[UserBlock]]


class AssistantMessage(BaseModel):
    """A model turn: text, tool calls and reasoning. Append it to Question.messages as is."""

    role: Literal['assistant'] = 'assistant'
    content: Union[str, List[AssistantBlock]]


Message = Annotated[Union[UserMessage, AssistantMessage], Field(discriminator='role')]
_MESSAGE = TypeAdapter(Message)

StopReason = Literal['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal']


class AnswerError(BaseModel):
    """
    Why a turn produced no message.

    `tools_unsupported` is decided before any provider call, so it costs no tokens.
    """

    code: Literal['tools_unsupported', 'provider_error']
    message: str


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
    # Turn-total LLM token usage (input/output/cache/model/calls) plus a per-call
    # `breakdown` list; surfaced in the Trace and the action history. Billing is
    # unaffected — it flows through the separate per-call metrics.counter path.
    tokens: Optional[Dict[str, Any]] = None
    # Set only for a turn-mode Question: the model's turn and why it stopped, or the error.
    message: Optional[AssistantMessage] = None
    stopReason: Optional[StopReason] = None
    error: Optional[AnswerError] = None

    @field_validator('answer', mode='before')
    @classmethod
    def prohibit_answer_on_creation(cls, value):
        """Prevent setting answer during object creation - answers come from the AI."""
        if value is not None:
            raise ValueError("Field 'answer' cannot be set during creation")
        return value

    @model_serializer(mode='wrap')
    def _omit_unset_turn_fields(self, handler):
        """Leave the turn fields out of a text answer's dump, so it stays as it was."""
        data = handler(self)
        for key in ('message', 'stopReason', 'error'):
            if data.get(key) is None:
                data.pop(key, None)
        return data

    def toolCalls(self) -> List[ToolCallBlock]:
        """
        Return the calls in this turn, in the order the model made them.

        Empty for a text answer and for a turn that made no calls.
        """
        if self.message is None or isinstance(self.message.content, str):
            return []
        return [block for block in self.message.content if isinstance(block, ToolCallBlock)]

    @classmethod
    def fromResult(cls, result: Dict[str, Any], key: str = 'answers') -> 'Answer':
        """
        Read the answer a turn-mode `client.chat()` call returned.

        Args:
            result: The dict `client.chat()` returned.
            key: The result key the response node wrote to.

        Returns:
            Answer: With `message` and `stopReason` set, or `error` set. A text entry
            (an engine that predates turn mode answers as text) gives a text Answer.
        """
        entry = result[key][-1]
        if isinstance(entry, dict):
            return cls.model_validate(entry)
        answer = cls()
        answer.setAnswer(entry)
        return answer

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
                    self.answer = json.loads(value)
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
            str: Text representation of the answer. For a turn, the text of `message`.

        Example:
            response_text = answer.getText()
            print(f"AI said: {response_text}")
        """
        if self.message is not None:
            content = self.message.content
            if isinstance(content, str):
                return content
            return ''.join(block.text for block in content if isinstance(block, TextBlock))
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
        cachePrefix: Whether the unchanging start of the prompt may be cached
        role: AI role/persona for the conversation
        instructions: List of custom instructions for the AI
        history: Previous conversation messages
        examples: Example question/answer pairs for consistency
        context: Additional context information
        documents: Specific documents to reference
        questions: List of questions to ask
        messages: The conversation; non-empty switches the Question to turn mode
        tools: Tools the model may call (turn mode only)

    Turn mode:
        A non-empty `messages` sends the conversation as real provider turns with
        native tool calling. The system prompt is role + instructions + examples
        (getSystemPrompt); context, documents and goals are added to the last user
        message. history, questions and expectJson are not allowed in this mode.
    """

    type: QuestionType = Field(
        QuestionType.QUESTION,
        description='Type of question - question uses basic Q&A, semantic uses AI understanding, keyword uses text matching.',
    )
    filter: Optional[DocFilter] = Field(
        default_factory=DocFilter, description='Controls which documents to search and how to process results.'
    )
    expectJson: Optional[bool] = Field(
        False, description='Set to True to get structured JSON responses instead of text.'
    )
    cachePrefix: Optional[bool] = Field(
        False,
        description=(
            'Set to True when this prompt will be sent again with only its context, documents, goals or '
            'questions changed (an agent loop). Providers that support prompt caching may then cache the '
            'unchanging start of the prompt. Providers without it ignore this.'
        ),
    )
    role: Optional[str] = Field(
        '', description='AI role or persona for the conversation (e.g., "You are a financial analyst").'
    )
    instructions: Optional[List[QuestionInstruction]] = Field(
        default_factory=list, description='Custom instructions to guide the AI response.'
    )
    history: Optional[List[QuestionHistory]] = Field(
        default_factory=list, description='Previous messages in this conversation for context.'
    )
    examples: Optional[List[QuestionExample]] = Field(
        default_factory=list, description='Example question/answer pairs to show desired response format.'
    )
    context: Optional[List[str]] = Field(
        default_factory=list, description='Additional context information to help the AI understand your question.'
    )
    goals: Optional[List[str]] = Field(
        default_factory=list,
        description='High-level objectives the AI should work towards (rendered as ### Goal before the prompt).',
    )
    documents: Optional[List[Doc]] = Field(
        default_factory=list, description='Specific documents to reference when answering.'
    )
    questions: Optional[List[QuestionText]] = Field(
        default_factory=list, description='List of questions to ask (usually just one).'
    )
    messages: List[Message] = Field(
        default_factory=list,
        description='The conversation, sent as real provider turns. Non-empty switches the Question to turn mode.',
    )
    tools: List[Tool] = Field(default_factory=list, description='Tools the model may call. Turn mode only.')

    @model_serializer(mode='wrap')
    def _omit_empty_turn_fields(self, handler):
        """Leave empty messages and tools out of the dump, so a legacy Question's JSON stays as it was."""
        data = handler(self)
        for key in ('messages', 'tools'):
            if not data.get(key):
                data.pop(key, None)
        return data

    @model_validator(mode='after')
    def _check_turn_on_parse(self) -> 'Question':
        self.checkTurn()
        return self

    def isTurn(self) -> bool:
        """Return True when this Question is in turn mode (non-empty `messages`)."""
        return bool(self.messages)

    def _turn_conflict(self) -> Optional[str]:
        if self.tools and not self.messages:
            return 'tools need messages: put the conversation in messages'
        if not self.messages:
            return None
        for name in ('history', 'questions', 'expectJson'):
            if getattr(self, name):
                return f'{name} cannot be used with messages'
        names = [tool.name for tool in self.tools]
        if len(names) != len(set(names)):
            return 'tool names must be unique'
        return None

    def checkTurn(self):
        """
        Check the turn-mode rules. Parsing runs this; call it after editing fields by hand.

        Raises:
            ValueError: Naming the broken rule.
        """
        problem = self._turn_conflict()
        if problem is None and self.messages and self.messages[-1].role != 'user':
            problem = 'the last message must be a user message'
        if problem:
            raise ValueError(problem)

    def addMessage(self, message: Union[UserMessage, AssistantMessage, Dict[str, Any]]):
        """
        Append a message to the conversation, switching the Question to turn mode.

        Args:
            message: A UserMessage, an AssistantMessage (such as `answer.message`), or the dict form of one.

        Raises:
            ValueError: If the message is malformed or the Question uses a field turn mode does not allow.
        """
        self.messages.append(_MESSAGE.validate_python(message))
        problem = self._turn_conflict()
        if problem:
            self.messages.pop()
            raise ValueError(problem)

    def addToolResult(self, callId: str, content: str, isError: bool = False):
        """
        Add the result of a tool call to the user message that answers it.

        Opens that user message after an assistant turn, or adds to it if open.

        Args:
            callId: The `id` of the ToolCallBlock this answers.
            content: The result, as text.
            isError: True when the tool failed; the model sees it as an error.

        Raises:
            ValueError: If no assistant turn before it made a call with this id.
        """
        tail = self.messages[-1] if self.messages else None
        asked = self.messages[-2] if tail is not None and tail.role == 'user' and len(self.messages) > 1 else tail
        calls = asked.content if asked is not None and asked.role == 'assistant' else []
        if isinstance(calls, str) or not any(getattr(block, 'id', None) == callId for block in calls):
            raise ValueError(f'no tool call {callId!r} in the last assistant message')
        result = ToolResultBlock(callId=callId, content=content, isError=isError)
        if tail is asked:
            self.messages.append(UserMessage(content=[result]))
        elif isinstance(tail.content, str):
            tail.content = [TextBlock(text=tail.content), result]
        else:
            tail.content.append(result)

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

    def addGoal(self, goal: str):
        """
        Add a high-level goal or objective for the AI to work towards.

        Goals describe what the user ultimately wants to achieve and are
        rendered in the prompt as a dedicated ### Goal section, separate
        from the step-specific prompt instructions.

        Args:
            goal: The goal or objective text

        Example:
            question.addGoal("Find all revenue trends in the quarterly reports")
        """
        self.goals.append(goal)

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
        Generate the complete prompt text for the AI.

        Combines all instructions, examples, context, and questions into
        a formatted prompt that guides the AI to provide the best response.

        Args:
            has_previous_json_failed: Whether a previous JSON parse failed

        Returns:
            str: Complete formatted prompt text
        """
        crlf = '\r\n'
        parts = self._system_parts(has_previous_json_failed)

        # --- Conversation history ---
        if self.history:
            lines = ['### Conversation History:']
            for item in self.history:
                lines.append(f'    {item.role}: {item.content}')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))

        parts.extend(self._material_parts())

        # --- Questions ---
        if self.questions:
            lines = ['### Current Task:']
            for q in self.questions:
                lines.append(f'    {q.text}')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))

        parts.append('')  # blank line after
        return crlf.join(parts)

    def getSystemPrompt(self) -> str:
        """
        Return the system prompt of a turn: role, instructions and examples.

        Rendered exactly as the start of getPrompt().

        Returns:
            str: The system prompt, or '' when the Question has none of the three.
        """
        return '\r\n'.join(self._system_parts(False))

    def getTurnMessages(self) -> List[Union[UserMessage, AssistantMessage]]:
        """
        Return the conversation to send for a turn.

        `messages`, with context, documents and goals added to the last user message
        as one more text block, so the cacheable start of the conversation stays the same.

        Returns:
            List: The messages to send.
        """
        material = '\r\n'.join(self._material_parts()).strip()
        if not material:
            return list(self.messages)
        last = self.messages[-1]
        content = [TextBlock(text=last.content)] if isinstance(last.content, str) else list(last.content)
        return [*self.messages[:-1], UserMessage(content=[*content, TextBlock(text=material)])]

    def _system_parts(self, has_previous_json_failed: bool) -> List[str]:
        crlf = '\r\n'
        parts: List[str] = []

        # Role
        if self.role:
            parts.append(f'{self.role}{crlf}')

        # --- Instructions ---
        all_instructions: List[QuestionInstruction] = []

        # JSON formatting
        if self.expectJson:
            all_instructions.append(
                QuestionInstruction(
                    subtitle='JSON Response Format',
                    instructions=(
                        '- Respond **only** with a fenced, valid JSON structure.\r\n'
                        '- Properly escape all quotes within content strings.\r\n'
                        '- No additional text, comments, or explanations.\r\n'
                        '- Ensure your answer is strictly valid JSON format.\r\n'
                        '- Double check the JSON response to ensure it is valid.\r\n'
                        '- Enclose the json with ```json and ``` tags.'
                    ),
                )
            )
            if has_previous_json_failed:
                all_instructions.append(
                    QuestionInstruction(
                        subtitle='CRITICAL',
                        instructions=(
                            '- Your previous response returned invalid JSON.\r\n- Examine your JSON and ensure it is complete and follows the JSON standards.'
                        ),
                    )
                )

        # User-provided instructions
        all_instructions.extend(self.instructions)

        if all_instructions:
            lines = ['### System Instructions:']
            for i, inst in enumerate(all_instructions, 1):
                lines.append(f'    {i}) **{inst.subtitle.strip()}**:')
                # Keep each line's indentation relative to its block, so a code example
                # keeps its nesting. dedent removes only the indentation every non-blank
                # line shares. It knows only \n as a line break, so every ending that
                # splitlines() accepts (\r\n, a lone \r) is made \n first.
                text = '\n'.join(inst.instructions.splitlines())
                for line in textwrap.dedent(text).splitlines():
                    if line.strip():
                        lines.append(f'        {line.rstrip()}')
                lines.append('')  # blank line after each instruction
            parts.append(crlf.join(lines))

        # --- Examples ---
        if self.examples:
            json_begin = '```json' + crlf if self.expectJson else ''
            json_end = crlf + '```' if self.expectJson else ''
            lines = ['### Examples:']
            for i, ex in enumerate(self.examples, 1):
                lines.append(f'    Example {i}')
                lines.append(f'        **Given**: {ex.given.strip()}')
                lines.append(f'        **Expected output**: {json_begin}{ex.result.strip()}{json_end}')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))
        return parts

    def _material_parts(self) -> List[str]:
        crlf = '\r\n'
        parts: List[str] = []

        # --- Context ---
        if self.context:
            lines = ['### Context:']
            for i, ctx in enumerate(self.context, 1):
                lines.append(f'    {i}) {ctx.strip()}')
                lines.append('')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))

        # --- Documents ---
        if self.documents:
            lines = ['### Documents:']
            for i, doc in enumerate(self.documents, 1):
                content = str(doc.toDict()['page_content'])
                lines.append(f'    Document {i}) Content: {content.strip()}')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))

        # --- Goals ---
        if self.goals:
            lines = ['### Ultimate Goal:']
            for i, goal in enumerate(self.goals, 1):
                lines.append(f'    {i}) {goal.strip()}')
            lines.append('')  # blank line after
            parts.append(crlf.join(lines))
        return parts
