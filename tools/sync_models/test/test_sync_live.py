"""
Live API tests for the sync script.

These tests call the real provider APIs to verify that every non-deprecated
profile in services.json has a model ID that still exists in the live API.

All tests are skipped when the required API key environment variable is not set.

Run with all keys:
  pytest tools/sync_models/test/test_sync_live.py

Run for a single provider:
  ROCKETRIDE_OPENAI_KEY=sk-... pytest tools/sync_models/test/test_sync_live.py -k openai
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Dict, Any, Set

# markers.py is a regular module in tools/sync_models/test/ (importable unlike conftest)
from markers import (
    requires_openai,
    requires_anthropic,
    requires_gemini,
    requires_mistral,
    requires_deepseek,
    requires_xai,
    requires_perplexity,
    requires_qwen,
    requires_minimax,
    requires_baidu_qianfan,
    requires_glm,
    requires_gmi_cloud,
    requires_nebius,
)
from core.patcher import get_profiles

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent.parent.parent


def _load_profiles(node_name: str, file_name: str = 'services.json') -> Dict[str, Any]:
    """
    Load all non-deprecated profiles from one of a node's services files.

    Args:
        node_name: Node directory name
        file_name: Services file inside it (a node may define several services)

    Returns:
        Profile key → profile dict
    """
    path = _REPO_ROOT / 'nodes' / 'src' / 'nodes' / node_name / file_name
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

    assert not error_missing, (
        f'These {node_label} model IDs (modelSource: provider/manual) are in services.json but not in the live API: {sorted(error_missing)}'
    )


def _fetch_openai_model_ids(api_key: str, base_url: str | None = None) -> Set[str]:
    """
    List model IDs from an OpenAI-compatible API.

    Args:
        api_key: API key for that endpoint
        base_url: Endpoint base URL; None for OpenAI itself

    Returns:
        Set of model IDs
    """
    import openai

    kwargs = {'api_key': api_key}
    if base_url:
        kwargs['base_url'] = base_url
    client = openai.OpenAI(**kwargs)
    return {m.id for m in client.models.list().data}


def _fetch_anthropic_model_ids(api_key: str) -> Set[str]:
    """
    List model IDs from the Anthropic API.

    Args:
        api_key: Anthropic API key

    Returns:
        Set of model IDs
    """
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    return {m.id for m in client.models.list().data}


def _fetch_gemini_model_ids(api_key: str) -> Set[str]:
    """
    List model names from the Gemini API.

    Args:
        api_key: Google AI Studio API key

    Returns:
        Set of model names (with the ``"models/"`` prefix)
    """
    from google import genai  # type: ignore[import]

    client = genai.Client(api_key=api_key)
    return {m.name for m in client.models.list()}


def _fetch_mistral_model_ids(api_key: str) -> Set[str]:
    """
    List model IDs from the Mistral API.

    Args:
        api_key: Mistral API key

    Returns:
        Set of model IDs
    """
    import openai

    client = openai.OpenAI(api_key=api_key, base_url='https://api.mistral.ai/v1')
    return {m.id for m in client.models.list().data}


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


@requires_openai
def test_openai_profiles_exist_in_api():
    """Every non-deprecated llm_openai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_OPENAI_KEY']
    profiles = _load_profiles('llm_openai')
    live_ids = _fetch_openai_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_openai')


@requires_openai
def test_embedding_openai_profiles_exist_in_api():
    """Every non-deprecated embedding_openai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_OPENAI_KEY']
    profiles = _load_profiles('embedding_openai')
    live_ids = _fetch_openai_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'embedding_openai')


@requires_openai
def test_vision_openai_profiles_exist_in_api():
    """Every non-deprecated llm_vision_openai profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_OPENAI_KEY']
    profiles = _load_profiles('llm_vision_openai')
    live_ids = _fetch_openai_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_vision_openai')


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


