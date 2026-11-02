"""
Mistral vision provider handler (Handler A).

Syncs the image-capable Mistral models into
nodes/src/nodes/llm_vision_mistral/services.json.

Same API as llm_mistral. The difference is which models qualify: Mistral's
model card reports ``capabilities.vision``, and ``model_filter.require_capabilities``
keeps only the models where it is true. New models are checked with an image.
"""

from __future__ import annotations

from providers.mistral import MistralProvider


class VisionMistralProvider(MistralProvider):
    """Handler for the llm_vision_mistral node."""

    provider_name = 'llm_vision_mistral'
    display_name = 'Mistral AI'
    smoke_type = 'vision_openai_compat'
