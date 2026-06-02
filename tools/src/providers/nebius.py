"""
Nebius provider handler (cloud) — Token Factory OpenAI-compatible models.

Fetches models from Nebius Token Factory's /v1/models endpoint and syncs
the cloud profiles into nodes/src/nodes/llm_nebius/services.json.

The Nebius Token Factory API is OpenAI-compatible, so the openai SDK can be
used with a custom base_url (the same shape as the DeepSeek handler). Nebius
hosts a broad multi-vendor catalogue, so model IDs are namespaced
(e.g. "meta-llama/Llama-3.3-70B-Instruct"); the config's model_filter and the
chat smoke test keep discovery to chat-capable models.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class NebiusProvider(CloudProvider):
    """Handler for cloud (API) models in the llm_nebius node."""

    provider_name = 'llm_nebius'
    display_name = 'Nebius Token Factory'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Nebius Token Factory API key

        Returns:
            openai.OpenAI client pointed at the Token Factory endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.tokenfactory.nebius.com/v1/',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Nebius Token Factory.

        Args:
            client: openai.OpenAI instance with the Token Factory base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
