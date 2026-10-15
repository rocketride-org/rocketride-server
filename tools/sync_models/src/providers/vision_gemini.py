"""
Gemini vision provider handlers (Handler A).

Two nodes analyse images with Gemini:

  - llm_vision_gemini stores native IDs (``"models/gemini-2.5-flash"``), like llm_gemini.
  - accessibility_describe stores bare IDs (``"gemini-2.5-flash"``).

The Gemini API does not say which models accept images, so
``model_filter.require_capabilities`` asks OpenRouter and LiteLLM.
New models are checked with an image.
"""

from __future__ import annotations

from providers.gemini import GeminiProvider


class VisionGeminiProvider(GeminiProvider):
    """Handler for the llm_vision_gemini node."""

    provider_name = 'llm_vision_gemini'
    display_name = 'Gemini'
    smoke_type = 'vision_gemini'


class AccessibilityDescribeProvider(VisionGeminiProvider):
    """
    Handler for the accessibility_describe node.

    Its profiles store bare Gemini IDs, so the ``"models/"`` prefix the API
    returns is removed, and nothing adds it back.
    """

    provider_name = 'accessibility_describe'

    def normalize_model_id(self, raw_id: str) -> str:
        """
        Strip the ``"models/"`` prefix the Gemini API returns.

        Args:
            raw_id: Raw model ID (e.g. ``"models/gemini-2.5-flash"``)

        Returns:
            Bare model ID (e.g. ``"gemini-2.5-flash"``)
        """
        return raw_id.removeprefix('models/')

    def litellm_to_native_model_id(self, litellm_bare_id: str) -> str:
        """
        Keep LiteLLM/OpenRouter IDs bare: this node's native form has no prefix.

        Args:
            litellm_bare_id: Bare model ID from a fallback source

        Returns:
            The same bare model ID
        """
        return litellm_bare_id
