"""
Mock anthropic package for LLM node testing.

When ROCKETRIDE_MOCK is set, this replaces the real anthropic SDK so validateConfig
in llm_anthropic does not call real APIs.
"""


class APIError(Exception):
    pass


class APIStatusError(APIError):
    pass


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIError):
    pass


class RateLimitError(APIError):
    pass


class AuthenticationError(APIError):
    pass


class BadRequestError(APIError):
    pass


class PermissionDeniedError(APIError):
    pass


class NotFoundError(APIError):
    pass


class InternalServerError(APIError):
    pass


class _MockMessages:
    def create(self, model=None, max_tokens=None, messages=None, **kwargs):
        return type('Obj', (), {'content': [], 'id': 'mock', 'model': model})()


class Anthropic:
    """Mock Anthropic client - no real API calls."""

    def __init__(self, api_key=None, **kwargs):
        self.api_key = api_key

    @property
    def messages(self):
        return _MockMessages()
