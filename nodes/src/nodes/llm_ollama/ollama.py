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
Ollame binding for the ChatLLM.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase, UNBOUND_MODEL
from langchain_openai import ChatOpenAI


class Chat(ChatBase):
    """
    Create an ollama chat bot.
    """

    _llm: ChatOpenAI

    # Ollama reasoning models (gpt-oss, deepseek-r1, qwen3, qwq, ...) detected by name.
    # They need a non-zero temperature so they emit a final answer instead of empty content.
    REASONING_HINTS = ('gpt-oss', 'deepseek-r1', 'qwen3', 'qwq', 'magistral', '-thinking')

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the ollama chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = self._config

        # Get the api key, don't save it
        apikey = config.get('apikey', 'dummy-key')

        # Get the api key, don't save it
        serverbase = config['serverbase']

        if not serverbase.rstrip('/').endswith('/v1'):
            serverbase = serverbase.rstrip('/') + '/v1'

        # Get the llm: one for every call, each request binds its model,
        # max_tokens, temperature and reasoning effort
        self._llm = ChatOpenAI(model=UNBOUND_MODEL, base_url=serverbase, api_key=apikey)

    def call_kwargs(self) -> Dict[str, Any]:
        """
        Return this call's request values, its temperature and reasoning effort included.

        Reasoning models (gpt-oss, deepseek-r1, qwen3, qwq, ...) loop at temperature 0 and
        spend the whole output budget on hidden reasoning, returning empty content — which
        breaks expectJson agent steps. Detect them via the stamped reasoning capability or
        the model name, then default to a non-zero temperature + low reasoning_effort so they
        emit the final answer. Both are the call's to override; non-reasoning models
        (llama/qwen2.5/mistral) keep temperature 0 and send no reasoning_effort.
        """
        call = self.call
        kwargs = super().call_kwargs()
        model_name = (call.model or '').lower()
        is_reasoning = call.reasoning or any(hint in model_name for hint in self.REASONING_HINTS)

        # Both leaves have no schema default on purpose: unset means model-dependent.
        temperature = call.settings.get('temperature')
        kwargs['temperature'] = (1.0 if is_reasoning else 0) if temperature is None else temperature
        reasoning_effort = call.settings.get('reasoning_effort') or ('low' if is_reasoning else None)
        if reasoning_effort:
            kwargs['reasoning_effort'] = reasoning_effort
        return kwargs
