"""
Mock openai package for LLM node testing.

When ROCKETRIDE_MOCK is set, this replaces the real openai SDK so validateConfig
and any direct OpenAI usage in llm_openai, llm_perplexity, llm_deepseek do not
call real APIs.
"""


class APIError(Exception):
    pass


class APIStatusError(APIError):
    pass


class AuthenticationError(APIError):
    pass


class RateLimitError(APIError):
    pass


class APIConnectionError(APIError):
    pass


class OpenAIError(APIError):
    pass


class _MockChatCompletions:
    def create(self, model=None, messages=None, max_tokens=None, max_completion_tokens=None, **kwargs):
        return type('Obj', (), {'choices': []})()


class _MockChat:
    completions = _MockChatCompletions()


class OpenAI:
    """Mock OpenAI client - no real API calls."""

    def __init__(self, api_key=None, **kwargs):
        self.api_key = api_key

    @property
    def chat(self):
        return _MockChat()
