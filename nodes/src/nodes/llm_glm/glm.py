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
Zhipu AI GLM binding for the ChatLLM.
"""

import re
from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI

# GLM reasoning models (GLM-4.5 and later hybrid-thinking models) can return
# chain-of-thought wrapped in <think>...</think> inside the `content` field on
# the OpenAI-compatible endpoint. The block is stripped here so downstream
# pipeline nodes only see the final answer. The closing tag is optional: a
# generation truncated at max_tokens mid-reasoning has no </think>, and the
# partial reasoning must not leak downstream either.
_THINK_BLOCK_RE = re.compile(r'<think>.*?(?:</think>|$)\s*', re.DOTALL | re.IGNORECASE)


class Chat(ChatBase):
    """
    Creates a Zhipu AI GLM chat bot.
    """

    _llm: ChatOpenAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize the Zhipu AI GLM chat bot.

        Args:
            provider (str): Provider name
            connConfig (Dict[str, Any]): Node configuration
            bag (Dict[str, Any]): Bag to store data
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the serverbase url; fall back to the Z.ai API default so runtime
        # accepts the same "no explicit serverbase" config that validateConfig does
        serverbase = config.get('serverbase') or 'https://api.z.ai/api/paas/v4'

        # API key is only required when calling the Z.ai / Zhipu cloud API.
        # Matches both api.z.ai (international) and open.bigmodel.cn (mainland
        # China) by substring. Zhipu keys use an 'id.secret' shape but other
        # formats exist, so only presence is enforced (the llm_baidu_qianfan
        # lesson: don't over-validate key format).
        apikey = config.get('apikey')
        if isinstance(apikey, str):
            apikey = apikey.strip()
        if ('api.z.ai' in serverbase or 'bigmodel.cn' in serverbase) and not apikey:
            raise ValueError('GLM API key is required for cloud profiles.')

        # Self-hosted / custom OpenAI-compatible endpoints accept any token,
        # so fall back to a dummy key. Mirrors the llm_minimax pattern.
        apikey = apikey or 'sk-local-dummy-key'

        # Get the llm via the OpenAI-compatible client
        self._llm = ChatOpenAI(
            model=self._model, base_url=serverbase, api_key=apikey, temperature=0, max_tokens=self._modelOutputTokens
        )

        # Save our chat class into the bag
        bag['chat'] = self

    def _chat(self, prompt: str) -> str:
        """Invoke the LLM and strip any <think>...</think> reasoning block from the response."""
        return _THINK_BLOCK_RE.sub('', super()._chat(prompt))
