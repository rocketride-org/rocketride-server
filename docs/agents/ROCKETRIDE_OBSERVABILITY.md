# RocketRide Observability & Tracing Integration Guide

This document describes how an external service (e.g. an "agents database") consumes
runtime logs, lifecycle events, and pipeline tracing data from a RocketRide server.

It reflects the actual server implementation, not aspirational features. If a feature
is not listed here, it likely does not exist in the server.

---

## 1. What RocketRide ships for observability

RocketRide does **not** expose OpenTelemetry, Jaeger, Prometheus `/metrics`,
Sentry, webhook registration, audit-log tables, or a queryable history database.
There is no SQL store of past runs to read from.

Everything is delivered live over a single channel: a **WebSocket Debug Adapter
Protocol (DAP) connection** on which the server emits typed events. To capture
historical data, your service must connect, subscribe, and write the events to
its own database as they arrive.

The features that _do_ exist:

| Feature                                                                   | Surface                                                             | Granularity        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| Task lifecycle events (`begin` / `end` / `running` / `restart`)           | DAP event `apaevt_task`                                             | Per task           |
| Periodic full task status (counts, rates, errors, metrics, tokens)        | DAP event `apaevt_status_update`                                    | Per task, periodic |
| Pipeline flow / component traces (op, lane, input/output, result, error)  | DAP event `apaevt_flow`                                             | Per pipe, per op   |
| Engine stdout/stderr-style log lines                                      | DAP event with `event: 'output'` (forwarded as `EVENT_TYPE.OUTPUT`) | Per task           |
| Real-time node→UI custom messages (`monitorSSE`)                          | DAP event `apaevt_sse`                                              | Per pipe           |
| File upload progress                                                      | DAP event `apaevt_status_upload`                                    | Per upload         |
| Server/admin dashboard events (connection added/removed, monitor changes) | DAP event `apaevt_dashboard`                                        | Server-wide        |
| Synchronous HTTP status query                                             | `GET /task?token=...`                                               | On-demand          |
| Synchronous HTTP server status                                            | `GET /status`                                                       | On-demand          |

---

## 2. Connection & authentication

### 2.1 Endpoints

The RocketRide server is a FastAPI app bound by default to:

- Host: `0.0.0.0`
- Port: `5565` (constant `CONST_DEFAULT_WEB_PORT`)

Two relevant transports run on that port:

| Transport       | Path                                                              | Use                                                          |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| WebSocket (DAP) | `/task/service`                                                   | Streaming events + commands. **Use this for observability.** |
| HTTP (REST)     | `/task`, `/task/data`, `/status`, `/version`, `/ping`, `/webhook` | Synchronous task control & status                            |

So the WebSocket URL is:

```
ws://<host>:5565/task/service
```

(or `wss://` when TLS is enabled via `tlsCertFile` / `tlsKeyFile` config).

### 2.2 Auth

All non-public endpoints require an API key.

- **HTTP:** `Authorization: Bearer <ROCKETRIDE_APIKEY>` header.
- **WebSocket DAP:** the _first_ DAP request you send after the socket opens
  must be the `auth` command:

```json
{
	"type": "request",
	"seq": 1,
	"command": "auth",
	"arguments": {
		"auth": "${ROCKETRIDE_APIKEY}",
		"clientName": "agents-db",
		"clientVersion": "1.0.0"
	}
}
```

If `success: false` comes back, the server closes the socket. Do not retry blindly
on auth failure.

Tenant scoping: events are only delivered to connections whose authenticated API
key matches the API key that started the task. You will only see your own runs.

### 2.3 Environment variables

Variables the server reads:

- `ROCKETRIDE_APIKEY` — server-side API key (also expected client-side).
- `ROCKETRIDE_URI` — default URI used by the SDK if not passed in code.
- `ROCKETRIDE_CORS_ORIGINS` — comma-separated CORS allow-list.

---

## 3. The DAP wire protocol (what you send and receive)

DAP is JSON-over-WebSocket. Three message types: `request`, `response`, `event`.

```jsonc
// Outbound request from your service
{
  "type": "request",
  "seq": 42,                    // unique correlation id you generate
  "command": "rrext_monitor",
  "arguments": { ... },
  "token": "${TASK_TOKEN}"      // optional, command-dependent
}

// Inbound response (matches request_seq → seq)
{
  "type": "response",
  "request_seq": 42,
  "command": "rrext_monitor",
  "success": true,
  "body": { ... },
  "message": "..."              // present when success=false
}

// Inbound event (no request)
{
  "type": "event",
  "seq": 1234,
  "event": "apaevt_flow",       // event-type discriminator
  "body": { ... }
}
```

