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

| Flag                    | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider PROVIDER`   | Sync one or more specific providers (repeatable)                                                                                            |
| `--all`                 | Sync all registered providers                                                                                                               |
| `--apply`               | Write changes to disk. Without this flag runs in **dry-run mode**                                                                           |
| `--litellm-only`        | Use LiteLLM database as sole model source — no API calls, no smoke tests, no key required. Exits with error if litellm is not installed     |
| `--no-litellm`          | Disable LiteLLM entirely — token limits come only from provider APIs, OpenRouter, and config overrides                                      |
| `--openrouter-only`     | Use OpenRouter as sole model source — no API calls, no smoke tests, no key required                                                         |
| `--no-openrouter`       | Disable OpenRouter fallback — token limits come only from provider APIs, LiteLLM, and config overrides                                      |
| `--no-config-overrides` | Ignore `token_limit_overrides` and `model_output_tokens.overrides` from the config file — token limits come entirely from live data sources |
| `--pr-body`             | Print a GitHub PR body (markdown). Also writes to `GITHUB_ENV` for CI                                                                       |

Mutually exclusive pairs: `--litellm-only` / `--no-litellm`, `--openrouter-only` / `--no-openrouter`, `--openrouter-only` / `--litellm-only`.

### Examples

```bash
# Dry-run a single provider
python tools/src/sync_models.py --provider llm_openai

# Dry-run multiple providers
python tools/src/sync_models.py --provider llm_mistral --provider llm_openai

# Apply changes for all providers
python tools/src/sync_models.py --all --apply

# Use LiteLLM database only (no API key needed)
python tools/src/sync_models.py --all --litellm-only --apply

# Skip LiteLLM, use only provider API + config overrides
python tools/src/sync_models.py --provider llm_openai --no-litellm
```

---

## Providers

| Provider key       | Node               | API key env var                |
| ------------------ | ------------------ | ------------------------------ |
| `llm_openai`       | `llm_openai`       | `ROCKETRIDE_APIKEY_OPENAI`     |
| `embedding_openai` | `embedding_openai` | `ROCKETRIDE_APIKEY_OPENAI`     |
| `llm_anthropic`    | `llm_anthropic`    | `ROCKETRIDE_APIKEY_ANTHROPIC`  |
| `llm_gemini`       | `llm_gemini`       | `ROCKETRIDE_APIKEY_GEMINI`     |
| `llm_mistral`      | `llm_mistral`      | `ROCKETRIDE_APIKEY_MISTRAL`    |
| `llm_deepseek`     | `llm_deepseek`     | `ROCKETRIDE_APIKEY_DEEPSEEK`   |
| `llm_xai`          | `llm_xai`          | `ROCKETRIDE_APIKEY_XAI`        |
| `llm_perplexity`   | `llm_perplexity`   | `ROCKETRIDE_APIKEY_PERPLEXITY` |
| `llm_qwen`         | `llm_qwen`         | `ROCKETRIDE_APIKEY_QWEN`       |

If an API key env var is not set the provider is skipped with a warning (not an error).
Set keys in a `.env` file in the repo root or export them in the shell.

---

## How It Works

### Pipeline (normal mode)

```
Provider API  →  filter  →  smoke test (new models only)  →  merge  →  services.json
```

1. **Fetch** — calls the provider's `/v1/models` (or equivalent) endpoint
2. **Filter** — applies `model_filter` rules from `sync_models.config.json`
3. **Smoke test** — for each _new_ model, makes a minimal chat/embed call to confirm it is usable with the given API key. Existing models are not re-tested.
4. **Merge** — smart merge into `preconfig.profiles`:
   - New model, smoke passed → add profile
   - Existing model → update token limits if authoritative data differs; preserve title and other manual fields
   - Model no longer in API → mark `"deprecated": true`
   - Model in `protected_profiles` → never deprecated (e.g. `"custom"`)

### Token limit resolution (priority order)

1. `token_limit_overrides` in `sync_models.config.json` — always wins
2. `context_window` returned by the provider API (Gemini returns it; most others don't)
3. **OpenRouter** — `https://openrouter.ai/api/v1/models`, no auth, fetched once per run
4. LiteLLM model database (`litellm.get_model_info`) — wide coverage but known accuracy issues (e.g. Anthropic context window)
5. `default_context_window` in provider config
6. `16384` — global last resort (flagged as `?` estimated in output)

The same order applies to output tokens: `model_output_tokens.overrides` → OpenRouter `max_completion_tokens` → LiteLLM `max_output_tokens` → `model_output_tokens.defaults.chat`.

### `--litellm-only` mode

Skips provider API calls and smoke tests entirely. Iterates `litellm.model_cost`,
strips provider prefixes (e.g. `"mistral/ministral-8b-latest"` → `"ministral-8b-latest"`),
applies the same filter rules, and runs the same merge. No API key required.
Also disables OpenRouter (litellm is the sole source).
Useful for an initial bulk population of token limits.

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
    "env_var": "ROCKETRIDE_APIKEY_OPENAI",
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

1. Runs a dry-run first (`python tools/src/sync_models.py --all`) — fails fast if the script errors
2. Runs with `--apply --pr-body` to write changes and capture the report
3. Opens a PR via `peter-evans/create-pull-request` with the report as the body

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
