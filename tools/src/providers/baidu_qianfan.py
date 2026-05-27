"""
Baidu Qianfan provider handler.

Fetches models from Qianfan's OpenAI-compatible models endpoint and syncs them
into nodes/src/nodes/llm_baidu_qianfan/services.json.
"""

from __future__ import annotations

from typing import Any, Dict, List

from providers.base import CloudProvider


class BaiduQianfanProvider(CloudProvider):
    """Handler for the llm_baidu_qianfan node."""

    provider_name = 'llm_baidu_qianfan'
    display_name = 'Baidu Qianfan'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://qianfan.baidubce.com/v2',
        )

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
