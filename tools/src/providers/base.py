"""
Base class for cloud API provider handlers (Handler A).

Each provider module in this package exposes a subclass of CloudProvider
that overrides ``fetch_models()`` and ``make_client()``.  The orchestrator
calls ``sync()`` which drives the full fetch → smoke-test → merge pipeline.
"""

from __future__ import annotations

import copy
import json
import os
import re
from abc import ABC, abstractmethod
from datetime import date as _date
from typing import Any, Dict, List, Optional

from core.merger import _derive_title, _LITELLM_AVAILABLE, get_openrouter_cache, is_openrouter_available, merge
from core.patcher import patch, _find_fields_block, _repair_field_objects
from core.reporter import ProviderReport
from core.smoke import run as smoke_run, SmokeResult

try:
    import json5 as _json5
except ImportError:
    _json5 = None  # type: ignore[assignment]

# Matches dated snapshot suffixes at the end of a model ID:
#   -2024-05-13  (YYYY-MM-DD, e.g. gpt-4-turbo-2024-04-09)
#   -0613        (MMDD, e.g. gpt-4-0613, gpt-3.5-turbo-1106)
_DATED_SNAPSHOT_RE = re.compile(r'(-20\d{2}-\d{2}-\d{2}|-\d{4})$')


def _active_protected_profiles(entries: List, today=None) -> set:
    """
    Parse a protected_profiles list from config and return the set of currently
    active profile keys.

    Each entry is either:
      - a bare string ``"key"`` — always active (legacy / no expiry)
      - ``["key", "YYYY-MM-DD"]`` — active only while today <= expiry date

    Expired entries (today > expiry) are silently dropped so the sync tool can
    deprecate a profile once its grace period is over.

    Args:
        entries: list from config, containing strings or [key, date] pairs
        today: date to compare against (defaults to date.today())

    Returns:
        Set of active profile key strings
    """
    if today is None:
        today = _date.today()
    active: set = set()
    for entry in entries:
        if isinstance(entry, str):
            active.add(entry)
        elif isinstance(entry, (list, tuple)) and len(entry) == 2:
            key, expiry_str = entry[0], entry[1]
            try:
                expiry = _date.fromisoformat(str(expiry_str))
                if today <= expiry:
                    active.add(key)
            except (ValueError, TypeError):
                active.add(key)  # malformed date → treat as always active
    return active


