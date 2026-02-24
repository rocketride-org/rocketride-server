"""
Mock langchain_aws for llm_bedrock node testing.
"""

MOCK_LLM_RESPONSE = (
    'Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set '
    'so tests run without API keys or external services.'
)


class _MockMessage:
    def __init__(self, content: str):
        self.content = content


class ChatBedrock:
    """Mock ChatBedrock - returns fixed stub from invoke()."""

    def __init__(self, model_id=None, region_name=None, **kwargs):
        self.model_id = model_id
        self.region_name = region_name

    def invoke(self, prompt) -> _MockMessage:
        return _MockMessage(MOCK_LLM_RESPONSE)

    def get_num_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)
