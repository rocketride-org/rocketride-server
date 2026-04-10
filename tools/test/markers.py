"""
markers.py — pytest skip markers for per-provider live API tests.

Import from here (not from conftest) to avoid conftest import issues.
"""

from __future__ import annotations

import os
import pytest

requires_openai = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_OPENAI'),
    reason='ROCKETRIDE_APIKEY_OPENAI not set',
)

requires_anthropic = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_ANTHROPIC'),
    reason='ROCKETRIDE_APIKEY_ANTHROPIC not set',
)

requires_gemini = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_GEMINI'),
    reason='ROCKETRIDE_APIKEY_GEMINI not set',
)

requires_mistral = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_MISTRAL'),
    reason='ROCKETRIDE_APIKEY_MISTRAL not set',
)

requires_deepseek = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_DEEPSEEK'),
    reason='ROCKETRIDE_APIKEY_DEEPSEEK not set',
)

requires_xai = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_XAI'),
    reason='ROCKETRIDE_APIKEY_XAI not set',
)

requires_perplexity = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_PERPLEXITY'),
    reason='ROCKETRIDE_APIKEY_PERPLEXITY not set',
)

requires_qwen = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_APIKEY_QWEN'),
    reason='ROCKETRIDE_APIKEY_QWEN not set',
)
