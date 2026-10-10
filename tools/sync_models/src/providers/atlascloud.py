"""
Atlas Cloud provider handler (Handler A).

Fetches models from the Atlas Cloud API (OpenAI-compatible) and syncs them into
nodes/src/nodes/llm_openai_api/services.atlascloud.json — the Atlas Cloud
service of the llm_openai_api node.
"""

from __future__ import annotations

from providers.aggregator import AggregatorProvider


class AtlasCloudProvider(AggregatorProvider):
    """Handler for the Atlas Cloud service (``llm_atlascloud://``) of the llm_openai_api node."""

    provider_name = 'llm_atlascloud'
    display_name = 'Atlas Cloud'
    base_url = 'https://api.atlascloud.ai/v1/'
