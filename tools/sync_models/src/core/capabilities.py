"""
Capabilities — what a model can do, as reported by the third-party model databases.

A node that serves one kind of model (e.g. a vision node) must only take models
that have that capability. The provider's own API answers this when it can
(Mistral reports ``capabilities.vision``); for the rest, OpenRouter and LiteLLM
are consulted in the order the sync was given.

Each lookup answers True, False, or None. None means the source does not know,
and the caller decides what an unknown means.
"""

from __future__ import annotations

from typing import List, Optional

from core import merger as _merger

# Capability name → the OpenRouter input modality that proves it.
_OPENROUTER_CAPABILITY_MODALITY = {'vision': 'image'}


def openrouter_capability(model_id: str, capability: str) -> Optional[bool]:
    """
    Read a capability from OpenRouter's ``architecture.input_modalities``.

    Args:
        model_id: Bare model ID as OpenRouter indexes it (e.g. "gpt-4.1").
        capability: Capability name (e.g. "vision").

    Returns:
        True or False when OpenRouter lists the model, None otherwise.
    """
    modality = _OPENROUTER_CAPABILITY_MODALITY.get(capability)
    if modality is None:
        return None
    _merger.get_openrouter_cache()
    modalities = _merger._OPENROUTER_INPUT_MODALITIES.get(model_id)
    if modalities is None:
        return None
    return modality in modalities


def litellm_capability(model_id: str, capability: str) -> Optional[bool]:
    """
    Read a ``supports_<capability>`` flag from LiteLLM's model database.

    A model can appear under several provider prefixes (``gemini/...`` and a
    bare Vertex entry, say). Any entry saying True wins; False needs an explicit
    False and no True; entries without the flag say nothing.

    Args:
        model_id: Model ID, matched against each key with and without its
            provider prefix.
        capability: Capability name (e.g. "vision").

    Returns:
        True, False, or None when LiteLLM is missing or has no flag for the model.
    """
    if not _merger._LITELLM_AVAILABLE:
        return None
    flag = f'supports_{capability}'
    found: Optional[bool] = None
    try:
        for key, data in _merger.litellm.model_cost.items():
            bare = key.split('/', 1)[1] if '/' in key else key
            if model_id not in (key, bare) or not isinstance(data, dict):
                continue
            value = data.get(flag)
            if value is True:
                return True
            if value is False:
                found = False
    except Exception:
        return None
    return found


def lookup_capability(model_id: str, capability: str, model_sources: List[str]) -> Optional[bool]:
    """
    Ask the third-party sources, in the sync's source order, whether a model has a capability.

    The ``provider`` source is skipped: its answer travels on the model entry
    itself and is read by the provider handler before this is called.

    Args:
        model_id: Bare model ID (no provider-specific prefix such as "models/").
        capability: Capability name (e.g. "vision").
        model_sources: Ordered source keys from the sync run.

    Returns:
        The first known answer, or None when no source knows.
    """
    for source in model_sources:
        if source == 'openrouter':
            value = openrouter_capability(model_id, capability)
        elif source == 'litellm':
            value = litellm_capability(model_id, capability)
        else:
            continue
        if value is not None:
            return value
    return None
