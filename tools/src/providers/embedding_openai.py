"""
OpenAI embedding provider handler (Handler A).

Fetches models from the OpenAI /v1/models endpoint and syncs text-embedding
models into nodes/src/nodes/embedding_openai/services.json.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class EmbeddingOpenAIProvider(CloudProvider):
    """
    Handler for the embedding_openai node.

    Reuses the OpenAI SDK client but filters for text-embedding-* models only
    and uses the embed smoke test type.
    """

    provider_name = 'embedding_openai'
    display_name = 'OpenAI'
    smoke_type = 'embed_openai'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: OpenAI API key

        Returns:
            openai.OpenAI client instance
        """
        import openai

        return openai.OpenAI(api_key=api_key)

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch all models from OpenAI; token limit filtering handled by config.

        Args:
            client: openai.OpenAI instance

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
