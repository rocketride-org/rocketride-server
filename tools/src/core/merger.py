"""
Merger — smart merge logic for LLM model sync.

Compares the current profiles in a services.json against a freshly fetched
list of models from a provider API and produces three buckets:

  added       — models in the API response that are not yet in services.json
  updated     — models in both, where token limits differ
  deprecated  — models in services.json that are absent from the API response
                (already-deprecated models in the same bucket but with the
                same flag set are left unchanged)
"""

from __future__ import annotations

import contextlib
import io
from typing import Dict, Any, List, NamedTuple, Tuple, Optional

try:
    import litellm

    _LITELLM_AVAILABLE = True
except ImportError:
    _LITELLM_AVAILABLE = False


# ---------------------------------------------------------------------------
# OpenRouter model database
# ---------------------------------------------------------------------------

# Module-level cache — populated on first use, once per process.
# None = not yet fetched; {} = fetch attempted but failed (no retry).
_OPENROUTER_CACHE: Optional[Dict[str, Tuple[Optional[int], Optional[int], Optional[str], Optional[str]]]] = None
_OPENROUTER_AVAILABLE: bool = False


def _load_openrouter_cache() -> None:
    """
    Fetch the full OpenRouter model list once and cache it in memory.

    OpenRouter exposes a free, no-auth endpoint that returns context_length
    and top_provider.max_completion_tokens for hundreds of models across all
    major providers.  IDs are in ``provider/model-id`` format; we strip the
    provider prefix and index by bare model ID.

    If the request fails for any reason (network error, timeout, bad JSON)
    the cache is set to an empty dict so subsequent calls skip the retry.
    """
    global _OPENROUTER_CACHE, _OPENROUTER_AVAILABLE
    if _OPENROUTER_CACHE is not None:
        return  # already loaded (or failed)

    try:
        import json as _json
        import urllib.request as _urllib

        req = _urllib.Request(
            'https://openrouter.ai/api/v1/models',
            headers={'User-Agent': 'rocketride-sync-models/1.0'},
        )
        with _urllib.urlopen(req, timeout=10) as resp:
            data = _json.loads(resp.read())

        cache: Dict[str, Tuple[Optional[int], Optional[int], Optional[str], Optional[str]]] = {}
        for model in data.get('data', []):
            raw_id = model.get('id', '')
            bare = raw_id.split('/', 1)[1] if '/' in raw_id else raw_id
            ctx = model.get('context_length')
            top = model.get('top_provider', {})
            out = top.get('max_completion_tokens') if isinstance(top, dict) else None
            name = model.get('name') or None
            exp = model.get('expiration_date') or None
            ctx = int(ctx) if ctx is not None else None
            out = int(out) if out is not None else None
            if bare not in cache:  # keep first occurrence per bare ID
                cache[bare] = (ctx, out, name, exp)

        _OPENROUTER_CACHE = cache
        _OPENROUTER_AVAILABLE = True
    except Exception:
        _OPENROUTER_CACHE = {}  # empty sentinel — no retry on subsequent calls


def _openrouter_info(model_id: str) -> Tuple[Optional[int], Optional[int], Optional[str], Optional[str]]:
    """
    Return (context_window, max_output_tokens, name, expiration_date) from the OpenRouter model list.

    Returns (None, None, None, None) if OpenRouter is unavailable or the model is not listed.

    Args:
        model_id: Provider model ID (e.g. "gpt-4o", "claude-sonnet-4-6")

    Returns:
        (context_window, max_output_tokens, name, expiration_date) — any value may be None.
        expiration_date is non-None when OpenRouter has marked the model as deprecated.
    """
    _load_openrouter_cache()
    return (_OPENROUTER_CACHE or {}).get(model_id, (None, None, None, None))


