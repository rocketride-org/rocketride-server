# MCP Tool Contract (frozen)

The tool-name/result-shape contract between these skills and the RocketRide HTTP MCP server.
Derived from the registrations in `rocketride-server`'s `packages/ai/src/ai/modules/mcp/tools/*.py`
on branch `fix/mcp-auth` (PR #2315, not yet merged), where `register_all` wires **33 tools** — every
one of them listed below. Deploy tools are on the deploy-2 SDK API.
**Maintainer note:** this file is regenerated from the registrations, not pinned to a commit. The
previous `origin/develop @ eb67ddea` pin predated this branch and was already inaccurate; once
PR #2315 lands on `develop`, replace the branch reference above with the merge commit if a pin is
wanted. The check that actually matters is `register_all` still registering exactly these 33 names.
The skills reference **only** names and shapes in this file; anything not listed here does not
exist — never invent a tool.

## Result envelope (every tool)

Every result is a JSON object with `ok`. `ok: false` carries `error_type`, `message`, and usually a `hint`;
the MCP `is_error` flag mirrors it, and `structured_content` mirrors the text JSON.
**Check `ok` — a successful tool *call* is not a successful *result*.**

## Introspection

| Tool | Input | Result (key fields) |
|---|---|---|
| `list_components` | — | `{ok, components: [{name, category, summary, wiring?}], note?}`. **No `lanes`/`invoke`** — wire from the bundled L1 index. Components whose integration isn't configured are **hidden**, with `note` pointing at `list_integrations`. |
| `describe_component` | `{name}` | Full service definition (the L2 schema). |
| `resolve_config` | `{provider, config?}` | `{ok, ...engine resolution, hint?}` — what a component config actually becomes at load, after profile and default merging; omit `config` for defaults. Discarded keys come back as `dropped` plus a `hint` naming the profile they belong inside. |
| `validate_pipeline` | `{pipeline}` (inline object) | `{ok, errors, warnings}` — the compiler. Zero errors before any run. |
| `describe_pipeline` | `{pipeline}` | Static per-node summary (preflight aid, not a gate). |

## Execution

| Tool | Input | Result / semantics |
|---|---|---|
| `run_pipeline` | `{pipeline, inputs?, ttl?, use_existing?, source?, threads?, pipelineTraceLevel?}` | `{ok, task_token, projectId, source, result?}`. Inline pipeline **only** (no filepath). With `inputs` it is a **one-shot**: the string is sent, `result` comes back inline, and the token is finished — don't poll it. **Keep `projectId` + `source`**: they key the log tools. `pipelineTraceLevel?`: `none\|metadata\|summary\|full`, server default `summary`. |
| `run_dropper_pipe` | like `run_pipeline` (incl. `pipelineTraceLevel?`), minus `inputs` | `{ok, task_token, upload_url, dropper_url, projectId, source}`. Out-of-band file ingress: multipart-POST files to `upload_url`, or hand the user `dropper_url` (browser drag-drop). URLs carry only the public `pk_` key — never the control token. |
| `send_data` | `{task_token, input}` | Sends to a running task; result inline. `input` is a **string** — serialize JSON; there is no chat operation (chat pipelines → SDK fallback). |
| `send_files` | `{task_token, files: [path]}` | **Local (loopback-bound) engines only** — paths on the engine host's filesystem. Deployed engines don't list it and refuse it (`Unavailable`); use `run_dropper_pipe`. |
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
| `store_read` | `{path}` → `{ok, path, content}`. Text only, inline and uncapped — prefer `store_stat` + `store_get_url` for big objects. |
| `store_list` | `{path?}` (default `''` = root) → `{ok, path, listing}`. |
| `store_stat` | `{path}` → `{ok, path, stat}` — exists, type (`file\|dir`), size, modified. |
| `store_get_url` | `{path, expires_in?, download_name?}` → `{ok, path, url, expires_in}`. Signed URL — artifact-by-reference for large results. |
| `save_template` | `{template_id, pipeline}` → `{ok, template_id}`. Gate D "save to cloud". |
| `load_template` | `{template_id}` → `{ok, template_id, pipeline}`. |
| `deploy_add` | `{pipeline, comment?, deploy_to?}` → `{ok, artifact, deployment?}`. Gate D "publish": registers the pipeline (needs `name` + `project_id`) as the next immutable version → `artifact.version`. Runs nothing by itself; a failed call may still have registered a version — check `deploy_versions` before retrying. |
| `deploy_to_team` | `{project_id, version, team_id}` → `{ok, deployment}`. Point a team (`team_id`, or `"@me"`) at a `version` — first deploy, promotion and rollback; revives a removed deployment. `deploy_add`'s `deploy_to` does this in the same call. |
| `deploy_list` | `{team_id?, page?, page_size?, search?, filters?, sort?}` → `{ok, deployments, count, total, page, pageSize}`. One row per (projectId, teamId); `count` is rows returned, `total` every match. |
| `deploy_status` | `{project_id, team_id}` → `{ok, deployment}` — version, state, per-source schedules, who deployed it when. |
| `deploy_versions` | `{project_id, page?, page_size?}` → `{ok, project_id, versions, count, total, page, pageSize}`. Newest first: `version`, `pipelineName`, `comment`, `publishedAt`. |
| `deploy_set_schedule` | `{project_id, source_id, schedule, team_id, ttl?}` → `{ok, deployment}`. Cron per source (`"manual"` clears); `source_id` must be a source component of the deployed version; schedules fire only while enabled. |
| `deploy_enable` | `{project_id, team_id}` → `{ok, deployment}`. Re-arms a disabled deployment's schedules. |
| `deploy_disable` | `{project_id, team_id}` → `{ok, deployment}`. The kill switch: schedules stop, manual runs refused. |
| `deploy_remove` | `{project_id, team_id}` → `{ok, deployment}`. Soft remove: leaves listings and stops running; versions and audit history are kept. |

## Node authoring

| Tool | Input | Result |
|---|---|---|
| `scaffold_node` | `{name, lane_in?, lane_out?, class_type?}` (`lane_in` defaults to `text`, `lane_out` to `lane_in`, `class_type` to `lane_in`) | `{ok, name, provider, files, next_steps}`. `files` maps `local_nodes/__init__.py` (the parent package marker) and `local_nodes/<name>/...` paths to contents — it **writes nothing itself**; you write **every** returned path under the engine's `--node_path`. Skipping the marker leaves `local_nodes` a non-package, and the engine cannot import `local_nodes.<name>`. `lane_in`/`lane_out`/`class_type` are validated against the live catalog, so an unknown value comes back as `ok: false` listing what is in service. The engine reads node manifests once at startup: restart it after writing. |

## Integrations / credentials

| Tool | Purpose |
|---|---|
| `list_integrations` | Bare: per-integration readiness rows. With `{name}`: field detail + `setup` instructions to relay to the user. Secret **values never transit MCP** — there is no `set_env`; credentials are configured out-of-band (env/account), and pipelines still reference `${ROCKETRIDE_*}`. |

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
