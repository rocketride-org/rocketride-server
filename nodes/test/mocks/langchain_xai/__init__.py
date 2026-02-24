"""
Mock langchain_xai for llm_xai node testing.
"""

MOCK_LLM_RESPONSE = (
    'Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set '
    'so tests run without API keys or external services.'
)


class _MockMessage:
    def __init__(self, content: str):
        self.content = content


class ChatXAI:
    """Mock ChatXAI - returns fixed stub from invoke()."""

    def __init__(self, model=None, api_key=None, **kwargs):
        self.model = model
        self.api_key = api_key

    def invoke(self, prompt) -> _MockMessage:
        return _MockMessage(MOCK_LLM_RESPONSE)

    def get_num_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)
