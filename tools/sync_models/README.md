# sync_models: LLM Model List Sync Tool

Fetches available models from provider APIs, smoke-tests new ones, and merges
the results into `nodes/src/nodes/*/services.json` profile lists.

---

## Usage

**Direct (Python):**

```bash
python tools/sync_models/src/sync_models.py --provider <PROVIDER> [--provider <PROVIDER> ...]
python tools/sync_models/src/sync_models.py --all
```

**Via the engine:**

```bash
engine run tools/sync_models/src/sync_models.py --provider <PROVIDER> [--provider <PROVIDER> ...]
engine run tools/sync_models/src/sync_models.py --all
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
| `--model-source SOURCE`      | Source to consult for model lists and token data. Repeatable. Values: `provider`, `openrouter`, `litellm`. Order matters, first listed source has highest enrichment priority and is the preferred discovery source. Default if omitted: `provider openrouter litellm` (in that order).                                                        |
| `--enable-discovery`         | Allow new model profiles to be added to `services.json`. Default off, without this flag, the sync only enriches existing profiles' token data and deprecation status. Never adds or removes profile keys.                                                                                                                                      |
| `--allow-fallback-discovery` | Permit `openrouter`/`litellm` to act as discovery sources for providers whose API key is missing. Requires `--enable-discovery`. Default off, strict mode skips discovery for providers without keys (existing profiles still enriched). Use only when you intentionally want to introduce model IDs the native runtime SDK may not recognise. |
| `--no-config-overrides`      | Ignore `token_limit_overrides` and `model_output_tokens.overrides` from the config file, token limits come entirely from live data sources                                                                                                                                                                                                     |
| `--verify-existing`          | Call every model already in the catalogue, not just new ones, and deprecate those the provider reports as gone. Requires the provider API key. One request per profile, so noticeably slower.                                                                                                                                                  |
| `--pr-body`                  | Print a GitHub PR body (markdown). Also writes to `GITHUB_ENV` for CI                                                                                                                                                                                                                                                                           |

Validation: `--model-source` may not list duplicate values. `--allow-fallback-discovery` requires `--enable-discovery`.

### Examples

```bash
# Default: dry-run, enrichment-only — updates token data on existing profiles, no new profiles added
python tools/sync_models/src/sync_models.py --provider llm_openai

# Production CI path: discovery on, strict mode — only providers with keys get new profiles
python tools/sync_models/src/sync_models.py --all --enable-discovery --apply

# Dev workflow without API keys, explicit fallback opt-in (may add OpenRouter aliases)
python tools/sync_models/src/sync_models.py --provider llm_openai --enable-discovery --allow-fallback-discovery

# Custom source ordering — LiteLLM first for token data, OpenRouter as backup, no provider API
python tools/sync_models/src/sync_models.py --provider llm_openai --model-source litellm --model-source openrouter

