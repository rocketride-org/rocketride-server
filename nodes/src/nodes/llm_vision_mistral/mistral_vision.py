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
from depends import depends  # type: ignore
from typing import Any, Dict, Tuple
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config

# Load requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

import httpx

try:
    from mistralai.client import Mistral  # 2.x layout
except ImportError:
    from mistralai import Mistral  # 1.x layout
from mistral_common.tokens.tokenizers.mistral import MistralTokenizer


class Chat(ChatBase):
    """Mistral Vision AI chat bot."""

    _model: str = ''
    _client: Mistral
    _system_prompt: str = ''
    _prompt: str = ''

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Mistral Vision chat instance."""
        super().__init__(provider, connConfig, bag)
        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)
        # Get the model
        self._model = config.get('model')
        try:
            self._tokenizer = MistralTokenizer.from_model(self._model, strict=True)
        except Exception:
            self._tokenizer = MistralTokenizer.v3()
        api_key = config.get('apikey')
        # Get vision-specific configuration
        self._system_prompt = config.get('vision.systemPrompt') or config.get('systemPrompt')
        self._prompt = config.get('vision.prompt') or config.get('prompt')
        # API key validation with specific error messages
        if not api_key:
            raise ValueError('Missing Mistral AI API key. Please check your configuration.')
        if api_key.startswith('sk-'):
            raise ValueError('Invalid API key format. You seem to be using an OpenAI API key. Please provide a Mistral AI API key.')
        if api_key.startswith('AI'):
            raise ValueError('Invalid API key format. You seem to be using a Google AI/Gemini API key. Please provide a Mistral AI API key.')
        # Initialize the client with a custom httpx client to handle large image payloads
        try:
            http_client = httpx.Client(follow_redirects=True, timeout=120.0)
            self._client = Mistral(api_key=api_key, client=http_client)
        except Exception as e:
            raise ValueError(f'Failed to initialize Mistral AI client: {str(e)}')
        # Get model-specific token limit
        self._modelTotalTokens = self._getModelTokens(config.get('modelTotalTokens', None))
        # Save our chat class into the bag
        bag['chat'] = self

    def _getModelTokens(self, configured_tokens: int | None) -> int:
        """Get the maximum token count for the specified vision model."""
        model_tokens = {
            'pixtral-12b-latest': 4096,
            'pixtral-large-latest': 4096,
            'mistral-medium-latest': 3025,
            'mistral-small-latest': 3025,
        }
        if configured_tokens is not None:
            return configured_tokens
        return model_tokens.get(self._model, 4096)

    def _getModelTimeout(self, model: str) -> int:
        """Get the appropriate timeout for the specified vision model."""
        if 'large' in model:
            return 120
        elif 'medium' in model:
            return 90
        else:
            return 60

    def _validateImageInput(self, image_data: str) -> bool:
        """Validate image input format and size."""
        if not image_data or not image_data.strip():
            return False
        if image_data.startswith(('http://', 'https://')):
            return True
        if image_data.startswith('data:image/') or image_data.startswith('data:application/'):
            return True
        if os.path.exists(image_data):
            file_size = os.path.getsize(image_data)
            if file_size > 10 * 1024 * 1024:
                return False
            return True
        return False

    def _processImageInput(self, image_data: str) -> Dict[str, Any]:
        """Process image input and return the appropriate format for Mistral API."""
        if image_data.startswith(('http://', 'https://')):
            return {'type': 'image_url', 'image_url': image_data}
        if image_data.startswith('data:image/') or image_data.startswith('data:application/'):
            return {'type': 'image_url', 'image_url': image_data}
        if os.path.exists(image_data):
            with open(image_data, 'rb') as image_file:
                image_bytes = image_file.read()
                ext = os.path.splitext(image_data)[1].lower()
                mime_type = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'}.get(ext, 'image/jpeg')
                base64_image = base64.b64encode(image_bytes).decode('utf-8')
                return {'type': 'image_url', 'image_url': f'data:{mime_type};base64,{base64_image}'}
        raise ValueError('Invalid image input format. Please provide a valid URL, base64 encoded image, or file path.')

    def getTotalTokens(self) -> int:
        """Get the total token limit for the current vision model."""
        return self._modelTotalTokens

    def getTokens(self, value: str) -> int:
        """Count tokens using the official Mistral tokenizer SDK."""
        if not value.strip():
            return 0
        return len(self._tokenizer.encode(value))

    def _format_user_error(self, error_msg: str) -> str:
        """Convert API error messages to user-friendly format."""
        error_lower = error_msg.lower()
        if any(phrase in error_lower for phrase in ['unauthorized', 'invalid api key', 'authentication']):
            return 'Authentication failed. Please check your Mistral AI API key.'
        if any(phrase in error_lower for phrase in ['rate limit', 'too many requests', '429']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'
        if any(phrase in error_lower for phrase in ['quota', 'billing', 'insufficient', 'credits']):
            return 'API quota exceeded or billing issue. Please check your Mistral AI account status.'
        if any(phrase in error_lower for phrase in ['invalid input', 'bad request', '400']):
            return 'Invalid input provided. Please check your image format and prompt.'
        if any(phrase in error_lower for phrase in ['model not found', 'unavailable']):
            return f"The vision model '{self._model}' is currently unavailable. Please try a different model."
        if any(phrase in error_lower for phrase in ['image', 'vision', 'multimodal']):
            return 'Image processing error. Please check that your image is in a supported format (JPEG, PNG, GIF, WEBP) and under 10MB.'
        if any(phrase in error_lower for phrase in ['internal server error', '500', 'service unavailable']):
            return 'Mistral AI vision service is temporarily unavailable. Please try again later.'
        if any(phrase in error_lower for phrase in ['content policy', 'violation', 'inappropriate']):
            return "Image content violates Mistral AI's usage policies. Please use a different image."
        if any(phrase in error_lower for phrase in ['timeout', 'timed out']):
            return f'Vision request timed out. The {self._model} model may need more time - please try again.'
        if any(phrase in error_lower for phrase in ['connection', 'network', 'unreachable']):
            return 'Network connection issue. Please check your internet connection.'
        return f'Mistral Vision API error: {error_msg}'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()
        retryable_errors = ['timeout', 'timed out', 'connection', 'network', '500', '502', '503', '504', 'internal server error', 'service unavailable', 'service temporarily unavailable', 'bad gateway']
        return any(phrase in error_msg for phrase in retryable_errors)

    def _getRetryConfig(self, model: str) -> Tuple[int, float]:
        """Get retry configuration based on vision model type."""
        if 'large' in model:
            return (3, 2.0)
        elif 'medium' in model:
            return (3, 1.5)
        else:
            return (3, 1.0)

    def chat(self, question: Question) -> Answer:
        """Send a vision request to Mistral AI and get the response."""
        # Get retry configuration for this model
        max_retries, base_delay = self._getRetryConfig(self._model)
        last_error = None
        # Extract image data from context and prompt from questions
        image_data = None
        prompt_text = self._prompt
        for context_item in question.context:
            if context_item.startswith('data:image/') or context_item.startswith('data:application/'):
                image_data = context_item
                break
        # Look for prompt in questions
        if question.questions and len(question.questions) > 0:
            prompt_text = question.questions[0].text

        # Validate image input
        if not image_data or not self._validateImageInput(image_data):
            raise ValueError('Invalid image input. Please provide a valid image URL, base64 encoded image, or file path.')
        for attempt in range(max_retries + 1):
            try:
                # Process the image input
                image_content = self._processImageInput(image_data)
                # Create the messages with system role, user prompt, and image content
                messages = [{'role': 'system', 'content': [{'type': 'text', 'text': self._system_prompt}]}, {'role': 'user', 'content': [{'type': 'text', 'text': prompt_text}, image_content]}]
                api_params = {
                    'model': self._model,
                    'messages': messages,
                    'temperature': 0.0,
                    'max_tokens': None,
                }
                chat_response = self._client.chat.complete(**api_params)
                # Create and return the answer
                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(chat_response.choices[0].message.content)
                return answer
            except Exception as e:
                last_error = e
                if attempt < max_retries and self._shouldRetry(e):
                    # Calculate delay with exponential backoff
                    delay = base_delay * (2**attempt)
                    time.sleep(delay)
                    continue
                else:
                    break

        # All retries failed or non-retryable error
        user_friendly_error = self._format_user_error(str(last_error))
        raise Exception(user_friendly_error)
