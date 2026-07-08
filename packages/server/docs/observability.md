---
title: Observability
---

# Observability

RocketRide exposes runtime observability (task lifecycle, periodic status,
resource metrics, and per-component flow traces) as a **live event stream over
the same [WebSocket](/protocols/websocket) the engine already speaks**. You open a
socket, subscribe to the event types you care about, and the engine pushes events
as a run unfolds. There is no separate metrics endpoint to scrape and no history
database to query: it is **not** OpenTelemetry, Prometheus, Sentry, or webhooks. To
keep history, connect, subscribe, and persist the events as they arrive.

The [TypeScript](/develop/typescript) and [Python](/develop/python) SDKs frame all
of this for you (`getTaskStatus()`, `onEvent`, `setEvents()` / `add_monitor`), so
you rarely touch the wire directly. This page documents the protocol surface so you
can debug it, build a dashboard, or write your own ingester.

## Subscribing: `rrext_monitor`

Subscriptions are managed with the `rrext_monitor` [DAP
request](/protocols/websocket#requests). The engine keeps a per-connection registry
of which event types you want and which tasks they cover. Send it once the
connection is authenticated (the initial `auth` handshake described on the
[WebSocket](/protocols/websocket#connection) page):

```json
{
	"type": "request",
	"seq": 2,
	"command": "rrext_monitor",
	"token": "*",
	"arguments": {
		"types": ["TASK", "SUMMARY", "FLOW", "OUTPUT", "SSE"]
	}
}
```

`token: "*"` subscribes to every task your API token owns: the recommended scope
for an ingestion service. Subscriptions are per-connection and not durable: on
reconnect, resubscribe.

### Event types

`types` accepts case-insensitive `EVENT_TYPE` strings (or the equivalent integer
bitmask, e.g. `36` = `SUMMARY | TASK`):

| String      | Bit | What you get                                                         |
| ----------- | --- | -------------------------------------------------------------------- |
| `NONE`      | 0   | Unsubscribe (clears the registry entry)                              |
| `DEBUGGER`  | 1   | DAP debug-protocol passthrough (stopped, threads, …)                 |
| `DETAIL`    | 2   | Real-time per-object processing updates                              |
| `SUMMARY`   | 4   | Periodic full `TASK_STATUS` snapshots, best for dashboards           |
| `OUTPUT`    | 8   | Engine log / output lines                                            |
| `FLOW`      | 16  | Pipeline component flow events (requires a trace level, see below)   |
| `TASK`      | 32  | Lifecycle: `running`, `begin`, `end`, `restart`                      |
| `SSE`       | 64  | Custom node-to-UI messages emitted by nodes via `monitorSSE()`       |
| `DASHBOARD` | 128 | Server-level events (connections, monitor changes)                   |
| `ALL`       | 255 | Everything above                                                     |

### Subscription scope

Replace `token: "*"` to narrow or widen what you receive:

| Scope                      | Set with                          | Receives                                       |
| -------------------------- | --------------------------------- | ---------------------------------------------- |
| One running task           | `token`                           | Events for that task only                      |
| One pipeline (any run)     | `projectId` + `source`            | That project + source, even across restarts    |
| One pipe within a pipeline | `projectId` + `source` + `pipeId` | That one pipe                                  |
| All sources in a project   | `projectId` + `source: "*"`       | Project-wide                                   |
| All your tasks             | `token: "*"`                      | Everything your token owns                     |

### Seeded on subscribe

You don't poll for the initial state: subscribing seeds it. Turning on `TASK`
triggers an immediate `apaevt_task` with `action: "running"` listing the active
tasks; turning on `SUMMARY` triggers an immediate `apaevt_status_update` with the
current status (or an empty "not running" placeholder).

### Flow traces need a trace level

`apaevt_flow` events fire only when the task was **started** with a
`pipelineTraceLevel`. If you don't control the executor, flow is silent for that
run. When you start the pipeline (`use()` / `execute`), pass:

| Level            | Captured                          |
| ---------------- | --------------------------------- |
| `none` (default) | No flow traces                    |
| `metadata`       | Component / lane structure only   |
| `summary`        | Lane writes and final results     |
| `full`           | Every lane write and invoke call  |

`summary` is the practical default: inputs and outputs without per-call noise.

## Events

The engine pushes [events](/protocols/websocket#events) whose `event` field is the
type discriminator and whose `body` carries the payload. Authoritative type
definitions live in the SDK type modules
(`client-typescript/src/client/types/events.ts`,
`client-python/src/rocketride/types/events.py`, and the matching `task` modules).

| Event                  | Subscribe to | Fires on                                          |
| ---------------------- | ------------ | ------------------------------------------------- |
| `apaevt_task`          | `TASK`       | Lifecycle: `running` / `begin` / `end` / `restart`|
| `apaevt_status_update` | `SUMMARY`    | Periodic full `TASK_STATUS` snapshot              |
| `apaevt_flow`          | `FLOW`       | Component entry / exit, per pipe, per op          |
| `output`              | `OUTPUT`     | Engine stdout/stderr-style log lines              |
| `apaevt_sse`           | `SSE`        | Node-emitted custom messages (`monitorSSE()`)     |
| `apaevt_status_upload` | `SUMMARY`    | File-upload progress                              |
| `apaevt_dashboard`     | `DASHBOARD`  | Server-level connection / monitor-change events   |

### `apaevt_task`: lifecycle

`body.action` is one of `running`, `begin`, `end`, or `restart`. The `running`
snapshot lists active tasks with their `id`; `begin` / `end` / `restart` carry
`name`, `projectId`, and `source` but **no per-event id**: correlate them by
`projectId` + `source`, using the `running` snapshot for the id ↔ project+source
map.

```json
{ "action": "running", "tasks": [{ "id": "…", "projectId": "…", "source": "…" }] }
{ "action": "begin", "name": "…", "projectId": "…", "source": "…" }
```

### `apaevt_status_update`: full status

`body` is a `TASK_STATUS` snapshot: the same shape the SDKs return from
`getTaskStatus()`. Key groups:

- **Identity / lifecycle:** `name`, `project_id`, `source`, `state`
  (`0` NONE · `1` STARTING · `2` INITIALIZING · `3` RUNNING · `4` STOPPING ·
  `5` COMPLETED · `6` CANCELLED), `completed`, `startTime`, `endTime`.
- **Activity:** `status`, `currentObject`, `currentSize`.
- **Counts:** `totalCount` / `completedCount` / `failedCount`, the matching
  `*Size` fields, `wordsCount` / `wordsSize`.
- **Rates:** `rateCount`, `rateSize` (instantaneous).
- **History:** `errors`, `warnings`, `notes`, each **capped at the last 50
  entries**, so persist them as they arrive or older ones are lost on long runs.
- **Termination:** `exitCode`, `exitMessage`.
- **Pipeline flow:** `pipeflow.{totalPipes, byPipe}`, where `byPipe` maps each pipe
  id to its currently-active component stack (a live snapshot of what is running).
- **Resource metrics:** `metrics.{cpu_percent, cpu_memory_mb, gpu_memory_mb}` plus
  `peak_*` and `avg_*` variants of each.
- **Billing tokens:** `tokens.{cpu_utilization, cpu_memory, gpu_memory, total}`
  (100 tokens = $1).

### `apaevt_flow`: execution trace

The data that lets you reconstruct *why* a pipeline produced what it did: each
component's entry and exit with its lane data and any error.

```ts
{
  id: number,                              // pipe index within the pipeline
  op: "begin" | "enter" | "leave" | "end",
  pipes: string[],                         // current component stack for this pipe
  component?: string,                      // component this op refers to (on "leave", the leaving one) — pair enter/leave by identity, not stack position
  trace: { lane?: string, data?: object, result?: string, error?: string },
  result?: PIPELINE_RESULT,                // on op === "end", level >= summary
  project_id: string,
  source: string
}
```

`trace` is free-form and varies by node and trace level, store it as JSON, don't
flatten it.

### `apaevt_sse`: node-to-UI messages

Nodes call `monitorSSE(pipe_id, type, data)` to broadcast custom updates
("thinking", "tool_call", progress, …). The body is `{ pipe_id, type, data }`; the
schema is intentionally open: interpret it per node type.

### `output`: log lines

The engine's DAP `output` events are re-emitted to subscribers. The body carries an
`output` string plus the DAP-standard output fields (`category`, …).

### `apaevt_status_upload`: upload progress

`{ action: "begin" | "write" | "complete" | "error", filepath, bytes_sent?, file_size? }`.

### `apaevt_dashboard`: admin events

Connection lifecycle and monitor-change audit events, useful if you want to record
*who* subscribed to which monitors.

## Related commands

Besides `rrext_monitor`, sent the same way over the socket:

| Command                 | Uses                                  | Returns       | Purpose                                          |
| ----------------------- | ------------------------------------- | ------------- | ------------------------------------------------ |
| `rrext_get_task_status` | `token`                               | `TASK_STATUS` | Fetch current status synchronously               |
| `rrext_get_token`       | `projectId` + `source`                | `{ token }`   | Resolve a running task's token                   |
| `execute`               | `{ pipeline, pipelineTraceLevel?, … }`| `{ token }`   | Start a pipeline; sets the trace level that gates `FLOW` |

## Notes

- **No global run id.** There is no `event_id` or global ordering key. Correlate a
  run by `(project_id, source, startTime)`, and order within a connection by the
  DAP envelope `seq` (per-connection monotonic).
- **No dead-letter queue.** If your consumer is offline it misses that window; the
  next `running` snapshot is the only crash-recovery handle.
- **Tenant scoped.** You only receive events for tasks started with your own API
  token.

## Related

- [WebSocket](/protocols/websocket): the protocol this stream rides on.
- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python): clients
  that wrap subscriptions behind `getTaskStatus()`, `onEvent`, and `setEvents()` /
  `add_monitor`.
- [Execution model](/concepts/execution-model): how a run streams once started.