# Discovery from OpenRouter alone, suitable for an aggregator-style node
python tools/sync_models/src/sync_models.py --provider llm_openai --model-source openrouter --enable-discovery --allow-fallback-discovery
```

---

## Providers

| Provider key             | Node                                      | API key env var                | Notes            |
| ------------------------ | ----------------------------------------- | ------------------------------ | ---------------- |
| `llm_openai`             | `llm_openai`                              | `ROCKETRIDE_OPENAI_KEY`        |                  |
| `embedding_openai`       | `embedding_openai`                        | `ROCKETRIDE_OPENAI_KEY`        |                  |
| `llm_anthropic`          | `llm_anthropic`                           | `ROCKETRIDE_ANTHROPIC_KEY`     |                  |
| `llm_gemini`             | `llm_gemini`                              | `ROCKETRIDE_GEMINI_KEY`        |                  |
| `llm_mistral`            | `llm_mistral`                             | `ROCKETRIDE_MISTRAL_KEY`       |                  |
| `llm_deepseek`           | `llm_deepseek`                            | `ROCKETRIDE_DEEPSEEK_KEY`      |                  |
| `llm_xai`                | `llm_xai`                                 | `ROCKETRIDE_XAI_KEY`           |                  |
| `llm_perplexity`         | `llm_perplexity`                          | `ROCKETRIDE_PERPLEXITY_KEY`    |                  |
| `llm_qwen`               | `llm_qwen`                                | `ROCKETRIDE_QWEN_KEY`          |                  |
| `llm_minimax`            | `llm_minimax`                             | `ROCKETRIDE_MINIMAX_KEY`       |                  |
| `llm_kimi`               | `llm_kimi`                                | `ROCKETRIDE_KIMI_KEY`          |                  |
| `llm_baidu_qianfan`      | `llm_baidu_qianfan`                       | `ROCKETRIDE_BAIDU_QIANFAN_KEY` |                  |
| `llm_glm`                | `llm_glm`                                 | `ROCKETRIDE_GLM_KEY`           |                  |
| `llm_gmi_cloud`          | `llm_gmi_cloud`                           | `ROCKETRIDE_GMI_CLOUD_KEY`     | key only         |
| `llm_nebius`             | `llm_openai_api` (`services.nebius.json`) | `ROCKETRIDE_NEBIUS_KEY`        | key only         |
| `llm_vision_openai`      | `llm_vision_openai`                       | `ROCKETRIDE_OPENAI_KEY`        | key only, vision |
| `llm_vision_gemini`      | `llm_vision_gemini`                       | `ROCKETRIDE_GEMINI_KEY`        | key only, vision |
| `llm_vision_mistral`     | `llm_vision_mistral`                      | `ROCKETRIDE_MISTRAL_KEY`       | key only, vision |
| `accessibility_describe` | `accessibility_describe`                  | `ROCKETRIDE_GEMINI_KEY`        | key only, vision |

- **key only**: synced only with its own API key (`require_api_key`). Without the key the provider is skipped with a warning, and nothing in its `services.json` changes. See [Why some providers need their own key](#why-some-providers-need-their-own-key).
- **vision**: a new model is added only when it accepts images (`require_capabilities`), and it is checked with an image. See [Vision nodes](#vision-nodes).

Without its API key, any other provider runs from OpenRouter/LiteLLM: existing profiles are still enriched, and new profiles are added only with `--allow-fallback-discovery`.
Set keys in a `.env` file in the repo root or export them in the shell.

---

## How It Works

### Pipeline

```
Pick primary source  →  fetch model list  →  discovery gate  →  capability gate  →  smoke test (provider-discovered new models only)  →  merge  →  services.json
```

1. **Pick primary source**: a provider with `require_api_key` and no key stops here with a warning. Otherwise walk `--model-source` in order, take the first source whose prerequisite is satisfied for this provider:

   - `provider`: provider API key env var is set.
   - `openrouter`: OpenRouter cache loaded (no auth required).
   - `litellm`: `litellm` package importable.

   If none qualify, the provider is skipped with a warning.

2. **Fetch model list**: call the source's API or read its database.
3. **Discovery gate**: if `--enable-discovery` is off, drop new models from the list (only existing profiles get enriched). If discovery is on but no source qualifies for discovery (because the provider key is missing and `--allow-fallback-discovery` is off), drop new models too and flag the provider as `discovery_skipped` in the report.
   **Capability gate**: when `model_filter.require_capabilities` is set, a new model stays only if a source says it has every listed capability. Existing profiles are never dropped here. See [Vision nodes](#vision-nodes).
4. **Smoke test**: only when (a) discovery is on, (b) the discovery source is `provider`, (c) the API key is set. New models are smoke-tested via the native API: a one-word chat call, or for vision nodes the same call with a small image attached. Discovery from `openrouter` or `litellm` skips smoke testing, there is no client to invoke.

   With `--verify-existing`, profiles already in the catalogue are called too. The smoke gate otherwise validates **additions only**, so a model that entered correctly and was retired months later is never called again and stays in the catalogue indefinitely. A listing endpoint does not answer this: providers keep returning models they have retired, and only the call itself does. A profile is deprecated on this evidence regardless of its `modelSource` — a refusal to run the model is stronger than absence from a listing, and an OpenRouter-discovered profile is just as unusable once the underlying provider has retired it.

   A failed call is classified from the typed SDK exception, into three answers rather than two, because a 404 does not settle the question on its own:

   | outcome | what it means | effect |
   | --- | --- | --- |
   | `retired` | the provider said the model is gone — *"no longer available"*, *"has been retired"* | deprecated, with the replacement it named |
   | `missing` | a bare 404. Could be retired, could be a model this key cannot reach: OpenAI answers *"does not exist or you do not have access to it"* for both, and Anthropic returns `not_found_error` for org-restricted models | reported for a human, never acted on |
   | `error` / `skip` | transient, or an auth/permission failure | ignored |

   So a CI key without a tier cannot deprecate a live-but-gated model: it gets `missing`.

   One more guard sits above all of it: if **more than half** of a provider's verified models come back `retired`, the run deprecates nothing and warns instead. A retirement message is per-model evidence, but a break one level up — a retired API version, say — produces that same message for every model at once. Providers do not retire most of a catalogue in one go, so a majority verdict says more about the API than about the models, and a real mass retirement is then applied deliberately rather than swept in.

   **A mark made by a call records `deprecatedBy: "provider-call"`, and only a call that passes can lift it.** The listing path must not: the premise of a call-verified retirement is that the provider *still lists the model*, so a scheduled run — which does not pass `--verify-existing` — would otherwise see it listed and resurrect it, deleting the provider's replacement note along the way.
5. **Merge**: smart merge into `preconfig.profiles`:
   - New model, smoke passed → add profile. Its form (field object) gets the API key, then the properties that **every** existing model form of the node shows (a vision node's prompt fields, for example), then the hidden model source. A property only some forms show, such as `temperature` on part of OpenAI's models, is a per-model choice and is not copied
   - Existing model → update token limits if authoritative data differs; preserve title and other manual fields
   - Model no longer in API → mark `"deprecated": true` (only by sources authoritative for the profile's `modelSource`) and record `"deprecatedBy"` with the source that marked it. The same ownership applies to an OpenRouter `expiration_date`: it is evidence about the models OpenRouter serves, not about one the native provider still supports
   - Model back in the API → lift the mark, **but only a mark this sync made**: a profile deprecated by hand carries no `deprecatedBy` and is left alone. A provider that keeps listing a model it has retired is exactly why someone marks one by hand, so its reappearance is not evidence to the contrary. Any source with authority over the profile may lift it, not only the one that applied it — the OpenRouter expiration path can stamp a `provider` profile, and requiring a match would strand it. A mark left standing is reported as "listed again but still deprecated" rather than passing silently
   - Model in `protected_profiles` → never deprecated (e.g. `"custom"`)

### Token limit resolution (priority order)

1. `token_limit_overrides` in `sync_models.config.json`, always wins.
2. First available source listed in `--model-source`, in the order given. Default order is `provider` → `openrouter` → `litellm`.
3. `default_context_window` in provider config.
4. `16384`, global last resort (flagged as `?` estimated in output).

A provider may narrow step 2 with `allowed_sources`, and may change the ID a source is asked about with `vendor_proxy_prefixes` (see [Model hosts](#model-hosts-gmi-cloud-nebius)).

The same priority applies to output tokens: `model_output_tokens.overrides` → first source in `--model-source` order with data → `model_output_tokens.defaults.chat` (or `defaults.embedding` for embedding providers).

**Swapped-value guard** (providers with `output_limit_below_context` only): LiteLLM and OpenRouter report max output tokens as the context window for some models. On a provider that caps completions below its window, a candidate equal to its own source's context window is discarded and the next source is tried. If no source has a usable value, the default applies to new profiles only — it never overwrites a limit already in `services.json`.

The equality is only a defect where the provider enforces a separate completion limit. OpenAI rejects an oversized `max_tokens` with _"This model supports at most N completion tokens"_, and litellm swaps the fields for Anthropic; both set `output_limit_below_context`. Mistral and xAI accept `max_tokens` up to the context window and publish no separate limit, so **every** source reports the two values as equal there and it is correct data — do not set the flag for them.

After the run the sync reports every profile with `modelOutputTokens == modelTotalTokens`, and exits 1 for those that are also (a) on a provider with `output_limit_below_context`, (b) `modelSource: provider` — a routed OpenRouter or LiteLLM alias is served elsewhere and is not bound by this provider's limit — and (c) not `deprecated`. Fix a failing profile with `model_output_tokens.overrides`; adding a model there also marks the value as confirmed and silences the warning.

### Discovery vs enrichment

The sync has two distinct modes:

- **Enrichment-only (default)**: refreshes `modelTotalTokens`, `modelOutputTokens`, `modelSource` provenance, and `deprecated`/`migration` fields on profiles already in `services.json`. Never adds or removes profile keys. Safe to run anywhere; no API key required.
- **Discovery (with `--enable-discovery`)**: additionally adds new profiles found in the configured sources. The discovery source for each provider is the first `--model-source` entry whose prerequisite is satisfied (and which is permitted for discovery, see below).

**Strict discovery (default when `--enable-discovery` is set)**: only the `provider` source can introduce new profiles. If the provider's API key is missing, that provider runs enrichment-only and the report shows `discovery skipped — set ROCKETRIDE_APIKEY_<PROVIDER>`. This is the production-safe mode: profiles in `services.json` only ever come from the native API, so they are guaranteed to be invokable through the native SDK.

**Loose discovery (`--allow-fallback-discovery`)**: opt in to letting `openrouter` or `litellm` serve as discovery sources. Useful for initial bulk-populating profiles in dev or for nodes that legitimately route through OpenRouter. **Risk**: OpenRouter routing aliases (e.g. `claude-opus-4-6-fast`) may be added as profiles even though they are not valid IDs for the native provider SDK. Use only when you understand the trade-off.

### Why some providers need their own key

Six of the providers above carry `require_api_key: true`. Without their key the sync does **nothing** for them — no enrichment, no deprecation, no discovery — and the report says so. That is deliberate. Running them from OpenRouter instead does not give a worse answer; it gives a wrong one, in four ways.

**1. OpenRouter decides what still exists, and it does not know these IDs.**
With no key, OpenRouter becomes the model source, and any profile it does not list is marked `deprecated`. These nodes store IDs it has never heard of:

| Node                     | Profiles absent from OpenRouter                      |
| ------------------------ | ---------------------------------------------------- |
| `llm_gmi_cloud`          | 21 of 21                                             |
| `llm_nebius`             | 3 of 3                                               |
| `llm_vision_mistral`     | 2 of 6 (`mistral-medium-2508`, `mistral-small-2506`) |
| `accessibility_describe` | 1 of 3 (`gemini-2.0-flash`)                          |
| `llm_vision_openai`      | 0 of 5                                               |
| `llm_vision_gemini`      | 0 of 5                                               |

A keyless run would therefore retire models that work. The hosts would lose their whole catalogue in one PR.

**2. Fallback discovery invents IDs the runtime cannot call.**
The weekly workflow runs every keyless provider with `--allow-fallback-discovery`, so new profiles would be created with OpenRouter's spelling: `mistral-medium-3.1` where Mistral's API wants `mistral-medium-2508`, or a bare `llama-4-scout` where GMI Cloud wants `meta-llama/Llama-4-Scout-17B-16E-Instruct`. This is not hypothetical — see the four dead profiles documented in `nodes/src/nodes/llm_qwen/README.md`, which arrived exactly this way.

**3. The token numbers would belong to someone else.**
For a host, a database entry under a similar ID describes a different deployment. LiteLLM answers `gpt-4o` with 16384 (an output limit) and `claude-opus-4.5` with 64000; OpenRouter shows `llama-3.3-70b-instruct` served with anything from 12288 to 131072 tokens, depending on the host. See [Model hosts](#model-hosts-gmi-cloud-nebius) below.

**4. A vision node cannot be verified without a client.**
The image check needs a real API client. Keyless discovery would add models with no evidence that they accept images, which is the one property these nodes exist to guarantee.

**The alternative, and why it was not used.** `llm_mistral`, `llm_minimax` and `llm_glm` handle point 1 with `protected_profiles`: a list of keys the sync may never deprecate. That stops wrong deletions only — not wrong additions (point 2) or wrong numbers (point 3) — and every entry carries an expiry date someone has to renew. `require_api_key` needs no upkeep: no key, no guessing.

**What it costs.** A missing secret means that node is not updated that week, and the PR body shows `— skipped` with the variable name. To trade that for the old behaviour on a given node, delete its `require_api_key` line.

### Model hosts (GMI Cloud, Nebius)

These serve many vendors' models behind one API, and their token data needs care. A host runs an open-weight model on its own hardware, so its context window is that host's choice: OpenRouter shows `meta-llama/llama-3.3-70b-instruct` served with 12288, 24000, 128000 **and** 131072 tokens by different hosts, and LiteLLM's entry for such an ID is likewise some other host's deployment (its `max_tokens` is often an output limit, not the window). Neither answers for our host, so:

- `allowed_sources` drops LiteLLM for both. Nebius keeps only `provider`.
- `vendor_proxy_prefixes` lists the models the host **resells** rather than runs — `openai/gpt-5.2`, `anthropic/claude-opus-4.5`, `google/gemini-3-flash-preview` on GMI Cloud. There the vendor's own published limits apply, and OpenRouter files them under the bare vendor ID, so those profiles get the same numbers as `llm_openai`, `llm_anthropic` and `llm_gemini`. Everything else keeps its host ID, which matches nothing on purpose.
- The open-weight families under a vendor's name (`openai/gpt-oss-*`) are deliberately **not** listed: the org is the model's author, not the API vendor.

OpenRouter also lists `GMICloud` and `Nebius` as providers, and its `/models/<slug>/endpoints` API would give their exact per-host windows. It is not used: of the 25 models in these two nodes, OpenRouter serves exactly one through the host in question.

### Vision nodes

`llm_vision_openai`, `llm_vision_gemini`, `llm_vision_mistral` and `accessibility_describe` use the same APIs and keys as their text siblings. The difference is which models qualify: a vision node must only offer models that accept images.

`model_filter.require_capabilities: ["vision"]` applies to **new** models only. For each one, the sync asks:

1. the provider itself, when its model list says so. Mistral's model card has `capabilities.vision`;
2. otherwise the sources in `--model-source` order: OpenRouter (`image` in `architecture.input_modalities`), then LiteLLM (`supports_vision`).

The first known answer wins. **Unknown counts as no**: a model too new for OpenRouter and LiteLLM is skipped, and a later run adds it once they list it. Existing profiles are never removed by this check.

A new vision model is then smoke-tested with a small PNG attached (`vision_openai_compat` / `vision_gemini`), so a model that rejects image input is skipped instead of reaching a pipeline.

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
| `!`    | New model skipped, smoke test failed        |
| `?`    | Token limit is an estimate, verify manually |

---

## Configuration: `tools/sync_models/src/sync_models.config.json`

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
    "output_limit_below_context": true, // provider caps completions below its window (see above)
    "require_api_key": false,          // true = skip the provider entirely without its key
    "allowed_sources": ["provider"],   // optional: the only sources this provider may use, even if --model-source lists more
    "vendor_proxy_prefixes": [],       // model hosts only: IDs resold from a vendor, looked up under the vendor's own ID
    "extra_profile_fields": {},        // added to every new profile, over the default {"apikey": ""}
    "model_filter": {
        "include_prefixes": ["gpt-", "o1"],  // only these prefixes; empty = allow all
        "exclude_prefixes": [],
        "exclude_patterns": ["embedding", "tts"],  // substring match anywhere in model ID
        "exclude_exact": ["mistral-medium"],        // exact model ID match
        "require_capabilities": []                  // e.g. ["vision"]: new models must have these
    },
    "token_limit_overrides": {
        "gpt-4.1": 1047576    // modelTotalTokens — always wins over API + litellm
    }
}
```

