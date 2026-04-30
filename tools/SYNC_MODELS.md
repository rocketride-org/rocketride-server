# sync_models — LLM Model List Sync Tool

Fetches available models from provider APIs, smoke-tests new ones, and merges
the results into `nodes/src/nodes/*/services.json` profile lists.

---

## Usage

**Direct (Python):**

```bash
python tools/src/sync_models.py --provider <PROVIDER> [--provider <PROVIDER> ...]
python tools/src/sync_models.py --all
```

**Via the engine:**

```bash
engine run tools/src/sync_models.py --provider <PROVIDER> [--provider <PROVIDER> ...]
engine run tools/src/sync_models.py --all
```

**Via the builder** (runs sync + Prettier in one step):

```bash
builder models:update --models="--all --apply"
```

The `--models` flag forwards arguments directly to `sync_models.py`.

### Flags

| Flag                         | Description                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider PROVIDER`        | Sync one or more specific providers (repeatable)                                                                                                                                                                                                                                                                                                |
| `--all`                      | Sync all registered providers                                                                                                                                                                                                                                                                                                                   |
| `--apply`                    | Write changes to disk. Without this flag runs in **dry-run mode**                                                                                                                                                                                                                                                                               |
| `--model-source SOURCE`      | Source to consult for model lists and token data. Repeatable. Values: `provider`, `openrouter`, `litellm`. Order matters — first listed source has highest enrichment priority and is the preferred discovery source. Default if omitted: `provider openrouter litellm` (in that order).                                                        |
| `--enable-discovery`         | Allow new model profiles to be added to `services.json`. Default off — without this flag, the sync only enriches existing profiles' token data and deprecation status. Never adds or removes profile keys.                                                                                                                                      |
| `--allow-fallback-discovery` | Permit `openrouter`/`litellm` to act as discovery sources for providers whose API key is missing. Requires `--enable-discovery`. Default off — strict mode skips discovery for providers without keys (existing profiles still enriched). Use only when you intentionally want to introduce model IDs the native runtime SDK may not recognise. |
| `--no-config-overrides`      | Ignore `token_limit_overrides` and `model_output_tokens.overrides` from the config file — token limits come entirely from live data sources                                                                                                                                                                                                     |
| `--pr-body`                  | Print a GitHub PR body (markdown). Also writes to `GITHUB_ENV` for CI                                                                                                                                                                                                                                                                           |

Validation: `--model-source` may not list duplicate values. `--allow-fallback-discovery` requires `--enable-discovery`.

### Examples

```bash
# Default: dry-run, enrichment-only — updates token data on existing profiles, no new profiles added
python tools/src/sync_models.py --provider llm_openai

# Production CI path: discovery on, strict mode — only providers with keys get new profiles
python tools/src/sync_models.py --all --enable-discovery --apply

# Dev workflow without API keys, explicit fallback opt-in (may add OpenRouter aliases)
python tools/src/sync_models.py --provider llm_openai --enable-discovery --allow-fallback-discovery

# Custom source ordering — LiteLLM first for token data, OpenRouter as backup, no provider API
python tools/src/sync_models.py --provider llm_openai --model-source litellm --model-source openrouter