@requires_anthropic
def test_anthropic_profiles_exist_in_api():
    """Every non-deprecated llm_anthropic profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_ANTHROPIC_KEY']
    profiles = _load_profiles('llm_anthropic')
    live_ids = _fetch_anthropic_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_anthropic')


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


@requires_gemini
def test_gemini_profiles_exist_in_api():
    """Every non-deprecated llm_gemini profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_GEMINI_KEY']
    profiles = _load_profiles('llm_gemini')
    live_ids = _fetch_gemini_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_gemini')


@requires_gemini
def test_gemini_profiles_can_actually_be_called():
    """
    Every non-deprecated llm_gemini profile must answer a real generateContent call.

    The listing check above cannot fail for a retired model: Google keeps returning
    those from models.list(), with generateContent among their supportedGenerationMethods,
    and only refuses when the model is actually called. Being listed and being usable
    are different questions, and this asks the second one.

    One minimal call per profile, so it is slower than the listing check by design.
    """
    from google import genai  # type: ignore[import]

    from core.smoke import classify_failure

    client = genai.Client(api_key=os.environ['ROCKETRIDE_GEMINI_KEY'])
    retired = []
    for profile_key, profile in _load_profiles('llm_gemini').items():
        model_id = profile.get('model')
        if not model_id or profile.get('deprecated'):
            continue
        try:
            client.models.generate_content(model=model_id, contents='Reply with the word OK only.')
        except Exception as exc:  # noqa: BLE001 — the classifier decides what the failure means
            if classify_failure(exc).retired():
                retired.append(f'{profile_key} ({model_id}): {str(exc)[:160]}')
    assert not retired, 'llm_gemini profiles the API says are retired:\n' + '\n'.join(retired)


@requires_gemini
def test_vision_gemini_profiles_exist_in_api():
    """Every non-deprecated llm_vision_gemini profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_GEMINI_KEY']
    profiles = _load_profiles('llm_vision_gemini')
    live_ids = _fetch_gemini_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_vision_gemini')


@requires_gemini
def test_accessibility_describe_profiles_exist_in_api():
    """Every non-deprecated accessibility_describe profile (bare IDs) must be in the live API."""
    api_key = os.environ['ROCKETRIDE_GEMINI_KEY']
    profiles = _load_profiles('accessibility_describe')
    live_ids = {model_id.removeprefix('models/') for model_id in _fetch_gemini_model_ids(api_key)}
    _check_missing_models(profiles, live_ids, 'accessibility_describe')


# ---------------------------------------------------------------------------
# Mistral
# ---------------------------------------------------------------------------


@requires_mistral
def test_mistral_profiles_exist_in_api():
    """Every non-deprecated llm_mistral profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_MISTRAL_KEY']
    profiles = _load_profiles('llm_mistral')
    live_ids = _fetch_mistral_model_ids(api_key)
    _check_missing_models(profiles, live_ids, 'llm_mistral')


@requires_mistral
def test_vision_mistral_profiles_exist_and_accept_images():
    """Every non-deprecated llm_vision_mistral profile must be listed, and Mistral must report vision for it."""
    import openai

    from providers.mistral import MistralProvider

    client = openai.OpenAI(api_key=os.environ['ROCKETRIDE_MISTRAL_KEY'], base_url='https://api.mistral.ai/v1')
    cards = {entry['id']: entry for entry in MistralProvider({}).fetch_models(client)}
    profiles = _load_profiles('llm_vision_mistral')
    _check_missing_models(profiles, set(cards), 'llm_vision_mistral')

    blind = sorted(
        p['model']
        for p in profiles.values()
        if p.get('model') in cards and (cards[p['model']].get('capabilities') or {}).get('vision') is False
    )
    assert not blind, f'llm_vision_mistral profiles Mistral reports as not vision-capable: {blind}'


# ---------------------------------------------------------------------------
# DeepSeek (cloud models only)
# ---------------------------------------------------------------------------