### Correcting wrong token limits

LiteLLM sometimes has stale or incorrect context window data (e.g. it confuses
`max_output_tokens` with `max_tokens` for Anthropic models). Use
`token_limit_overrides` to pin the correct value, it always wins:

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
(e.g. `"custom"`). Use a 6-month horizon for workaround protections, once the expiry
passes the sync tool will automatically re-evaluate the profile against the provider API.

---

## Dependencies

Managed in `tools/sync_models/requirements.txt`. Install with:

```bash
pip install -r tools/sync_models/requirements.txt
```

| Package                    | Purpose                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `openai`                   | OpenAI, Mistral (OpenAI-compat), DeepSeek, xAI, Perplexity, Qwen, Kimi, GMI Cloud, Nebius clients |
| `anthropic`                | Anthropic client                                                                                  |
| `google-genai`             | Gemini client (`from google import genai`)                                                        |
| `litellm`                  | Model database for token limits and `supports_vision`                                             |
| `json5`                    | Parsing `services.json` files (JSON5: supports `//` comments)                                     |
| `python-dotenv`            | `.env` file loading                                                                               |
| `pytest`, `pytest-asyncio` | Test runner                                                                                       |

---

## Tests

```bash
# Offline tests (no API key, no server)
pytest tools/sync_models/test --ignore=tools/sync_models/test/test_sync_live.py

# Live API tests (skipped if keys not set)
pytest tools/sync_models/test/test_sync_live.py
```

