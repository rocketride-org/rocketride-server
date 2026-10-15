"""
Nebius Token Factory provider handler (Handler A).

Fetches models from the Nebius Token Factory API (OpenAI-compatible) and syncs
them into nodes/src/nodes/llm_openai_api/services.nebius.json — the Nebius
service of the llm_openai_api node.
"""

from __future__ import annotations

from providers.aggregator import AggregatorProvider


class NebiusProvider(AggregatorProvider):
    """Handler for the Nebius service (``llm_nebius://``) of the llm_openai_api node."""

    provider_name = 'llm_nebius'
    display_name = 'Nebius'
    base_url = 'https://api.tokenfactory.nebius.com/v1/'