class CloudProvider(ABC):
    """
    Abstract base for a cloud-API provider handler.

    Subclasses must implement:
      - ``fetch_models(client)`` — call the provider's models list API
      - ``make_client(api_key)`` — return the SDK client

    They may optionally override:
      - ``smoke_type`` property — which smoke function to use
      - ``normalize_model_id()`` — strip prefix/suffix from raw API IDs
      - ``litellm_to_native_model_id()`` — convert LiteLLM bare ID to native format
    """

    # Override in subclasses
    provider_name: str = ''
    display_name: str = ''  # human-readable provider name (e.g. "xAI") for messages
    smoke_type: str = 'chat_openai_compat'

    def __init__(self, config: Dict[str, Any]):
        """
        Args:
            config: The provider's entry from sync_models.config.json["providers"]
        """
        self._config = config

    @property
    def env_var(self) -> str:
        """Name of the environment variable that holds the API key."""
        return self._config['env_var']

    @property
    def token_overrides(self) -> Dict[str, int]:
        return self._config.get('token_limit_overrides', {})

    @property
    def model_filter(self) -> Dict[str, Any]:
        return self._config.get('model_filter', {})

    def get_api_key(self) -> Optional[str]:
        """Return the API key from the environment, or None if not set."""
        return os.environ.get(self.env_var)

    @abstractmethod
    def make_client(self, api_key: str) -> object:
        """
        Construct and return the provider SDK client.

        Args:
            api_key: The provider API key

        Returns:
            Provider SDK client instance
        """

    @abstractmethod
    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Fetch the list of available models from the provider API.

        Args:
            client: SDK client returned by ``make_client()``

        Returns:
            List of model dicts, each with at least ``{"id": str}``.
            Optionally include ``"context_window": int``.
        """

    def normalize_model_id(self, raw_id: str) -> str:
        """
        Normalise a raw model ID returned by the API to a canonical form.

        Default implementation returns the id unchanged. Override if the
        provider prefixes IDs (e.g. Gemini uses ``"models/gemini-2.0-flash"``).

        Args:
            raw_id: Raw model ID from the API response

        Returns:
            Canonical model ID to use in services.json profiles
        """
        return raw_id

    def derive_title(self, model_id: str, title_mappings: Dict[str, str]) -> str:
        """
        Derive a human-readable display title for a model ID.

        The default implementation delegates to the standalone ``_derive_title``
        helper in ``core.merger``, which uses the ``title_mappings`` from
        ``sync_models.config.json`` to map known prefixes to display prefixes
        (e.g. ``"claude-"`` → ``"Claude "``) and title-cases the remainder.

        Override in provider subclasses when the canonical model ID stored in
        services.json contains a provider-specific prefix that should be stripped
        before title generation.  For example, Gemini stores IDs as
        ``"models/gemini-2.5-pro"``; the Gemini override strips ``"models/"``
        so the title becomes ``"Gemini 2.5 Pro"`` rather than
        ``"Models/gemini-2.5-pro"``.

        Args:
            model_id: Provider model ID as it will be stored in the ``"model"``
                      field of the new profile (e.g. ``"models/gemini-2.5-pro"``)
            title_mappings: Prefix → display prefix dict from sync_models.config.json

        Returns:
            Human-readable title string (e.g. ``"Gemini 2.5 Pro"``)
        """
        return _derive_title(model_id, title_mappings)

    def normalize_profile_model_id(self, model_id: str) -> str:
        """
        Normalise a ``"model"`` field value from an existing services.json profile
        to match the form returned by the discovery source (provider API or
        OpenRouter) for the purpose of deprecation checking.

        This is the inverse direction of ``normalize_model_id``.  The default
        implementation is an identity (returns the id unchanged).

        Override when the canonical form stored in services.json differs from
        what the fallback discovery source (OpenRouter) returns.  For example,
        Gemini profiles store ``"models/gemini-2.5-pro"`` but OpenRouter uses
        the bare ``"gemini-2.5-pro"`` — the override strips the ``"models/"``
        prefix so the deprecation check finds a match and the profile is not
        wrongly marked deprecated.

        Args:
            model_id: ``"model"`` field value from a services.json profile

        Returns:
            Normalised model ID to use when looking up against the API model list
        """
        return model_id

    def litellm_to_native_model_id(self, litellm_bare_id: str) -> str:
        """
        Convert a bare LiteLLM model ID (provider prefix stripped) to the
        native format stored in services.json ``"model"`` fields.

        The default returns the ID unchanged.  Override when the provider's
        native format differs from LiteLLM's representation — e.g. Gemini
        stores ``"models/gemini-2.0-flash"`` but LiteLLM uses ``"gemini-2.0-flash"``.

        Args:
            litellm_bare_id: Model ID after stripping any LiteLLM provider prefix
                             (e.g. ``"gemini/"`` stripped from ``"gemini/gemini-2.0-flash"``)

        Returns:
            Native model ID for this provider's services.json profiles
        """
        return litellm_bare_id

    def should_include(self, model_id: str) -> bool:
        """
        Return True if this model ID should be considered for sync.

        Applies the ``model_filter`` rules from the config:
        - If ``include_prefixes`` is non-empty, the model must match one.
        - The model must not match any ``exclude_prefixes``.
        - The model must not contain any ``exclude_patterns``.

        Args:
            model_id: Normalised model ID

        Returns:
            bool
        """
        f = self.model_filter
        include_prefixes = f.get('include_prefixes', [])
        exclude_prefixes = f.get('exclude_prefixes', [])
        exclude_patterns = f.get('exclude_patterns', [])
        exclude_exact = f.get('exclude_exact', [])

        if model_id in exclude_exact:
            return False

        if include_prefixes:
            if not any(model_id.startswith(p) for p in include_prefixes):
                return False

        if any(model_id.startswith(p) for p in exclude_prefixes):
            return False

        if any(pat in model_id for pat in exclude_patterns):
            return False

        if self._config.get('exclude_dated_snapshots') and _DATED_SNAPSHOT_RE.search(model_id):
            return False

        return True

    def sync(
        self,
        current_profiles: Dict[str, Any],
        title_mappings: Dict[str, str],
        output_token_overrides: Dict[str, int],
        default_output_tokens: int,
        extra_profile_fields: Dict[str, Any] | None,
        apply: bool,
        services_json_path: str,
        model_sources: List[str] | None = None,
        enable_discovery: bool = False,
        allow_fallback_discovery: bool = False,
        use_config_overrides: bool = True,
        global_protected_profiles: List[str] | None = None,
    ) -> ProviderReport:
        """
        Full sync pipeline: pick source → fetch → discovery gate → smoke (if applicable) → merge.

        Args:
            current_profiles: Current profiles dict from the node's services.json
            title_mappings: From sync_models.config.json for title generation
            output_token_overrides: model_id → output token count overrides
            default_output_tokens: Default output tokens when no override exists
            extra_profile_fields: Fields to add to every new profile (e.g. {"apikey": ""})
            apply: If False, perform a dry run (no file writes)
            services_json_path: Path to the node's services.json file
            model_sources: Ordered list of sources to consult.  Allowed values:
                ``"provider"``, ``"openrouter"``, ``"litellm"``.  Order matters —
                first listed source has highest enrichment priority and is the
                preferred discovery source.  Default ``["provider", "openrouter", "litellm"]``.
            enable_discovery: If True, new models found in the discovery source
                are added as profiles.  If False (default), the sync runs in
                enrichment-only mode — token data and deprecation status are
                updated on existing profiles, but no profile keys are added.
            allow_fallback_discovery: If True, OpenRouter/LiteLLM may serve as
                discovery sources for providers whose API key is missing.
                Default False — strict mode: missing-key providers are skipped
                for discovery (existing profiles still enriched).
            use_config_overrides: If False, ignore token_limit_overrides and
                model_output_tokens.overrides from the config file.
            global_protected_profiles: Profile keys that must never be deprecated
                regardless of provider config (e.g. ["custom"])

        Returns:
            ProviderReport describing what changed
        """
        if model_sources is None:
            model_sources = ['provider', 'openrouter', 'litellm']

        report = ProviderReport(provider=self.provider_name)

        # Per-provider config can force-disable OpenRouter (e.g. embedding providers
        # where OpenRouter has no coverage and would wrongly deprecate all models).
        if self._config.get('use_openrouter') is False:
            model_sources = [s for s in model_sources if s != 'openrouter']

        api_key = self.get_api_key()

        # --- Compute per-source availability for this provider ---
        # Enrichment availability: can the source contribute token data at all.
        # Discovery availability: can the source ADD new profiles (stricter — gated
        # by --allow-fallback-discovery for non-provider sources).
        def _enrichment_available(src: str) -> bool:
            if src == 'provider':
                return bool(api_key)
            if src == 'openrouter':
                # Trigger the cache load lazily; is_openrouter_available() reflects post-load state.
                get_openrouter_cache()
                return is_openrouter_available()
            if src == 'litellm':
                return _LITELLM_AVAILABLE
            return False

        def _discovery_available(src: str) -> bool:
            if not _enrichment_available(src):
                return False
            if src == 'provider':
                return True
            return allow_fallback_discovery

        # Pick the first enrichment-available source for fetching api_models.
        primary_source: str | None = next((s for s in model_sources if _enrichment_available(s)), None)
        if primary_source is None:
            report.warning = f'No source available for {self.provider_name}: API key {self.env_var} not set; OpenRouter/LiteLLM also unavailable.'
            return report

        # Pick the first discovery-available source (may be None even when primary_source is set —
        # e.g. provider key missing + allow_fallback_discovery=False).
        discovery_source: str | None = next((s for s in model_sources if _discovery_available(s)), None)

        # --- Fetch api_models from primary_source ---
        try:
            if primary_source == 'provider':
                client = self.make_client(api_key)
                raw_models = self.fetch_models(client)
                # Filter and normalise model IDs (provider source only — fallback
                # sources do their own filtering inside _fetch_*_models()).
                candidate_models: List[Dict[str, Any]] = []
                for m in raw_models:
                    raw_id = m.get('id', '')
                    model_id = self.normalize_model_id(raw_id)
                    if self.should_include(model_id):
                        entry = dict(m)
                        entry['id'] = model_id
                        candidate_models.append(entry)
                api_models = candidate_models
            elif primary_source == 'openrouter':
                client = None
                api_models = self._fetch_openrouter_models()
            else:  # 'litellm'
                client = None
                api_models = self._fetch_litellm_models()
        except Exception as e:
            report.error = f'Failed to fetch models from {primary_source}: {e}'
            return report

        # Set deprecation_source label based on the actual primary source.
        if primary_source == 'provider':
            provider_label = self.display_name or self.provider_name
            deprecation_source = f'{provider_label} API'
        elif primary_source == 'openrouter':
            deprecation_source = 'OpenRouter'
        else:
            deprecation_source = 'LiteLLM'

        # --- Discovery gate ---
        # If discovery is off, OR no source qualifies for discovery, drop new models
        # from api_models so the merger only enriches existing profiles.
        existing_model_ids = {p.get('model') for p in current_profiles.values() if isinstance(p, dict)}
        discovery_skipped_due_to_strict_mode = False
        if not enable_discovery:
            api_models = [m for m in api_models if m['id'] in existing_model_ids]
        elif discovery_source is None:
            api_models = [m for m in api_models if m['id'] in existing_model_ids]
            discovery_skipped_due_to_strict_mode = True

        # --- Smoke gate ---
        # Smoke tests run only when (a) discovery is enabled, (b) discovery_source
        # is the native provider API (we have a client), and (c) there are new
        # models surviving the discovery gate.
        if enable_discovery and discovery_source == 'provider' and primary_source == 'provider' and client is not None:
            verified_models: List[Dict[str, Any]] = []
            for m in api_models:
                model_id = m['id']
                if model_id in existing_model_ids:
                    verified_models.append(m)
                else:
                    result: SmokeResult = smoke_run(self.smoke_type, client, model_id)
                    if result.passed():
                        verified_models.append(m)
                    else:
                        report.skipped.append((model_id, result.reason))
            api_models = verified_models

        # --- Warning messages for partial-result modes ---
        if primary_source != 'provider' and api_key is None:
            report.warning = f'API key not set ({self.env_var}) — using {primary_source} as model source (no smoke tests).'
        if discovery_skipped_due_to_strict_mode:
            report.discovery_skipped = True

        return self._run_merge(
            report=report,
            api_models=api_models,
            current_profiles=current_profiles,
            title_mappings=title_mappings,
            output_token_overrides=output_token_overrides,
            default_output_tokens=default_output_tokens,
            extra_profile_fields=extra_profile_fields,
            apply=apply,
            services_json_path=services_json_path,
            model_sources=model_sources,
            use_config_overrides=use_config_overrides,
            global_protected_profiles=global_protected_profiles,
            deprecation_source=deprecation_source,
        )

    def _fetch_litellm_models(self) -> List[Dict[str, Any]]:
        """
        Build a filtered model list from LiteLLM's built-in model database.

        Iterates ``litellm.model_cost``, strips provider prefixes (e.g. ``"openai/"``
        from ``"openai/gpt-4o"``), converts to native model IDs via
        ``litellm_to_native_model_id()``, and applies this provider's filter rules.

        Returns:
            List of model dicts ``{"id": str, "context_window": int (optional)}``.
            Each ``id`` is in this provider's native format.
        """
        import litellm  # type: ignore[import]

        seen: Dict[str, Dict[str, Any]] = {}  # native_id → entry

        for model_key, info in litellm.model_cost.items():
            # Skip template/documentation entries — litellm.model_cost contains
            # a "sample_spec" key whose values are descriptive strings, not numbers.
            # Any entry where max_tokens is not an integer is not a real model.
            raw_ctx = info.get('max_tokens')
            if raw_ctx is not None and not isinstance(raw_ctx, (int, float)):
                continue

            # Strip the LiteLLM provider prefix if present (e.g. "gemini/" from
            # "gemini/gemini-2.0-flash") to get the bare model ID for filtering.
            if '/' in model_key:
                bare_id = model_key.split('/', 1)[1]
            else:
                bare_id = model_key

            if not self.should_include(bare_id):
                continue

            native_id = self.litellm_to_native_model_id(bare_id)
            if native_id in seen:
                continue  # keep first encounter

            ctx_window: Optional[int] = int(raw_ctx) if raw_ctx is not None else None
            entry: Dict[str, Any] = {'id': native_id, '_source': 'litellm'}
            if ctx_window:
                entry['context_window'] = ctx_window
            seen[native_id] = entry

        return list(seen.values())

    def _fetch_openrouter_models(self) -> List[Dict[str, Any]]:
        """
        Build a filtered model list from the OpenRouter model database.

        Loads the cached OpenRouter model list (fetched once per process),
        applies this provider's filter rules, and converts bare model IDs to
        the native format via ``litellm_to_native_model_id()``.

        OpenRouter IDs are ``provider/model-id`` (e.g. ``"anthropic/claude-sonnet-4-6"``);
        the cache is already indexed by bare ID (``"claude-sonnet-4-6"``).

        Returns:
            List of model dicts ``{"id": str, "context_window": int (optional)}``.
            Each ``id`` is in this provider's native format.
        """
        seen: Dict[str, Dict[str, Any]] = {}  # native_id → entry

        for bare_id, (ctx, _out, _name, _exp) in get_openrouter_cache().items():
            # Apply the same two-step conversion as _fetch_litellm_models():
            # 1. normalize_model_id() — handles raw ID quirks (e.g. dots→hyphens for Anthropic)
            # 2. litellm_to_native_model_id() — converts to the native format stored in
            #    services.json (e.g. adds "models/" prefix for Gemini)
            normalized = self.normalize_model_id(bare_id)
            if not normalized:
                continue  # normalize_model_id() returns '' to reject an ID
            native_id = self.litellm_to_native_model_id(normalized)
            if not native_id:
                continue
            if not self.should_include(normalized):
                continue
            if native_id in seen:
                continue  # keep first encounter

            entry: Dict[str, Any] = {'id': native_id, '_source': 'openrouter'}
            if ctx is not None:
                entry['context_window'] = ctx
            if _out is not None:
                entry['max_output_tokens'] = _out
            if _name:
                entry['name'] = _name
            if _exp:
                entry['expiration_date'] = _exp
            seen[native_id] = entry

        return list(seen.values())

    def _run_merge(
        self,
        report: ProviderReport,
        api_models: List[Dict[str, Any]],
        current_profiles: Dict[str, Any],
        title_mappings: Dict[str, str],
        output_token_overrides: Dict[str, int],
        default_output_tokens: int,
        extra_profile_fields: Dict[str, Any] | None,
        apply: bool,
        services_json_path: str,
        model_sources: List[str] | None = None,
        use_config_overrides: bool = True,
        global_protected_profiles: List[str] | None = None,
        deprecation_source: str = 'provider API',
    ) -> ProviderReport:
        """
        Run the smart merge and optionally write results to disk.

        Args:
            report: ProviderReport to populate (mutated in-place and returned)
            api_models: Verified model list to merge against
            current_profiles: Current profiles dict from services.json
            title_mappings: From config for title generation
            output_token_overrides: model_id → output token count overrides
            default_output_tokens: Default output tokens when no override exists
            extra_profile_fields: Fields to add to every new profile
            apply: If True, write changed profiles to disk
            services_json_path: Path to the node's services.json file
            model_sources: Ordered list of token-data sources (``"provider"``,
                ``"openrouter"``, ``"litellm"``).  Determines enrichment priority.
            use_config_overrides: If False, ignore token_limit_overrides and
                                  output_token_overrides from the config file
            global_protected_profiles: Global keys that must never be deprecated
            deprecation_source: Human-readable label for the model discovery source
                (e.g. "xAI API", "OpenRouter", "LiteLLM"). Written into the
                "migration" field of newly deprecated profiles.

        Returns:
            The populated ProviderReport
        """
        provider_default_ctx = self._config.get('default_context_window')
        # Merge per-provider and global protected lists, respecting expiry dates
        protected = _active_protected_profiles(self._config.get('protected_profiles', []))
        if global_protected_profiles:
            protected.update(_active_protected_profiles(global_protected_profiles))
        updated_profiles, merge_result = merge(
            current_profiles=current_profiles,
            api_models=api_models,
            title_mappings=title_mappings,
            token_overrides=self.token_overrides if use_config_overrides else {},
            output_token_overrides=output_token_overrides if use_config_overrides else {},
            default_output_tokens=default_output_tokens,
            extra_profile_fields=extra_profile_fields,
            provider_default_context_window=provider_default_ctx,
            protected_profile_keys=protected,
            model_sources=model_sources,
            normalize_profile_model_id=self.normalize_profile_model_id,
            deprecation_source=deprecation_source,
            derive_title_fn=self.derive_title,
        )

        report.added = merge_result.added
        report.updated = merge_result.updated
        report.deprecated = merge_result.deprecated
        report.unchanged_count = len(merge_result.unchanged)
        report.estimated_tokens = merge_result.estimated_tokens

        if apply:
            # Check if field repairs are needed even when no profiles changed
            _needs_repair = False
            if not (merge_result.added or merge_result.updated or merge_result.deprecated):
                try:
                    with open(services_json_path, 'r', encoding='utf-8') as _fh:
                        _raw = _fh.read()
                    _f_start, _f_end, _ = _find_fields_block(_raw)
                    try:
                        _fields = _json5.loads(_raw[_f_start:_f_end])
                    except Exception:
                        _fields = json.loads(_raw[_f_start:_f_end])

                    _fields_copy = copy.deepcopy(_fields)
                    _needs_repair = _repair_field_objects(_fields_copy)
                except Exception:
                    pass

            if merge_result.added or merge_result.updated or merge_result.deprecated or _needs_repair:
                patch(
                    services_json_path,
                    updated_profiles,
                    added_profile_keys={key for key, _ in merge_result.added},
                    deprecated_profile_keys=set(merge_result.deprecated),
                    protected_profile_keys=protected,
                    dry_run=False,
                )

        return report
