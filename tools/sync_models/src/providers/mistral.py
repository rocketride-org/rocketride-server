"""
Mistral provider handler (Handler A).

Fetches models from the Mistral /v1/models endpoint and syncs into
nodes/src/nodes/llm_mistral/services.json.

Mistral's API is OpenAI-compatible, so this handler uses openai.OpenAI
pointed at the Mistral base URL instead of the mistralai SDK. This avoids
SDK version conflicts (the engine uses an older mistralai package) and means
the standard chat_openai_compat smoke test works without any adaptation.
"""

from __future__ import annotations

from typing import Dict, Any, List, Optional

from providers.base import CloudProvider


class MistralProvider(CloudProvider):
    """
    Handler for the llm_mistral node.

    Uses openai.OpenAI with Mistral's base URL (OpenAI-compatible endpoint).
    Embedding and moderation models are filtered via model_filter in sync_models.config.json.
    Token limits are sourced from sync_models.config.json overrides since
    the Mistral API does not return context_window in the model list.
    """

    provider_name = 'llm_mistral'
    display_name = 'Mistral AI'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Mistral API key

        Returns:
            openai.OpenAI client pointed at https://api.mistral.ai/v1
        """
        import openai  # type: ignore[import]

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.mistral.ai/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Mistral via its OpenAI-compatible endpoint.

        Mistral's model card carries a ``capabilities`` object (``vision``,
        ``completion_chat``, ...). The openai SDK keeps it as an extra field; it is
        copied onto the entry so capability filters can use the provider's answer.

        Args:
            client: openai.OpenAI instance pointing at the Mistral API

        Returns:
            List of model dicts with {"id": str} and, when reported, {"capabilities": dict}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        result = []
        for m in response.data:
            entry: Dict[str, Any] = {'id': m.id}
            capabilities = _as_dict(getattr(m, 'capabilities', None))
            if capabilities is not None:
                entry['capabilities'] = capabilities
            result.append(entry)
        return result


def _as_dict(value: Any) -> Optional[Dict[str, Any]]:
    """
    Return an SDK extra field as a plain dict.

    Args:
        value: A dict, a pydantic model, or anything else

    Returns:
        The dict, or None when the value is not dict-shaped
    """
    if isinstance(value, dict):
        return value
    dump = getattr(value, 'model_dump', None)
    if callable(dump):
        try:
            dumped = dump()
        except Exception:
            return None
        return dumped if isinstance(dumped, dict) else None
    return None
