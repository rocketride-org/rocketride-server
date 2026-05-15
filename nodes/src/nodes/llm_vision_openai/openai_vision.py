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

import openai as openai_sdk


class Chat(ChatBase):
    """OpenAI Vision chat for general-purpose image analysis."""

    _model: str = ''
    _api_key: str = ''
    _system_prompt: str = ''
    _prompt: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the OpenAI Vision chat instance."""
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)

        self._model = config.get('model', 'gpt-4o')
        api_key = config.get('apikey')

        self._system_prompt = config.get('vision.systemPrompt') or config.get('systemPrompt') or ''
        self._prompt = config.get('vision.prompt') or config.get('prompt') or 'Describe this image in detail.'

        if not api_key:
            raise ValueError('Missing OpenAI API key. Get one at https://platform.openai.com/api-keys')
        if not api_key.startswith('sk-'):
            raise ValueError('Invalid OpenAI API key format. Keys should start with "sk-". Please check your key at https://platform.openai.com/api-keys')

        self._api_key = api_key
        self._modelTotalTokens = config.get('modelTotalTokens', 128000)
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
        if any(p in error_lower for p in ['authentication', 'invalid api key', 'incorrect api key', 'unauthorized']):
            return 'Authentication failed. Please check your OpenAI API key.'
        if any(p in error_lower for p in ['rate limit', 'too many requests', '429']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'
        if any(p in error_lower for p in ['quota', 'billing', 'insufficient', 'credit']):
            return 'API quota exceeded or billing issue. Please check your OpenAI account status.'
        if any(p in error_lower for p in ['invalid request', 'bad request', '400']):
            return 'Invalid input. Please check your image format and prompt.'
        if any(p in error_lower for p in ['model not found', 'not found', '404']):
            return f"Model '{self._model}' not found. Please check the model name."
        if any(p in error_lower for p in ['timeout', 'timed out']):
            return 'Request timed out. Please try again.'
        if any(p in error_lower for p in ['server error', '500', '502', '503', '504']):
            return 'OpenAI API is temporarily unavailable. Please try again later.'
        return f'OpenAI error: {error_msg}'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        # Use typed checks for OpenAI SDK exceptions first — more reliable than string matching
        if isinstance(error, openai_sdk.RateLimitError):
            return True
        if isinstance(error, openai_sdk.APIConnectionError):
            return True
        error_msg = str(error).lower()
        retryable = ['timeout', 'timed out', '500', '502', '503', '504', 'server error']
        return any(p in error_msg for p in retryable)

    def chat(self, question: Question) -> Answer:
        """Send an image to OpenAI Vision and get the response."""
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

        # Validate the data URL is well-formed before entering the retry loop
        try:
            _header, _ = image_data.split(',', 1)
            _header.split(':')[1].split(';')[0]  # ensure mime type segment exists
        except (ValueError, IndexError) as e:
            raise ValueError('Malformed image data URL. Expected format: data:<mime>;base64,<data>') from e

        hard_timeout = 30

        for attempt in range(max_retries + 1):
            try:
                result = [None]
                exc = [None]

                def _invoke():
                    try:
                        # Fresh client per attempt — avoids exhausting the shared HTTP connection
                        # pool when daemon threads from prior timed-out attempts are still running
                        client = openai_sdk.OpenAI(api_key=self._api_key, max_retries=0)

                        content = [
                            {
                                'type': 'image_url',
                                'image_url': {
                                    'url': image_data,
                                    'detail': 'auto',
                                },
                            },
                            {'type': 'text', 'text': prompt_text},
                        ]

                        messages = []
                        if self._system_prompt:
                            messages.append({'role': 'system', 'content': self._system_prompt})
                        messages.append({'role': 'user', 'content': content})

                        result[0] = client.chat.completions.create(
                            model=self._model,
                            messages=messages,
                        )
                    except Exception as e:
                        exc[0] = e

                t = threading.Thread(target=_invoke, daemon=True)
                t.start()
                t.join(timeout=hard_timeout)
                if t.is_alive():
                    warning(f'OpenAI Vision: inference timed out after {hard_timeout}s (attempt {attempt + 1}/{max_retries + 1}) — daemon thread still running')
                    raise TimeoutError(f'Vision inference timed out after {hard_timeout}s (attempt {attempt + 1})')
                if exc[0]:
                    raise exc[0]

                response = result[0]
                if not response.choices:
                    raise ValueError('OpenAI returned an empty response')
                text = response.choices[0].message.content or ''
                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(text)
                return answer
            except Exception as e:
                last_error = e
                # Don't spin on repeated timeouts — a second 30s wait is enough.
                if isinstance(e, TimeoutError) and attempt >= 1:
                    break
                if attempt < max_retries and self._shouldRetry(e):
                    if isinstance(e, openai_sdk.RateLimitError):
                        # Respect the retry-after header; default to 60s if absent.
                        retry_after = 60
                        try:
                            retry_after = int(e.response.headers.get('retry-after', 60))
                        except Exception:
                            pass
                        warning(f'OpenAI Vision: rate limited — waiting {retry_after}s before retry')
                        time.sleep(retry_after)
                    else:
                        time.sleep(base_delay * (2**attempt))
                    continue
                break

        user_friendly_error = self._format_user_error(str(last_error))
        raise Exception(user_friendly_error) from last_error
