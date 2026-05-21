"""
Kimi (Moonshot AI) provider handler (Handler A) — cloud models only.

Fetches models from the Moonshot AI /models endpoint and syncs profiles
(moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, kimi-k2.5) into
nodes/src/nodes/llm_kimi/services.json.

The Moonshot AI API is OpenAI-compatible, so the openai SDK is used
with a custom base_url pointing at https://api.moonshot.ai/v1.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class KimiProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_kimi node.

    The Moonshot AI (Kimi) API is OpenAI-compatible, so the openai SDK
    can be used with a custom base_url.
    """

    provider_name = 'llm_kimi'
    display_name = 'Kimi'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Moonshot AI API key (ROCKETRIDE_KIMI_KEY)

        Returns:
            openai.OpenAI client pointed at the Moonshot AI endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.moonshot.ai/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Moonshot AI.

        Args:
            client: openai.OpenAI instance with Moonshot AI base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
