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
Qwen (DashScope) binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError

DASHSCOPE_REGIONS = {
    'us': 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'intl': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'cn': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}


class Chat(ChatBase):
    """
    Create a Qwen chat bot via DashScope's OpenAI-compatible API.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Qwen chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key, don't save it
        apikey = config.get('apikey')

        if not apikey or not apikey.startswith('sk-'):
            raise ValueError('Invalid DashScope API key. Key must start with "sk-".')

        # Resolve regional endpoint
        region = config.get('region', 'us')
        base_url = DASHSCOPE_REGIONS.get(region, DASHSCOPE_REGIONS['us'])

        # Get the llm using OpenAI-compatible endpoint
        self._llm = ChatOpenAI(
            model=self._model,
            api_key=apikey,
            base_url=base_url,
            temperature=0,
        )

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
        Convert unfriendly exceptions to friendlier ones.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid DashScope API key.')
        elif isinstance(error, APIError):
            return ValueError('An error occurred with the DashScope API.')
        elif isinstance(error, RateLimitError):
            return ValueError('Rate limit exceeded. Please try again later.')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the DashScope API.')
        else:
            return super().map_exception(error)
