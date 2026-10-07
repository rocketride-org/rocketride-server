# Error → Cause → Fix

**Load this when:** a `validate()` error or a run failure needs diagnosing — every error → cause →
fix in one place.

**Single source of truth for RocketRide errors** (build-time + runtime). The configuring skill's
`PIPELINE_ANTIPATTERNS.md` keeps only a 3-row TL;DR of the commonest build-time errors and points
here for the full list.

The exact error message maps to an exact cause and an owning phase. Quote the real message, find
the row, route the fix.

| Error message | Cause | Owning phase | Fix |
|---|---|---|---|
| `Connection closed` / `Connection timeout` | **event loop blocked** by sync I/O (input(), time.sleep, requests, readFileSync) | running | use async I/O; never block the async loop |
| `Connection closed unexpectedly` | same — blocked event loop | running | same |
| `The service <provider> was not found` | `provider` misspelled / not in catalog | designing | check the node index; fix the name |
| validate error contains `references unknown component id` | a `source`/`input`/`control` entry names a component `id` that doesn't exist | designing | fix the component id in the wiring |
| validate error contains `input has unknown lane` | output lane ≠ input lane on an edge (input names a lane the node doesn't provide) | designing | add a converter or pick compatible nodes |
| `KeyError: '<key>'` | response key ≠ `laneName` | configuring/running | read `result_types`; use defaults or match client code |
| `Pipeline is already running.` | `use()` called twice on same token | running | `use_existing=True`, or `terminate(token)` then `use()` |
| `Invalid API key` | wrong/missing key | configuring | set `${ROCKETRIDE_*}` env var correctly |
| run/validate failure mentioning `project_id` (no single verbatim message) | variable used in `project_id` | configuring | use a literal GUID |
| empty / wrong output, no error | wrong wiring or wrong input data | designing/data | trace the first node with empty output; check input + lanes |
| store returns nothing | data not embedded before store, or different embedding model for ingest vs query | designing | embed before store; same model both sides |
| agent does nothing / errors on invoke | control plane wrong, or `invoke` min not met | designing | put `control:[{from:<agent>}]` on the controlled node; satisfy invoke min/max |
| `RocketRide cloud database is not available for this task: this server has no RocketRide cloud database ...` | `rocketride_sql` / `rocketride_vector` / `rocketride_graph` on an engine with no database broker (for example, a local or self-hosted engine without the broker env) | designing | run the pipeline on a server with a configured RocketRide database broker, or switch to a node with its own connection settings: `db_postgres` for SQL, PostgreSQL (pgvector), provider `postgres`, for vectors, or `graph_neo4j` for graphs |
| `RocketRide cloud database is not available for this task: this RocketRide Cloud server is missing required database broker configuration ...` | a hosted engine is missing database broker configuration; the server also emits a warning | running | contact the server operator to restore the broker configuration, then retry the pipeline; no database-node replacement is needed |
| `RocketRide cloud database is not available for this task: <broker error>` | the engine's broker call failed: a transient outage, a rejected request (bad broker token, unknown tenant), or a misconfigured broker URL | running | a transient outage: retry; anything else: the operator of that engine checks the broker URL, token and tenant; the broker error after the colon says which it was |

## Reading the trace
- Per-node traces are on by default (`pipelineTraceLevel` server default `"summary"`; pass `"full"`
  for more detail). `"none"` still yields chapters/console logs, but the traces come back empty.
- Status fields that tell the story: `state`, `exitCode`, `exitMessage`, `errors[]` (capped at 1000),
  `failedCount`, `completedCount`. The `apaevt_flow` events show `op` (begin/enter/leave/end) per
  pipe with `trace.lane` / `trace.error`.
- Correlate by `projectId` + `source` (begin/end events carry no token).

## Where each cause is fixed
- **Config** (field/key/model) → `rocketride-configuring-pipelines` → re-fetch schema, re-validate.
- **Wiring/lane/control** → `rocketride-designing-pipelines` → re-wire → re-configure → re-validate.
- **Runtime** (loop/use_existing/blocking) → `rocketride-running-pipelines` → fix the run code.
- After **any** fix: `validate()` must be clean again before re-running.