# Discovery from OpenRouter alone, suitable for an aggregator-style node
python tools/src/sync_models.py --provider llm_openai --model-source openrouter --enable-discovery --allow-fallback-discovery
```

---

## Providers

| Provider key       | Node               | API key env var             |
| ------------------ | ------------------ | --------------------------- |
| `llm_openai`       | `llm_openai`       | `ROCKETRIDE_OPENAI_KEY`     |
| `embedding_openai` | `embedding_openai` | `ROCKETRIDE_OPENAI_KEY`     |
| `llm_anthropic`    | `llm_anthropic`    | `ROCKETRIDE_ANTHROPIC_KEY`  |
| `llm_gemini`       | `llm_gemini`       | `ROCKETRIDE_GEMINI_KEY`     |
| `llm_mistral`      | `llm_mistral`      | `ROCKETRIDE_MISTRAL_KEY`    |
| `llm_deepseek`     | `llm_deepseek`     | `ROCKETRIDE_DEEPSEEK_KEY`   |
| `llm_xai`          | `llm_xai`          | `ROCKETRIDE_XAI_KEY`        |
| `llm_perplexity`   | `llm_perplexity`   | `ROCKETRIDE_PERPLEXITY_KEY` |
| `llm_qwen`         | `llm_qwen`         | `ROCKETRIDE_QWEN_KEY`       |

If an API key env var is not set the provider is skipped with a warning (not an error).
Set keys in a `.env` file in the repo root or export them in the shell.

---

## How It Works

### Pipeline

```
Pick primary source  →  fetch model list  →  discovery gate  →  smoke test (provider-discovered new models only)  →  merge  →  services.json
```

1. **Pick primary source** — walk `--model-source` in order, take the first source whose prerequisite is satisfied for this provider:

   - `provider`: provider API key env var is set.
   - `openrouter`: OpenRouter cache loaded (no auth required).
   - `litellm`: `litellm` package importable.

   If none qualify, the provider is skipped with a warning.

2. **Fetch model list** — call the source's API or read its database.
3. **Discovery gate** — if `--enable-discovery` is off, drop new models from the list (only existing profiles get enriched). If discovery is on but no source qualifies for discovery (because the provider key is missing and `--allow-fallback-discovery` is off), drop new models too and flag the provider as `discovery_skipped` in the report.
4. **Smoke test** — only when (a) discovery is on, (b) the discovery source is `provider`, (c) the API key is set. New models are smoke-tested via the native API. Discovery from `openrouter` or `litellm` skips smoke testing — there is no client to invoke.
5. **Merge** — smart merge into `preconfig.profiles`:
   - New model, smoke passed → add profile
   - Existing model → update token limits if authoritative data differs; preserve title and other manual fields
   - Model no longer in API → mark `"deprecated": true` (only by sources authoritative for the profile's `modelSource`)
   - Model in `protected_profiles` → never deprecated (e.g. `"custom"`)

### Token limit resolution (priority order)

1. `token_limit_overrides` in `sync_models.config.json` — always wins.
2. First available source listed in `--model-source`, in the order given. Default order is `provider` → `openrouter` → `litellm`.
3. `default_context_window` in provider config.
4. `16384` — global last resort (flagged as `?` estimated in output).

The same priority applies to output tokens: `model_output_tokens.overrides` → first source in `--model-source` order with data → `model_output_tokens.defaults.chat` (or `defaults.embedding` for embedding providers).

### Discovery vs enrichment

The sync has two distinct modes:

- **Enrichment-only (default)** — refreshes `modelTotalTokens`, `modelOutputTokens`, `modelSource` provenance, and `deprecated`/`migration` fields on profiles already in `services.json`. Never adds or removes profile keys. Safe to run anywhere; no API key required.
- **Discovery (with `--enable-discovery`)** — additionally adds new profiles found in the configured sources. The discovery source for each provider is the first `--model-source` entry whose prerequisite is satisfied (and which is permitted for discovery — see below).

**Strict discovery (default when `--enable-discovery` is set)**: only the `provider` source can introduce new profiles. If the provider's API key is missing, that provider runs enrichment-only and the report shows `discovery skipped — set ROCKETRIDE_APIKEY_<PROVIDER>`. This is the production-safe mode: profiles in `services.json` only ever come from the native API, so they are guaranteed to be invokable through the native SDK.

**Loose discovery (`--allow-fallback-discovery`)**: opt in to letting `openrouter` or `litellm` serve as discovery sources. Useful for initial bulk-populating profiles in dev or for nodes that legitimately route through OpenRouter. **Risk**: OpenRouter routing aliases (e.g. `claude-opus-4-6-fast`) may be added as profiles even though they are not valid IDs for the native provider SDK. Use only when you understand the trade-off.

---

## Output

```
=== Sync Models (dry run) ===  [openrouter ✓]  [litellm ✓]

[llm_openai]
  + gpt-4.2                        new model added (smoke passed)
  ~ gpt-4o                         modelTotalTokens: 128000 → 200000
  - gpt-3.5-turbo-instruct         deprecated (no longer in API)
  ! gpt-o5-preview                 403 access_denied (smoke failed)
  ? gpt-5-nano                     token limit is estimated — verify manually
  (no changes — 12 profiles unchanged)
