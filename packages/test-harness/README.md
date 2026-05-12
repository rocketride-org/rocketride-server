# @rocketride/test-harness

TypeScript pipeline test harness for rocketride-server. Spawns the server with `ROCKETRIDE_MOCK=1`, runs every fixture under `pipelines/`, captures the live `apaevt_*` event stream for each run, diffs exercised nodes against `GET /services`, classifies failures into pass / logic / infra / timeout buckets, and emits a markdown + JSON report.

This package sits above the per-node contract framework at `nodes/test/` and the engine-binary task driver at `test/testdata/tests/tasktest.py`. Neither is replaced — the harness owns pipeline-level coverage and trace persistence.

## Quick start

Prerequisites:
- Engine binary staged at `<workspace>/dist/server/engine[.exe]` (run `builder build:server` or junction-link from a sibling checkout).
- TypeScript client built: `cd packages/client-typescript && npx tsc -p tsconfig.cjs.json && npx tsc -p tsconfig.types.json`.

```bash
# Build the harness
cd packages/test-harness
npx tsc -p tsconfig.json

# Run the smoke tier (mocked LLMs, fast)
node lib/cli.js smoke

# Run the integration tier (multi-node composites, still mocked)
node lib/cli.js integration

# Run both, one server lifecycle
node lib/cli.js all

# Re-render report.md from an existing run dir without re-running
node lib/cli.js report .harness-runs/<ISO>

# Emit a starter coverage-exclusions.json populated from /services
node lib/cli.js scaffold-exclusions
```

Or via the builder CLI:

```bash
builder harness:smoke
builder harness:integration
builder harness:full              # real APIs, requires keys (no ROCKETRIDE_MOCK)
builder harness:report --runDir=.harness-runs/<ISO>
builder harness:scaffold-exclusions
```

Run artifacts land in `<workspace>/.harness-runs/<ISO>/`:

```
.harness-runs/2026-05-12T20-30-42-305Z/
├── traces/
│   ├── smoke__llm_openai.json
│   ├── smoke__parse.json
│   └── ...
├── report.md       # human-readable
└── report.json     # structured, same data
```

`.harness-runs/` is gitignored. The newest `HARNESS_RETAIN_RUNS` dirs are kept; older ones are pruned at the end of each run.

## Environment variables

| Name | Default | Purpose |
| ---- | ------- | ------- |
| `HARNESS_TIER` | `smoke` | `smoke` \| `integration` \| `all` (overridden by CLI subcommand). |
| `HARNESS_MOCK_LLM` | `true` | Sets `ROCKETRIDE_MOCK=1` in the spawned server. Set `false` for real-API runs. |
| `HARNESS_SERVER_MODE` | `spawn` | `spawn` (harness owns lifecycle) or `external` (server already running). |
| `HARNESS_SERVER_URL` | `http://localhost:5565` | Used when `HARNESS_SERVER_MODE=external`. |
| `ROCKETRIDE_APIKEY` | `MYAPIKEY` | Client auth for the spawned server. |
| `HARNESS_PIPELINE_TIMEOUT_S` | `60` | Per-pipeline terminal-event timeout in seconds. |
| `HARNESS_RETAIN_RUNS` | `20` | How many `.harness-runs/<ISO>/` dirs to keep. |
| `HARNESS_BAIL` | `false` | Stop after the first non-pass result. |
| `HARNESS_RUNS_DIR` | `<workspace>/.harness-runs` | Override the run-artifact root. |
| `HARNESS_PIPELINES_DIR` | `packages/test-harness/pipelines` | Override the fixture root. |

All `process.env` access lives in `src/config.ts` — nothing else reads env vars directly.

## How to add a smoke pipeline

1. Create `pipelines/smoke/<provider>.json` where `<provider>` matches the directory name under `nodes/src/nodes/` and the `"provider"` value used inside the pipeline JSON.
2. Use the shape from one of the existing fixtures (`pipelines/smoke/llm_openai.json` is the canonical minimal example for an LLM, `pipelines/smoke/webhook_response.json` for a pure-echo pipeline).
3. Source components are addressed via `"source": "<component-id>"` plus a component with `"config": { "mode": "Source", ... }`. Downstream nodes use `"input": [{ "lane": "...", "from": "<component-id>" }]`.
4. For LLMs that pre-validate the key prefix before the mock SDK kicks in (`llm_anthropic`, `llm_gemini`, `llm_xai`), hardcode the required prefix in front of a `${ROCKETRIDE_*_KEY}` substitution placeholder so format validation passes even without a real key:
   ```json
   "claude-sonnet-4-6": { "apikey": "sk-ant-${ROCKETRIDE_ANTHROPIC_KEY}" }
   ```
