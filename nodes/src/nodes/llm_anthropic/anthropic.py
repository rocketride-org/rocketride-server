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
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_anthropic import ChatAnthropic

# --- ANTI-SIGBUS PATCH: disable fast tokenizers and Claude-specific token counting ---
# 1) Disable tokenizer parallelism
import os

os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

# 2) Force AutoTokenizer to use the slow (Python) version to avoid Rust binary crashes
try:
    import transformers as _tf  # type: ignore

    _orig_from_pretrained = _tf.AutoTokenizer.from_pretrained

    def _patched_from_pretrained(*args, **kwargs):
        kwargs.setdefault('use_fast', False)
        return _orig_from_pretrained(*args, **kwargs)

    _tf.AutoTokenizer.from_pretrained = _patched_from_pretrained
except Exception:
    # If transformers is not installed or fails, just skip
    pass

# 3) Disable real token counting ONLY for Claude models to avoid transformer usage
try:
    import langchain_core.utils.tokenization as _tok  # type: ignore

    _orig_get_token_ids = _tok.get_token_ids

    def _patched_get_token_ids(*args, **kwargs):
        # Compatible with both positional and keyword arguments
        text = kwargs.get('text', args[0] if args else '')
        model_name = kwargs.get('model_name')
        if model_name is None and len(args) >= 2:
            model_name = args[1]

        if model_name and 'claude' in str(model_name).lower():
            # Simple estimate: ~4 chars/token; LC only needs len(ids)
            n = max(1, (len(text) + 3) // 4)
            return [0] * n

        return _orig_get_token_ids(*args, **kwargs)

    _tok.get_token_ids = _patched_get_token_ids
except Exception:
    # If LC is not imported yet, step 2 already avoids crashes
    pass
# --- END PATCH ---


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

        # Get the API key, don't save it
        apikey = (config.get('apikey') or '').strip()

        # API key validation: must be non-empty and look like an Anthropic key
        # Formats: sk-ant-... (standard), sk-ant-api03-... (newer keys)
        if not apikey or not apikey.startswith('sk-ant'):
            raise ValueError('Invalid Anthropic API key format, please check your API key.')

        # Init the chat base
        super().__init__(provider, connConfig, bag)

        # Get the LLM
        self._llm = ChatAnthropic(model=model, api_key=apikey, temperature=0, max_tokens=self._modelOutputTokens)

        # Save our chat class into the bag
        bag['chat'] = self
