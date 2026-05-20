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
Anthropic binding for the ChatLLM (fixes #785: prompt caching support).

Changes vs. original:
  - Reads optional ``caching`` bool from the service profile config.
  - When caching=true, attaches the ``anthropic-beta: prompt-caching-2024-07-31``
    header and wraps the system prompt content block with cache_control so
    the system prompt is eligible for cache hits on repeated calls.
  - Surfaces ``cache_creation_input_tokens`` and ``cache_read_input_tokens``
    from the API response usage block via the existing debug channel so they
    appear in flow traces (satisfies the observability requirement in #785).
  - Backwards-compatible: caching defaults to False, existing pipeline configs
    that omit the field behave identically to before.
"""

from typing import Any, Dict, List

from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import BaseMessage, SystemMessage

# --- ANTI-SIGBUS PATCH: disable fast tokenizers and Claude-specific token counting ---
import os
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

try:
    import transformers as _tf
    _orig_from_pretrained = _tf.AutoTokenizer.from_pretrained

    def _patched_from_pretrained(*args, **kwargs):
        kwargs.setdefault('use_fast', False)
        return _orig_from_pretrained(*args, **kwargs)

    _tf.AutoTokenizer.from_pretrained = _patched_from_pretrained
except Exception:
    pass

try:
    import langchain_core.utils.tokenization as _tok
    _orig_get_token_ids = _tok.get_token_ids

    def _patched_get_token_ids(*args, **kwargs):
        text = kwargs.get('text', args[0] if args else '')
        model_name = kwargs.get('model_name')
        if model_name is None and len(args) >= 2:
            model_name = args[1]

        if model_name and 'claude' in str(model_name).lower():
            n = max(1, (len(text) + 3) // 4)
            return [0] * n

        return _orig_get_token_ids(*args, **kwargs)

    _tok.get_token_ids = _patched_get_token_ids
except Exception:
    pass

# --- END PATCH ---

# Anthropic prompt-caching beta header
_CACHING_BETA_HEADER = "prompt-caching-2024-07-31"


def _wrap_system_with_cache_control(messages: List[BaseMessage]) -> List[BaseMessage]:
    """
    Find the first SystemMessage and attach cache_control to its content block.

    This marks the system prompt as cacheable so subsequent calls with the same
    system prompt hit the cache instead of re-processing it. The cache_control
    block must be on the *last* content block of the system message per the
    Anthropic caching spec.
    """
    result = []
    for msg in messages:
        if isinstance(msg, SystemMessage) and not getattr(msg, '_cache_applied', False):
            text = msg.content if isinstance(msg.content, str) else str(msg.content)
            cached_msg = SystemMessage(
                content=[
                    {
                        "type": "text",
                        "text": text,
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
            )
            # Tag so we don't double-wrap on retry
            object.__setattr__(cached_msg, '_cache_applied', True)
            result.append(cached_msg)
        else:
            result.append(msg)
    return result


class Chat(ChatBase):
    """
    Create an Anthropic chat bot with optional prompt caching (issue #785).

    Config fields:
        model   — Claude model name (required)
        apikey  — Anthropic API key starting with sk-ant (required)
        caching — bool; enable Anthropic prompt caching (optional, default False)
    """

    _llm: ChatAnthropic
    _caching: bool

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        config = Config.getNodeConfig(provider, connConfig)
        model = config.get('model')
        apikey = (config.get('apikey') or '').strip()
        self._caching = bool(config.get('caching', False))

        if not apikey or not apikey.startswith('sk-ant'):
            raise ValueError('Invalid Anthropic API key format, please check your API key.')

        super().__init__(provider, connConfig, bag)

        llm_kwargs: Dict[str, Any] = {
            'model': model,
            'api_key': apikey,
            'temperature': 0,
            'max_tokens': self._modelOutputTokens,
        }

        if self._caching:
            # Activate the prompt-caching beta on every request from this node.
            llm_kwargs['model_kwargs'] = {
                'extra_headers': {'anthropic-beta': _CACHING_BETA_HEADER},
            }

        self._llm = ChatAnthropic(**llm_kwargs)

        bag['chat'] = self

    def _invoke(self, messages: List[BaseMessage], **kwargs) -> Any:
        """
        Invoke the LLM, optionally wrapping the system prompt for cache eligibility,
        and emit cache token counts into the flow trace when caching is active.
        """
        if self._caching:
            messages = _wrap_system_with_cache_control(messages)

        response = self._llm.invoke(messages, **kwargs)

        if self._caching:
            self._emit_cache_metrics(response)

        return response

    def _emit_cache_metrics(self, response: Any) -> None:
        """Log Anthropic cache token usage to the flow trace via debug()."""
        try:
            # langchain-anthropic surfaces usage_metadata on the AIMessage
            usage = getattr(response, 'usage_metadata', None) or {}
            # Anthropic-specific keys surfaced by langchain-anthropic >= 0.3
            created = usage.get('cache_creation_input_tokens', 0)
            read = usage.get('cache_read_input_tokens', 0)
            if created or read:
                from engLib import debug
                debug(
                    f'[llm_anthropic] cache_creation_input_tokens={created} '
                    f'cache_read_input_tokens={read}'
                )
        except Exception:
            pass  # Never let metric collection crash the pipeline