5. Pick a unique `project_id` UUID per pipeline; the harness scopes monitor subscriptions by token, but separate project IDs keep cross-pipeline trace bleed impossible to construct by accident.
6. Re-run `node lib/cli.js smoke`. If the new provider was previously in the gap list, the report will move it from `gaps` → `covered`. If the run fails, inspect `.harness-runs/<latest>/traces/smoke__<provider>.json`.

## How to add an integration pipeline

Same shape as smoke, but live under `pipelines/integration/`. Use these to exercise composite scenarios that touch multiple providers in one run (chain LLMs, fan out to parallel nodes, etc.). Coverage tracking aggregates exercised nodes across all tiers in a `harness:all` run.

## How to add an infra signature

Infra signatures live in `src/classify/infraSignatures.ts` as a single exported `INFRA_SIGNATURES` array. Entries are either literal substrings (matched case-insensitively) or regular expressions:

```typescript
export const INFRA_SIGNATURES: InfraSignature[] = [
	'credit balance is too low',
	/429\s+Too Many Requests/i,
	// add new entries here
];
```

Any error from the live trace (`apaevt_flow.body.trace.error`, `apaevt_status_error.body.message`, or a thrown `pipe.close()` rejection) that matches one of these is bucketed as `infra_failure`. Infra failures show up in the report but don't count against pass/fail totals.

Keep the list narrow — only add patterns specific enough that a real logic bug will not match by accident.

## How to add a coverage exclusion

Open `coverage-exclusions.json` and add an entry under `exclusions`:

```json
{
	"node": "tool_my_new_node",
	"reason": "Requires a running my-service instance with seeded data; defer until harness gains fixture support.",
	"owner": "<your-handle>",
	"added": "<YYYY-MM-DD>"
}
```

The validator (`src/coverage/exclusions.ts`) enforces three rules:

- **Stale entries** — `node` must match a name returned by `GET /services`. If it doesn't, the entry is ignored and the run logs a warning.
- **Thin reasons** — `reason` must be at least 3 words. One-word placeholders are ignored.
- **Old entries** — entries older than 90 days emit a warning (not a failure). Review and either remove or refresh the `added` date.

Use `node lib/cli.js scaffold-exclusions` to emit a starter file pre-populated from the live `/services` registry; fill in real reasons and trim what should be exercised.

## How to run unit tests

```bash
cd packages/test-harness
npx vitest run            # one-shot
npx vitest                # watch mode
npx vitest run --coverage # with v8 coverage report
```

Tests mirror the source tree under `tests/`. Coverage excludes `src/cli.ts` and `src/server/lifecycle.ts` — both are thin orchestration layers exercised by the live smoke run.

## Architecture cheat sheet

- **Single env reader.** `src/config.ts` is the only file that reads `process.env`. Everything else takes a typed `HarnessConfig`.
- **Token-scoped monitor.** Each pipeline uses a fresh `use()` token → `addMonitor({ token }, ['FLOW', 'SSE', 'DETAIL', 'TASK'])`. Cross-pipeline event bleed is impossible by construction.
- **Subscription type vs event-name distinction.** The server's `rrext_monitor` RPC accepts EVENT_TYPE enum names (`FLOW`, `SSE`, `DETAIL`, `TASK`); wire-level event names use the `apaevt_*` prefix. The harness subscribes by enum name and dispatches by event name.
- **Reuses existing infra.** `scripts/lib/server.js` for spawn/teardown, `nodes/test/mocks/*` for offline SDK swaps via `ROCKETRIDE_MOCK=1`. No HTTP mock server, no LLM-node patches.
- **Component-ID → provider name resolution.** `apaevt_flow.body.pipes[-1]` carries component IDs (`llm_openai_1`); the harness resolves them to provider class names (`llm_openai`) via the loaded pipeline config so the coverage diff matches `/services`.

## Common errors

| Symptom | Likely cause |
| ------- | ------------ |
| `Server not found at .../dist/server/engine[.exe]` | Run `builder build:server` or junction-link `<workspace>/dist` to a sibling checkout that already has the staged engine. |
| `Invalid <provider> API key format` thrown from `client.use()` | The LLM node pre-validates the key prefix before the mock SDK is invoked. Hardcode the required prefix in front of the `${ROCKETRIDE_*_KEY}` placeholder in the pipeline JSON. |
| `Warning: Unknown event type 'apaevt_flow' ignored` from the server | The harness is subscribing by event name instead of EVENT_TYPE enum name. Verify `MONITOR_TYPES` in `src/runner/runPipeline.ts` uses `['FLOW', 'SSE', 'DETAIL', 'TASK']`. |
| `Component <id> input lane <X> not found in service definition` | Pipeline JSON wires a lane the upstream/downstream provider doesn't declare. Check the provider's `services*.json` `input` / `output` blocks under `nodes/src/nodes/`. |
| Run exits with `gaps=N` | `N` providers from `/services` aren't covered by any pipeline and aren't in `coverage-exclusions.json`. Either add a fixture or add an entry with a real reason. |
