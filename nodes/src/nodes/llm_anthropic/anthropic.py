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
``ai.common.llm_native_stream`` (``native_stream_key()`` names 'anthropic' for a thinking call).
"""

from typing import Any, Dict

from ai.common.chat import ChatBase, UNBOUND_MODEL
from ai.common.llm_native_stream import (
    PROMPT_CACHE_PREFIX_VAR,
    apply_prompt_cache_breakpoint,
    build_anthropic_thinking_kwargs,
    gate_model_name,
)
from ai.common.utils import parse_bool
from langchain_anthropic import ChatAnthropic


def _estimate_token_ids(text: str) -> list:
    """Estimate token ids at ~4 chars/token."""
    return [0] * max(1, (len(text) + 3) // 4)


class _ChatAnthropic(ChatAnthropic):
    """ChatAnthropic that marks the cacheable start of the prompt, when there is one.

    Every request is built here, whether invoked, streamed through LangChain, or
    streamed by the native extended-thinking adapter, so one override covers all three.
    """

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        return apply_prompt_cache_breakpoint(payload, PROMPT_CACHE_PREFIX_VAR.get())


class Chat(ChatBase):
    """
    Create an Anthropic chat bot.
    """

    _llm: ChatAnthropic

    # Anthropic caches only up to an explicit marker, so the driver places one at the
    # end of the prompt's unchanging start (see apply_prompt_cache_breakpoint).
    SUPPORTS_PROMPT_CACHE_PREFIX = True
    SUPPORTS_NATIVE_TOOLS = True

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Anthropic chat bot.
        """
        # Init the chat base: it refuses a key left as ${ROCKETRIDE_...}. The
        # model, its output window and extended thinking are the call's.
        super().__init__(provider, connConfig, bag)
        config = self._config

        # Get the API key, don't save it
        apikey = (config.get('apikey') or '').strip()

        # API key validation: must be non-empty and look like an Anthropic key
        # Formats: sk-ant-... (standard), sk-ant-api03-... (newer keys)
        if not apikey or not apikey.startswith('sk-ant'):
            raise ValueError('Invalid Anthropic API key format, please check your API key.')

        # One client for every call: each request binds its model and max_tokens
        self._llm = _ChatAnthropic(
            model=UNBOUND_MODEL,
            api_key=apikey,
            custom_get_token_ids=_estimate_token_ids,
        )

    def thinking_kwargs(self) -> Dict[str, Any]:
        """
        Return this call's extended-thinking request values, or ``{}``.

        Extended thinking is opt-in per call (``extendedThinking``, default off)
        and only for reasoning models. It is NOT baked into the client: the
        native streaming adapter adds it per call, so thinking activates on the
        interactive streaming path only, never on the agent / expectJson path
        (which has no streaming and stays on the plain LangChain request).
        """
        call = self.call
        if not (call.reasoning and parse_bool(call.settings.get('extendedThinking'))):
            return {}
        return build_anthropic_thinking_kwargs(gate_model_name(str(call.model or '')), call.output_tokens)

    def native_stream_key(self) -> str:
        """Stream through the native Messages API when this call thinks; otherwise the LangChain stream."""
        return 'anthropic' if self.thinking_kwargs() else ''

    def turn_kwargs(self) -> Dict[str, Any]:
        """
        Return the request values of a turn: the call's, with its extended thinking.

        A turn keeps the signed thinking blocks in its messages, so thinking
        can stay on through a tool loop on any path, not only the native text
        stream. The thinking values are this call's (``thinking_kwargs``) and
        are bound onto the request, never onto the client.
        """
        return {**self.call_kwargs(), **self.thinking_kwargs()}
