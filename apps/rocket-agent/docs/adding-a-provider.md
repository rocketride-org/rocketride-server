# Adding an inference provider — recipe

Adding a provider the canvas agent can be pointed at is, in the common case, **one
registry entry**: `apps/rocket-agent/src/providers.ts`'s `PROVIDERS` array. Everything
downstream (key resolution, config generation, the `/agent/providers` route, the gear
UI) reads that registry — nothing else needs to change for a `native` provider opencode
already bundles.

## The `ProviderDef` fields

```ts
export interface ProviderDef {
	id: string;        // opencode provider id, e.g. 'openai'
	rrNode: string;    // RocketRide catalog node, e.g. 'llm_openai'
	label: string;     // 'OpenAI' — human label shown in the gear UI
	keyVar: string;    // user-variable name, e.g. 'ROCKETRIDE_OPENAI_KEY'
	mode: 'native' | 'openai-compatible';
	baseURL?: string;  // required for openai-compatible; sourced from the node's services.json `serverbase`
	models?: Array<{ id: string; title: string }>;  // required for openai-compatible; native gets models from opencode
}
```

- **`id`** — opencode's own provider id. It's the left half of the `<id>/<modelId>`
  model string opencode expects everywhere (config `model`, `enabled_providers`, the
  gear UI's model dropdown value).
- **`rrNode`** — the RocketRide catalog node this provider mirrors (e.g. `llm_openai`,
  `llm_kimi`). Documentation / provenance for where the `keyVar` and (for compat) the
  curated `models` came from — it is never sent to opencode and no longer fetched at runtime.
- **`label`** — display name in the gear UI and (for `openai-compatible` providers) the
  `provider.<id>.name` field opencode shows in its own UI/logs.
- **`keyVar`** — the RocketRide user-variable name a key is read from. Must start with
  `ROCKETRIDE_` and end in `_KEY` by convention (`ROCKETRIDE_<PROVIDER>_KEY`); the
  resolver's `providerByKeyVar` looks it up by exact string match against the user's
  `getEnv('user')` blob.
- **`mode`** — see the decision rule below.
- **`baseURL`** — only for `openai-compatible`. Copy it from that provider's node's
  `services.json`, the `serverbase` field (e.g. `nodes/src/nodes/llm_kimi/services.json`
  has `"serverbase": "https://api.moonshot.ai/v1"`). This is the upstream API's OpenAI-
  compatible base URL — verify it against the provider's own docs before shipping; a
  wrong baseURL fails silently as an auth/404 error at inference time, not at startup.

## native vs. openai-compatible

opencode bundles first-class SDKs for a fixed set of providers. If the provider is one
of them, use `mode: 'native'` — opencode already knows its request/response shape and
default base URL; the registry only has to supply the id and key:

> openai, anthropic, google, deepseek, mistral, xai, groq, perplexity

Everything else is `mode: 'openai-compatible'` — opencode talks to it through
`@ai-sdk/openai-compatible`, which needs an explicit `baseURL` and an explicit `models`
map (opencode has no built-in catalog for it). Concretely, `generateProviderConfig`
(`src/opencode.ts`) emits, per enabled provider:

```jsonc
// native — options.apiKey holds the env-placeholder described below, not a literal key
{ "options": { "apiKey": PLACEHOLDER } }

// openai-compatible — same apiKey placeholder, plus npm/name/baseURL/models
{
  "npm": "@ai-sdk/openai-compatible",
  "name": "<label>",
  "options": { "baseURL": "<baseURL>", "apiKey": PLACEHOLDER },
  "models": { "<modelId>": { "name": "<modelId>" } }
}
```

Where `PLACEHOLDER` is the literal string `env` + `:` + `AGENT_KEY_` + the provider id
uppercased, wrapped in curly braces — never the raw key. opencode substitutes it from
its own process env at spawn time (see "How the key flows" below); the real secret
never appears in the generated JSON.

The registry ships seven `native` entries (openai, anthropic, google, deepseek, mistral,
xai, perplexity) and five `openai-compatible` ones (kimi, minimax, qwen, gmi, qianfan —
each with a curated `models` list and `baseURL`). The `openai-compatible` config path is
additionally proven against a fixture `ProviderDef` in `tests/opencode.test.ts` ("Task 7"
describe blocks). When you add a real `openai-compatible` entry, verify its `baseURL` and
at least one real model id against a live call before merging.

## Where the model list comes from

Two sources, keyed off `mode`:

- **`native`** — opencode already ships a models.dev catalog for these providers. The
  rocket-agent server reads it from opencode's own `GET /provider` endpoint (`all` field —
  the full bundled list, independent of keys, available with
  `OPENCODE_DISABLE_MODELS_FETCH=1`) via a cached throwaway spawn in `src/catalog.ts`
  (`getNativeModelCatalog`). Only tool-calling, non-deprecated models are kept (the agent
  drives every turn through tool calls). Nothing to add per provider — a new native id
  automatically picks up opencode's list.
