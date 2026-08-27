---
title: Tools
sidebar_position: 2
---

# Tools

The server exposes **27 tools**. This page is the full reference; the
[overview](/connect/mcp/http/) has the one-table summary.

## How every tool behaves

- **One result, two encodings.** Every tool returns a JSON object, serialized
  once and delivered both as the text content and as `structuredContent` — they
  can never diverge.
- **`ok` is the contract.** Success payloads carry `ok: true`. Recoverable
  failures come back in-band as
  `{ok: false, error_type, message, hint}` with the MCP `isError` flag set:
  `BadRequest` (bad or missing arguments), `Timeout` (one engine call ran past
  its budget — the hint says how to recover), `NotFound`/`TraceExpired` (log
  tools), `UnknownTool`. Hard failures (lost engine connection, auth) surface
  as MCP protocol errors with the original message preserved.
- **Timeouts.** Read-side engine calls are budgeted at 30 seconds; the
  execution tools (`run_pipeline`, `run_dropper_pipe`, `send_data`,
  `send_files`, `terminate`) get 120 seconds per engine call.
- **Per-caller identity.** Tools act as the account behind your credential —
  your store, your deployments, your environment variables, your run logs.
- **Pipelines are inline-only.** Every `pipeline` parameter takes the pipeline
  JSON itself (a `{"pipeline": {...}}` wrapper is auto-unwrapped). File paths
  are rejected — the client reads its own `.pipe` file and sends the contents.

## Discover components

### list_components