def _litellm_info(model_id: str) -> Tuple[Optional[int], Optional[int]]:
    """
    Look up context window and max output tokens for a model via LiteLLM's
    built-in model database.  Returns (None, None) if LiteLLM is not installed
    or the model is not in its database.

    Two lookup strategies are tried in order:

    1. ``litellm.get_model_info(model_id)`` — direct lookup.  Works for models
       stored under their bare ID (e.g. ``"gpt-4o"``).

    2. Scan ``litellm.model_cost`` for an entry whose bare ID (provider prefix
       stripped) matches ``model_id``.  Handles models stored under prefixed keys
       such as ``"mistral/ministral-8b-latest"`` that the direct lookup misses.

    litellm prints "Provider List: ..." to stdout for every unrecognised model;
    that output is suppressed so it does not pollute the sync tool's output.

    Args:
        model_id: Provider model ID (e.g. "gpt-4o", "ministral-8b-latest")

    Returns:
        (context_window, max_output_tokens) — either value may be None
    """
    if not _LITELLM_AVAILABLE:
        return None, None

    # Strategy 1: direct lookup
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            info = litellm.get_model_info(model_id)
        ctx = info.get('max_tokens')
        out = info.get('max_output_tokens')
        if ctx is not None or out is not None:
            return ctx, out
    except Exception:
        pass

    # Strategy 2: scan model_cost for a provider-prefixed entry whose bare
    # ID (after stripping "provider/") matches the requested model_id.
    try:
        for key, data in litellm.model_cost.items():
            bare = key.split('/', 1)[1] if '/' in key else key
            if bare == model_id:
                return data.get('max_tokens'), data.get('max_output_tokens')
    except Exception:
        pass

    return None, None


class MergeResult(NamedTuple):
    """
    Outcome of a single merge operation.

    Attributes:
        added: list of (profile_key, profile_dict) tuples for new models
        updated: list of (profile_key, field_name, old_value, new_value) tuples for changed fields
        deprecated: list of profile_key strings for models no longer in provider API
        unchanged: list of profile_key strings for models with no detected changes
        estimated_tokens: list of profile_key strings where modelTotalTokens is a best-guess
                          default (no authoritative source) — needs manual review
    """

    added: List[tuple]
    updated: List[tuple]
    deprecated: List[str]
    unchanged: List[str]
    estimated_tokens: List[str]


def _make_profile_key(model_id: str) -> str:
    """
    Derive a deterministic profile key from a provider model ID.

    Applies the same transformations described in sync_models.config.json:
      - dots, underscores, slashes, colons → hyphens
      - lowercase

    Args:
        model_id: Raw model ID as returned by the provider API (e.g. "gpt-4o", "claude-sonnet-4.6")

    Returns:
        Normalised profile key (e.g. "gpt-4o", "claude-sonnet-4-6")
    """
    key = model_id.lower()
    for ch in ['.', '_', '/', ':']:
        key = key.replace(ch, '-')
    return key


def _derive_title(model_id: str, title_mappings: Dict[str, str]) -> str:
    """
    Produce a human-readable title for a model ID using prefix mappings.

    The remainder after stripping the matched prefix is title-cased by
    splitting on hyphens and capitalising each segment, so that e.g.
    ``"mistral-medium-latest"`` → ``"Mistral Medium Latest"`` rather than
    ``"Mistral medium-latest"``.

    Args:
        model_id: Raw model ID
        title_mappings: Dict mapping prefix strings to display prefix strings,
                        from sync_models.config.json["title_mappings"]

    Returns:
        Best-effort display title (e.g. "GPT-4o", "Claude Sonnet 4.6",
        "Mistral Medium Latest")
    """
    for prefix, display_prefix in title_mappings.items():
        if model_id.startswith(prefix):
            remainder = model_id[len(prefix) :]
            raw_parts = [seg for seg in remainder.split('-') if seg]
            # Merge consecutive short numeric segments back into version numbers
            # (e.g. ["4", "6"] → "4.6", ["3", "7"] → "3.7").
            # Only merge segments of ≤ 2 digits to avoid merging long date strings
            # like "20241022" with neighbouring parts.
            merged: list = []
            i = 0
            while i < len(raw_parts):
                a = raw_parts[i]
                b = raw_parts[i + 1] if i + 1 < len(raw_parts) else None
                if b is not None and a.isdigit() and b.isdigit() and len(a) <= 2 and len(b) <= 2:
                    merged.append(f'{a}.{b}')
                    i += 2
                else:
                    merged.append(a.capitalize())
                    i += 1
            return display_prefix + ' '.join(merged)
    # Fallback: capitalise first letter
    return model_id[0].upper() + model_id[1:] if model_id else model_id