You correlate responses to requests by matching `request_seq` to the `seq` you sent.

---

## 4. Subscribing to events: `rrext_monitor`

Subscriptions are managed with the `rrext_monitor` DAP command. The server keeps
a per-connection registry keyed by **token** (resolved to project+source) or
**project+source** directly, optionally narrowed to a `pipe_id` or widened to
`*` (all your tasks).

### 4.1 Request shape

```json
{
	"type": "request",
	"seq": 2,
	"command": "rrext_monitor",
	"arguments": {
		"types": ["TASK", "SUMMARY", "FLOW", "OUTPUT", "SSE"],
		"projectId": "<uuid>", // OR omit and use token below
		"source": "<source-id>", // pairs with projectId
		"pipeId": 0 // optional, narrows to one pipe
	},
	"token": "${TASK_TOKEN}" // OR use projectId+source above
}
```

The `types` array accepts case-insensitive strings of the `EVENT_TYPE` enum.
Valid values:

| String      | Bit | What you get                                                                      |
| ----------- | --- | --------------------------------------------------------------------------------- |
| `NONE`      | 0   | Unsubscribe (clears the registry entry)                                           |
| `DEBUGGER`  | 1   | DAP debug protocol passthrough (stopped, threads, etc.)                           |
| `DETAIL`    | 2   | Real-time per-object processing updates                                           |
| `SUMMARY`   | 4   | Periodic full `TASK_STATUS` snapshots — best for dashboards                       |
| `OUTPUT`    | 8   | Engine log/output lines                                                           |
| `FLOW`      | 16  | Pipeline component flow events (requires `pipelineTraceLevel` on execute, see §5) |
| `TASK`      | 32  | Lifecycle: `running`, `begin`, `end`, `restart`                                   |
| `SSE`       | 64  | Custom node-to-UI messages emitted by nodes via `monitorSSE()`                    |
| `DASHBOARD` | 128 | Server-level events (connections, monitor changes)                                |
| `ALL`       | 255 | Everything above                                                                  |

You may also send the bitmask as an integer (`"types": 36` = SUMMARY|TASK).

### 4.2 Subscription scopes

| Scope                      | Set with                          | Receives                                                  |
| -------------------------- | --------------------------------- | --------------------------------------------------------- |
| One running task           | `token`                           | Events for that task only                                 |
| One pipeline (any run)     | `projectId` + `source`            | Events for that project+source, even across restarts      |
| One pipe within a pipeline | `projectId` + `source` + `pipeId` | Events for that one pipe                                  |
| All sources in a project   | `projectId` + `source: "*"`       | Project-wide                                              |
| All your tasks             | `token: "*"`                      | Everything you own (recommended for an ingestion service) |

### 4.3 Recommended subscription for an agents-database ingester

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

This gives you lifecycle, full status snapshots, component traces, log lines,
and node-emitted events for every pipeline your API key triggers.

### 4.4 Replay-on-subscribe behavior

When you turn on `TASK`, the server immediately replies with one
`apaevt_task` event with `action: "running"` listing currently-active tasks.

When you turn on `SUMMARY`, the server immediately sends an `apaevt_status_update`
with the current `TASK_STATUS` (or an empty "Not running" placeholder).

So you do not need to poll for initial state — subscribing seeds it.

### 4.5 Important: enabling FLOW traces

`apaevt_flow` events are only forwarded when the _task_ was started with a
`pipelineTraceLevel`. If you don't control the executor, FLOW events for that
run will be silent. Possible values when starting a pipeline (`execute` /
`use`):

| Level            | Captured                         |
| ---------------- | -------------------------------- |
| `none` (default) | No flow traces                   |
| `metadata`       | Component/lane structure only    |
| `summary`        | Lane writes and final results    |
| `full`           | Every lane write and invoke call |

If your service is the executor, pass `pipelineTraceLevel: "summary"` (good
default — captures inputs/outputs without per-call noise).

---

## 5. Event payload schemas

Authoritative type definitions live at:

- Python: `packages/client-python/src/rocketride/types/events.py`
- Python: `packages/client-python/src/rocketride/types/task.py`
- TypeScript: `packages/client-typescript/src/client/types/events.ts`
- TypeScript: `packages/client-typescript/src/client/types/task.ts`

### 5.1 `apaevt_task` — lifecycle (subscribe to `TASK`)

`body` is one of:

```ts
// Initial snapshot, sent once on subscription
{ action: "running", tasks: [{ id: string, projectId: string, source: string }] }

// Task started
{ action: "begin", name: string, projectId: string, source: string }

// Task ended (completed or terminated)
{ action: "end", name: string, projectId: string, source: string }

// Task restarted
{ action: "restart", name: string, projectId: string, source: string }
```

