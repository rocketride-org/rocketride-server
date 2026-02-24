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
OpenAI binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError


class Chat(ChatBase):
    """
    Create an OpenAI chat bot.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the OpenAI chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key, don't save it
        apikey = config.get('apikey')

        # Get the llm
        self._llm = ChatOpenAI(model=self._model, api_key=apikey, temperature=0)

        # Save our chat class into the bag
        bag['chat'] = self

    def is_retryable_error(self, error):
        """
        Determine if the error is retryable.
        """
        if isinstance(error, AuthenticationError):
            return False
        elif isinstance(error, APIError):
            return False
        elif isinstance(error, RateLimitError):
            return True
        elif isinstance(error, APIConnectionError):
            return True
        else:
            return super().map_exception(error)

    def map_exception(self, error):
        """
        Convert unfriendly openai exceptions to friendlier ones.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid API key.')
        elif isinstance(error, APIError):
            return ValueError('An error occurred with the OpenAI API.')
        elif isinstance(error, RateLimitError):
            return ValueError('Rate limit exceeded. Please try again later.')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the OpenAI API.')
        else:
            return super().map_exception(error)
