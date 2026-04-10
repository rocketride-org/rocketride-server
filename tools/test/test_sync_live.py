"""
Live API tests for the sync script.

These tests call the real provider APIs to verify that every non-deprecated
profile in services.json has a model ID that still exists in the live API.

All tests are skipped when the required API key environment variable is not set.

Run with all keys:
  pytest tools/test/test_sync_live.py

Run for a single provider:
  ROCKETRIDE_APIKEY_OPENAI=sk-... pytest tools/test/test_sync_live.py -k openai
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Dict, Any, Set

# markers.py is a regular module in tools/test/ (importable unlike conftest)
from markers import (
    requires_openai,
    requires_anthropic,
    requires_gemini,
    requires_mistral,
    requires_deepseek,
    requires_xai,
    requires_perplexity,
    requires_qwen,
)
from core.patcher import get_profiles

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent.parent


def _load_profiles(node_name: str) -> Dict[str, Any]:
    """Load all non-deprecated profiles from a node's services.json."""
    path = _REPO_ROOT / 'nodes' / 'src' / 'nodes' / node_name / 'services.json'
    all_profiles = get_profiles(str(path))
    return {key: p for key, p in all_profiles.items() if isinstance(p, dict) and not p.get('deprecated')}


# Sources where a missing model ID is an error vs a warning.
_ERROR_SOURCES = frozenset({'provider', 'manual'})


def _check_missing_models(
    profiles: Dict[str, Any],
    live_ids: Set[str],
    node_label: str,
) -> None:
    """
    Check that model IDs in profiles exist in the live API.

    - modelSource "provider" or "manual" (or absent): missing ID → test failure.
    - Any other source (e.g. "openrouter", "litellm"): missing ID → warning only.
    """
    error_missing: Set[str] = set()
    warn_missing: Set[str] = set()

    for profile in profiles.values():
        model = profile.get('model')
        if not model or model in live_ids:
            continue
        source = profile.get('modelSource', 'manual')
        if source in _ERROR_SOURCES:
            error_missing.add(model)
        else:
            warn_missing.add(model)

    if warn_missing:
        warnings.warn(
            f'{node_label}: model IDs not found in live API (modelSource is not provider/manual — non-critical): {sorted(warn_missing)}',
            UserWarning,
            stacklevel=3,
        )

    assert not error_missing, f'These {node_label} model IDs (modelSource: provider/manual) are in services.json but not in the live API: {sorted(error_missing)}'


def _fetch_openai_model_ids(api_key: str, base_url: str | None = None) -> Set[str]:
    import openai

    kwargs = {'api_key': api_key}
    if base_url:
        kwargs['base_url'] = base_url
    client = openai.OpenAI(**kwargs)
    return {m.id for m in client.models.list().data}


def _fetch_anthropic_model_ids(api_key: str) -> Set[str]:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    return {m.id for m in client.models.list().data}


def _fetch_gemini_model_ids(api_key: str) -> Set[str]:
    import google.generativeai as genai  # type: ignore[import]

    genai.configure(api_key=api_key)
    return {m.name for m in genai.list_models()}


def _fetch_mistral_model_ids(api_key: str) -> Set[str]:
    import openai

    client = openai.OpenAI(api_key=api_key, base_url='https://api.mistral.ai/v1')
    return {m.id for m in client.models.list().data}


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


@requires_openai
def test_openai_profiles_exist_in_api():
    """Every non-deprecated llm_openai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_OPENAI']
    profiles = _load_profiles('llm_openai')
    live_ids = _fetch_openai_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_openai')


@requires_openai
def test_embedding_openai_profiles_exist_in_api():
    """Every non-deprecated embedding_openai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_OPENAI']
    profiles = _load_profiles('embedding_openai')
    live_ids = _fetch_openai_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'embedding_openai')


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


@requires_anthropic
def test_anthropic_profiles_exist_in_api():
    """Every non-deprecated llm_anthropic profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_ANTHROPIC']
    profiles = _load_profiles('llm_anthropic')
    live_ids = _fetch_anthropic_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_anthropic')


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


@requires_gemini
def test_gemini_profiles_exist_in_api():
    """Every non-deprecated llm_gemini profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_GEMINI']
    profiles = _load_profiles('llm_gemini')
    live_ids = _fetch_gemini_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_gemini')


# ---------------------------------------------------------------------------
# Mistral
# ---------------------------------------------------------------------------


@requires_mistral
def test_mistral_profiles_exist_in_api():
    """Every non-deprecated llm_mistral profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_MISTRAL']
    profiles = _load_profiles('llm_mistral')
    live_ids = _fetch_mistral_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_mistral')


# ---------------------------------------------------------------------------
# DeepSeek (cloud models only)
# ---------------------------------------------------------------------------


@requires_deepseek
def test_deepseek_cloud_profiles_exist_in_api():
    """
    Non-deprecated, non-local (no colon in model ID) llm_deepseek profiles
    must be in the live DeepSeek API.
    """
    api_key = os.environ['ROCKETRIDE_APIKEY_DEEPSEEK']
    # Exclude Ollama-style "model:size" IDs — those are local, not cloud
    profiles = {k: p for k, p in _load_profiles('llm_deepseek').items() if ':' not in p.get('model', '')}
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.deepseek.com')
    _check_missing_models(profiles, live_ids, 'llm_deepseek')


# ---------------------------------------------------------------------------
# xAI
# ---------------------------------------------------------------------------


@requires_xai
def test_xai_profiles_exist_in_api():
    """Every non-deprecated llm_xai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_XAI']
    profiles = _load_profiles('llm_xai')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.x.ai/v1')
    _check_missing_models(profiles, live_ids, 'llm_xai')


# ---------------------------------------------------------------------------
# Perplexity
# ---------------------------------------------------------------------------


@requires_perplexity
def test_perplexity_profiles_exist_in_api():
    """Every non-deprecated llm_perplexity profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_PERPLEXITY']
    profiles = _load_profiles('llm_perplexity')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.perplexity.ai')
    _check_missing_models(profiles, live_ids, 'llm_perplexity')


# ---------------------------------------------------------------------------
# Qwen
# ---------------------------------------------------------------------------


@requires_qwen
def test_qwen_profiles_exist_in_api():
    """Every non-deprecated llm_qwen profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_APIKEY_QWEN']
    profiles = _load_profiles('llm_qwen')
    live_ids = _fetch_openai_model_ids(
        api_key,
        base_url='https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    )
    _check_missing_models(profiles, live_ids, 'llm_qwen')