There is **no per-event task `id` or token in begin/end** — correlate by
`projectId` + `source`. Use `running` for the id↔project+source map at
subscription time.

### 5.2 `apaevt_status_update` — periodic full status (subscribe to `SUMMARY`)

`body` is a `TASK_STATUS` (Pydantic model). Key fields:

```ts
{
  // Identity
  name: string,
  project_id: string,
  source: string,

  // Lifecycle
  state: 0 | 1 | 2 | 3 | 4 | 5 | 6,   // NONE/STARTING/INITIALIZING/RUNNING/STOPPING/COMPLETED/CANCELLED
  completed: boolean,
  startTime: number,                  // unix seconds, float
  endTime: number,                    // unix seconds, float
  debuggerAttached: boolean,
  serviceUp: boolean,

  // Current activity
  status: string,                     // human-readable status line
  currentObject: string,
  currentSize: number,

  // Counts
  totalCount: number, completedCount: number, failedCount: number,
  totalSize:  number, completedSize:  number, failedSize:  number,
  wordsCount: number, wordsSize: number,

  // Rates (instantaneous)
  rateCount: number, rateSize: number,

  // History (last 50 each)
  errors:   string[],
  warnings: string[],
  notes:    (string | object)[],

  // Termination
  exitCode: number, exitMessage: string,

  // Pipeline flow snapshot
  pipeflow: {
    totalPipes: number,
    byPipe: { [pipeId: number]: string[] }   // active component stack per pipe
  },

  // Resource metrics (per-process, normalized)
  metrics: {
    cpu_percent: number, cpu_memory_mb: number, gpu_memory_mb: number,
    peak_cpu_percent: number, peak_cpu_memory_mb: number, peak_gpu_memory_mb: number,
    avg_cpu_percent:  number, avg_cpu_memory_mb:  number, avg_gpu_memory_mb:  number
  },

  // Cumulative billing tokens (100 tokens = $1)
  tokens: {
    cpu_utilization: number, cpu_memory: number, gpu_memory: number, total: number
  }
}
```

`state` enum mapping:
`0=NONE, 1=STARTING, 2=INITIALIZING, 3=RUNNING, 4=STOPPING, 5=COMPLETED, 6=CANCELLED`.

### 5.3 `apaevt_flow` — per-pipe execution trace (subscribe to `FLOW`)

```ts
{
  id: number,                                  // pipe index within the pipeline
  op: "begin" | "enter" | "leave" | "end",
  pipes: string[],                             // current component stack for this pipe
  trace: {                                     // shape depends on pipelineTraceLevel
    lane?: string,
    data?: object,                             // input/intermediate data
    result?: string,                           // output data / serialized result
    error?: string
  },
  result?: PIPELINE_RESULT,                    // present when op==="end" and level >= summary
  project_id: string,
  source: string
}
```

This is the data that lets you reconstruct _why_ a pipeline produced what it
produced: each component entry/exit with its lane data and any error.

### 5.4 `apaevt_sse` — node-to-UI passthrough (subscribe to `SSE`)

Nodes can call `monitorSSE(pipe_id, type, data)` to broadcast custom updates
("thinking", "tool_call", progress, etc.). Body shape:

```ts
{
  pipe_id: number,
  type: string,        // node-defined event type
  data: object         // node-defined payload
}
```

Schema is intentionally open — interpret per node type.

### 5.5 Output / log lines (subscribe to `OUTPUT`)

The original DAP `output` events from the engine are re-emitted to subscribers
under `EVENT_TYPE.OUTPUT`. The body carries an `output` string field plus
DAP-standard fields (`category`, etc., from the underlying debugger output
event).

### 5.6 `apaevt_status_upload` — file upload progress

```ts
{
  action: "begin" | "write" | "complete" | "error",
  filepath: string,
  bytes_sent?: number,
  file_size?: number,
  ...
}
```

### 5.7 `apaevt_dashboard` — server admin events (subscribe to `DASHBOARD`)

Connection lifecycle, monitor-change audit events, etc. Useful if you want to
record _who_ subscribed/unsubscribed to monitors (operator-level audit).

---

## 6. Out-of-band: synchronous HTTP for one-off queries

If you don't want a persistent WebSocket and just want to poll, the HTTP REST
surface is:

