"""
NVIDIA Nemotron provider handler (Handler A) — cloud models only.

Fetches models from the NVIDIA /v1/models endpoint and syncs the cloud
profiles (nemotron-3-super, nemotron-3-ultra, nemotron-3-5-lightning) into
nodes/src/nodes/llm_nemotron/services.json.

The NVIDIA API (build.nvidia.com) is OpenAI-compatible, so the openai SDK can
be used with a custom base_url. The endpoint lists the full multi-vendor
catalog (Llama, GLM, Kimi, Mistral, ...), so the model_filter in
sync_models.config.json keeps only the nvidia/*nemotron* text chat models;
vision (VL/Omni), safety, parse, retriever, and speech variants are excluded
(they belong in dedicated nodes).

Fallback discovery (OpenRouter / LiteLLM, used when ROCKETRIDE_NVIDIA_KEY is
absent) sees the same models under bare, vendor-less IDs — and for two of
them under a different spelling than NVIDIA's own catalog. Both are folded
back into the native ``nvidia/...`` form before the config filter runs, so
the keyless scheduled sync applies exactly the rules the keyed one does.
"""

from __future__ import annotations

from typing import Dict, Any, List

from providers.base import CloudProvider

# OpenRouter (and the LiteLLM entries that mirror it) name two Nemotron models
# differently from NVIDIA's /v1/models catalog. Map the fallback spelling to the
# native one so discovery matches the seeded profiles instead of adding a
# duplicate the native SDK cannot serve. Verified against the live catalog
# (2026-09): the 3.5 Lightning line ships one size (30B-A3B), and "Nemotron 3
# Nano" was renamed to "nemotron-nano-3" upstream.
_FALLBACK_ID_ALIASES = {
    'nemotron-3.5-lightning': 'nemotron-3.5-lightning-30b-a3b',
    'nemotron-3-nano-30b-a3b': 'nemotron-nano-3-30b-a3b',
}


class NemotronProvider(CloudProvider):
    """
    Handler for cloud (API) models in the llm_nemotron node.

    The NVIDIA API is OpenAI-compatible, so the openai SDK can be used
    with a custom base_url.
    """

    provider_name = 'llm_nemotron'
    display_name = 'Nemotron (NVIDIA)'
    smoke_type = 'chat_openai_compat'

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: NVIDIA API key (nvapi-...)

        Returns:
            openai.OpenAI client pointed at the NVIDIA endpoint
        """
        import openai

        return openai.OpenAI(
            api_key=api_key,
            base_url='https://integrate.api.nvidia.com/v1',
        )

    def litellm_to_native_model_id(self, litellm_bare_id: str) -> str:
        """
        LiteLLM and OpenRouter store NVIDIA models bare (``"nemotron-3-super-120b-a12b"``),
        but the NVIDIA API — and therefore services.json — uses the
        vendor-prefixed ``"nvidia/nemotron-3-super-120b-a12b"`` form. Known
        fallback spellings that differ from the NVIDIA catalog are mapped to
        the native ID first (see ``_FALLBACK_ID_ALIASES``).

        Args:
            litellm_bare_id: Bare model ID from LiteLLM / OpenRouter (provider
                prefix stripped), or an already vendor-prefixed native ID

        Returns:
            Native model ID with the ``"nvidia/"`` vendor prefix
        """
        bare = litellm_bare_id.removeprefix('nvidia/')
        return f'nvidia/{_FALLBACK_ID_ALIASES.get(bare, bare)}'

    def should_include(self, model_id: str) -> bool:
        """
        Apply the config filter to the native (``nvidia/``-prefixed) form of ``model_id``.

        The base fallback fetchers call this on the bare OpenRouter / LiteLLM ID
        *before* ``litellm_to_native_model_id()`` adds the vendor prefix, while
        the ``include_prefixes`` in sync_models.config.json are written in
        native form. Normalising first means one set of rules holds for every
        discovery source; without it the keyless sync rejected every Nemotron
        model and succeeded as a no-op. (Same shape as the Gemini override.)

        Args:
            model_id: Bare or native model ID

        Returns:
            bool
        """
        return super().should_include(self.litellm_to_native_model_id(model_id))

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch available models from the NVIDIA API.

        Args:
            client: openai.OpenAI instance with the NVIDIA base_url

        Returns:
            List of model dicts with {"id": str}
        """
        response = client.models.list()  # type: ignore[attr-defined]
        return [{'id': m.id} for m in response.data]
