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
AI Chat Functionality for RocketRide Client.

This module provides chat capabilities for asking questions to RocketRide's AI system.
Use this to have conversations with AI about your documents, get analysis,
extract information, and receive both text and structured responses.

The chat system supports:
- Natural language questions about your documents
- Structured JSON responses for data extraction
- Context-aware conversations with history
- Custom instructions and examples for better responses

Usage:
    from rocketride.schema import Question

    # Simple chat
    question = Question()
    question.addQuestion("What are the main themes in these documents?")
    response = await client.chat(token="your_token", question=question)
    answer_text = response['data']['answer'].getText()

    # Structured data extraction
    question = Question(expectJson=True)
    question.addQuestion("Extract all email addresses and phone numbers")
    question.addExample("Find contacts", {"emails": ["john@company.com"], "phones": ["555-1234"]})
    response = await client.chat(token="your_token", question=question)
    structured_data = response['data']['answer'].getJson()
"""

from ..core import DAPClient
from ..schema import Question
from ..types import PIPELINE_RESULT

try:
    import json5
except ImportError:
    json5 = None


class ChatMixin(DAPClient):
    """
    Provides AI chat capabilities for the RocketRide client.

    This mixin adds the ability to ask questions to RocketRide's AI system,
    which can analyze your documents, extract information, and provide
    insights based on your data. The AI can understand natural language
    questions and provide responses in both text and structured formats.

    The chat system works by:
    1. Taking your Question object with instructions, examples, and context
    2. Sending it to the AI through a data pipe
    3. Returning the AI's response in the format you requested

    This is automatically included when you use RocketRideClient, so you can
    call client.chat() directly without needing to import this mixin.
    """

    def __init__(self, **kwargs):
        """Initialize the chat functionality."""
        super().__init__(**kwargs)
        self._next_chat_id = 1

    async def chat(
        self,
        *,
        token: str,
        question: Question,
        on_sse=None,
    ) -> PIPELINE_RESULT:
        """
        Send a Question to RocketRide's AI pipeline and return the pipeline result.
        
        Parameters:
            token (str): Pipeline authentication/resource token.
            question (Question): Question object containing the query, instructions, examples, and any context to send to the AI.
            on_sse (callable, optional): Callback for server-sent events from the pipeline.
        
        Returns:
            PIPELINE_RESULT: Dictionary containing the AI response; typically includes keys such as `answers` (list of answer strings or parsed JSON objects), `result_types` (field type mappings), `objectId`, `name`, and `path`.
        
        Raises:
            RuntimeError: If `question` is empty.
        """
        try:
            # Validate that we have a question to ask
            if not question:
                raise RuntimeError('Question cannot be empty')

            # Create unique identifier for this chat operation
            objinfo = {'name': f'Question {self._next_chat_id}'}
            self._next_chat_id += 1

            # Set up a data pipe to send the question to the AI system
            pipe = await self.pipe(token, objinfo, 'application/rocketride-question', provider='chat', on_sse=on_sse)

            try:
                # Open the communication channel to the AI
                await pipe.open()

                # Send the question as JSON data to the AI system
                question_json = question.model_dump_json()
                await pipe.write(bytes(question_json, 'utf-8'))

                # Close the pipe and get the AI's response
                result = await pipe.close()

                # Return success response in standard format
                return result

            finally:
                # Ensure the pipe is properly closed even if errors occur
                if pipe.is_opened:
                    try:
                        await pipe.close()
                    except Exception:
                        pass  # Ignore errors during cleanup

        except Exception as exc:
            # Just use it
            exc

            # Reraise it
            raise