List the components ready to use right now: every engine service definition,
minus credentialed integrations that are not fully configured (call
[`list_integrations`](#list_integrations) to see those and how to finish their
setup).

- **Parameters:** none.
- **Returns:** `{ok, components: [{name, category, summary, wiring?}], note?}`.
  `wiring` (a config-path → `${ENV_VAR}` map) appears only for configured
  credentialed integrations; `note` appears when unconfigured integrations were
  omitted.

### describe_component

Return one component's full service definition — metadata, lanes, and config
schema — plus a credential-readiness block when the component is a credentialed
integration.

- **Parameters:** `name` (string, required) — a component name from
  `list_components`.
- **Returns:** the engine's whole service definition at top level, plus
  `ok: true` and, for integrations, `credentials: {status, missing, candidates,
  wiring | setup}`.

### list_integrations

Report credential setup status for integrations — the discovery counterpart to
`list_components`, which hides unready ones. Only integrations with a matching
node on the connected engine are listed.

- **Parameters:** `name` (string, optional) — request full field detail for one
  integration.
- **Returns (bare call):** `{ok, integrations: [{name, title, status,
  missing_count}], note}` with status one of `configured`, `available`
  (needs setup — no matching variables found), or `unconfirmed` (candidate
  variables found for you to confirm, or the variable read failed).
- **Returns (with `name`):** `{ok, name, title, fields, caller_variables,
  status, missing, candidates, wiring | setup}` — `setup` carries the
  suggested variable names, instructions to relay to the user, and a docs
  link.
- **Notable:** only environment-variable **names** are read and reported —
  values never transit MCP. Wiring values are emitted as `${VAR}` placeholder
  strings for use in a pipeline config.

## Author pipelines

### validate_pipeline

Validate an inline pipeline with the engine's own validator — the same rules
`use()` applies, so there is no client-side drift.

- **Parameters:** `pipeline` (object, required).
- **Returns:** `{ok, errors: [], warnings: []}` — `ok` is true only when there
  are no errors.

### describe_pipeline

Statically parse an inline pipeline into its components, enriched with a
best-effort engine lookup per provider (title, category).

- **Parameters:** `pipeline` (object, required).
- **Returns:** `{ok, source, components: [{id, provider, title, classType,
  inputs}]}`.
- **Notable:** lookups share one 30-second budget; providers the engine cannot
  resolve fall back to the pipeline's own metadata instead of failing the
  parse.

### save_template

Save an inline pipeline as a reusable template under an id (stored in your
account file store at `.templates/<id>.json`).

- **Parameters:** `template_id` (string, required); `pipeline` (object,
  required).
- **Returns:** `{ok, template_id}`.

### load_template

Load a previously saved pipeline template.

- **Parameters:** `template_id` (string, required).
- **Returns:** `{ok, template_id, pipeline}`.

## Run pipelines

The three start/send tools share these optional start parameters: `ttl`
(integer — task TTL in seconds, 0 = no timeout), `use_existing` (boolean —
reuse an already-running task), `source` (string — source label), `threads`
(integer), and `pipelineTraceLevel` (`none | metadata | summary | full`).
Runs default to `summary` tracing so the [replay tools](#replay-past-runs)
have content.

### run_pipeline

Start a pipeline from an inline definition, returning a `task_token`;
optionally send data in the same call and get the result back synchronously.

- **Parameters:** `pipeline` (object, required); `inputs` (string, optional —
  data to send immediately after start); plus the shared start parameters.
- **Returns:** `{ok, task_token, projectId, source, result?}` — `result` only
  when `inputs` was passed. Keep `projectId` and `source`: they key the
  [replay tools](#replay-past-runs).
- **Notable:** if the initial send times out, the error hint still reports the
  token so you can `monitor` the task instead of losing it.

### run_dropper_pipe

Start a pipeline and get two self-contained URLs for sending file bytes over a
separate HTTP channel (bytes cannot ride an MCP tool call).

- **Parameters:** `pipeline` (object, required); plus the shared start
  parameters (no `inputs`).
- **Returns:** `{ok, task_token, upload_url, dropper_url, projectId, source}`.
  `upload_url` accepts programmatic multipart POSTs; `dropper_url` is a
  browser page where a person can drag and drop files into the running
  pipeline.
- **Notable:** the URLs embed only the task's public key (`pk_`); the control
  token never appears in a URL. If the pipeline has no data-ingress source, the
  task is cleaned up and the call fails with a `BadRequest` instead of leaving
  an orphaned run. In MCP Apps hosts the result renders as the
  [file-dropper widget](/connect/mcp/http/resources-and-widgets#widgets).

### send_data

Send data to a running task and return its result.

- **Parameters:** `task_token` (string, required); `input` (string, required).
- **Returns:** `{ok, result}`.

### send_files

Upload files to a running task by token.

- **Parameters:** `task_token` (string, required); `files` (array of strings,
  at least one, required).
- **Returns:** `{ok, result}` — per-file upload results (status, timing,
  processing results).
- **Caution:** paths are resolved on the machine the engine runs on — **not**
  through your account file store. Against RocketRide Cloud this tool is only
  useful for files the engine host can already see; to get local files into a
  pipeline, use `run_dropper_pipe` and its `upload_url` instead.

### terminate

Terminate a running task by token — also the way to stop a runaway run.

- **Parameters:** `task_token` (string, required).
- **Returns:** `{ok, terminated}`.

## Watch what's running

### monitor

Poll a task until it reaches a terminal state or the timeout elapses, then
return a status snapshot. This is bounded polling, not an event stream — it
always returns within the timeout.

- **Parameters:** `task_token` (string, required); `timeout` (number, optional,
  default 30, clamped to 0–300 seconds); `interval` (number, optional, default
  1, minimum 0.25 seconds).
- **Returns:** `{ok, task_token, state, state_label, completed, terminal,
  status, counts: {completedCount, failedCount, totalCount}, errors, warnings,
  polls, poll_timed_out?}`.
- **Notable:** `state` is an integer enum (0 none, 1 starting,
  2 initializing, 3 running, 4 stopping, 5 completed, 6 cancelled);
  `state_label` is the readable form. Long-lived pipelines (webhook sources)
  legitimately sit at `running` forever — a timeout then returns the current
  snapshot with `terminal: false`, which is not an error.

### list_running_pipelines

List the running pipelines on the connected server.

- **Parameters:** none.
- **Returns:** `{ok, tasks, count}` — task tokens, names, and state, ready to
  feed `monitor`, `send_data`, or `terminate`. In MCP Apps hosts the result
  renders as the
  [pipelines-table widget](/connect/mcp/http/resources-and-widgets#widgets).

## Read the file store

All four tools resolve store-relative paths on the engine, scoped to your
account's file store.

### store_read

Read a text file from the store.

- **Parameters:** `path` (string, required).
- **Returns:** `{ok, path, content}`.

### store_list

List the entries under a store directory.

- **Parameters:** `path` (string, optional — defaults to the store root).
- **Returns:** `{ok, path, listing}`.

### store_stat

Get metadata for a store file or directory.

- **Parameters:** `path` (string, required).
- **Returns:** `{ok, path, stat}` — existence, type, size, modified time.

### store_get_url

Get a time-limited signed download URL for a store file — the out-of-band
counterpart to `store_read` for large or binary files.

- **Parameters:** `path` (string, required); `expires_in` (integer ≥ 1,
  optional, default 3600 seconds); `download_name` (string, optional —
  filename the browser saves as).
- **Returns:** `{ok, path, url, expires_in}`.

## Manage deployments

### deploy_add

Register an inline pipeline as a deployment, optionally on a cron schedule.

- **Parameters:** `pipeline` (object, required); `schedule` (string, optional
  cron expression).
- **Returns:** `{ok, deployment}`.
- **Notable:** creation is not idempotent — after a timeout, call
  `deploy_list` before retrying, since the deployment may already exist.

### deploy_list

List your deployments.

- **Parameters:** none.
- **Returns:** `{ok, deployments, count}`.

### deploy_status

Detailed status of one deployment.

- **Parameters:** `project_id` (string, required).
- **Returns:** `{ok, deployment}`.

### deploy_remove

Undeploy and remove a deployment.

- **Parameters:** `project_id` (string, required).
- **Returns:** `{ok, removed}`.

### deploy_update

Update a deployment's pipeline and/or schedule.

- **Parameters:** `project_id` (string, required); `pipeline` (object,
  optional); `schedule` (string, optional — a replacement cron expression or
  `"manual"`). At least one of `pipeline`/`schedule` is required.
- **Returns:** `{ok, project_id, updated}` — which of the two changed.

## Replay past runs

The run-log (DVR) tools are keyed by **`projectId` + `source`** — the values
`run_pipeline`/`run_dropper_pipe` return — never by task token, so they work
for runs that have already finished. All four accept `teamId` (string,
optional) to address a team's deploy continuum instead of your own dev stream.

Retention: runs are evicted after 7 days (dev) / 30 days (deploy), or earlier
under storage caps. Runs recorded with `pipelineTraceLevel: 'none'` still have
chapters and console output but empty traces.

### log_chapters

List the recorded runs (chapters) for a pipeline — begin/end times, outcome,
and each chapter's `beginSeq`. Works for past and live runs.

- **Parameters:** `projectId`, `source` (strings, required); `teamId`
  (string, optional).
- **Returns:** `{ok, chapters, horizonSeq}`.

### log_read

Read raw run-log events, cursor-paged.

- **Parameters:** the key parameters; `fromSeq` (integer, optional — sequence
  to start from); `cursor` (integer, optional — from a previous `nextCursor`);
  `maxEvents` (integer, optional, default and maximum 200); `types` (array of
  strings, optional — event-type filter, e.g. `["output"]` for console lines
  only).
- **Returns:** `{ok, events, nextCursor, truncatedAtSeq}`.
- **Notable:** pages are additionally capped at 1 MiB.

### log_traces

List per-object trace summaries — one per file or document that traveled the
pipeline — for the latest run or a specific past run.

- **Parameters:** the key parameters; `n` (integer, optional, default 20,
  clamped 1–100); `chapterBeginSeq` (integer, optional — address a specific
  past run by its chapter `beginSeq` from `log_chapters`).
- **Returns:** `{ok, traces, open, context, note?}` — `traces` are finished
  journeys, `open` are still in flight; each summary carries `beginSeq`, the
  permanent trace id. In MCP Apps hosts the result renders in the
  [trace-viewer widget](/connect/mcp/http/resources-and-widgets#widgets).

### log_trace

Fetch one object's full begin-to-end journey: every component enter/leave with
lane data, plus node narration.

- **Parameters:** the key parameters; `beginSeq` (integer, required — a trace
  id from `log_traces`).
- **Returns:** `{ok, beginSeq, summary, events, context}`.
- **Errors:** a trace below the retention horizon returns
  `{ok: false, error_type: 'TraceExpired', ...}`.
