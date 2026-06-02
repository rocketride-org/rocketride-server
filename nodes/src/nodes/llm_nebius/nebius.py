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

"""Nebius Token Factory binding for the ChatLLM (OpenAI-compatible)."""

import os
from typing import Any, Dict
from openai import AuthenticationError, APIError, RateLimitError, APIConnectionError
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI

NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/'


class Chat(ChatBase):
    """Creates a Nebius Token Factory chat bot."""

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        super().__init__(provider, connConfig, bag)

        config = Config.getNodeConfig(provider, connConfig)

        # Resolve the key from config first, then the NEBIUS_API_KEY env var.
        # The 'sk-dummy' placeholder lets the client initialise before a key is
        # saved (e.g. during config-only open mode).
        apikey = (config.get('apikey') or '').strip() or os.environ.get('NEBIUS_API_KEY', '').strip() or 'sk-dummy'

        self._llm = ChatOpenAI(
            model=self._model,
            base_url=NEBIUS_BASE_URL,
            api_key=apikey,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )

        bag['chat'] = self

    def is_retryable_error(self, error):
        # Always retry rate limits and connection errors; for anything else
        # delegate to ChatBase, which also flags transient 5xx server errors.
        if isinstance(error, (RateLimitError, APIConnectionError)):
            return True
        return super().is_retryable_error(error)

    def map_exception(self, error):
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid Nebius API key.')
        elif isinstance(error, RateLimitError):
            return ValueError(f'Nebius rate limit: {error}')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the Nebius Token Factory API.')
        elif isinstance(error, APIError):
            return ValueError(f'Nebius API error: {error}')
        else:
            return super().map_exception(error)
