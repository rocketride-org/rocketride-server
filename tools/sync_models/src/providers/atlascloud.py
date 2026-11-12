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
    # The model list reports a per-model completion limit as ``max_output_length``.
    # Without it every model would get the sync's 4,096 default, which a reasoning
    # model can spend entirely on thinking.
    output_fields = ('max_output_length',)
