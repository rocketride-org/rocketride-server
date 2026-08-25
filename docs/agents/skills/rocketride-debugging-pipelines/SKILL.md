---
name: rocketride-debugging-pipelines
description: Use when a RocketRide pipeline run failed, errored, or produced wrong/empty output, and you need to find the failing node and fix it. Reads run status and execution traces, diagnoses the cause, and routes back to design or configuration. Also use directly when asked to debug a run.
---

# Debugging RocketRide Pipelines

Diagnose, don't guess. A failed run has a real cause in the status/trace; find it, then route the
fix to the right phase. No re-running until the cause is identified and the fix is validated.

## Procedure

1. **Read the status.** MCP: `monitor(task_token)` → quote `state_label`, `errors[]`,
   `warnings[]`, `counts` verbatim. SDK: `get_task_status(token)` → `state`, `errors[]`,
   `warnings[]`, `exitCode`, `exitMessage`, `failedCount`. Don't paraphrase error messages.
2. **Read the trace.** MCP — the run-log (DVR) tools work for past *and* live runs, keyed by the
   `projectId` + `source` returned by `run_pipeline`/`run_dropper_pipe` (never the task token):
   `log_chapters` to find the run → `log_read` for paged events (≤200/page; follow the cursor) →
   `log_traces` to list per-object traces → `log_trace` for one object's full per-node
   `enter`/`leave` with `lane`, `data`, `result`, `error`. Retention: 7 days dev / 30 days
   deploy. A run started with `pipelineTraceLevel="none"` has chapters/console but **empty
   traces** — re-run with `"summary"`/`"full"` for flow evidence. SDK fallback: the
   `apaevt_flow` / `_trace` events in the response. Either way, find the **first** node whose op
   shows an error or whose output is empty/wrong — that's the failure point. Downstream errors
   are usually consequences.
3. **Classify the cause** (see `ERROR_TABLE.md`):
   - **Config** — bad/missing field, wrong API key, wrong model name → fix in
     `rocketride-configuring-pipelines` (re-fetch schema, re-validate).
   - **Wiring/lane** — lane mismatch, missing converter, wrong source method → fix in
     `rocketride-designing-pipelines` (re-wire), then re-configure + re-validate.
   - **Runtime** — event-loop blocked (`Connection closed`/timeout), `Pipeline already running`,
     blocking I/O → fix the run code in `rocketride-running-pipelines`.
   - **Data** — empty/garbage input, wrong response key (`KeyError`) → check input + `result_types`.
4. **Propose a specific fix** tied to the evidence: "Node `llm_1` failed: `Invalid API key`. The
   `${ROCKETRIDE_OPENAI_KEY}` env var is unset / wrong. Fix: set it, re-validate, re-run." Route to
   the owning phase. **Do not re-run until the fix is made and `validate()` is clean again.**

## Common diagnoses (full table in ERROR_TABLE.md)
- `Connection closed` / `Websocket closed unexpectedly` → **event loop blocked by sync I/O** (most
  common runtime failure) — fix the run code, not the pipeline.
- `Component not found` → misspelled `provider`; check the index.
- `Lane not supported` → lane mismatch; add a converter or pick compatible nodes.
- `KeyError: '<key>'` → response key vs `laneName` mismatch; read `result_types`.
- `Pipeline already running` → `use_existing=True` or `terminate()` first.
- `Invalid API key` / `project_id must be a GUID` → config fix.

## Red flags

| Thought | Reality |
|---|---|
| "I'll just re-run, maybe it works" | Find the cause first; blind re-runs cost money and teach nothing. |
| "The last node errored, fix that node" | The **first** failing node in the trace is usually the cause; later errors cascade. |
| "Connection dropped — the engine is flaky" | Almost always a blocked event loop (sync I/O in async code), not the engine. |
| "I'll paraphrase the error" | Quote it verbatim — the exact message maps to the exact fix. |
| "Fixed it, re-running" | Re-validate() after any fix before re-running. |

## Supporting files
- `ERROR_TABLE.md` — error message → cause → owning phase → fix
- **deep docs** — for failure modes the table doesn't cover, fetch ONE page:
  `../rocketride-building-pipelines/tools/fetch-doc.py "error handling"`
  (→ `/concepts/error-handling.md`) or `… "observability"` (→ `/protocols/websocket/observability.md`).
  Never `llms-full.txt`.