`test_new_providers.py` also checks the wiring of every registered provider: config block, `services.json` path, handler class, the workflow's key map, and `scripts/tasks.js`. A provider missing from the workflow is never synced, and this test is what notices.

---

## CI/CD

`.github/workflows/sync-models.yml` runs every Monday at 05:00 UTC and on
manual dispatch. It:

1. Splits the providers by whether their API key secret is set (the `PROVIDER_KEY` map in the workflow).
2. Syncs the providers **with** a key in strict mode: `--enable-discovery --apply --pr-body`, native API only.
3. Syncs the providers **without** a key with `--allow-fallback-discovery`, so OpenRouter/LiteLLM may add models. Key-only providers (`require_api_key`) are skipped here with a note in the PR body.
4. Opens one PR via `peter-evans/create-pull-request` with both reports as the body, and fails the run afterwards if either step reported an error. The PR is opened with a release-bot GitHub App token (`RELEASE_BOT_APP_ID` / `RELEASE_BOT_PRIVATE_KEY`), not `GITHUB_TOKEN`, so its CI starts without a manual "Approve workflows to run". The App needs Contents and Pull requests write access on this repo.

Review fallback-mode additions before merging: some may be OpenRouter routing aliases that the native SDK does not accept.

Provider API keys are stored as GitHub Actions secrets named
`ROCKETRIDE_<PROVIDER>_KEY` (e.g. `ROCKETRIDE_OPENAI_KEY`,
`ROCKETRIDE_ANTHROPIC_KEY`; see `.github/workflows/sync-models.yml` for the
full list).

---

## Adding a New Provider

1. Create `tools/sync_models/src/providers/<name>.py` subclassing `CloudProvider` (or `AggregatorProvider` for an OpenAI-compatible host with org-prefixed IDs)
2. Implement `make_client(api_key)` and `fetch_models(client)`
3. Add an entry to `_PROVIDER_REGISTRY` and `_SERVICES_JSON_PATHS` in `tools/sync_models/src/sync_models.py`
4. Add a provider config block to `tools/sync_models/src/sync_models.config.json`
5. Add the provider and its key to the `PROVIDER_KEY` map in `.github/workflows/sync-models.yml`, and a new key's secret to both `env:` blocks there
6. Add the path to `SERVICES_JSON_PATHS` in `tools/sync_models/scripts/tasks.js`
7. For a new key, add a skip marker to `test/markers.py` and a live test to `test/test_sync_live.py`
8. Run `pytest tools/sync_models/test/test_new_providers.py`, then `python tools/sync_models/src/sync_models.py --provider <name>` to verify
