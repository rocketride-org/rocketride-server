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

from typing import Dict, Any, List

from providers.base import CloudProvider


class MistralProvider(CloudProvider):
    """
    Handler for the llm_mistral node.

    Uses openai.OpenAI with Mistral's base URL (OpenAI-compatible endpoint).
    Filters out embedding and moderation models.
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

        Args:
            client: openai.OpenAI instance pointing at the Mistral API

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
