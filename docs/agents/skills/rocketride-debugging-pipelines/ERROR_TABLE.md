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
| `Websocket closed unexpectedly` | same — blocked event loop | running | same |
| `Component not found` | `provider` misspelled / not in catalog | designing | check the node index; fix the name |
| `Lane not supported` | output lane ≠ input lane on an edge | designing | add a converter or pick compatible nodes |
| `KeyError: '<key>'` | response key ≠ `laneName` | configuring/running | read `result_types`; use defaults or match client code |
| `Pipeline already running` | `use()` called twice on same token | running | `use_existing=True`, or `terminate(token)` then `use()` |
| `Invalid API key` | wrong/missing key | configuring | set `${ROCKETRIDE_*}` env var correctly |
| `project_id must be a GUID` | variable used in `project_id` | configuring | use a literal GUID |
| empty / wrong output, no error | wrong wiring or wrong input data | designing/data | trace the first node with empty output; check input + lanes |
| store returns nothing | data not embedded before store, or different embedding model for ingest vs query | designing | embed before store; same model both sides |
| agent does nothing / errors on invoke | control plane wrong, or `invoke` min not met | designing | put `control:[{from:<agent>}]` on the controlled node; satisfy invoke min/max |

## Reading the trace
- Start the run with `pipelineTraceLevel="summary"` (or `"full"`) to get per-node traces; `"none"`
  (default) gives you only the final status.
- Status fields that tell the story: `state`, `exitCode`, `exitMessage`, `errors[]` (capped at 50),
  `failedCount`, `completedCount`. The `apaevt_flow` events show `op` (begin/enter/leave/end) per
  pipe with `trace.lane` / `trace.error`.
- Correlate by `projectId` + `source` (begin/end events carry no token).

## Where each cause is fixed
- **Config** (field/key/model) → `rocketride-configuring-pipelines` → re-fetch schema, re-validate.
- **Wiring/lane/control** → `rocketride-designing-pipelines` → re-wire → re-configure → re-validate.
- **Runtime** (loop/use_existing/blocking) → `rocketride-running-pipelines` → fix the run code.
- After **any** fix: `validate()` must be clean again before re-running.
