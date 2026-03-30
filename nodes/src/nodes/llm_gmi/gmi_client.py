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
GMI Cloud binding for the ChatLLM.

GMI Cloud exposes an OpenAI-compatible inference API backed by GPU clusters.
We use the same ``langchain_openai.ChatOpenAI`` class with a custom base URL.
"""

from typing import Any, Dict

from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError


GMI_CLOUD_BASE_URL = 'https://api.gmi-serving.com/v1'


class Chat(ChatBase):
    """
    Creates a GMI Cloud chat bot using the OpenAI-compatible API.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the GMI Cloud chat bot.

        Args:
            provider (str): Provider name
            connConfig (Dict[str, Any]): Node configuration
            bag (Dict[str, Any]): Bag to store data
        """
        super().__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)

        serverbase = config.get('serverbase', GMI_CLOUD_BASE_URL)
        if not serverbase:
            serverbase = GMI_CLOUD_BASE_URL

        apikey = config.get('apikey')
        if not apikey:
            raise ValueError('GMI Cloud API key is required.')

        self._llm = ChatOpenAI(
            model=self._model,
            base_url=serverbase,
            api_key=apikey,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )

        bag['chat'] = self

    def is_retryable_error(self, error):
        """Determine if the error is retryable."""
        if isinstance(error, AuthenticationError):
            return False
        elif isinstance(error, APIError):
            return False
        elif isinstance(error, RateLimitError):
            return True
        elif isinstance(error, APIConnectionError):
            return True
        else:
            return False

    def map_exception(self, error):
        """Convert unfriendly exceptions to friendlier ones."""
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid GMI Cloud API key.')
        elif isinstance(error, APIError):
            return ValueError('An error occurred with the GMI Cloud API.')
        elif isinstance(error, RateLimitError):
            return ValueError('GMI Cloud rate limit exceeded. Please try again later.')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to GMI Cloud API.')
        else:
            return super().map_exception(error)
