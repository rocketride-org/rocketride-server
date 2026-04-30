"""
markers.py — pytest skip markers for per-provider live API tests.

Import from here (not from conftest) to avoid conftest import issues.
"""

from __future__ import annotations

import os
import pytest

requires_openai = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_OPENAI_KEY'),
    reason='ROCKETRIDE_OPENAI_KEY not set',
)

requires_anthropic = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_ANTHROPIC_KEY'),
    reason='ROCKETRIDE_ANTHROPIC_KEY not set',
)

requires_gemini = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_GEMINI_KEY'),
    reason='ROCKETRIDE_GEMINI_KEY not set',
)

requires_mistral = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_MISTRAL_KEY'),
    reason='ROCKETRIDE_MISTRAL_KEY not set',
)

requires_deepseek = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_DEEPSEEK_KEY'),
    reason='ROCKETRIDE_DEEPSEEK_KEY not set',
)

requires_xai = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_XAI_KEY'),
    reason='ROCKETRIDE_XAI_KEY not set',
)

requires_perplexity = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_PERPLEXITY_KEY'),
    reason='ROCKETRIDE_PERPLEXITY_KEY not set',
)

requires_qwen = pytest.mark.skipif(
    not os.environ.get('ROCKETRIDE_QWEN_KEY'),
    reason='ROCKETRIDE_QWEN_KEY not set',
)
