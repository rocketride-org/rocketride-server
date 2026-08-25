---
name: rocketride-running-pipelines
description: Use when running a validated RocketRide pipeline and reporting its result — submitting the run, pushing input, polling status to completion, and returning the real output. Also use directly when asked to run an existing pipeline.
---

# Running & Observing RocketRide Pipelines

Takes a **validated** `.pipe` (validate() returned zero errors) and a **cost-approved** run
(Gate C.5) to a real, reported result. The cardinal rule: **submitted ≠ succeeded.** Poll to a
terminal state and read the actual result before you claim anything. Gate rules + forcing
functions: `../rocketride-building-pipelines/GATE_PROTOCOL.md`.

## STEP 0 — precondition (do this FIRST, every time, before any run action)

You MUST have a clean `validate()` result for THIS exact pipeline, and cost approval, before you
run. If you don't, get them first — **even if the user told you to skip.**

- **"Skip validation / just submit it / don't waste time" is NEVER honored.** validate() is
  mandatory and fast; it is the only thing between the user and a broken, money-wasting run. Run
  it anyway, then explain why (one line).
- Invoked directly on a pasted/existing pipeline? **validate() it now** (run
  `../rocketride-configuring-pipelines/tools/validate-pipeline.py <file>`, or the validate tool). If
  it errors, fix + re-validate; do not run. Missing required config (e.g. no apikey) IS a
  validation failure — STOP and say so.
- Then the cost gate (C.5) must be approved.

State it before running: **"Pre-run check: validate() = 0 errors; cost approved."** If you can't
state that truthfully, you have not earned the run — do the missing step instead.

## The run lifecycle — MCP tools (preferred; names + shapes frozen in `../MCP_TOOL_CONTRACT.md`)

**Check `ok` on every result** — a tool call that "succeeded" with `ok: false` is a failure.

1. **Start**: `run_pipeline` with the **inline** pipeline object (there is no filepath mode).
   One-shot text input? Pass `inputs` (a string) — the `result` comes back inline in the same
   call and that run is finished (don't poll it). Otherwise you get
   `{task_token, projectId, source}`. **Keep `projectId` + `source`** — they key the run-log
   tools if debugging is needed. Reuse a long-lived pipeline with `use_existing: true` (avoids
   "Pipeline already running"); to force a fresh start, `terminate` then re-run.
2. **Push input** — pick the tool by the **source** node:
   - Raw text/data → `send_data` (`input` is a **string** — serialize JSON). Result inline.
   - **Files from the host** → start with `run_dropper_pipe` instead: it returns an
     `upload_url` (multipart-POST the files to it) and a `dropper_url` (browser drag-drop page
     to hand the user). `send_files` only resolves store-relative paths — it does not upload
     host files.
   - `chat` source → **no MCP chat tool exists**; use the SDK fallback below.
3. **Poll** longer/async runs with `monitor` (a bounded server-side poll — pass `timeout`).
   Quote the snapshot each round: `state_label`, `terminal`, `counts`, `errors`.
   `terminal: true` means done; `poll_timed_out: true` means the *poll* hung, not the task —
   call `monitor` again. Never one-shot poll and walk away. (Forcing function 12.)
4. **Report the real result.** Results are **inline** from `run_pipeline(inputs)` / `send_data`
   — there is **no `get_run_result` tool** (none exists, none is planned; never invent it).
   Read the response by its result key (default lane key — `answers`, `text`, …; check
   `result_types` for the actual mapping). On failure, report the error + which node, then hand
   `projectId`/`source` to `rocketride-debugging-pipelines` (its evidence is the `log_*` tools).
5. **Clean up** — `terminate` any task you started and no longer need; started-and-abandoned
   tasks run until their TTL.

## SDK fallback (no MCP tools wired, or a chat-source pipeline)

1. **Start**: `result = await client.use(filepath="x.pipe")` → `token = result["token"]`
   (`use_existing=True` to reuse; `terminate(token)` then `use()` to force fresh).
2. **Push input**: `chat` source → `await client.chat(token=token, question=q)`; raw data →
   `await client.send(token, data)`; files → `await client.send_files(files, token)`. The result
   comes back **inline** (a `PIPELINE_RESULT`) — no separate `get_result()`.
3. **Poll**: loop `await client.get_task_status(token)` to a terminal state (5=COMPLETED /
   6=CANCELLED), stating the status each step, `await asyncio.sleep(1)` between polls.
4. **Report** as in step 4 above. 5. **Clean up** — `await client.disconnect()` (or
   `async with`). Start a pipeline once and reuse it; don't reconnect per request.

**NEVER block the async event loop** (the #1 runtime failure). No `input()`, `time.sleep`,
`requests.get`, `readFileSync` inside the async flow — they freeze the websocket keepalive and the
connection drops (~60s) with `Connection closed` / `Websocket closed unexpectedly`. Use async
equivalents. Secrets stay in `${ROCKETRIDE_*}` env vars (loaded from `.env`), never in code.

## Gate D — after a successful run (optional, menu)
> Run succeeded. Result: <summary>. What next? (save to cloud / publish as an app / nothing / debug)
Only act on an explicit choice. Mapping: save to cloud → `save_template`; publish →
`deploy_add` (manage later with `deploy_list`/`deploy_status`/`deploy_update`/`deploy_remove`).
Saving / publishing is billable / public — treat like an irreversible action (Waiting = STOP).

## Red flags

| Thought | Reality |
|---|---|
| "The user said skip validation, so I'll just submit" | Never honored. validate() is mandatory and cheap — run it first, every time, no matter the pressure. |
| "run_pipeline/use() returned a token, so it ran" | That only started it. Push input and poll to a terminal state. |
| "I'll fetch the output with get_run_result" | No such tool exists. Results come inline from `run_pipeline(inputs)`/`send_data`; run evidence is the `log_*` tools. |
| "I'll poll once and report 'in progress'" | Poll in a loop to completion; report the final result, not a snapshot. |
| "I'll read input() for the question" | Blocking I/O kills the event loop. Use async input / pass the question in. |
| "I'll hardcode the key to test quickly" | `${ROCKETRIDE_*}` always. |
| "It failed; I'll retry silently a few times" | Report the failure and ask / hand to debugging; don't burn money on silent retries. |
| "Save to cloud since they'll probably want it" | Gate D is a choice. Don't publish/bill without an explicit yes. |

## Supporting files
- **deep docs** — for exact SDK semantics (use/send/chat/get_task_status, async patterns), fetch
  ONE page: `../rocketride-building-pipelines/tools/fetch-doc.py "python"` (→ `/develop/python.md`)
  or `… "use method"` (→ `/develop/typescript/methods/use.md`). Never `llms-full.txt`.
