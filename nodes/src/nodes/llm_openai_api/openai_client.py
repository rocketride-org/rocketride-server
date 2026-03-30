"""
OpenAI-compatible API binding for the ChatLLM.
Supports custom base_url for providers like Featherless, Together, Groq, Ollama, etc.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError


class Chat(ChatBase):
    """
    Create an OpenAI-compatible API chat bot with custom base_url support.
    """

    _llm: ChatOpenAI

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
        kwargs = dict(
            model=self._model,
            api_key=apikey,
            temperature=0,
            max_tokens=self._modelOutputTokens,
        )
        if base_url:
            kwargs['base_url'] = base_url

        # Get the llm
        self._llm = ChatOpenAI(**kwargs)

        # Save our chat class into the bag
        bag['chat'] = self

    def is_retryable_error(self, error):
        """
        Determine if the error is retryable.
        """
        if isinstance(error, AuthenticationError):
            return False
        elif isinstance(error, APIError):
            return False
        elif isinstance(error, RateLimitError):
            return True
        elif isinstance(error, APIConnectionError):
            return True
        else:
            return False

    def map_exception(self, error):
        """
        Convert unfriendly openai exceptions to friendlier ones.
        """
        if isinstance(error, AuthenticationError):
            return ValueError('Invalid API key.')
        elif isinstance(error, APIError):
            return ValueError('An error occurred with the API.')
        elif isinstance(error, RateLimitError):
            return ValueError('Rate limit exceeded. Please try again later.')
        elif isinstance(error, APIConnectionError):
            return ValueError('Failed to connect to the API.')
        else:
            return super().map_exception(error)
