---
title: Observability
---

# Observability

Every RocketRide run is recorded. This guide is the map: the mental model
behind run logs, the two ways to watch a pipeline (live and replayed), and
which surface to reach for — each section links to the page that owns the
detail.

## The mental model: a DVR, not a log file

The engine writes every run into a durable, append-only stream — one
**continuum** per pipeline identity, where each run is a **chapter** inside
it. There are no per-run log files to collect. Watching a run live and
replaying it tomorrow are the same data at different positions: live is just
a position pinned to "now".

Two identities matter, and they do different jobs:

| Identity | What it is | What it's for |
| --- | --- | --- |
| **Task token** (`tk_...`) | The live control handle a run returns when started | Send data, poll status, terminate — dies with the run |
| **`projectId` + `source` (+ `teamId`)** | The pipeline's durable log identity | Monitoring subscriptions and everything recorded — outlives the run, works after it finished |

Omitting `teamId` addresses your own **dev stream**; passing it addresses
that team's **deploy continuum**. Team membership is the read right. Inside
the stream, `beginSeq` is a run's (and a trace's) permanent id.

## The two planes

**Live plane** — event subscriptions (`rrext_monitor` on the wire,
`add_monitor`/`addMonitor` in the SDKs). Push-based, per-connection, and
non-durable: if you weren't subscribed, you missed it. Covers lifecycle,
status updates (with metrics and billing), component-level flow events, and
console output. The full event schema lives on
[WebSocket Events](/connect/websocket/observability).

**Recorded plane** — the run-log continuum (`client.log` in the SDKs, the
`log_*` MCP tools). Pull-based and durable: chapters, ranged reads, per-object
traces, and a DVR session that can seek, replay at any speed, and pin to
live. The full API lives on the SDK [run-log pages](/clients/python/logs).

They are two views of the same events: a flow event you watch live is the
same record you replay from the log later.

## Trace levels

`pipelineTraceLevel` — set when a run starts — decides how much of the run
gets recorded (and emitted live as flow events):

| Level | Records | Cost |
| --- | --- | --- |
| `none` | Lifecycle, status, console only — **no traces** | None |
| `metadata` | Component enter/leave, object identities | Minimal |
| `summary` | Above, plus lane writes and final results | Modest — the debugging sweet spot |
| `full` | Everything, entire payloads inlined (including images) | Can slow runs and swell the log |

**The default depends on where you start the run** — each surface picks what
its users typically want, so don't assume:

| Surface | Default | Why |
| --- | --- | --- |
| Wire / SDK `use()` | `none` | Production callers opt in to tracing |
| MCP server tools | `summary` | Assistants need replayable content to debug |
| VS Code extension | `full` | Interactive debugging wants everything |

A run recorded with `none` still has chapters and console output — but its
traces are empty, which is the most common "why can't I replay this?" answer.

## Retention

Runs are kept **7 days (dev streams) / 30 days (deploy continuums)** on a
bounded (~1 GB) ring, evicted earlier under storage pressure. Reads below the
horizon fail explicitly (`TraceExpired` on MCP, truncation markers in the
SDKs) rather than returning partial silence.

## Which surface, when

| You are… | Reach for | Where |
| --- | --- | --- |
| Writing Python/TypeScript | `get_task_status` / `add_monitor` live; `client.log` chapters, reads, and DVR sessions | [Python](/clients/python/logs) · [TypeScript](/clients/typescript/logs) |
| In an AI assistant (MCP) | `monitor` and `list_running_pipelines` live; `log_chapters`/`log_read`/`log_traces`/`log_trace` for replay — traces render in the trace-viewer widget | [MCP tools](/connect/mcp/http/tools#replay-past-runs) |
| In VS Code | The Status page, Flow and Trace tabs, and the component debugger | [VS Code usage](/clients/vscode/usage) |
| Building your own ingester / dashboards | Raw `rrext_monitor` subscriptions over the WebSocket protocol | [WebSocket Events](/connect/websocket/observability) |

What RocketRide observability is **not**: there is no OpenTelemetry,
Prometheus, or webhook emitter — the wire protocol is the integration point
if you need one.

## Two workflows

**Watch a live run.** Start the pipeline (keep `projectId`/`source` from the
result), subscribe with `add_monitor({project_id, source})` or open the VS
Code Status page, and watch status/flow events arrive. Poll-style
alternatives: `get_task_status(token)` in the SDKs, `monitor` over MCP.

**Autopsy yesterday's failed run.** No token needed — the run is gone but the
log isn't. List the chapters for `projectId + source`, pick the failed run's
`beginSeq`, list its traces, and pull the failing object's full journey —
every component it entered and left, with lane data at each hop. In the SDKs
that's `chapters()`, then a DVR session's `get_traces()` → `get_trace()`; over
MCP it's
`log_chapters` → `log_traces` → `log_trace`.

## One naming trap

The SDK constructor option `on_trace`/`onTrace` has nothing to do with
pipeline traces — it's a client-side hook that logs the SDK's own
request/response frames for debugging your integration (and in Python it is
**not** credential-redacted). Pipeline tracing is controlled by
`pipelineTraceLevel` alone. See
[Configuration](/clients/python/configuration).