def build_new_profile(
    model_id: str,
    total_tokens: int,
    output_tokens: int,
    title_mappings: Dict[str, str],
    extra_fields: Dict[str, Any] | None = None,
    total_tokens_source: str | None = None,
    output_tokens_source: str | None = None,
    derive_title_fn=None,
    model_source: str = 'provider',
    display_name: str | None = None,
) -> Dict[str, Any]:
    """
    Build a new profile dict for a model discovered via the provider API.

    Args:
        model_id: Provider model ID (e.g. "gpt-o3")
        total_tokens: Context window size
        output_tokens: Maximum output tokens (0 for embedding models)
        title_mappings: From sync_models.config.json for title generation
        extra_fields: Additional fields to merge into the profile (e.g. {"apikey": ""})
        total_tokens_source: Human-readable label for where total_tokens came from
        output_tokens_source: Human-readable label for where output_tokens came from
        derive_title_fn: Optional callable ``(model_id, title_mappings) -> str`` that
            overrides the default ``_derive_title`` logic.  Providers can supply this
            to strip provider-specific prefixes (e.g. Gemini strips ``"models/"``).
        model_source: Where this model ID was discovered — ``"provider"``,
            ``"openrouter"``, ``"litellm"``, or ``"manual"``.
        display_name: Human-readable name from OpenRouter (``model.name``).  When
            provided it is used directly as the profile title, bypassing
            ``derive_title_fn`` and ``title_mappings``.

    Returns:
        Profile dict ready to be written into services.json "preconfig.profiles".
        Includes ``_src_modelTotalTokens`` / ``_src_modelOutputTokens`` annotation
        keys that the patcher converts to inline ``// source`` comments.
    """
    _title_fn = derive_title_fn if derive_title_fn is not None else _derive_title
    profile: Dict[str, Any] = {
        'title': display_name if display_name else _title_fn(model_id, title_mappings),
        'model': model_id,
        'modelSource': model_source,
        'modelTotalTokens': total_tokens,
    }
    if total_tokens_source:
        profile['_src_modelTotalTokens'] = total_tokens_source
    if output_tokens > 0:
        profile['modelOutputTokens'] = output_tokens
        if output_tokens_source:
            profile['_src_modelOutputTokens'] = output_tokens_source
    if extra_fields:
        profile.update(extra_fields)
    return profile


