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
Anthropic binding for the ChatLLM.

Extended-thinking streaming is handled globally via
``ai.common.llm_native_stream`` (``_native_stream_provider = 'anthropic'``).
"""

from typing import Any, Dict

from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.llm_native_stream import build_anthropic_thinking_kwargs, gate_model_name
from langchain_anthropic import ChatAnthropic


def _estimate_token_ids(text: str) -> list:
    """Estimate token ids at ~4 chars/token."""
    return [0] * max(1, (len(text) + 3) // 4)


class Chat(ChatBase):
    """
    Create an Anthropic chat bot.
    """

    _llm: ChatAnthropic

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Anthropic chat bot.
        """
        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the model
        model = config.get('model')
        model_gate = gate_model_name(str(model) if model is not None else '')

        # Get the API key, don't save it
        apikey = (config.get('apikey') or '').strip()

        # API key validation: must be non-empty and look like an Anthropic key
        # Formats: sk-ant-... (standard), sk-ant-api03-... (newer keys)
        if not apikey or not apikey.startswith('sk-ant'):
            raise ValueError('Invalid Anthropic API key format, please check your API key.')

        # Init the chat base
        super().__init__(provider, connConfig, bag)

        # Get the LLM
        kwargs: Dict[str, Any] = {
            'model': model,
            'api_key': apikey,
            'max_tokens': self._modelOutputTokens,
            'custom_get_token_ids': _estimate_token_ids,
        }
        if self._is_reasoning:
            kwargs.update(build_anthropic_thinking_kwargs(model_gate, self._modelOutputTokens))

        self._extended_thinking = bool(kwargs.get('thinking'))
        # Only route through the native handler when thinking is actually on;
        # non-reasoning models stay on the default LangChain path.
        if self._extended_thinking:
            self._native_stream_provider = 'anthropic'

        self._llm = ChatAnthropic(**kwargs)

        # Save our chat class into the bag
        bag['chat'] = self
