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

import re
from typing import Any, Dict
from ai.common.chat import ChatBase, UNBOUND_MODEL
from ai.common.llm_adapter import report_usage_metadata
from langchain_openai import ChatOpenAI

# MiniMax M2-series models return chain-of-thought wrapped in <think>...</think>
# inside the `content` field (per the OpenAI-compatible spec at
# https://platform.minimax.io/docs/api-reference/text-chat-openai). The block is
# stripped here so downstream pipeline nodes only see the final answer.
_THINK_BLOCK_RE = re.compile(r'<think>.*?</think>\s*', re.DOTALL | re.IGNORECASE)


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
            bag (Dict[str, Any]): The endpoint bag (read-only; the chat lives on the IGlobal)
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the api key, use a dummy key if not provided. Local profiles
        # (Ollama / vLLM / TGI) intentionally have no apikey property — local
        # OpenAI-compatible servers accept any token. Mirrors the llm_deepseek pattern.
        # Each model branch names its endpoint, so the client is the call's.
        self._apikey = self._config.get('apikey') or 'sk-local-dummy-key'

    def _llm_for(self) -> ChatOpenAI:
        """Return the client of the endpoint that serves this call's model (one per endpoint, keyed cache)."""
        serverbase = self.call.settings['serverbase']
        return self._keyed_handle(('llm', serverbase), lambda: self._build(serverbase))

    def _build(self, serverbase: str) -> ChatOpenAI:
        """Build the client of one endpoint: every request binds its model and max_tokens."""
        # API key is only required when calling MiniMax's cloud API. Matches both
        # api.minimax.io (international) and api.minimaxi.com (China) by substring.
        if 'api.minimax' in serverbase and self._apikey == 'sk-local-dummy-key':
            raise ValueError('MiniMax API key is required for cloud profiles.')
        return ChatOpenAI(model=UNBOUND_MODEL, base_url=serverbase, api_key=self._apikey, temperature=0)

    def _chat(self, prompt: str) -> str:
        """Invoke the LLM and strip any <think>...</think> reasoning block from the response."""
        llm = self.bound_llm()
        results = llm.invoke(prompt)
        # This override bypasses LangChainAdapter.collect(), the capture point that
        # meters every other non-streaming call, so report from here or the call bills zero.
        report_usage_metadata(getattr(results, 'usage_metadata', None), llm)
        return _THINK_BLOCK_RE.sub('', results.content)
