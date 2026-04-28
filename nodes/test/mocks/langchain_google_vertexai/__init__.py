"""
Mock langchain_google_vertexai for llm_vertex node testing.
"""

MOCK_LLM_RESPONSE = 'Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.'


class _MockMessage:
    def __init__(self, content: str):
        self.content = content


class ChatVertexAI:
    """Mock ChatVertexAI - returns fixed stub from invoke()."""

    def __init__(self, model=None, project=None, location=None, credentials=None, temperature=0, **kwargs):
        self.model = model
        self.project = project
        self.location = location
        self.credentials = credentials
        self.temperature = temperature

    def invoke(self, prompt) -> _MockMessage:
        return _MockMessage(MOCK_LLM_RESPONSE)

    def get_num_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)
