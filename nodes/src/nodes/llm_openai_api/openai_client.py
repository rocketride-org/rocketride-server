"""
OpenAI-compatible API binding for the ChatLLM.
Supports custom base_url for providers like Featherless, Together, Groq, Ollama, etc.
"""

from typing import Any, Dict
from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.model_gateway import (
    HostedModelError,
    friendly_gateway_error,
    hosted_http_clients,
    resolve_openai_credentials,
)
from langchain_openai import ChatOpenAI
from openai import APIError, AuthenticationError, RateLimitError, APIConnectionError


class Chat(ChatBase):
    """
    Create an OpenAI-compatible API chat bot with custom base_url support.
    """

    _llm: ChatOpenAI

    SUPPORTS_NATIVE_TOOLS = True
    # True when the client runs on the run's hosted models pass (no key of our own)
    _hosted_models = False

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the OpenAI-compatible chat bot.
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # The node's own key and base url, or on a hosted engine with neither,
        # the run's hosted models pass
        credentials = resolve_openai_credentials(provider, config.get('apikey'), config.get('base_url') or None)
        apikey = credentials.apikey
        base_url = credentials.base_url or None
        self._hosted_models = credentials.hosted

        # Build kwargs for ChatOpenAI
        kwargs = {
            'model': self._model,
            'api_key': apikey,
            'temperature': 0,
            'max_tokens': self._modelOutputTokens,
        }
        if base_url:
            kwargs['base_url'] = base_url
        if self._hosted_models:
            kwargs.update(hosted_http_clients())

        # Get the llm
        self._llm = ChatOpenAI(**kwargs)

        # Save our chat class into the bag
        bag['chat'] = self

    def terminal_error(self, error):
        """
        A refusal from the hosted models backend ends the call with its sentence.
        """
        if not self._hosted_models:
            return None
        sentence = friendly_gateway_error(error, self._model)
        return HostedModelError(sentence) if sentence else None

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
