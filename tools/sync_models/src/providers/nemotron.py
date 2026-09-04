"""
NVIDIA Nemotron provider handler (Handler A) — cloud models only.

Fetches models from the NVIDIA /v1/models endpoint and syncs the cloud
profiles (nemotron-3-super, nemotron-3-ultra, nemotron-3-nano) into
nodes/src/nodes/llm_nemotron/services.json.

The NVIDIA API (build.nvidia.com) is OpenAI-compatible, so the openai SDK can
be used with a custom base_url. The endpoint lists the full multi-vendor
catalog (Llama, GLM, Kimi, Mistral, ...), so the model_filter in
sync_models.config.json keeps only the nvidia/*nemotron* text chat models;
vision (VL/Omni), safety, parse, retriever, and speech variants are excluded
(they belong in dedicated nodes).
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class NemotronProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_nemotron node.

    The NVIDIA API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_nemotron'
    display_name = 'Nemotron (NVIDIA)'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: NVIDIA API key (nvapi-...)

        Returns:
            openai.OpenAI client pointed at the NVIDIA endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://integrate.api.nvidia.com/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from the NVIDIA API.

        Args:
            client: openai.OpenAI instance with the NVIDIA base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