- **`openai-compatible`** — opencode has no catalog for these, so the registry entry
  carries the models itself in `models: [{ id, title }]`. Copy the ids/titles from that
  provider's RocketRide `services.json` `preconfig.profiles.<key>.{model, title}` (drop
  local/self-hosted profiles — the agent only offers the hosted API). The `id` is the
  provider-native API model id opencode sends upstream.

Either way, `GET /agent/providers` (`src/index.ts`) returns each provider WITH its
`models` (native resolved from the catalog, compat straight from the registry), and the
gear UI builds the opencode model string as `<providerDef.id>/<model.id>`. The UI no
longer calls the RR `getService` schema for models.

## How the key flows

1. User sets a RocketRide user variable named `<ProviderDef.keyVar>` (and, to pick a
   model, `ROCKETRIDE_AGENT_MODEL` = `<id>/<modelId>`) via the gear UI or directly.
2. `UserVarKeyResolver.resolve()` (`src/keys.ts`) reads the user's `getEnv('user')` blob,
   looks up each entry by `providerByKeyVar`, and builds `InferenceSettings.keys[id]` +
   `InferenceSettings.model`. `FallbackKeyResolver` layers this over `EnvKeyResolver` so
   an operator-set env default still works when the user hasn't configured a key.
3. `generateProviderConfig(settings, defs)` (`src/opencode.ts`) turns each resolved key
   into `AGENT_KEY_<ID>` (uppercased provider id) and injects it into the opencode
   child's env — the key itself never appears in the generated JSON config, only the
   `{env:AGENT_KEY_<ID>}` placeholder does. `defs` defaults to the shipped `PROVIDERS`
   registry; it exists as a parameter so the `openai-compatible` branch is unit-testable
   with a fixture def without shipping an unverified provider (see above).
4. `buildConfigContent` merges the generated `provider`/`enabled_providers`/`model` into
   the locked config **after** every security assert (deny-wall, autoupdate/share/
   snapshot) has already passed against the untouched file on disk — a loosened locked
   config still fails closed regardless of which provider generated the merge.
5. `buildChildEnv` puts the generated env (including every `AGENT_KEY_*`) into the
   opencode child process's environment; never logged (see `spawnOpencodeServer`'s
   stdout/stderr handlers, which redact known secret shapes and never log `env` itself).

## Checklist for a new entry

1. Confirm the provider's SDK is/isn't one opencode bundles natively (see the list
   above) — decides `mode`. A `native` id MUST be one opencode's catalog lists, or its
   model dropdown comes back empty; if it isn't, use `openai-compatible` instead.
2. Add the `ProviderDef` to `PROVIDERS` in `src/providers.ts` (`id`, `rrNode`, `label`,
   `keyVar`, `mode`; for `openai-compatible` also `baseURL` and a curated `models` list —
   copied from that node's `services.json` `serverbase` + `preconfig.profiles`, verified
   against the provider's own docs).
3. No changes needed to `keys.ts`, `opencode.ts`, `src/catalog.ts`, the `/agent/providers`
   route, or the gear UI — they all read the registry (and, for native models, opencode's
   catalog) generically.
4. Add/extend tests in `tests/providers.test.ts` and, if the new entry is the first real
   `openai-compatible` one, replace (or add alongside) the fixture-based coverage in
   `tests/opencode.test.ts` with an assertion against the real entry.
5. `npx jest` + `npx tsc -p tsconfig.json --noEmit`.
