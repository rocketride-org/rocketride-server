"""
OpenAI-compatible API binding for the ChatLLM.
Supports custom base_url for providers like Featherless, Together, Groq, Ollama, etc.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.llm_native_stream import PROMPT_CACHE_PREFIX_VAR, apply_prompt_cache_breakpoint
from ai.common.utils import parse_bool
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError


class _CacheBoundaryChatOpenAI(ChatOpenAI):
    """ChatOpenAI that sends the cacheable start of the prompt as its own content part.

    The split is the Anthropic driver's, without its marker: what to mark is left to
    the gateway in front of the model, and a plain endpoint would reject the field.
    """

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        apply_prompt_cache_breakpoint(payload, PROMPT_CACHE_PREFIX_VAR.get())
        messages = payload.get('messages') or []
        content = messages[-1].get('content') if messages else None
        if isinstance(content, list):
            for part in content:
                part.pop('cache_control', None)
        return payload


class Chat(ChatBase):
    """
    Create an OpenAI-compatible API chat bot with custom base_url support.
    """

    _llm: ChatOpenAI

    SUPPORTS_NATIVE_TOOLS = True

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the OpenAI-compatible chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get the api key and base url
        apikey = config.get('apikey')
        base_url = config.get('base_url') or None

        # Build kwargs for ChatOpenAI
        kwargs = {
            'model': self._model,
            'api_key': apikey,
            'temperature': 0,
            'max_tokens': self._modelOutputTokens,
        }
        if base_url:
            kwargs['base_url'] = base_url

        # Off by default: some endpoints accept only a string as message content.
        send_boundary = parse_bool(config.get('cachePrefixParts'))
        self.SUPPORTS_PROMPT_CACHE_PREFIX = send_boundary

        # Get the llm. Turns stay on the plain class: reasoning is replayed only to the
        # class that wrote it, so the option must not change which class that is.
        self._plain_llm = ChatOpenAI(**kwargs)
        self._llm = _CacheBoundaryChatOpenAI(**kwargs) if send_boundary else self._plain_llm

        # Save our chat class into the bag
        bag['chat'] = self

    def _turn_llm(self) -> ChatOpenAI:
        return self._plain_llm

    def chat_turn(self, question, *args, **kwargs):
        """Send a turn unmarked: ChatBase would add cache_control, which this node never sends.

        Args:
            question: The turn-mode Question.
            *args: Passed on to ChatBase.chat_turn.
            **kwargs: Passed on to ChatBase.chat_turn.

        Returns:
            The model's Answer.
        """
        return super().chat_turn(question.model_copy(update={'cachePrefix': False}), *args, **kwargs)

    def is_retryable_error(self, error):
        """
        Determine if the error is retryable.
        """
        if isinstance(error, (AuthenticationError, APIError)):
            return False
        if isinstance(error, (RateLimitError, APIConnectionError)):
            return True
        return super().is_retryable_error(error)

    def map_exception(self, error):
        """
        Convert unfriendly openai exceptions to friendlier ones.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid API key.')
        if isinstance(error, APIError):
            return ValueError('An error occurred with the API.')
        if isinstance(error, RateLimitError):
            return ValueError('Rate limit exceeded. Please try again later.')
        if isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the API.')
        return super().map_exception(error)