@requires_deepseek
def test_deepseek_cloud_profiles_exist_in_api():
    """
    Non-deprecated, non-local (no colon in model ID) llm_deepseek profiles
    must be in the live DeepSeek API.
    """
    api_key = os.environ['ROCKETRIDE_DEEPSEEK_KEY']
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
    api_key = os.environ['ROCKETRIDE_XAI_KEY']
    profiles = _load_profiles('llm_xai')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.x.ai/v1')
    _check_missing_models(profiles, live_ids, 'llm_xai')


# ---------------------------------------------------------------------------
# Perplexity
# ---------------------------------------------------------------------------


@requires_perplexity
def test_perplexity_profiles_exist_in_api():
    """Every non-deprecated llm_perplexity profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_PERPLEXITY_KEY']
    profiles = _load_profiles('llm_perplexity')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.perplexity.ai')
    _check_missing_models(profiles, live_ids, 'llm_perplexity')


# ---------------------------------------------------------------------------
# Qwen
# ---------------------------------------------------------------------------


@requires_qwen
def test_qwen_profiles_exist_in_api():
    """Every non-deprecated llm_qwen profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_QWEN_KEY']
    profiles = _load_profiles('llm_qwen')
    live_ids = _fetch_openai_model_ids(
        api_key,
        base_url='https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    )
    _check_missing_models(profiles, live_ids, 'llm_qwen')


# ---------------------------------------------------------------------------
# MiniMax
# ---------------------------------------------------------------------------


@requires_minimax
def test_minimax_profiles_exist_in_api():
    """Every non-deprecated llm_minimax profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_MINIMAX_KEY']
    profiles = _load_profiles('llm_minimax')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.minimax.io/v1')
    _check_missing_models(profiles, live_ids, 'llm_minimax')


# ---------------------------------------------------------------------------
# Baidu Qianfan
# ---------------------------------------------------------------------------


@requires_baidu_qianfan
def test_baidu_qianfan_profiles_exist_in_api():
    """Every non-deprecated llm_baidu_qianfan profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_BAIDU_QIANFAN_KEY']
    profiles = _load_profiles('llm_baidu_qianfan')
    live_ids = _fetch_openai_model_ids(
        api_key,
        base_url='https://qianfan.baidubce.com/v2',
    )
    _check_missing_models(profiles, live_ids, 'llm_baidu_qianfan')


# ---------------------------------------------------------------------------
# Zhipu AI GLM
# ---------------------------------------------------------------------------


@requires_glm
def test_glm_profiles_exist_in_api():
    """Every non-deprecated llm_glm profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_GLM_KEY']
    profiles = _load_profiles('llm_glm')
    live_ids = _fetch_openai_model_ids(
        api_key,
        base_url='https://api.z.ai/api/paas/v4',
    )
    _check_missing_models(profiles, live_ids, 'llm_glm')


# ---------------------------------------------------------------------------
# Model hosts (GMI Cloud, Nebius)
# ---------------------------------------------------------------------------


@requires_gmi_cloud
def test_gmi_cloud_profiles_exist_in_api():
    """Every non-deprecated llm_gmi_cloud profile model ID must be in the live API."""
    api_key = os.environ['ROCKETRIDE_GMI_CLOUD_KEY']
    profiles = _load_profiles('llm_gmi_cloud')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.gmi-serving.com/v1')
    _check_missing_models(profiles, live_ids, 'llm_gmi_cloud')


@requires_nebius
def test_nebius_profiles_exist_in_api():
    """Every non-deprecated Nebius profile (llm_openai_api/services.nebius.json) must be in the live API."""
    api_key = os.environ['ROCKETRIDE_NEBIUS_KEY']
    profiles = _load_profiles('llm_openai_api', 'services.nebius.json')
    live_ids = _fetch_openai_model_ids(api_key, base_url='https://api.tokenfactory.nebius.com/v1/')
    _check_missing_models(profiles, live_ids, 'llm_nebius')
