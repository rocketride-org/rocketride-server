"""
Qwen (Alibaba DashScope) provider handler (Handler A).

Fetches models from the DashScope API and syncs into
nodes/src/nodes/llm_qwen/services.json.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class QwenProvider(CloudProvider):
    """
    Handler for the llm_qwen node.

    DashScope exposes an OpenAI-compatible API. Uses the openai SDK
    with the DashScope international endpoint.
    """

    provider_name = 'llm_qwen'
    display_name = 'Qwen'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: DashScope API key

        Returns:
            openai.OpenAI client pointed at the DashScope endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from DashScope.

        Args:
            client: openai.OpenAI instance with DashScope base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
