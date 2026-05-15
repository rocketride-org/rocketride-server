"""
xAI (Grok) provider handler (Handler A).

Fetches models from the xAI /v1/models endpoint and syncs into
nodes/src/nodes/llm_xai/services.json.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class XAIProvider(CloudProvider):
    """
    Handler for the llm_xai node.

    The xAI API is OpenAI-compatible; uses the openai SDK with a custom base_url.
    """

    provider_name = 'llm_xai'
    display_name = 'xAI'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: xAI API key

        Returns:
            openai.OpenAI client pointed at the xAI endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://api.x.ai/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from xAI.

        Args:
            client: openai.OpenAI instance with xAI base_url

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
