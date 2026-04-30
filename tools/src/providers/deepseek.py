"""
DeepSeek provider handler (Handler A) — cloud models only.

Fetches models from the DeepSeek /models endpoint and syncs the cloud
profiles (deepseek-reasoner, deepseek-chat) into
nodes/src/nodes/llm_deepseek/services.json.

NOTE: Local Ollama-style profiles (deepseek-r1:8b, etc.) in the same
services.json are managed separately by Handler B and are not touched
by this handler. The model_filter include_prefixes setting ensures only
"deepseek-" IDs from the cloud API are considered.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class DeepSeekProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_deepseek node.

    The DeepSeek API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_deepseek'
    display_name = 'DeepSeek'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: DeepSeek API key

        Returns:
            openai.OpenAI client pointed at the DeepSeek endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.deepseek.com',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from DeepSeek.

        Args:
            client: openai.OpenAI instance with DeepSeek base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
