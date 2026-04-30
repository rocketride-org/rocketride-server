"""
Perplexity provider handler (Handler A).

Fetches models from the Perplexity /models endpoint and syncs into
nodes/src/nodes/llm_perplexity/services.json.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class PerplexityProvider(CloudProvider):
    """
    Handler for the llm_perplexity node.

    Perplexity's API is OpenAI-compatible; uses the openai SDK with a
    custom base_url.
    """

    provider_name = 'llm_perplexity'
    display_name = 'Perplexity'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Perplexity API key

        Returns:
            openai.OpenAI client pointed at the Perplexity endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.perplexity.ai',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Perplexity.

        Args:
            client: openai.OpenAI instance with Perplexity base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        result = []
        for m in response.data:
            entry: Dict[str, Any] = {'id': m.id}
            if hasattr(m, 'context_length') and m.context_length:
                entry['context_window'] = m.context_length
            result.append(entry)
        return result
