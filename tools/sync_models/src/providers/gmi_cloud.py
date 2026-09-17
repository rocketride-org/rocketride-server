"""
GMI Cloud provider handler (Handler A).

Fetches models from the GMI Cloud inference API (OpenAI-compatible) and syncs
them into nodes/src/nodes/llm_gmi_cloud/services.json.
"""

from __future__ import annotations

from providers.aggregator import AggregatorProvider


class GmiCloudProvider(AggregatorProvider):
    """Handler for the llm_gmi_cloud node."""

    provider_name = 'llm_gmi_cloud'
    display_name = 'GMI Cloud'
    base_url = 'https://api.gmi-serving.com/v1'
