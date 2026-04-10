"""
OpenAI provider handler (Handler A).

Fetches models from the OpenAI /v1/models endpoint and syncs chat models
into nodes/src/nodes/llm_openai/services.json.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class OpenAIProvider(CloudProvider):
    """
    Handler for the llm_openai node.

    Uses the openai SDK. Filters to chat-completion-capable models only
    (excludes embeddings, tts, image, search, etc.).
    """

    provider_name = 'llm_openai'
    display_name = 'OpenAI'
    smoke_type = 'chat_openai_compat'

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
        Fetch all models from OpenAI.

        The /v1/models endpoint may or may not return context_window per model.
        DEBUG lines below log the raw model object so we can see what fields
        are actually available — remove once confirmed.

        Args:
            client: openai.OpenAI instance

        Returns:
            List of model dicts with at least {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        result = []
        for m in response.data:
            entry: Dict[str, Any] = {'id': m.id}
            ctx = getattr(m, 'context_window', None)
            if ctx:
                entry['context_window'] = ctx
            result.append(entry)
        return result
