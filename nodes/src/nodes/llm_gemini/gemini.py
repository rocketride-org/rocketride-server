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

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.llm_adapter import debug_usage_failure, report_llm_tokens
from google import genai


def _report_gemini_usage(response: Any, model: str) -> None:
    """Report a ``generate_content`` response's usage on the four token counters.

    This node overrides ``_chat`` and sets no ``_llm``, so it never reaches
    ``LangChainAdapter`` — without this the provider bills zero. Gemini counts
    ``prompt_token_count`` with the cached prefix included, so the cache is subtracted
    back out to keep the counters disjoint; ``thoughts_token_count`` is reasoning, which
    Google bills at the output rate.
    """
    um = getattr(response, 'usage_metadata', None)
    if um is None:
        return

    def _n(field: str) -> int:
        return int(getattr(um, field, 0) or 0)

    # Best-effort: this runs on a response the user already paid for, and the caller is
    # a retry loop that would read a raise as a provider error and lose the answer.
    try:
        cache_read = _n('cached_content_token_count')
        fresh_input = max(0, _n('prompt_token_count') - cache_read)
        output = _n('candidates_token_count') + _n('thoughts_token_count')
    except Exception as exc:
        debug_usage_failure(exc)
        return
    report_llm_tokens(fresh_input, output, model=model, cache_read_tokens=cache_read)


class GeminiNoTextError(Exception):
    """A response that carried no text: blocked, out of budget, or non-text only.

    Terminal, not transient. The API has answered — asking again sends the same
    prompt for the same verdict, and every retry is billed.
    """


class Chat(ChatBase):
    """
    Google GenAI chat class supporting both Gemini Developer API and Vertex AI.

    This class provides a standardized interface for interacting with Google's Gemini
    models through the genai library. It inherits from ChatBase and implements
    the necessary methods for chat functionality.

    Attributes:
        _client (genai.Client): The Google GenAI client instance for API communication

    Example:
        >>> chat = Chat(provider='gemini', connConfig={'apikey': 'your-api-key'}, bag={})
        >>> response = chat._chat('Hello, how are you?')
    """

    _client: genai.Client

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the Gemini chat bot.

        Args:
            provider (str): The provider identifier (e.g., "gemini")
            connConfig (Dict[str, Any]): Connection configuration containing API credentials
                Expected keys:
                - apikey: Google GenAI API key
            bag (Dict[str, Any]): Shared state bag for storing chat instance

        Raises:
            KeyError: If required configuration keys are missing
            ValueError: If API key is invalid or empty
        """
        super().__init__(provider, connConfig, bag)

        # Retrieve and validate configuration
        config = Config.getNodeConfig(provider, connConfig)
        api_key = config.get('apikey')

        # The C++ engine derives the profile sub-key as the segment after the first underscore
        # of the profile name (e.g. "gemini-2_5-pro" → stored as "5-pro"). Try that fallback.
        # IJson.get() requires a default argument — always pass one.
        if not api_key and hasattr(connConfig, 'get'):
            _profile = connConfig.get('profile', None) or ''
            if _profile and '_' in _profile:
                _sub = connConfig.get(_profile.split('_', 1)[1], None)
                if _sub and hasattr(_sub, 'get'):
                    api_key = _sub.get('apikey', None) or ''

        if not api_key:
            raise ValueError('Please enter your Gemini API key.')

        self._modelTotalTokens = config.get('modelTotalTokens', 8192)

        # Initialize the Google GenAI client — key format validation is delegated to the library
        self._client = genai.Client(api_key=api_key)

        # Store chat instance in shared bag for access by other components
        bag['chat'] = self

        """
        Note: For future refactor, we can consolidate Vertex AI support.
        The google-genai library supports Vertex AI through the same client:
        
        client = genai.Client(
            vertexai=True, 
            project='your-project-id', 
            location='us-central1'
        )
        
        This would allow us to remove the separate Vertex Node implementation
        and use a unified interface for both Developer API and Vertex AI.
        """

    def getTokens(self, value: str | None) -> int:
        """
        Estimate the number of tokens in a given text string.

        This is a simplified token estimation that assumes approximately 0.75 tokens
        per word. For more accurate token counting, consider using the model's
        built-in tokenizer if available.

        Args:
            value (str | None): The text string to estimate tokens for. None is
                accepted and counts as nothing: `.text` is None for a response
                that carried no text parts, and token accounting must not be
                the place that discovers it.

        Returns:
            int: Estimated number of tokens

        Note:
            This is an approximation. Different models may have different
            tokenization schemes. For production use, consider using the
            model's native token counting method if available.
        """
        # None or empty means nothing to count. The SDK hands back None (not
        # '') for a response with no text parts, and token accounting must not
        # be the place that discovers it.
        if not value:
            return 0
        # Simple approximation: ~0.75 tokens per word
        word_count = len(value.split())
        return int(word_count / 0.75)

    def _chat(self, prompt: str) -> str:
        """
        Send a chat prompt to the Gemini model and return the response.

        This method handles the core chat functionality by sending the prompt
        to the configured Gemini model and returning the generated text response.

        Args:
            prompt (str): The user's input prompt/message

        Returns:
            str: The model's text response

        Raises:
            Exception: If the API call fails or returns an error
            AttributeError: If the model is not properly configured

        Note:
            This method assumes self._model is set by the parent class.
            The model should be a valid Gemini model identifier (e.g., 'gemini-pro').
        """
        # Generate content using the configured model
        response = self._client.models.generate_content(model=self._model, contents=prompt)

        # Before the text check, deliberately: a response that carried no text
        # still burned tokens, and a safety block is exactly the run somebody
        # will be asking about when they look at the bill.
        _report_gemini_usage(response, self._model)

        # `.text` is None (not '') when the candidate carried no text parts:
        # safety-blocked, the token budget spent before any visible text (a
        # thinking model can burn it all mid-thought), or non-text parts only.
        # Name the API's own reasons rather than letting the None surface
        # downstream as a token-counting crash that says nothing.
        text = response.text
        if text is None:
            candidates = getattr(response, 'candidates', None) or []
            finish = getattr(candidates[0], 'finish_reason', None) if candidates else 'no candidates'
            feedback = getattr(response, 'prompt_feedback', None)
            block = getattr(feedback, 'block_reason', None) if feedback else None
            detail = f'finish_reason={finish}'
            if block:
                detail += f', block_reason={block}'
            raise GeminiNoTextError(f'Gemini returned a response with no text ({detail})')
        return text

    def is_retryable_error(self, error: Exception) -> bool:
        """
        Never retry a text-free response.

        ChatBase treats an error it does not recognise as retryable, so without
        this a safety block would be re-sent — and re-billed — up to
        ``CONST_CHAT_MAX_RETRIES`` times for the same refusal.
        """
        if isinstance(error, GeminiNoTextError):
            return False
        return super().is_retryable_error(error)