| Method   | Path                   | Auth   | Purpose                                                                                            |
| -------- | ---------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `GET`    | `/ping`                | public | Liveness                                                                                           |
| `GET`    | `/version`             | public | Server version                                                                                     |
| `GET`    | `/status`              | Bearer | Server uptime / version / startTime                                                                |
| `POST`   | `/task`                | Bearer | Start a pipeline. Body = pipeline config. Query: `token?`, `threads`, `trace`. Returns `{ token }` |
| `GET`    | `/task?token=<t>`      | Bearer | Returns the same `TASK_STATUS` shape as `apaevt_status_update`                                     |
| `DELETE` | `/task?token=<t>`      | Bearer | Cancel                                                                                             |
| `POST`   | `/task/data?token=<t>` | Bearer | Send data payload to a running task                                                                |
| `POST`   | `/webhook?token=<t>`   | Bearer | Alias for `/task/data`                                                                             |

These all use `Authorization: Bearer <api-key>`.

There is no streaming HTTP endpoint (no SSE route, no `/logs` endpoint). For
streaming you must use the WebSocket DAP path.

---

## 7. DAP commands you may need (besides `rrext_monitor`)

Sent the same way as `rrext_monitor`:

| Command                 | `arguments`                                                                      | Returns          | Purpose                            |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------- | ---------------------------------- |
| `auth`                  | `{ auth, clientName?, clientVersion? }`                                          | `{ success }`    | Required first message             |
| `rrext_get_task_status` | — (uses `token`)                                                                 | `TASK_STATUS`    | Fetch current status synchronously |
| `rrext_get_token`       | `{ projectId, source }`                                                          | `{ token }`      | Resolve a running task's token     |
| `execute`               | `{ pipeline, token?, threads?, args?, useExisting?, ttl?, pipelineTraceLevel? }` | `{ token, ... }` | Start a pipeline                   |
| `terminate`             | — (uses `token`)                                                                 | —                | Stop a running pipeline            |

---

## 8. Reference SDKs

If you'd rather not implement DAP-over-WebSocket from scratch, two first-party
clients exist in this repo and ship to npm/PyPI:

- Python: `pip install rocketride` — `RocketRideClient(uri, auth, on_event=...)`,
  then `await client.add_monitor(key={'token': '*'}, types=['summary','flow','task','output','sse'])`.
- TypeScript: `@rocketride/client` — same shape.

Both let you pass an `on_event` async callback that fires for every inbound
event message. Source: `packages/client-python/src/rocketride/` and
`packages/client-typescript/src/client/`.

---

## 9. Recommended ingestion design for the agents database

1. Open one long-lived WebSocket to `ws://<rocketride-host>:5565/task/service`.
2. Send `auth` with the service-account API key.
3. Send `rrext_monitor` with `token: "*"` and
   `types: ["TASK", "SUMMARY", "FLOW", "OUTPUT", "SSE"]`.
4. For every inbound `event` message, switch on `event` and write to your DB:
   - `apaevt_task` → `pipeline_runs` (insert on `begin`, update on `end`,
     reconcile from `running` snapshot at startup).
     by `(project_id, source, startTime)`.
   - `apaevt_flow` → append to `pipeline_run_traces` keyed by
     `(project_id, source, id /*pipe*/, op, seq)`. Store `trace.data`,
     `trace.result`, `trace.error` as JSONB.
   - `apaevt_sse` → append to `pipeline_run_node_events`.
   - `output` events → append to `pipeline_run_logs`.
5. Correlate runs: there is no global run-id. Use
   `(project_id, source, startTime)` from `TASK_STATUS` as the run key, or
   capture the `token` from `running`/`apaevt_task` and your own `execute`
   responses.
6. Reconnect on disconnect; the SDK handles auto-resubscribe of monitors,
   and the next `running` snapshot will let you reconcile any missed
   `begin`/`end` you slept through.
7. If you need full per-component data flow, ensure pipelines are launched
   with `pipelineTraceLevel: "summary"` (or `"full"` for debugging). Without
   it `apaevt_flow` does not fire.

---

## 10. Things to NOT assume

- There is no built-in dead-letter queue — if your ingester is offline, you
  miss events for that window. The next `apaevt_task` `running` snapshot is
  your only crash-recovery handle.
- There is no `event_id` / global ordering key. Use the DAP envelope `seq`
  (per-connection monotonic) plus your own ingest timestamp.
- `apaevt_flow` `trace` is a free-form dict; schema varies by node and trace
  level. Store as JSONB, do not flatten.
- `errors` and `warnings` arrays in `TASK_STATUS` are capped at 50 entries
  each — you must persist them as they appear or you'll lose older ones on
  long runs.
- Monitor subscriptions are per-connection, not durable server-side. Reconnect
  → resubscribe.
