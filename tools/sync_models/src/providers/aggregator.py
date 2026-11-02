"""
Base handler for OpenAI-compatible model hosts (Handler A).

Hosts such as GMI Cloud and Nebius serve many vendors' models behind one
OpenAI-compatible API, with org-prefixed IDs (``"Qwen/Qwen3-32B-FP8"``). Those
IDs exist nowhere else — OpenRouter indexes ``"qwen3-32b"`` — so these providers
set ``require_api_key`` and are synced only through their own API.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from providers.base import CloudProvider

# Model-list fields that hosts use for the context window, in order of preference.
_CONTEXT_FIELDS = ('context_window', 'context_length', 'max_model_len', 'max_context_length')


class AggregatorProvider(CloudProvider):
    """
    OpenAI-compatible host with org-prefixed model IDs.

    Subclasses set ``provider_name``, ``display_name`` and ``base_url``.
    """

    base_url: str = ''
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Host API key

        Returns:
            openai.OpenAI client pointed at ``base_url``
        """
        import openai

        return openai.OpenAI(api_key=api_key, base_url=self.base_url)

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch the host's model list, with the context window when the host reports one.

        Args:
            client: openai.OpenAI instance pointed at the host

        Returns:
            List of model dicts with {"id": str} and optionally {"context_window": int}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        result = []
        for m in response.data:
            entry: Dict[str, Any] = {'id': m.id}
            context_window = _context_window(m)
            if context_window:
                entry['context_window'] = context_window
            result.append(entry)
        return result

    def token_lookup_id(self, model_id: str) -> str:
        """
        Map a proxied vendor model to the vendor's own ID; leave everything else alone.

        A host that resells ``"openai/gpt-5.2"`` serves the vendor's model, so the
        vendor's published limits are the right ones, and they are what OpenRouter
        files under ``"gpt-5.2"``. An open-weight model the host runs itself
        (``"Qwen/Qwen3-32B-FP8"``) keeps its ID, which matches nothing — deliberately,
        since another host's deployment says nothing about this one's.

        Args:
            model_id: Org-prefixed model ID

        Returns:
            The vendor's bare ID for a proxied model, else the ID unchanged
        """
        prefixes = self._config.get('vendor_proxy_prefixes', [])
        if any(model_id.lower().startswith(prefix.lower()) for prefix in prefixes):
            return model_id.split('/', 1)[-1].lower()
        return model_id

    def should_include(self, model_id: str) -> bool:
        """
        Apply the model filter, with ``exclude_patterns`` matched case-insensitively.

        Host IDs mix case (``"meta-llama/Llama-Guard-4-12B"``), so a lowercase
        pattern such as ``"guard"`` must still match.

        Args:
            model_id: Org-prefixed model ID

        Returns:
            bool
        """
        lowered = model_id.lower()
        if any(pattern.lower() in lowered for pattern in self.model_filter.get('exclude_patterns', [])):
            return False
        return super().should_include(model_id)

    def derive_title(self, model_id: str, title_mappings: Dict[str, str]) -> str:
        """
        Title a model from its name without the org prefix.

        ``"Qwen/Qwen3-32B-FP8"`` becomes ``"Qwen3 32B FP8"``. Names that match a
        title mapping (``"openai/gpt-5.2"``) use the shared rules instead.

        Args:
            model_id: Org-prefixed model ID
            title_mappings: Prefix → display prefix dict from sync_models.config.json

        Returns:
            Human-readable title
        """
        name = model_id.rsplit('/', 1)[-1]
        if any(name.startswith(prefix) for prefix in title_mappings):
            return super().derive_title(name, title_mappings)
        title = re.sub(r'[-_]+', ' ', name).strip()
        return title[:1].upper() + title[1:]


def _context_window(model: object) -> Optional[int]:
    """
    Read the context window from a model-list entry, whatever the host calls it.

    Args:
        model: An SDK model object (extra fields are kept as attributes)

    Returns:
        The first positive integer found, or None
    """
    for name in _CONTEXT_FIELDS:
        value = getattr(model, name, None)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return None