```

| Symbol | Meaning                                      |
| ------ | -------------------------------------------- |
| `+`    | New model added                              |
| `~`    | Existing model updated (token limits)        |
| `-`    | Model deprecated (`"deprecated": true` set)  |
| `!`    | New model skipped — smoke test failed        |
| `?`    | Token limit is an estimate — verify manually |

---

## Configuration — `tools/src/sync_models.config.json`

### Top-level keys

| Key                                 | Purpose                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `providers`                         | Per-provider config blocks (see below)                                          |
| `default_protected_profiles`        | Profile keys never deprecated for **any** provider (e.g. `["custom"]`)          |
| `title_mappings`                    | Prefix → display prefix for auto-generating `title` on new profiles             |
| `model_output_tokens.defaults.chat` | Fallback `modelOutputTokens` when no override and litellm has no data           |
| `model_output_tokens.overrides`     | Per model-id `modelOutputTokens` overrides (highest priority for output tokens) |

### Per-provider keys

```jsonc
"llm_openai": {
    "env_var": "ROCKETRIDE_OPENAI_KEY",
    "default_context_window": 128000,  // fallback for new models when API + litellm have no data
    "protected_profiles": ["custom"],  // these keys are never deprecated (merged with default_protected_profiles)
    "exclude_dated_snapshots": true,   // drop -2024-04-09 and -0613 date suffixes
    "model_filter": {
        "include_prefixes": ["gpt-", "o1"],  // only these prefixes; empty = allow all
        "exclude_prefixes": [],
        "exclude_patterns": ["embedding", "tts"],  // substring match anywhere in model ID
        "exclude_exact": ["mistral-medium"]         // exact model ID match
    },
    "token_limit_overrides": {
        "gpt-4.1": 1047576    // modelTotalTokens — always wins over API + litellm
    }
}
```

### Correcting wrong token limits

LiteLLM sometimes has stale or incorrect context window data (e.g. it confuses
`max_output_tokens` with `max_tokens` for Anthropic models). Use
`token_limit_overrides` to pin the correct value — it always wins:

```json
"token_limit_overrides": {
    "claude-sonnet-4-6": 1000000,
    "gpt-5.4": 1050000
}
```

Similarly, `model_output_tokens.overrides` pins `modelOutputTokens`:

```json
"model_output_tokens": {
    "defaults": { "chat": 4096 },
    "overrides": {
        "claude-opus-4-6": 131072,
        "claude-sonnet-4-6": 65536
    }
}
```

### Excluding non-chat models

Add substrings to `exclude_patterns` to filter out entire model families:

```json
"exclude_patterns": ["embed", "tts", "voxtral", "pixtral", "ocr", "realtime"]
```

Use `exclude_exact` for bare legacy aliases that match an `include_prefixes` rule
but should not be synced:

```json
"exclude_exact": ["mistral-medium"]
```

### Protected profiles

`default_protected_profiles` at the top level protects keys across **all** providers.
Per-provider `protected_profiles` adds to this list for that provider only.

Each entry is either a bare string (always active) or a `["key", "YYYY-MM-DD"]` pair
that is active only while the current date is on or before the expiry date. Expired
entries are silently dropped, making the profile eligible for normal deprecation again.

```json
"default_protected_profiles": [
    ["custom", "2126-04-09"]
]
```

```json
"protected_profiles": [
    ["custom", "2126-04-09"],
    ["devstral-medium", "2026-10-09"]
]
```

Use a far-future date (e.g. 100 years) for profiles that must never be deprecated
(e.g. `"custom"`). Use a 6-month horizon for workaround protections — once the expiry
passes the sync tool will automatically re-evaluate the profile against the provider API.

---

## Dependencies

Managed in `tools/requirements.txt`. Install with:

```bash
pip install -r tools/requirements.txt
```

| Package                    | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `openai`                   | OpenAI, Mistral (OpenAI-compat), DeepSeek, xAI, Perplexity, Qwen clients |
| `anthropic`                | Anthropic client                                                         |
| `google-genai`             | Gemini client (`from google import genai`)                               |
| `litellm`                  | Model database for token limit lookup                                    |
| `json5`                    | Parsing `services.json` files (JSON5 — supports `//` comments)           |
| `python-dotenv`            | `.env` file loading                                                      |
| `pytest`, `pytest-asyncio` | Test runner                                                              |

---

## Tests

```bash
# Offline logic tests (no API key, no server)
pytest tools/test/test_sync_logic.py

# Live API tests (skipped if keys not set)
pytest tools/test/test_sync_live.py
```

---

## CI/CD

`.github/workflows/sync-models.yml` runs every Monday at 05:00 UTC and on
manual dispatch. It:

1. Runs a dry-run first (`python tools/src/sync_models.py --all --enable-discovery`) — fails fast if the script errors.
2. Runs with `--apply --pr-body` to write changes and capture the report.
3. Opens a PR via `peter-evans/create-pull-request` with the report as the body.

The workflow uses `--enable-discovery` (so model lists grow over time) but **does NOT** use `--allow-fallback-discovery`. This is intentional: when a provider's secret is missing from the GitHub Actions environment, the resulting PR body shows `Discovery skipped — set ROCKETRIDE_APIKEY_<PROVIDER>` for that provider. A reviewer sees the gap and can decide whether to add the secret rather than silently shipping fallback-discovered profiles to production.

Provider API keys are stored as GitHub Actions secrets named
`ROCKETRIDE_APIKEY_<PROVIDER>` (see `.github/workflows/sync-models.yml` for
the full list).

---

## Adding a New Provider

1. Create `tools/src/providers/<name>.py` subclassing `CloudProvider`
2. Implement `make_client(api_key)` and `fetch_models(client)`
3. Add an entry to `_PROVIDER_REGISTRY` and `_SERVICES_JSON_PATHS` in `tools/src/sync_models.py`
4. Add a provider config block to `tools/src/sync_models.config.json`
5. Run `python tools/src/sync_models.py --provider <name>` to verify
