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
from ai.common.chat import ChatBase
from ai.common.config import Config
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
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key, don't save it
        apikey = config.get('apikey', 'dummy-key')

        # Get the api key, don't save it
        serverbase = config.get('serverbase', None)

        if not serverbase.rstrip('/').endswith('/v1'):
            serverbase = serverbase.rstrip('/') + '/v1'

        # Reasoning models (gpt-oss, deepseek-r1, qwen3, qwq, ...) loop at temperature 0 and
        # spend the whole output budget on hidden reasoning, returning empty content — which
        # breaks expectJson agent steps. Detect them via the stamped reasoning capability or
        # the model name, then default to a non-zero temperature + low reasoning_effort so they
        # emit the final answer. Both are overridable from the pipe config; non-reasoning models
        # (llama/qwen2.5/mistral) keep temperature 0 and send no reasoning_effort.
        model_name = (self._model or '').lower()
        is_reasoning = bool(self._is_reasoning) or any(hint in model_name for hint in self.REASONING_HINTS)

        temperature = config['temperature'] if 'temperature' in config else (1.0 if is_reasoning else 0)
        if 'reasoning_effort' in config:
            reasoning_effort = config.get('reasoning_effort')
        else:
            reasoning_effort = 'low' if is_reasoning else None
        model_kwargs = {'reasoning_effort': reasoning_effort} if reasoning_effort else {}

        # Get the llm
        self._llm = ChatOpenAI(
            model=self._model,
            base_url=serverbase,
            api_key=apikey,
            temperature=temperature,
            max_tokens=self._modelOutputTokens,
            model_kwargs=model_kwargs,
        )

        # Save our chat class into the bag
        bag['chat'] = self
