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
Baidu Qianfan binding for the ChatLLM.
"""

from typing import Any, Dict

from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIError, AuthenticationError, RateLimitError


DEFAULT_QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2'


class Chat(ChatBase):
    """
    Create a Baidu Qianfan chat bot through Qianfan's OpenAI-compatible API.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Baidu Qianfan chat bot.
        """
        super().__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)
        apikey = config.get('apikey')
        serverbase = (config.get('serverbase') or DEFAULT_QIANFAN_BASE_URL).rstrip('/')

        if not isinstance(apikey, str) or not apikey.strip():
            raise ValueError('Baidu Qianfan API key is required.')

        self._llm = ChatOpenAI(
            model=self._model,
            api_key=apikey.strip(),
            base_url=serverbase,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )

        bag['chat'] = self

    def is_retryable_error(self, error):
        """
        Determine if the error is retryable.
        """
        if isinstance(error, AuthenticationError):
            return False
        elif isinstance(error, RateLimitError):
            return True
        elif isinstance(error, APIConnectionError):
            return True
        elif isinstance(error, APIError):
            return False
        else:
            return False

    def map_exception(self, error):
        """
        Convert provider exceptions to user-facing errors.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Baidu Qianfan API key is invalid or unauthorized.')
        elif isinstance(error, RateLimitError):
            return ValueError('Baidu Qianfan rate limit exceeded. Please try again later.')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the Baidu Qianfan API.')
        elif isinstance(error, APIError):
            return ValueError('An error occurred with the Baidu Qianfan API.')
        else:
            return super().map_exception(error)
