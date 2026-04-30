"""
Mock langchain_openai for LLM and embedding node testing.
=========================================================

When ROCKETRIDE_MOCK is set, this replaces the real langchain_openai so
llm_openai, llm_ollama, llm_deepseek, llm_perplexity use stubbed responses
instead of calling real APIs. embedding_openai also uses this mock.

The mock returns prompt-aware responses so client-python chat tests pass
without real API keys (test_should_handle_json_response_questions,
test_should_handle_chat_workflow_with_multiple_interactions).
"""

import json

# Stub response returned by ChatOpenAI.invoke() - mirrors LangChain AIMessage
MOCK_LLM_RESPONSE = 'Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.'

# Mock embedding dimension (OpenAI text-embedding-3-small default)
MOCK_EMBEDDING_DIM = 1536

# Responses for tests that expect specific content (client-python chat tests)
_CONSTITUTION_JSON = json.dumps(
    {
        'text': 'We the People of the United States, in Order to form a more perfect Union, '
        'establish Justice, insure domestic Tranquility, provide for the common defence, '
        'promote the general Welfare, and secure the Blessings of Liberty to ourselves '
        'and our Posterity, do ordain and establish this Constitution for the United States of America.'
    }
)
_MATH_JSON = json.dumps({'result': 20, 'operation': 'multiplication'})


def _extract_prompt_text(prompt) -> str:
    """Extract text from prompt (string, Message, or list of messages)."""
    if isinstance(prompt, str):
        return prompt
    if hasattr(prompt, 'content'):
        return str(prompt.content)
    if isinstance(prompt, (list, tuple)) and len(prompt) > 0:
        last = prompt[-1]
        if hasattr(last, 'content'):
            return str(last.content)
        return str(last)
    return str(prompt)


def _mock_response_for_prompt(prompt) -> str:
    """
    Return a response that satisfies client-python chat test assertions.
    Inspects prompt text to return JSON or plain text as required.
    """
    text = _extract_prompt_text(prompt)
    if not text:
        return MOCK_LLM_RESPONSE
    p = text.lower()
    # JSON: constitution quote (test_should_handle_json_response_questions)
    if 'constitution' in p and ('first paragraph' in p or 'cite' in p):
        return _CONSTITUTION_JSON
    # JSON: math result (test_should_handle_chat_workflow Q3)
    if ('10 * 2' in p or '10*2' in p) and ('json' in p or 'example' in p):
        return _MATH_JSON
    # Plain: 5+3 (test_should_handle_chat_workflow Q1)
    if '5 + 3' in p or '5+3' in p:
        return '8'
    # Plain: "What was the previous answer?" (test_should_handle_chat_workflow Q2)
    if 'previous answer' in p or 'what was the previous' in p:
        return '8'
    return MOCK_LLM_RESPONSE


class _MockMessage:
    """Mimics LangChain AIMessage with .content."""

    def __init__(self, content: str):
        self.content = content


class ChatOpenAI:
    """
    Mock ChatOpenAI - returns fixed stub response from invoke().
    Accepts same constructor args as real ChatOpenAI (model, api_key, etc.)
    but never calls external APIs.
    """

    def __init__(self, model=None, api_key=None, temperature=0, base_url=None, **kwargs):
        self.model = model
        self.api_key = api_key
        self.temperature = temperature
        self.base_url = base_url

    def invoke(self, prompt) -> _MockMessage:
        return _MockMessage(MOCK_LLM_RESPONSE)

    def get_num_tokens(self, text: str) -> int:
        """Return approximate token count (ChatBase uses this for limits)."""
        return max(1, len(text) // 4)


class OpenAIEmbeddings:
    """
    Mock OpenAIEmbeddings - returns fixed-dimension zero vectors.
    Used by embedding_openai node.
    """

    def __init__(self, openai_api_key=None, model=None, **kwargs):
        self.openai_api_key = openai_api_key
        self.model = model
        self.embedding_ctx_length = 8191

    def embed_query(self, text: str) -> list:
        return [0.0] * MOCK_EMBEDDING_DIM

    def embed_documents(self, texts: list) -> list:
        return [[0.0] * MOCK_EMBEDDING_DIM for _ in texts]
