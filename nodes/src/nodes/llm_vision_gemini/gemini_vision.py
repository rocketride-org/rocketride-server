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

import os
import time
import base64
import threading
from depends import depends  # type: ignore
from typing import Any, Dict
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config
from rocketlib import warning

# Load requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from google import genai
from google.genai.types import Part, Content


class Chat(ChatBase):
    """Google Gemini Vision chat for general-purpose image analysis."""

    _model: str = ''
    _client: genai.Client
    _system_prompt: str = ''
    _prompt: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Gemini Vision chat instance."""
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)

        self._model = config.get('model', 'models/gemini-2.5-flash')
        api_key = config.get('apikey')

        self._system_prompt = config.get('vision.systemPrompt') or config.get('systemPrompt') or ''
        self._prompt = config.get('vision.prompt') or config.get('prompt') or 'Describe this image in detail.'

        if not api_key:
            raise ValueError('Missing Google AI API key. Get one at https://aistudio.google.com/apikey')
        if api_key.startswith('sk-'):
            raise ValueError('Invalid API key format. This appears to be an OpenAI key. Please provide a Google AI API key.')
        if not api_key.startswith('AI'):
            raise ValueError('Invalid Gemini API key format. Google AI API keys start with "AI". Please check your API key at https://aistudio.google.com/apikey')

        try:
            self._api_key = api_key
            self._client = genai.Client(api_key=api_key)
        except Exception as e:
            raise ValueError(f'Failed to initialize Google AI client: {e!s}') from e

        self._modelTotalTokens = config.get('modelTotalTokens', 1048576)
        bag['chat'] = self

    def getTotalTokens(self) -> int:
        """Get the total token limit for the current model."""
        return self._modelTotalTokens

    def getTokens(self, value: str) -> int:
        """Approximate token count (4 chars per token heuristic)."""
        if not value.strip():
            return 0
        return len(value) // 4

    def _format_user_error(self, error_msg: str) -> str:
        """Convert API error messages to user-friendly format."""
        error_lower = error_msg.lower()
        if any(p in error_lower for p in ['unauthorized', 'invalid api key', 'authentication', 'api_key']):
            return 'Authentication failed. Please check your Google AI API key.'
        if any(p in error_lower for p in ['rate limit', 'too many requests', '429', 'quota']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'
        if any(p in error_lower for p in ['billing', 'insufficient', 'credits']):
            return 'API quota exceeded or billing issue. Please check your Google AI account status.'
        if any(p in error_lower for p in ['invalid input', 'bad request', '400']):
            return 'Invalid input. Please check your image format and prompt.'
        if any(p in error_lower for p in ['model not found', 'unavailable', 'not supported']):
            return f"Model '{self._model}' is currently unavailable. Please try a different model."
        if any(p in error_lower for p in ['timeout', 'timed out']):
            return 'Request timed out. Please try again.'
        if any(p in error_lower for p in ['content policy', 'safety', 'blocked']):
            return 'Image was blocked by safety filters. Please try a different image.'
        if any(p in error_lower for p in ['internal server error', '500', '502', '503', '504']):
            return 'Google AI vision service is temporarily unavailable. Please try again later.'
        return f'Google AI error: {error_msg}'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()
        retryable = ['timeout', 'timed out', 'connection', '500', '502', '503', '504', 'internal server error', 'service unavailable']
        return any(p in error_msg for p in retryable)

    def chat(self, question: Question) -> Answer:
        """Send an image to Gemini Vision and get the response."""
        max_retries = 1
        base_delay = 1.0
        last_error = None

        # Extract image data from context
        image_data = None
        prompt_text = self._prompt
        for context_item in question.context:
            if context_item.startswith(('data:image/', 'data:application/')):
                image_data = context_item
                break

        if question.questions and len(question.questions) > 0:
            prompt_text = question.questions[0].text

        if not image_data:
            raise ValueError('No image provided. Please connect an image source to this node.')

        # Parse the data URL once outside the retry loop
        try:
            header, b64_data = image_data.split(',', 1)
            mime_type = header.split(':')[1].split(';')[0]
            image_bytes = base64.b64decode(b64_data)
        except (ValueError, IndexError, base64.binascii.Error) as e:
            raise ValueError('Malformed image data URL. Expected format: data:<mime>;base64,<data>') from e

        # Build request contents once (deterministic, no need to rebuild per retry)
        contents = [
            Content(
                role='user',
                parts=[
                    Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    Part.from_text(text=prompt_text),
                ],
            )
        ]

        generate_config: Dict[str, Any] = {}
        if self._system_prompt:
            generate_config['system_instruction'] = self._system_prompt

        hard_timeout = 30

        for attempt in range(max_retries + 1):
            try:
                result = [None]
                exc = [None]

                def _invoke():
                    try:
                        # Fresh client per call — isolates the httpx session so concurrent
                        # calls from multiple threads don't share a non-thread-safe connection
                        client = genai.Client(api_key=self._api_key)
                        result[0] = client.models.generate_content(
                            model=self._model,
                            contents=contents,
                            config=generate_config if generate_config else None,
                        )
                    except Exception as e:
                        exc[0] = e

                t = threading.Thread(target=_invoke, daemon=True)
                t.start()
                t.join(timeout=hard_timeout)
                if t.is_alive():
                    warning(f'Gemini Vision: inference timed out after {hard_timeout}s (attempt {attempt + 1}/{max_retries + 1}) — daemon thread still running')
                    raise TimeoutError(f'Vision inference timed out after {hard_timeout}s (attempt {attempt + 1})')
                if exc[0]:
                    raise exc[0]

                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(result[0].text)
                return answer
            except Exception as e:
                last_error = e
                # Don't spin on repeated timeouts — a second 30s wait is enough.
                if isinstance(e, TimeoutError) and attempt >= 1:
                    break
                if attempt < max_retries and self._shouldRetry(e):
                    delay = base_delay * (2**attempt)
                    time.sleep(delay)
                    continue
                break

        user_friendly_error = self._format_user_error(str(last_error))
        raise Exception(user_friendly_error) from last_error
