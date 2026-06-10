"""
Gemini provider handler (Handler A).

Fetches models from the Google Generative Language API and syncs into
nodes/src/nodes/llm_gemini/services.json.

Gemini model IDs are prefixed with "models/" (e.g. "models/gemini-2.5-pro").
The services.json profiles store the full "models/" prefix in the "model" field,
so normalize_model_id returns the ID as-is.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider


class GeminiProvider(CloudProvider):
    """
    Handler for the llm_gemini node.

    Uses the google-genai SDK (``from google import genai``). Filters for gemini-* generative models only.
    """

    provider_name = 'llm_gemini'
    display_name = 'Gemini'
    smoke_type = 'chat_gemini'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Google AI Studio API key

        Returns:
            google.genai.Client instance
        """
        from google import genai  # type: ignore[import]

        return genai.Client(api_key=api_key)

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available generative models from Google.

        Args:
            client: google.genai.Client instance

        Returns:
            List of model dicts with {"id": str, "context_window": int (optional)}
        """
        result = []
        for m in client.models.list():  # type: ignore[attr-defined]
            entry: Dict[str, Any] = {'id': m.name}  # e.g. "models/gemini-2.5-pro"
            if hasattr(m, 'input_token_limit') and m.input_token_limit:
                entry['context_window'] = m.input_token_limit
            result.append(entry)
        return result

    def litellm_to_native_model_id(self, litellm_bare_id: str) -> str:
        """
        LiteLLM stores Gemini models as ``"gemini-2.0-flash"`` (bare), but the
        Google API — and therefore services.json — uses ``"models/gemini-2.0-flash"``.

        Args:
            litellm_bare_id: Bare model ID from LiteLLM (provider prefix stripped)

        Returns:
            Native model ID with ``"models/"`` prefix
        """
        return f'models/{litellm_bare_id}'

    def derive_title(self, model_id: str, title_mappings: 'Dict[str, str]') -> str:
        """
        Strip the ``"models/"`` prefix before deriving a display title.

        Gemini profiles store model IDs as ``"models/gemini-2.5-pro"`` but the
        title mappings are keyed on the bare prefix ``"gemini-"``.  Without
        stripping, ``_derive_title`` falls through to the generic capitalisation
        fallback and produces ``"Models/gemini-2.5-pro"`` instead of
        ``"Gemini 2.5 Pro"``.

        Args:
            model_id: Native Gemini model ID (e.g. ``"models/gemini-2.5-pro"``)
            title_mappings: Prefix → display prefix dict from sync_models.config.json

        Returns:
            Human-readable title (e.g. ``"Gemini 2.5 Pro"``)
        """
        return super().derive_title(model_id.removeprefix('models/'), title_mappings)

    def normalize_profile_model_id(self, model_id: str) -> str:
        """
        Strip the ``"models/"`` prefix from a services.json profile model ID
        so that it matches the bare IDs returned by OpenRouter (which is used
        as a fallback when no Google API key is available).

        Gemini profiles store ``"models/gemini-2.5-pro"`` but OpenRouter uses
        ``"gemini-2.5-pro"``.  Without this normalisation the deprecation check
        would compare ``"models/gemini-2.5-pro" in openrouter_ids`` → False and
        wrongly mark the profile as deprecated.

        Args:
            model_id: ``"model"`` field value from a services.json profile

        Returns:
            Bare model ID without the ``"models/"`` prefix
        """
        return model_id.removeprefix('models/')

    def should_include(self, model_id: str) -> bool:
        """
        Only include models that support generateContent and match the filter.

        Args:
            model_id: Model name (with or without "models/" prefix)

        Returns:
            bool
        """
        # Apply the base include/exclude filter first
        # Use the short name for pattern matching
        short_id = model_id.removeprefix('models/')
        if not super().should_include(short_id):
            return False
        return True
