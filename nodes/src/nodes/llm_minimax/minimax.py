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
MiniMax binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI


MINIMAX_BASE_URL = 'https://api.minimax.io/v1'


class Chat(ChatBase):
    """
    Creates a MiniMax chat bot.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the MiniMax chat bot.

        Args:
            provider (str): Provider name
            connConfig (Dict[str, Any]): Node configuration
            bag (Dict[str, Any]): Bag to store data
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key
        apikey = config.get('apikey')
        if not apikey:
            raise ValueError('MiniMax API key is required.')

        # MiniMax temperature must be strictly greater than 0
        # Clamp temperature=0 to a small positive value
        temperature = max(config.get('temperature', 0.01), 0.01)

        # Get the llm via OpenAI-compatible API
        self._llm = ChatOpenAI(
            model=self._model,
            base_url=MINIMAX_BASE_URL,
            api_key=apikey,
            temperature=temperature,
            max_tokens=self._modelOutputTokens,
        )

        # Save our chat class into the bag
        bag['chat'] = self
