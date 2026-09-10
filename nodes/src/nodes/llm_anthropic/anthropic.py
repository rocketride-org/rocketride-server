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
from ai.common.utils import parse_bool
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

        # Extended thinking is opt-in per node (config extendedThinking, default off) and only
        # for reasoning models. It is NOT baked into the client: the native streaming adapter adds
        # it per call, so thinking activates on the interactive streaming path only — never on the
        # agent / expectJson path (which has no streaming and stays on the plain LangChain client).
        self._thinking_mode_kwargs: Dict[str, Any] = {}
        if self._is_reasoning and parse_bool(config.get('extendedThinking')):
            self._thinking_mode_kwargs = build_anthropic_thinking_kwargs(model_gate, self._modelOutputTokens)
        self._extended_thinking = bool(self._thinking_mode_kwargs)
        if self._extended_thinking:
            self._native_stream_provider = 'anthropic'

        # The workspace an identity-linked key acts in.
        #
        # Anthropic binds a key either to a workspace or to a user identity. An
        # identity-linked key does not carry a workspace of its own, so the API
        # refuses the request outright: "anthropic-workspace-id is required when
        # authenticating with an identity-linked API key". Nothing about such a
        # key looks unusual — same `sk-ant-api03` prefix, same length — so the
        # first sign of it is a 400 on the first turn.
        #
        # OPTIONAL, and silent when unset. A workspace-scoped key needs no
        # header and is rejected if sent a wrong one, so this must stay absent
        # unless a real value was configured — which is why an unresolved
        # `${...}` is treated as unset rather than passed along. An engine that
        # leaves the reference in place when nothing is set would otherwise send
        # the literal text as the workspace id, and the resulting error names a
        # workspace nobody has.
        workspace = str(config.get('workspaceId') or '').strip()
        if workspace.startswith('${'):
            workspace = ''

        client_kwargs: Dict[str, Any] = {}
        if workspace:
            client_kwargs['default_headers'] = {'anthropic-workspace-id': workspace}

        self._llm = ChatAnthropic(
            model=model,
            api_key=apikey,
            max_tokens=self._modelOutputTokens,
            custom_get_token_ids=_estimate_token_ids,
            **client_kwargs,
        )

        # Save our chat class into the bag
        bag['chat'] = self
