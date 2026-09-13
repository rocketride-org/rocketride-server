"""
Zhipu AI GLM provider handler (Handler A) — cloud models only.

Fetches models from the Z.ai /models endpoint and syncs the cloud profiles
(the glm-* family) into nodes/src/nodes/llm_glm/services.json.

The Z.ai API (api.z.ai) is OpenAI-compatible, so the openai SDK can be used
with a custom base_url. The model_filter in sync_models.config.json keeps
only the glm-* text chat models; vision (4V/4.5V), embedding, rerank, audio,
and reward variants are excluded (they belong in dedicated nodes).
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class GlmProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_glm node.

    The Z.ai API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_glm'
    display_name = 'GLM (Z.ai)'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Z.ai / Zhipu AI API key

        Returns:
            openai.OpenAI client pointed at the Z.ai endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.z.ai/api/paas/v4',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from the Z.ai API.

        Args:
            client: openai.OpenAI instance with the Z.ai base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
