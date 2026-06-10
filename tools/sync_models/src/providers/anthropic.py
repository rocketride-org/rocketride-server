"""
Anthropic provider handler (Handler A).

Fetches models from the Anthropic /v1/models endpoint and syncs into
nodes/src/nodes/llm_anthropic/services.json.
"""

from __future__ import annotations

import re
from typing import Dict, Any, List

from providers.base import CloudProvider

# Matches a digit-dot-digit boundary in version numbers, e.g. "4.6" or "3.7".
# OpenRouter uses dotted versions (claude-sonnet-4.6) while Anthropic's own API
# uses hyphens (claude-sonnet-4-6).  Normalise to hyphens so OpenRouter-sourced
# IDs match existing profiles.
_DIGIT_DOT_DIGIT = re.compile(r'(\d)\.(\d)')


class AnthropicProvider(CloudProvider):
    """
    Handler for the llm_anthropic node.

    Uses the anthropic SDK. The /v1/models endpoint returns model metadata
    including context_window for most models.
    """

    provider_name = 'llm_anthropic'
    display_name = 'Anthropic'
    smoke_type = 'chat_anthropic'

    def normalize_model_id(self, raw_id: str) -> str:
        """
        Normalise an Anthropic model ID.

        Converts digit-dot-digit separators to hyphens so that OpenRouter IDs
        (e.g. ``"claude-sonnet-4.6"``) match Anthropic's own API format
        (``"claude-sonnet-4-6"``).

        Also strips models that contain a colon (e.g. ``"claude-3-7-sonnet:thinking"``
        from OpenRouter) — those are special inference modes, not standalone model IDs
        usable in standard chat completions.

        Args:
            raw_id: Raw model ID, possibly with dotted version numbers

        Returns:
            Normalised model ID with hyphens in place of dots
        """
        if ':' in raw_id:
            return ''  # causes should_include() to reject it when the empty id is checked
        return _DIGIT_DOT_DIGIT.sub(r'\1-\2', raw_id)

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Anthropic API key

        Returns:
            anthropic.Anthropic client instance
        """
        import anthropic

        return anthropic.Anthropic(api_key=api_key)

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from Anthropic.

        The Anthropic models API returns a list with id and context_window.

        Args:
            client: anthropic.Anthropic instance

        Returns:
            List of model dicts with {"id": str, "context_window": int (optional)}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        result = []
        for m in response.data:
            entry: Dict[str, Any] = {'id': m.id}
            if hasattr(m, 'context_window') and m.context_window:
                entry['context_window'] = m.context_window
            result.append(entry)
        return result
