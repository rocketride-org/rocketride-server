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

"""
Perplexity AI node for the RocketRide Data Toolchain.

This node provides access to Perplexity AI's advanced language models
including sonar models with real-time web search capabilities.
"""

import os
import time
from depends import depends  # type: ignore

# Load the requirements
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict
from ai.common.schema import Answer, Question
from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.validation import validate_prompt
from langchain_openai import ChatOpenAI


class Chat(ChatBase):
    """
    Perplexity AI chat node with search-enhanced language models.
    """

    _model: str = ''
    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Perplexity AI node.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the node configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the model and API key
        self._model = config.get('model')
        apikey = config.get('apikey')

        # Get model-specific timeout
        timeout = self._getModelTimeout(self._model)

        # Initialize the language model with Perplexity API settings
        self._llm = ChatOpenAI(
            model=self._model,
            api_key=apikey,
            base_url='https://api.perplexity.ai',
            temperature=0,
            timeout=timeout,
            max_retries=0,  # We handle retries ourselves
            max_tokens=self._modelOutputTokens,
        )

        # Store in bag for pipeline access
        bag['chat'] = self

    def _getModelTokens(self, model: str) -> int:
        """
        Get the maximum token count for the specified model.
        """
        model_tokens = {
            'sonar-pro': 127072,
            'sonar': 127072,
            'sonar-reasoning-pro': 127072,
            'sonar-reasoning': 127072,
            'sonar-deep-research': 127072,
            'r1-1776': 128000,
        }
        return model_tokens.get(model, 127072)

    def _getModelTimeout(self, model: str) -> int:
        """
        Get the appropriate timeout for the specified model.

        Some models like sonar-deep-research require longer processing times.
        """
        if model == 'sonar-deep-research':
            return 180  # 3 minutes for deep research
        elif 'reasoning' in model:
            return 120  # 2 minutes for reasoning models
        else:
            return 60  # 1 minute for standard models

    def getTotalTokens(self) -> int:
        """Get the total token limit for the current model."""
        return self._getModelTokens(self._model)

    def getTokens(self, value: str) -> int:
        """
        Estimate token count for a given text string.

        Uses a simple word-based approximation: ~0.75 words per token.
        """
        return int(len(value.split()) / 0.75)

    def _format_user_error(self, error_msg: str) -> str:
        """
        Convert API error messages to user-friendly format.
        """
        error_lower = error_msg.lower()

        # Authentication errors
        if any(phrase in error_lower for phrase in ['unauthorized', 'invalid api key', 'authentication']):
            return 'Authentication failed. Please check your Perplexity API key in the node settings.'

        # Rate limiting
        if any(phrase in error_lower for phrase in ['rate limit', 'too many requests', '429']):
            return 'Rate limit exceeded. Please wait a moment before trying again or upgrade your Perplexity plan.'

        # Quota/billing issues
        if any(phrase in error_lower for phrase in ['quota', 'billing', 'insufficient', 'credits']):
            return 'API quota exceeded or billing issue. Please check your Perplexity account billing status.'

        # Input validation errors
        if any(phrase in error_lower for phrase in ['invalid input', 'bad request', '400']):
            return 'Invalid input provided. Please check your question format and try again.'

        # Model availability
        if any(phrase in error_lower for phrase in ['model not found', 'unavailable', 'not available']):
            return (
                f"The model '{self._model}' is currently unavailable. Please try a different model or contact support."
            )

        # Server errors
        if any(phrase in error_lower for phrase in ['internal server error', '500', 'service unavailable', '503']):
            return 'Perplexity service is temporarily unavailable. Please try again in a few moments.'

        # Content policy violations
        if any(phrase in error_lower for phrase in ['content policy', 'violation', 'inappropriate']):
            return "Content violates Perplexity's usage policies. Please rephrase your question appropriately."

        # Timeout errors
        if any(phrase in error_lower for phrase in ['timeout', 'timed out']):
            return f'Request timed out. The {self._model} model may need more time - please try again or use a faster model.'

        # Network errors
        if any(phrase in error_lower for phrase in ['connection', 'network', 'unreachable']):
            return 'Network connection issue. Please check your internet connection and try again.'

        # Generic fallback
        return f'Perplexity API error: {error_msg}. Please try again or contact support if the issue persists.'

    def _shouldRetry(self, error: Exception) -> bool:
        """Determine if an error is retryable."""
        error_msg = str(error).lower()

        # Retry on temporary network/server issues
        retryable_errors = [
            'timeout',
            'timed out',
            'connection',
            'network',
            '500',
            '502',
            '503',
            '504',
            'internal server error',
            'service unavailable',
            'bad gateway',
        ]

        return any(phrase in error_msg for phrase in retryable_errors)

    def _getRetryConfig(self, model: str) -> tuple[int, float]:
        """Get retry configuration for specific models."""
        if model == 'sonar-deep-research':
            return (3, 2.0)  # 3 retries, 2 second base delay for problematic model
        elif 'reasoning' in model:
            return (2, 1.5)  # 2 retries for reasoning models
        else:
            return (2, 1.0)  # Standard retry config

    def chat(self, question: Question) -> Answer:
        """Process a question and return an answer with retry logic."""
        prompt = validate_prompt(question.getPrompt(), self._modelTotalTokens, self.getTokens)
        max_retries, base_delay = self._getRetryConfig(self._model)
        last_error = None

        for attempt in range(max_retries + 1):  # +1 for initial attempt
            try:
                # Ask the model
                results = self._llm.invoke(prompt)

                # Create and return the answer
                answer = Answer(expectJson=question.expectJson)
                answer.setAnswer(results.content)
                return answer

            except Exception as e:
                last_error = e

                # Check if we should retry
                if attempt < max_retries and self._shouldRetry(e):
                    # Calculate delay with exponential backoff
                    delay = base_delay * (2**attempt)
                    time.sleep(delay)
                    continue
                else:
                    # No more retries or non-retryable error
                    break

        # All retries failed, format and raise the error
        user_friendly_error = self._format_user_error(str(last_error))
        raise Exception(user_friendly_error)
