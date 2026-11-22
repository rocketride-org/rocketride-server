"""
Mock langchain_aws for llm_bedrock node testing.
"""

MOCK_LLM_RESPONSE = (
    'Mock LLM response. This stub is used when RR_MOCK is set so tests run without API keys or external services.'
)


class _MockMessage:
    def __init__(self, content: str):
        self.content = content


class ChatBedrock:
    """Mock ChatBedrock - returns fixed stub from invoke()."""

    def __init__(self, model_id=None, region_name=None, **kwargs):
        # ``model`` is the real class's alias of ``model_id``; the boto3 clients may be passed in to share
        self.model_id = model_id or kwargs.get('model')
        self.region_name = region_name
        self.client = kwargs.get('client')
        self.bedrock_client = kwargs.get('bedrock_client')

    def bind(self, **kwargs):
        """Bind a call's request values (model, max_tokens, ...); the stub answers the same for every call."""
        return self

    def invoke(self, prompt) -> _MockMessage:
        return _MockMessage(MOCK_LLM_RESPONSE)

    def get_num_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)
