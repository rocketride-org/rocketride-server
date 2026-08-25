# MCP Tool Contract (frozen)

The tool-name/result-shape contract between these skills and the RocketRide HTTP MCP server.
Frozen against `rocketride-server` `origin/develop @ eb67ddea` (module
`packages/ai/src/ai/modules/mcp/`, 27 tools). The skills reference **only** names and shapes in
this file; anything not listed here does not exist — never invent a tool.

## Result envelope (every tool)

Every result is a JSON object with `ok`. `ok: false` carries `error` and usually a `hint`;
the MCP `is_error` flag mirrors it, and `structured_content` mirrors the text JSON.
**Check `ok` — a successful tool *call* is not a successful *result*.**

## Introspection

| Tool | Input | Result (key fields) |
|---|---|---|
| `list_components` | — | `{ok, components: [{name, category, summary, wiring?}], note?}`. **No `lanes`/`invoke`** — wire from the bundled L1 index. Components whose integration isn't configured are **hidden**, with `note` pointing at `list_integrations`. |
| `describe_component` | `{name}` | Full service definition (the L2 schema). |
| `validate_pipeline` | `{pipeline}` (inline object) | `{ok, errors, warnings}` — the compiler. Zero errors before any run. |
| `describe_pipeline` | `{pipeline}` | Static per-node summary (preflight aid, not a gate). |

## Execution

| Tool | Input | Result / semantics |
|---|---|---|
| `run_pipeline` | `{pipeline, inputs?, ttl?, use_existing?, source?, threads?}` | `{ok, task_token, projectId, source, result?}`. Inline pipeline **only** (no filepath). With `inputs` it is a **one-shot**: the string is sent, `result` comes back inline, and the token is finished — don't poll it. **Keep `projectId` + `source`**: they key the log tools. |
| `run_dropper_pipe` | like `run_pipeline`, minus `inputs` | `{ok, task_token, upload_url, dropper_url, projectId, source}`. Out-of-band file ingress: multipart-POST files to `upload_url`, or hand the user `dropper_url` (browser drag-drop). URLs carry only the public `pk_` key — never the control token. |
| `send_data` | `{task_token, input}` | Sends to a running task; result inline. `input` is a **string** — serialize JSON; there is no chat operation (chat pipelines → SDK fallback). |
| `send_files` | `{task_token, files: [path]}` | Store-resolvable paths only — not a host-file upload; for host files use `run_dropper_pipe`. |
| `terminate` | `{task_token}` | Stops the task. |

## Visibility

| Tool | Input | Result |
|---|---|---|
| `monitor` | `{task_token, timeout? ≤300, interval?}` | Bounded poll, returns a snapshot: `{ok, state, state_label, completed, terminal, status, counts: {completedCount, failedCount, totalCount}, errors, warnings, polls, poll_timed_out?}`. `terminal: true` means done; `poll_timed_out: true` means the *poll* hung, not the task. |
| `list_running_pipelines` | — | `{ok, tasks, count}`. |

## Run logs (DVR — the debugging evidence)

All keyed by `(projectId, source[, teamId])` **returned by `run_pipeline`/`run_dropper_pipe`** —
never by task token. Omit `teamId` for your own dev runs. Works for past and live runs.
Retention: 7 days (dev) / 30 days (deploy). Runs started with `pipelineTraceLevel: "none"` have
chapters/console but **empty traces**.

| Tool | Purpose |
|---|---|
| `log_chapters` | Run/chapter listing — find the run. |
| `log_read` | Paged events (≤200 events / 1 MiB per page, cursor to continue). |
| `log_traces` | Per-object trace summaries (1–100, default 20). |
| `log_trace` | One object's full node/lane trace — the per-node enter/leave evidence. |

## Capability

| Tool | Purpose |
|---|---|
| `store_read` / `store_list` / `store_stat` | Object store access (read is inline and uncapped — prefer `stat` + URL for big objects). |
| `store_get_url` | Signed URL — artifact-by-reference for large results. |
| `save_template` / `load_template` | Gate D "save to cloud". |
| `deploy_add` / `deploy_list` / `deploy_status` / `deploy_remove` / `deploy_update` | Gate D "publish" + deployment lifecycle. |

## Integrations / credentials

| Tool | Purpose |
|---|---|
| `list_integrations` | Bare: per-integration readiness rows. With `{name}`: field detail + `setup_block` instructions to relay to the user. Secret **values never transit MCP** — there is no `set_env`; credentials are configured out-of-band (env/account), and pipelines still reference `${ROCKETRIDE_*}`. |

## Gaps the skills must compensate for (server-verified, current)

1. **`run_pipeline` does not validate first** — the skills' mandatory `validate_pipeline` +
   re-validate loop is the only guard. Never run without a clean result in hand.
2. **No cost preflight** — Gate C.5 stays a skills-side estimate and hard stop.
3. **Strings-only input, no chat tool** — serialize JSON; drive chat pipelines via the SDK.
4. **`list_components` has no lanes** — select from it if live, but **wire** from the bundled
   L1 index / `describe_component`.
5. **No `get_run_result` and none planned** — results are inline; evidence is `log_*`.
6. A known node missing from `list_components` usually means its integration isn't configured —
   check `list_integrations` before concluding it doesn't exist (the bundled index still lists it).
