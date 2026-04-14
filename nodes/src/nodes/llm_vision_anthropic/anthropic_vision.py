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

import anthropic as anthropic_sdk


class Chat(ChatBase):
    """Anthropic Claude Vision chat for general-purpose image analysis."""

    _model: str = ''
    _api_key: str = ''
    _system_prompt: str = ''
    _prompt: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Anthropic Vision chat instance."""
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)

        self._model = config.get('model', 'claude-opus-4-6')
        api_key = config.get('apikey')

        self._system_prompt = config.get('vision.systemPrompt') or config.get('systemPrompt') or ''
        self._prompt = config.get('vision.prompt') or config.get('prompt') or 'Describe this image in detail.'

        if not api_key:
            raise ValueError('Missing Anthropic API key. Get one at https://console.anthropic.com')
        if not api_key.startswith('sk-ant-'):
            raise ValueError('Invalid Anthropic API key format. Keys should start with "sk-ant-". Please check your key at https://console.anthropic.com')

        self._api_key = api_key
        self._modelTotalTokens = config.get('modelTotalTokens', 200000)
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
        if any(p in error_lower for p in ['authentication', 'invalid x-api-key', 'api_key', 'unauthorized']):
            return 'Authentication failed. Please check your Anthropic API key.'
        if any(p in error_lower for p in ['rate limit', 'too many requests', '429']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'
        if any(p in error_lower for p in ['credit', 'billing', 'quota', 'insufficient']):
            return 'API quota exceeded or billing issue. Please check your Anthropic account status.'
        if any(p in error_lower for p in ['invalid request', 'bad request', '400']):
            return 'Invalid input. Please check your image format and prompt.'
        if any(p in error_lower for p in ['not found', '404']):
            return f"Model '{self._model}' not found. Please check the model name."
        if any(p in error_lower for p in ['timeout', 'timed out']):
            return 'Request timed out. Please try again.'
        if any(p in error_lower for p in ['overloaded', '529']):
            return 'Anthropic API is overloaded. Please try again later.'
        if any(p in error_lower for p in ['server error', '500', '502', '503', '504']):
            return 'Anthropic API is temporarily unavailable. Please try again later.'
        return f'Anthropic error: {error_msg}'

    def _compress_image(self, b64_data: str, mime_type: str) -> tuple[str, str]:
        """Compress image to fit Anthropic's 5MB limit, converting to JPEG if needed.
        Returns (b64_data, mime_type) — possibly updated. Raises on failure.
        """
        import base64
        import io
        from PIL import Image

        _MAX_BYTES = 5 * 1024 * 1024  # 5 MB — Anthropic measures base64 string length

        # Check base64 string length, not decoded size — that's what Anthropic counts
        if len(b64_data) <= _MAX_BYTES:
            return b64_data, mime_type

        raw = base64.b64decode(b64_data)
        original_mb = len(b64_data) / (1024 * 1024)
        warning(f'Anthropic Vision: image is {original_mb:.1f}MB, exceeds 5MB limit — compressing to JPEG')

        img = Image.open(io.BytesIO(raw))
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGB')

        for quality in (85, 70, 55, 40):
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=quality, optimize=True)
            compressed_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            if len(compressed_b64) <= _MAX_BYTES:
                compressed_mb = len(compressed_b64) / (1024 * 1024)
                warning(f'Anthropic Vision: compressed to {compressed_mb:.1f}MB at JPEG quality={quality}')
                return compressed_b64, 'image/jpeg'

        raise ValueError('Image could not be compressed under 5MB at any JPEG quality — skipping frame')

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()
        retryable = ['timeout', 'timed out', 'connection', '500', '502', '503', '504', '529', 'overloaded', 'server error']
        return any(p in error_msg for p in retryable)

    def chat(self, question: Question) -> Answer:
        """Send an image to Claude Vision and get the response."""
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
        except (ValueError, IndexError) as e:
            raise ValueError('Malformed image data URL. Expected format: data:<mime>;base64,<data>') from e

        # Anthropic's hard limit is 5MB — compress if needed
        try:
            b64_data, mime_type = self._compress_image(b64_data, mime_type)
        except Exception as compress_err:
            raise ValueError(f'Anthropic Vision: {compress_err}') from compress_err

        hard_timeout = 30

        for attempt in range(max_retries + 1):
            try:
                result = [None]
                exc = [None]

                def _invoke():
                    try:
                        # Fresh client per attempt — avoids exhausting the shared HTTP connection
                        # pool when daemon threads from prior timed-out attempts are still running
                        client = anthropic_sdk.Anthropic(api_key=self._api_key, max_retries=0)

                        content = [
                            {
                                'type': 'image',
                                'source': {
                                    'type': 'base64',
                                    'media_type': mime_type,
                                    'data': b64_data,
                                },
                            },
                            {'type': 'text', 'text': prompt_text},
                        ]

                        kwargs: Dict[str, Any] = {
                            'model': self._model,
                            'max_tokens': 1024,
                            'messages': [{'role': 'user', 'content': content}],
                        }
                        if self._system_prompt:
                            kwargs['system'] = self._system_prompt

                        result[0] = client.messages.create(**kwargs)
                    except Exception as e:
                        exc[0] = e

                t = threading.Thread(target=_invoke, daemon=True)
                t.start()
                t.join(timeout=hard_timeout)
                if t.is_alive():
                    warning(f'Anthropic Vision: inference timed out after {hard_timeout}s (attempt {attempt + 1}/{max_retries + 1}) — daemon thread still running')
                    raise TimeoutError(f'Vision inference timed out after {hard_timeout}s (attempt {attempt + 1})')
                if exc[0]:
                    raise exc[0]

                response = result[0]
                text = next((b.text for b in response.content if b.type == 'text'), '')
                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(text)
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
