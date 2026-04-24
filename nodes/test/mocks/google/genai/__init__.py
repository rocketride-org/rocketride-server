# =============================================================================
# MIT License
# Copyright (c) 2026 Aparati Software AG
# =============================================================================

"""
Mock google.genai for llm_gemini and accessibility_describe node testing.
===========================================================================

When ROCKETRIDE_MOCK is set, this replaces the real google.genai so that
llm_gemini and accessibility_describe use stubbed responses instead of
calling the real Google AI API.

API surface mocked:
    genai.Client(api_key=...)
    client.models.generate_content(model=..., contents=..., config=...)
    response.text  ->  str
"""

MOCK_RESPONSE_TEXT = 'Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.'


class _MockResponse:
    """Mimics the response object returned by generate_content()."""

    def __init__(self, text: str):
        self.text = text


class _MockModels:
    """Mimics genai.Client().models — the namespace for generative model calls."""

    def generate_content(self, model, contents, config=None):
        """
        Return a fixed stub response regardless of model, contents, or config.

        Args:
            model: Gemini model identifier (ignored)
            contents: Prompt string or list of Content objects (ignored)
            config: Optional generation config dict (ignored)

        Returns:
            _MockResponse with a fixed .text value
        """
        return _MockResponse(MOCK_RESPONSE_TEXT)


class Client:
    """
    Mock google.genai.Client.

    Accepts the same constructor arguments as the real Client (api_key,
    vertexai, project, location) but never makes network calls.
    """

    def __init__(self, api_key=None, vertexai=False, project=None, location=None, **kwargs):
        """
        Initialize the mock client.

        Args:
            api_key: API key (ignored)
            vertexai: Whether to use Vertex AI (ignored)
            project: Project ID (ignored)
            location: Location (ignored)
            **kwargs: Additional arguments (ignored)
        """
        self.api_key = api_key
        self.vertexai = vertexai
        self.project = project
        self.location = location
        self.models = _MockModels()