def merge(
    current_profiles: Dict[str, Any],
    api_models: List[Dict[str, Any]],
    title_mappings: Dict[str, str],
    token_overrides: Dict[str, int],
    output_token_overrides: Dict[str, int],
    default_output_tokens: int = 4096,
    extra_profile_fields: Dict[str, Any] | None = None,
    provider_default_context_window: int | None = None,
    protected_profile_keys: set | None = None,
    use_litellm: bool = True,
    use_openrouter: bool = True,
    normalize_profile_model_id=None,
    deprecation_source: str = 'provider API',
    derive_title_fn=None,
) -> tuple[Dict[str, Any], MergeResult]:
    """
    Perform a smart merge of current profiles against the provider API model list.

    Strategy:
    - New model in API, not in profiles → add
    - Model in both → update token limits if they differ; preserve title and other manual fields
    - Model in profiles but absent from API → mark deprecated (set deprecated=true)
    - Already-deprecated models that are still absent → leave unchanged

    Args:
        current_profiles: The current "preconfig.profiles" dict from services.json
        api_models: List of model dicts from provider API, each with at least:
                    {"id": str, "context_window": int (optional)}
        title_mappings: Prefix → display prefix mappings for title generation
        token_overrides: model_id → total_token_count overrides
        output_token_overrides: model_id → output_token_count overrides
        default_output_tokens: Default output token count when not overridden
        extra_profile_fields: Fields to add to every new profile (e.g. {"apikey": ""})
        normalize_profile_model_id: Optional callable that normalises a profile's
            "model" field value into the form returned by the discovery source.
            Used when the canonical form stored in services.json differs from
            the API/OpenRouter ID format (e.g. Gemini stores "models/gemini-2.5-pro"
            but OpenRouter returns "gemini-2.5-pro"). When supplied:
              - Pass 1 uses it to match incoming API model IDs against existing profiles
              - Pass 2 uses it to check whether a profile's model still exists in the API
        deprecation_source: Human-readable label for the discovery source used to
            determine deprecation (e.g. "xAI API", "OpenRouter", "LiteLLM").
            Written into the "migration" field of newly deprecated profiles so
            users understand why a model was marked deprecated.

    Returns:
        Tuple of (updated_profiles dict, MergeResult describing what changed)
    """
    _norm = normalize_profile_model_id  # short alias; None = identity

    # Build lookup: model_id → api entry
    api_lookup: Dict[str, Dict[str, Any]] = {m['id']: m for m in api_models}

    # Build reverse lookup: model_id → profile_key (from current profiles).
    # Two versions: raw (for exact matches) and normalised (for fallback lookup
    # when the provider stores IDs in a different form than the discovery source).
    model_to_key: Dict[str, str] = {}
    norm_model_to_key: Dict[str, str] = {}
    for key, profile in current_profiles.items():
        if isinstance(profile, dict) and 'model' in profile:
            raw_mid: str = profile['model']
            model_to_key[raw_mid] = key
            if _norm is not None:
                norm_mid = _norm(raw_mid)
                if norm_mid != raw_mid:
                    norm_model_to_key[norm_mid] = key

    updated_profiles = dict(current_profiles)

    added: List[tuple] = []
    updated_fields: List[tuple] = []
    deprecated: List[str] = []
    unchanged: List[str] = []
    estimated_tokens: List[str] = []

    # Track every profile key "covered" by the API in Pass 1 so Pass 2 does not
    # wrongly deprecate profiles whose stored model ID differs from the API alias
    # (e.g. profile key "devstral-medium" with model "devstral-medium-2507" that
    # the API returns as bare "devstral-medium").
    covered_keys: set = set()
    # Profiles found via model_to_key exact match — used to prevent a generic alias
    # from overwriting a versioned model that was already matched exactly.
    # Example: OpenRouter lists both "mistral-large-2512" (262144 tokens, exact match
    # for the profile storing that model ID) and "mistral-large" (128000 tokens, which
    # would match "mistral-large" profile key via collision).  Without this guard,
    # whichever alias comes last in iteration order wins — inconsistently.
    exact_matched_profiles: set = set()

    # --- Pass 1: add new models, update changed ones ---
    for model_id, api_entry in api_lookup.items():
        # Try exact match first; fall back to normalised lookup (e.g. for Gemini
        # where API returns "models/gemini-2.5-pro" but OpenRouter has "gemini-2.5-pro").
        profile_key = model_to_key.get(model_id) or norm_model_to_key.get(model_id)

        if profile_key is not None:
            exact_matched_profiles.add(profile_key)

        # Key-collision fallback: the API model derives the same profile key as an
        # existing profile even though the stored model IDs differ (e.g. the API
        # exposes alias "devstral-medium" while the profile stores the dated form
        # "devstral-medium-2507").  In this case treat the profile as existing —
        # update token limits only; preserve title and model field.
        if profile_key is None:
            candidate_key = _make_profile_key(model_id)
            if candidate_key in updated_profiles:
                if candidate_key in exact_matched_profiles:
                    # A versioned model ID already claimed this profile via an exact
                    # model_to_key match.  Skip the generic alias to prevent it from
                    # overwriting the more-specific data (e.g. skip "mistral-large"
                    # once "mistral-large-2512" has been matched to profile "mistral-large").
                    continue
                profile_key = candidate_key

        # Resolve token limit — priority order:
        #   1. Manual override in sync_models.config.json  (highest)
        #   2. context_window returned by the provider API
        #   3. OpenRouter model database
        #   4. LiteLLM model database
        #   5. provider_default_context_window (per-provider config estimate)
        #   6. 16384 (global last resort, only for brand-new profiles)

        # For existing profiles, anchor OR/LiteLLM lookups to the stored model ID
        # (the "model" field), not the API-returned alias.  This prevents the token
        # limits from silently changing when the provider API returns "mistral-large-latest"
        # while the profile stores "mistral-large-2512" — both are valid aliases but OR and
        # LiteLLM may report different context windows for each.  Using the stored ID keeps
        # values stable and consistent between with-key and no-key runs.
        if profile_key is not None:
            _stored_mid = updated_profiles[profile_key].get('model', '')
            _token_lookup_id = _stored_mid if _stored_mid and _stored_mid != model_id else model_id
        else:
            _token_lookup_id = model_id

        _override = token_overrides.get(_token_lookup_id) or token_overrides.get(model_id)
        _api_ctx = api_entry.get('context_window')
        # When OpenRouter or LiteLLM was used as the fallback model source, entries
        # carry '_source': 'openrouter'/'litellm'.  Provider API entries have no '_source'.
        _api_entry_source: str = api_entry.get('_source', 'provider API')
        # Map API entry source to modelSource field value
        _source_to_model_source: Dict[str, str] = {
            'provider API': 'provider',
            'openrouter': 'openrouter',
            'litellm': 'litellm',
        }
        _model_source: str = _source_to_model_source.get(_api_entry_source, 'provider')
        _api_entry_out = api_entry.get('max_output_tokens')
        _api_entry_name: Optional[str] = api_entry.get('name')
        _or_ctx, _or_out, _or_name, _or_exp = _openrouter_info(_token_lookup_id) if use_openrouter else (None, None, None, None)
        _display_name: Optional[str] = _api_entry_name or _or_name
        _litellm_ctx, _litellm_out = _litellm_info(_token_lookup_id) if use_litellm else (None, None)
        # Cast to int — config/litellm/openrouter values may arrive as float or str
        _override = int(_override) if _override is not None else None
        _api_ctx = int(_api_ctx) if _api_ctx is not None else None
        _api_entry_out = int(_api_entry_out) if _api_entry_out is not None else None
        _or_ctx = int(_or_ctx) if _or_ctx is not None else None
        _or_out = int(_or_out) if _or_out is not None else None
        _litellm_ctx = int(_litellm_ctx) if _litellm_ctx is not None else None
        _litellm_out = int(_litellm_out) if _litellm_out is not None else None

        # Determine winning source for total tokens (for provenance annotation)
        if _override is not None:
            authoritative_total_tokens: int | None = _override
            total_tokens_src = 'sync_models.config.json'
        elif _api_ctx is not None:
            authoritative_total_tokens = _api_ctx
            total_tokens_src = _api_entry_source  # 'provider API' or 'openrouter' (fallback mode)
        elif _or_ctx is not None:
            authoritative_total_tokens = _or_ctx
            total_tokens_src = 'openrouter'
        elif _litellm_ctx is not None:
            authoritative_total_tokens = _litellm_ctx
            total_tokens_src = 'litellm'
        else:
            authoritative_total_tokens = None
            total_tokens_src = None

        # Determine winning source for output tokens (for provenance annotation)
        _out_override = output_token_overrides.get(_token_lookup_id) or output_token_overrides.get(model_id)
        if _out_override is not None:
            api_output_tokens: int = int(_out_override)
            output_tokens_src = 'sync_models.config.json'
        elif _api_entry_out is not None:
            api_output_tokens = _api_entry_out
            output_tokens_src = _api_entry_source  # 'openrouter' when it's the fallback source
        elif _or_out is not None:
            api_output_tokens = _or_out
            output_tokens_src = 'openrouter'
        elif _litellm_out is not None:
            api_output_tokens = _litellm_out
            output_tokens_src = 'litellm'
        else:
            api_output_tokens = int(default_output_tokens)
            output_tokens_src = 'default'

        if profile_key is None:
            # New model — use authoritative value if available, then provider default,
            # then global fallback. Track when we're guessing so the report can flag it.
            if authoritative_total_tokens:
                total_tokens = authoritative_total_tokens
                is_estimated = False
            elif provider_default_context_window:
                total_tokens = provider_default_context_window
                total_tokens_src = 'default_context_window'
                is_estimated = True
            else:
                total_tokens = 16384
                total_tokens_src = 'estimated'
                is_estimated = True

            profile_key = _make_profile_key(model_id)
            new_profile = build_new_profile(
                model_id=model_id,
                total_tokens=total_tokens,
                output_tokens=api_output_tokens,
                title_mappings=title_mappings,
                extra_fields=extra_profile_fields,
                total_tokens_source=total_tokens_src,
                output_tokens_source=output_tokens_src,
                derive_title_fn=derive_title_fn,
                model_source=_model_source,
                display_name=_display_name,
            )
            updated_profiles[profile_key] = new_profile
            added.append((profile_key, new_profile))
            if is_estimated:
                estimated_tokens.append(profile_key)
        else:
            # Existing model — only update token limits when we have authoritative data
            existing = updated_profiles[profile_key]
            changed = False

            if authoritative_total_tokens is not None and existing.get('modelTotalTokens') != authoritative_total_tokens:
                old_val = existing.get('modelTotalTokens')
                updated_profiles[profile_key]['modelTotalTokens'] = authoritative_total_tokens
                updated_profiles[profile_key]['_src_modelTotalTokens'] = total_tokens_src
                updated_fields.append((profile_key, 'modelTotalTokens', old_val, authoritative_total_tokens))
                changed = True

            if api_output_tokens > 0 and existing.get('modelOutputTokens') != api_output_tokens:
                old_val = existing.get('modelOutputTokens')
                updated_profiles[profile_key]['modelOutputTokens'] = api_output_tokens
                updated_profiles[profile_key]['_src_modelOutputTokens'] = output_tokens_src
                updated_fields.append((profile_key, 'modelOutputTokens', old_val, api_output_tokens))
                changed = True

            # Deprecate if OpenRouter signals expiration — takes priority over un-deprecation.
            # Combine the expiration signal from the api_entry (OpenRouter-as-source mode)
            # and the supplementary _openrouter_info lookup (token-fallback mode).
            _exp = api_entry.get('expiration_date') or _or_exp
            if _exp and not existing.get('deprecated'):
                updated_profiles[profile_key]['deprecated'] = True
                if not existing.get('migration'):
                    updated_profiles[profile_key]['migration'] = f'Model deprecated by OpenRouter (expiration date: {_exp}). Please select a current model.'
                deprecated.append(profile_key)
                changed = True
            elif not _exp:
                # Un-deprecate if it came back (only when there is no expiration signal)
                if existing.get('deprecated'):
                    updated_profiles[profile_key].pop('deprecated', None)
                    updated_profiles[profile_key].pop('deprecatedSince', None)
                    updated_fields.append((profile_key, 'deprecated', True, None))
                    changed = True

            # Upgrade modelSource to "provider" when confirmed by the live provider API.
            # Only upgrade — never downgrade a "provider" profile to "openrouter"/"litellm".
            if _api_entry_source == 'provider API' and existing.get('modelSource') != 'provider':
                old_src = existing.get('modelSource')
                updated_profiles[profile_key]['modelSource'] = 'provider'
                updated_fields.append((profile_key, 'modelSource', old_src, 'provider'))
                changed = True

            if not changed:
                unchanged.append(profile_key)

        covered_keys.add(profile_key)

    _protected = protected_profile_keys or set()

    # --- Pass 2: deprecate models no longer in API ---
    for model_id, profile_key in model_to_key.items():
        if profile_key in _protected:
            unchanged.append(profile_key)
            continue
        # If this profile was covered in Pass 1 via key-collision (API alias maps to
        # the same profile key even though model IDs differ), skip deprecation.
        if profile_key in covered_keys:
            continue
        # Check both the raw profile model_id and the normalised form.
        # When api_lookup uses native IDs (e.g. "models/gemini-2.5-pro" via the
        # provider API or after litellm_to_native_model_id conversion), the raw
        # match succeeds.  When api_lookup uses bare IDs (e.g. "gemini-2.5-pro"
        # from a fallback source that doesn't add prefixes), the normalised form
        # matches instead.  Both variants must be absent before marking deprecated.
        lookup_id = _norm(model_id) if _norm is not None else model_id
        if lookup_id not in api_lookup and model_id not in api_lookup:
            profile = updated_profiles.get(profile_key, {})
            model_source = profile.get('modelSource', 'manual')

            # Only the native provider API is authoritative enough to deprecate
            # provider-confirmed or hand-curated profiles.  OpenRouter and LiteLLM
            # are routing/database indexes — a model absent from them may still be
            # perfectly available via its native API.
            #
            # Deprecation authority by source:
            #   provider API  → may deprecate any modelSource
            #   OpenRouter    → may deprecate 'openrouter' and 'litellm' only
            #   LiteLLM       → may deprecate 'litellm' only
            if deprecation_source == 'OpenRouter' and model_source not in ('openrouter', 'litellm'):
                unchanged.append(profile_key)
                continue
            if deprecation_source == 'LiteLLM' and model_source != 'litellm':
                unchanged.append(profile_key)
                continue

            if not profile.get('deprecated'):
                updated_profiles[profile_key]['deprecated'] = True
                # Only set migration if not already present (don't overwrite manual msgs).
                if not profile.get('migration'):
                    updated_profiles[profile_key]['migration'] = f'Model no longer listed in {deprecation_source}. Please select a current model.'
                deprecated.append(profile_key)
            else:
                unchanged.append(profile_key)

    # --- Pass 3: backfill missing fields ---
    # Profiles that were not processed in Pass 1 (e.g. model not listed by the
    # current source) are left untouched.  Fill in any fields that every non-deprecated,
    # non-placeholder profile should consistently carry.
    for key, profile in updated_profiles.items():
        if not isinstance(profile, dict):
            continue
        if profile.get('deprecated'):
            continue
        if not profile.get('model'):  # skip custom / placeholder profiles
            continue
        if 'modelOutputTokens' not in profile:
            updated_profiles[key]['modelOutputTokens'] = int(default_output_tokens)
            updated_profiles[key]['_src_modelOutputTokens'] = 'default'
            updated_fields.append((key, 'modelOutputTokens', None, int(default_output_tokens)))
        # Profiles without a modelSource were added before this field existed — treat as manual.
        if 'modelSource' not in profile:
            updated_profiles[key]['modelSource'] = 'manual'
            updated_fields.append((key, 'modelSource', None, 'manual'))

    return updated_profiles, MergeResult(
        added=added,
        updated=updated_fields,
        deprecated=deprecated,
        unchanged=unchanged,
        estimated_tokens=estimated_tokens,
    )
