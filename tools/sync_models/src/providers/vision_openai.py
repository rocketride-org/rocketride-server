"""
OpenAI vision provider handler (Handler A).

Syncs the image-capable OpenAI chat models into
nodes/src/nodes/llm_vision_openai/services.json.

Same API as llm_openai. OpenAI's /v1/models does not say which models accept
images, so ``model_filter.require_capabilities`` asks OpenRouter and LiteLLM.
New models are checked with an image.
"""

from __future__ import annotations

from providers.openai import OpenAIProvider


class VisionOpenAIProvider(OpenAIProvider):
    """Handler for the llm_vision_openai node."""

    provider_name = 'llm_vision_openai'
    display_name = 'OpenAI'
    smoke_type = 'vision_openai_compat'
