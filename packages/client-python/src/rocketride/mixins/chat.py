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
    ) -> PIPELINE_RESULT:
        """
        Ask a question to RocketRide's AI and get an intelligent response.

        This is your main interface for AI conversations. The AI can analyze
        your documents, answer questions, extract structured data, and provide
        insights based on the content you have stored in RocketRide.

        The AI understands context, follows instructions, learns from examples,
        and can provide responses in both natural language and structured JSON.

        Args:
            token: Your pipeline token for authentication and resource access
            question: A Question object containing your query, instructions,
                     examples, and any context you want to provide

        Returns:
            Dict containing the AI response (PIPELINE_RESULT):
            - answers: List of answer strings from the AI
            - result_types: Dictionary mapping field names to types
            - objectId: Unique identifier for this operation
            - name: Question name/identifier
            - path: Processing path

        Raises:
            RuntimeError: If the question is empty or if the chat operation fails

        Example:
            # Simple question
            from rocketride.schema import Question

            question = Question()
            question.addQuestion("What are the key findings in these research papers?")

            response = await client.chat(token="your_token", question=question)
            if 'answers' in response and len(response['answers']) > 0:
                answer_text = response['answers'][0]
                print(f"AI Response: {answer_text}")

            # Structured data extraction (JSON)
            question = Question(expectJson=True)
            question.addQuestion("Extract sales data by quarter")
            question.addExample("Show Q1 data", {"Q1": {"revenue": 100000, "units": 500}})
            question.addInstruction("Format", "Use clear quarter labels and include both revenue and units")

            response = await client.chat(token="your_token", question=question)
            if 'answers' in response and len(response['answers']) > 0:
                sales_data = response['answers'][0]  # Already parsed as dict for JSON responses
                print(f"Q1 Revenue: ${sales_data['Q1']['revenue']:,}")

            # Question with context
            question = Question()
            question.addContext("These are financial reports from TechCorp for 2024")
            question.addQuestion("What were the main revenue drivers this year?")

            response = await client.chat(token="your_token", question=question)
            answer = response['answers'][0]
            print(f"Analysis: {answer}")

        Tips for Better Results:
            - Be specific in your questions
            - Provide examples of the output format you want
            - Add context about the domain, time period, or specific focus
            - Use custom instructions to guide the AI's analysis approach
            - For data extraction, use expectJson=True and provide clear examples
        """
        try:
            # Validate that we have a question to ask
            if not question:
                raise RuntimeError('Question cannot be empty')

            # Create unique identifier for this chat operation
            objinfo = {'name': f'Question {self._next_chat_id}'}
            self._next_chat_id += 1

            # Set up a data pipe to send the question to the AI system
            pipe = await self.pipe(token, objinfo, 'application/rocketride-question', provider='chat')

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
