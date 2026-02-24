# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

"""
Mistral AI binding for the ChatLLM.

This node provides access to Mistral AI's advanced language models,
supporting a wide range of models from large (128K context) to small (32K context).
"""

import os
import time
from depends import depends  # type: ignore
from rocketlib import debug

# Load the requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, Tuple
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config
from mistralai import Mistral


class Chat(ChatBase):
    """
    Create a Mistral AI chat bot.
    """

    _model: str = ''
    _client: Mistral

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Mistral AI chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the model
        self._model = config.get('model')

        # Get the API key, don't save it
        api_key = config.get('apikey')

        # API key validation with specific error messages
        if not api_key:
            raise ValueError('Missing Mistral AI API key. Please check your configuration.')
        if api_key.startswith('sk-'):
            raise ValueError('Invalid API key format. You seem to be using an OpenAI API key. Please provide a Mistral AI API key.')
        if api_key.startswith('AI'):
            raise ValueError('Invalid API key format. You seem to be using a Google AI/Gemini API key. Please provide a Mistral AI API key.')

        # Initialize the client with error handling
        try:
            self._client = Mistral(api_key=api_key)
        except Exception as e:
            raise ValueError(f'Failed to initialize Mistral AI client: {str(e)}')

        # Get model-specific token limit
        self._modelTotalTokens = self._getModelTokens(config.get('modelTotalTokens', None))

        # Save our chat class into the bag
        bag['chat'] = self

        # Output some debug information
        debug(f'    Chat model        : {self._model}')
        debug(f'    Chat total tokens : {self._modelTotalTokens}')

    def _getModelTokens(self, configured_tokens: int | None) -> int:
        """Get the maximum token count for the specified model."""
        model_tokens = {
            # Premier Models - Latest and Most Capable
            'mistral-large-2411': 131072,  # 128K context
            'mistral-medium-2505': 131072,  # 128K context
            'mistral-small-latest': 131072,  # 128K context
            'magistral-medium-2506': 40960,  # 40K context for reasoning
            'codestral-2501': 262144,  # 256K context for code
            'devstral-medium-2507': 131072,  # 128K context for technical tasks
            # Latest Small Models - Good for RAG
            'mistral-small-2506': 131072,  # Latest small with 128K context
            'mistral-small-2503': 131072,  # Previous small with 128K context
            'mistral-small-2501': 32768,  # Base small with 32K context
            # Specialized Models
            'magistral-small-2506': 40960,  # Specialized reasoning model
            'devstral-small-2507': 131072,  # Code/technical model
            'devstral-small-2505': 131072,  # Legacy code/technical model
            'open-mistral-nemo': 131072,  # 128K context multilingual model
            # Edge Models - Fast Inference
            'ministral-8b-2410': 131072,  # 8B params, 128K context
            'ministral-3b-2410': 131072,  # 3B params, 128K context
        }

        # If tokens were configured explicitly, use that value
        if configured_tokens is not None:
            return configured_tokens

        # Otherwise use model-specific default, falling back to 32K if model unknown
        return model_tokens.get(self._model, 32768)

    def _getModelTimeout(self, model: str) -> int:
        """
        Get the appropriate timeout for the specified model.

        Some models require longer processing times.
        """
        if 'large' in model:
            return 120  # 2 minutes for large models
        elif 'medium' in model or 'magistral' in model:
            return 90  # 1.5 minutes for medium/magistral models
        else:
            return 60  # 1 minute for small models

    def getTotalTokens(self) -> int:
        """Get the total token limit for the current model."""
        return self._modelTotalTokens

    def getTokens(self, value: str) -> int:
        """
        Estimate token count for a given text string.

        Uses an improved estimate based on words and characters.
        """
        if not value.strip():
            return 0

        # Split into words and filter out empty strings
        words = [word for word in value.split() if word.strip()]
        word_count = len(words)

        if word_count == 0:
            return 0

        # Improved token estimation algorithm
        # Base estimate: 1.25 tokens per word for better accuracy
        base_tokens = word_count * 1.25

        # Adjust for punctuation and special characters
        punctuation_count = sum(1 for char in value if char in '.,!?;:"()[]{}')
        punctuation_adjustment = punctuation_count * 0.1

        # Adjust for longer words (more likely to be split into subwords)
        long_word_count = sum(1 for word in words if len(word) > 8)
        long_word_adjustment = long_word_count * 0.2

        # Calculate final estimate
        estimated_tokens = base_tokens + punctuation_adjustment + long_word_adjustment

        return max(1, int(round(estimated_tokens)))

    def _format_user_error(self, error_msg: str) -> str:
        """
        Convert API error messages to user-friendly format.
        """
        error_lower = error_msg.lower()

        # Authentication errors
        if any(phrase in error_lower for phrase in ['unauthorized', 'invalid api key', 'authentication']):
            return 'Authentication failed. Please check your Mistral AI API key.'

        # Rate limiting
        if any(phrase in error_lower for phrase in ['rate limit', 'too many requests', '429']):
            return 'Rate limit exceeded. Please wait a moment before trying again.'

        # Quota/billing issues
        if any(phrase in error_lower for phrase in ['quota', 'billing', 'insufficient', 'credits']):
            return 'API quota exceeded or billing issue. Please check your Mistral AI account status.'

        # Input validation errors
        if any(phrase in error_lower for phrase in ['invalid input', 'bad request', '400']):
            return 'Invalid input provided. Please check your question format.'

        # Model availability
        if any(phrase in error_lower for phrase in ['model not found', 'unavailable']):
            return f"The model '{self._model}' is currently unavailable. Please try a different model."

        # Server errors
        if any(phrase in error_lower for phrase in ['internal server error', '500', 'service unavailable']):
            return 'Mistral AI service is temporarily unavailable. Please try again later.'

        # Content policy violations
        if any(phrase in error_lower for phrase in ['content policy', 'violation', 'inappropriate']):
            return "Content violates Mistral AI's usage policies. Please rephrase appropriately."

        # Timeout errors
        if any(phrase in error_lower for phrase in ['timeout', 'timed out']):
            return f'Request timed out. The {self._model} model may need more time - please try again.'

        # Network errors
        if any(phrase in error_lower for phrase in ['connection', 'network', 'unreachable']):
            return 'Network connection issue. Please check your internet connection.'

        # Generic fallback
        return f'Mistral AI API error: {error_msg}'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()

        retryable_errors = ['timeout', 'timed out', 'connection', 'network', '500', '502', '503', '504', 'internal server error', 'service unavailable', 'bad gateway', 'rate limit']

        return any(phrase in error_msg for phrase in retryable_errors)

    def _getRetryConfig(self, model: str) -> Tuple[int, float]:
        """Get retry configuration based on model type."""
        if 'large' in model:
            return (3, 2.0)  # 3 retries, 2 second base delay for large models
        elif 'medium' in model or 'magistral' in model:
            return (2, 1.5)  # 2 retries, 1.5 second base delay for medium models
        else:
            return (2, 1.0)  # 2 retries, 1 second base delay for small models

    def chat(self, question: Question) -> Answer:
        """Send a chat message to Mistral AI and get the response."""
        # Get retry configuration for this model
        max_retries, base_delay = self._getRetryConfig(self._model)
        last_error = None

        for attempt in range(max_retries + 1):
            try:
                # Create the chat message
                messages = [{'role': 'user', 'content': question.getPrompt()}]

                # Make the API call
                chat_response = self._client.chat.complete(
                    model=self._model,
                    messages=messages,
                    temperature=0.0,  # Using 0 for more deterministic responses
                    max_tokens=None,  # Let model decide based on content
                    random_seed=None,  # No fixed seed for variety
                )

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
