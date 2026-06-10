"""
MiniMax provider handler (Handler A) — cloud models only.

Fetches models from the MiniMax /models endpoint and syncs the cloud
profiles into nodes/src/nodes/llm_minimax/services.json.

The MiniMax API is OpenAI-compatible, so the openai SDK can be used
with a custom base_url.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class MiniMaxProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_minimax node.

    The MiniMax API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_minimax'
    display_name = 'MiniMax'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: MiniMax API key

        Returns:
            openai.OpenAI client pointed at the MiniMax endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.minimax.io/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from MiniMax.

        Args:
            client: openai.OpenAI instance with MiniMax base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
