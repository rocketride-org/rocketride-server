"""
Kimi (Moonshot) provider handler (Handler A) — cloud models only.

Fetches models from the Moonshot /v1/models endpoint and syncs the cloud
profiles (kimi-k2.6, kimi-k2.5, moonshot-v1-8k/32k/128k) into
nodes/src/nodes/llm_kimi/services.json.

The Moonshot API is OpenAI-compatible, so the openai SDK can be used with a
custom base_url. The model_filter in sync_models.config.json keeps only the
text chat/generation models; the moonshot-v1-*-vision-preview image models
are excluded (they belong in a dedicated vision node).
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class KimiProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_kimi node.

    The Moonshot API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_kimi'
    display_name = 'Kimi (Moonshot)'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Moonshot API key

        Returns:
            openai.OpenAI client pointed at the Moonshot endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.moonshot.ai/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Moonshot.

        Args:
            client: openai.OpenAI instance with the Moonshot base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
