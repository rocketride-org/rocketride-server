---
title: WebSocket
---

# WebSocket protocol

The RocketRide [engine](/concepts/runtime-engine) speaks a native **WebSocket**
protocol. Every consumer (the [TypeScript](/develop/typescript) and
[Python](/develop/python) SDKs and the [MCP server](/protocols/mcp)) connects
over this one socket to start pipelines and stream results. You rarely touch it
directly; the SDKs frame the messages for you. This page documents what they
send so you can debug, trace, or build your own client.

## Connection

- **Endpoint:** `ws://<host>:<port>/task/service`. The engine listens on port
  **5565** by default, so a local engine is `ws://localhost:5565/task/service`.
- **Cloud:** managed engines are reached at `https://api.rocketride.ai`; the
  client upgrades to a WebSocket from there. See [Cloud](/cloud).
- **Encoding:** JSON messages framed per the engine protocol (described below).
- **Auth:** the first frame on the socket is an `auth` request carrying your API
  key (`{ "auth": "$ROCKETRIDE_APIKEY", "clientName": "...", "clientVersion": "..." }`);
  the SDKs read the key from the `ROCKETRIDE_APIKEY` env var (engine URI from
  `ROCKETRIDE_URI`). If `auth` fails the request errors. Once authenticated, each
  task request carries the task `token` returned by `open` in its `arguments`.
  Cloud requires a key; a local engine typically does not.

The default port is applied only when the URI omits one, point the client at a
different host or port to reach a remote or self-hosted engine.

### Pre-auth probe (`rrext_public_probe`)

Before authenticating, a client may open a public connection and send
`rrext_public_probe`. The response body carries `version`, `capabilities`,
`platform`, the public `apps` list, `stripePublishableKey` (when billing is
configured), and `endpoints` — the server's public addresses:

```json
{ "endpoints": { "api": "origin", "ui": "origin" } }
```

Each value is an absolute URL or the literal `origin`, meaning "the address
you probed me at" (the SDKs substitute it client-side before returning, so
callers always see absolute URLs). The server reads `RR_BACKEND_ORIGIN` /
`RR_FRONTEND_ORIGIN` for the two values; unset means `origin`, correct for
any single-host deployment. They differ only on split deployments — e.g. a
CDN-served UI whose live traffic should connect directly to the API host.

## Message format

The engine protocol is a DAP-style (Debug Adapter Protocol) message exchange.
Every frame is a JSON object with a `type` of `request`, `response`, or `event`,
and a monotonically increasing `seq` used to correlate replies with the requests
that triggered them.

### Requests

The client sends a **request** naming a `command`. Arguments (including the auth
`token`) travel in `arguments`; raw file bytes, when a command carries a
payload, travel in `data`.

```json
{
	"type": "request",
	"seq": 1,
	"command": "rrext_process",
	"arguments": { "subcommand": "open", "token": "$ROCKETRIDE_APIKEY" }
}
```

### Responses

The engine answers each request with a **response** that echoes the original
`command` and points back at the request via `request_seq`. `success` tells you
whether the command worked; a successful response carries a `body`.

```json
{
	"type": "response",
	"seq": 2,
	"request_seq": 1,
	"command": "rrext_process",
	"success": true,
	"body": { "task": "<task-id>" }
}
```

On failure, `success` is `false` and the frame carries a `message` plus a
`trace` (`file`, `lineno`) instead of a body. A failure the engine can name
also carries a machine-readable `code`:

```json
{
	"type": "response",
	"seq": 2,
	"request_seq": 1,
	"command": "rrext_process",
	"success": false,
	"message": "Your pipeline is not running",
	"code": "TASK_NOT_REGISTERED",
	"trace": { "file": "task_server.py", "lineno": 722 }
}
```

`message` is written for a person and may be reworded or translated; `code` is
the contract. Classify a failure on `code` and never on the message text.
Absent `code`, the failure has no named class — treat it as unclassified rather
than inferring one from the prose.

| `code` | Meaning |
| --- | --- |
| `TASK_NOT_REGISTERED` | The token, public key or project/source names no live task: never started, terminated, replaced by another client, or the engine restarted (the task registry is in-memory and rebuilt at boot, so every previously issued token is invalid after a restart). |
| `TASK_AMBIGUOUS` | An unscoped lookup matched several running tasks; retry with a scope. |
| `TASK_COMPLETED` | The task finished before the request could be served. |
| `TASK_STOPPED` | The task was stopped or cancelled before the request. |

