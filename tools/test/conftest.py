"""
conftest.py — pytest fixtures and configuration for tools/test/.

Provides:
  - sys.path setup so tools/src/ modules are importable
  - mock_provider_api fixture for offline tests
  - sample_services_json fixture for patcher tests

Per-provider skip markers live in markers.py so they can be imported
directly by test modules without the 'conftest not on sys.path' problem.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, Any, List
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Path setup — must happen before any tools/src imports
# ---------------------------------------------------------------------------

_TOOLS_TEST = Path(__file__).parent
_TOOLS_SRC = _TOOLS_TEST.parent / 'src'

for _p in [str(_TOOLS_SRC), str(_TOOLS_TEST)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Load .env from repo root so ROCKETRIDE_<PROVIDER>_KEY vars are available.
# This must run before markers.py is imported (skipif conditions are
# evaluated at import time).
try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore[assignment]

if load_dotenv is not None:
    try:
        load_dotenv(_TOOLS_TEST.parent.parent / '.env')
    except OSError as exc:
        import warnings

        warnings.warn(f'Could not load .env: {exc}', stacklevel=1)

# ---------------------------------------------------------------------------
# Mock provider API helper
# ---------------------------------------------------------------------------


def _make_model(model_id: str, context_window: int | None = None) -> MagicMock:
    """Create a mock model object as returned by SDK list() calls."""
    m = MagicMock()
    m.id = model_id
    m.context_window = context_window
    return m


def _make_model_list(model_ids: List[str]) -> MagicMock:
    """Create a mock response from client.models.list()."""
    response = MagicMock()
    response.data = [_make_model(mid) for mid in model_ids]
    return response


@pytest.fixture
def mock_openai_models() -> List[str]:
    """Canned list of OpenAI model IDs for offline tests."""
    return [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-5',
        'gpt-5-mini',
        'o3',
        'o3-mini',
        # non-chat models that should be filtered out
        'text-embedding-3-small',
        'dall-e-3',
        'whisper-1',
        'tts-1',
    ]


@pytest.fixture
def mock_anthropic_models() -> List[str]:
    """Canned list of Anthropic model IDs for offline tests."""
    return [
        'claude-sonnet-4-6-20250514',
        'claude-opus-4-6-20250514',
        'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-20241022',
    ]


@pytest.fixture
def mock_provider_client(mock_openai_models) -> MagicMock:
    """
    Return a mock SDK client whose .models.list() returns the canned OpenAI model list.

    Also mocks .chat.completions.create() to succeed (smoke test pass).
    """
    client = MagicMock()
    client.models.list.return_value = _make_model_list(mock_openai_models)

    completion = MagicMock()
    completion.choices = [MagicMock()]
    client.chat.completions.create.return_value = completion

    return client


# ---------------------------------------------------------------------------
# Sample services.json fixture
# ---------------------------------------------------------------------------

_SAMPLE_SERVICES_JSON = """\
{
\t// Node configuration
\t"type": "llm_test",
\t"title": "Test LLM",

\t//
\t// Preconfig section
\t//
\t"preconfig": {
\t\t//
\t\t// Available profiles
\t\t//
\t\t"profiles": {
\t\t\t"test-model-a": {
\t\t\t\t"title": "Test Model A",
\t\t\t\t"model": "test-model-a",
\t\t\t\t"modelTotalTokens": 16384,
\t\t\t\t"apikey": ""
\t\t\t},
\t\t\t"test-model-b": {
\t\t\t\t"title": "Test Model B",
\t\t\t\t"model": "test-model-b",
\t\t\t\t"modelTotalTokens": 32768,
\t\t\t\t"apikey": ""
\t\t\t}
\t\t},
\t\t"default": "test-model-a"
\t}
}
"""


@pytest.fixture
def sample_services_json_file():
    """
    Write a minimal services.json with comments to a temp file.

    Yields the file path; cleans up after the test.
    """
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, encoding='utf-8') as fh:
        fh.write(_SAMPLE_SERVICES_JSON)
        path = fh.name
    yield path
    os.unlink(path)


@pytest.fixture
def current_profiles() -> Dict[str, Any]:
    """Profiles dict extracted from the sample services.json."""
    return {
        'test-model-a': {
            'title': 'Test Model A',
            'model': 'test-model-a',
            'modelSource': 'provider',
            'modelTotalTokens': 16384,
            'modelOutputTokens': 4096,
            'apikey': '',
        },
        'test-model-b': {
            'title': 'Test Model B',
            'model': 'test-model-b',
            'modelSource': 'provider',
            'modelTotalTokens': 32768,
            'modelOutputTokens': 4096,
            'apikey': '',
        },
    }


@pytest.fixture
def title_mappings() -> Dict[str, str]:
    """Minimal title mappings for offline tests."""
    return {
        'gpt-': 'GPT-',
        'claude-': 'Claude ',
        'gemini-': 'Gemini ',
        'test-': 'Test ',
    }
