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
Deepseek binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase, UNBOUND_MODEL
from langchain_openai import ChatOpenAI

from .deepseek_endpoint import is_deepseek_api


class Chat(ChatBase):
    """
    Creates an Deepseek chat bot.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Deepseek chat bot.

        Args:
            provider (str): Provider name
            connConfig (Dict[str, Any]): Node configuration
            bag (Dict[str, Any]): The endpoint bag (read-only; the chat lives on the IGlobal)
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # The API key belongs to the cloud endpoint; each model branch names
        # its own endpoint, so the client is the call's (``_llm_for``)
        self._apikey = (self._config.get('apikey') or '').strip()

    def _llm_for(self) -> ChatOpenAI:
        """
        Return the client of the endpoint that serves this call's model.

        The DeepSeek API for the cloud branches, the Ollama server the local
        branches alias: one client per endpoint, from the bounded keyed cache.
        """
        # The endpoint that serves the selected model
        serverbase = (self.call.settings['serverbase'] or '').strip()
        if not serverbase:
            # An empty endpoint would let the OpenAI client fall back to its own
            # default host and fail with an unrelated authentication error
            raise ValueError('DeepSeek serverbase is required.')
        return self._keyed_handle(('llm', serverbase), lambda: self._build(serverbase))

    def _build(self, serverbase: str) -> ChatOpenAI:
        """Build the client of one endpoint: every request binds its model and max_tokens."""
        # A local server takes any token; the DeepSeek API needs its key
        apikey = self._apikey
        if is_deepseek_api(serverbase):
            if not apikey:
                raise ValueError('DeepSeek API key is required for the DeepSeek API endpoint.')
            if not apikey.startswith('sk-'):
                raise ValueError('Invalid DeepSeek API key format, please check your API key.')
        return ChatOpenAI(
            model=UNBOUND_MODEL, base_url=serverbase, api_key=apikey or 'sk-local-dummy-key', temperature=0
        )