These codes ride command replies. A task key rejected while the connection is
still being established — on the HTTP request or the WebSocket upgrade — is
answered by the web layer with a generic `400 Bad request` carrying neither a
message nor a code, deliberately, so that a rejected credential reveals nothing
about why it was rejected. A client therefore cannot tell an invalidated task
key from any other bad credential at connect time; the codes above appear only
once a command is in flight.

### Events

The engine pushes **events** that are not replies to any request: this is how
pipeline output streams back. An event names an `event` and carries a `body`;
the client matches it to the task it started.

```json
{ "type": "event", "seq": 7, "event": "data", "body": { "lane": "answers", "text": "..." } }
```

The engine can also push a dedicated monitoring stream (task lifecycle, periodic
status snapshots, resource metrics, and per-component flow traces) over this same
socket. See [Observability](/protocols/websocket/observability).

## A session, end to end

A typical run is one request/response/event conversation over a single open
socket, opened with the `auth` handshake above. The SDK methods map onto engine
commands:

1. **Start**: `use()` opens a task on a running pipeline
   (`rrext_process` / `open`) and gets back a task id.
2. **Feed**: `send()` / `pipe()` push input (`rrext_process` / `write`), with
   file bytes in the request's `data` field; `chat()` drives a streaming,
   conversational exchange.
3. **Stream**: the engine emits `event` frames as nodes produce output, so
   responses arrive incrementally rather than in one block (see the
   [Execution model](/concepts/execution-model)).
4. **Stop**: `terminate()` closes the task (`rrext_process` / `close`) and
   releases its resources.

The pipeline JSON sent over the socket is identical to the JSON you author
visually or by hand, the protocol just transports it.

## MIME type selects the lane

Every write carries a MIME type — the `mimeType` argument of `rrext_process` /
`open`, which the HTTP `/webhook/{project_id}/{source}` route fills in from the
request's `Content-Type` header. That MIME type is **routing, not metadata**: it
picks which lane the body is delivered on.

The choice is made against the pipeline's live wiring, not a fixed table. A
branch is taken only when the MIME type matches **and** some component actually
reads that lane; anything unmatched falls through to the raw/tags lane.

| MIME type | Lane, when a component reads it |
| --- | --- |
| `application/json` | `json` |
| `text/*` | `text` |
| `image/*`, `video/*`, `audio/*` | `image`, `video`, `audio` |
| `application/rocketride-question+json` | `questions` |
| `application/rocketlib-tag` | `tags` |
| anything else, or no reader above | raw, delivered on `tags` |

The prefix `lane/<name>` bypasses detection and targets a lane directly.

### When nothing reads the chosen lane

The write still succeeds. The object is accepted, counted as completed and
answered `200 OK`; only `resultTypes` comes back empty, because no component
received the body. Nothing about the response, the HTTP log line or the task
counters distinguishes this from a successful run.

Because that outcome is indistinguishable from success, the engine emits a task
**warning** naming the lane the data went to and the lanes the pipeline reads.
It is a warning rather than an error: a source may legitimately offer several
lanes while a pipeline wires up one, so an unread lane is not by itself a fault
— but *this object reaching nobody* is never what the sender intended, and the
warning is the only signal that separates the two.

Read the warnings from `get_task_status(token)['warnings']`, or subscribe to
`apaevt_status_warning` (see [Observability](/protocols/websocket/observability)).

Note that the mismatch is symmetric: `text/plain` into a pipeline whose first
component reads `json` fails exactly the way `application/json` fails into a
`text`-first one. There is no single header that is correct for every pipeline,
which is why the endpoint panel offers one example per lane and preselects the
one the running pipeline reads.

## Keepalive & timeouts

The connection is long-lived: a task stays open while it streams. The SDK
clients keep it healthy with WebSocket pings and a periodic `rrext_ping`
command.

| Setting             | Default | Meaning                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| Ping interval       | 15 s    | How often a ping frame is sent.                         |
| Ping timeout        | 60 s    | No pong within this window → the connection is closed.  |
| Idle/socket timeout | 180 s   | No communication within this window → treated as stale. |

## Related

- [Observability](/protocols/websocket/observability): monitoring events and
  metrics over this socket.
- [MCP](/protocols/mcp): pipelines-as-tools for AI assistants, transported over
  this socket.
- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python): the
  clients that speak this protocol.
- [Pipeline JSON Reference](/pipeline-reference): the `.pipe` payload shape.
- [Execution model](/concepts/execution-model): how a run streams once started.
