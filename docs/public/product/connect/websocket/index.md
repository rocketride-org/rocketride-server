---
title: WebSocket
---

# WebSocket protocol

The RocketRide [engine](/concepts/runtime-engine) speaks a native **WebSocket**
protocol. Every consumer (the [TypeScript](/clients/typescript) and
[Python](/clients/python) SDKs and the [MCP server](/connect/mcp/stdio)) connects
over this one socket to start pipelines and stream results. You rarely touch it
directly; the SDKs frame the messages for you. This page documents what they
send so you can debug, trace, or build your own client.

## Connection

- **Endpoint:** `ws://<host>:<port>/task/service`. The engine listens on port
  **5565** by default, so a local engine is `ws://localhost:5565/task/service`.
- **Cloud:** managed engines are reached at `https://api.rocketride.ai`; the
  client upgrades to a WebSocket from there. See [Cloud](/operate/cloud).
- **Encoding:** JSON messages framed per the engine protocol (described below).
- **Auth:** the first frame on the socket is an `auth` request carrying your API
  key (`{ "auth": "$ROCKETRIDE_APIKEY", "clientName": "...", "clientVersion": "..." }`);
  the SDKs read the key from the `ROCKETRIDE_APIKEY` env var (engine URI from
  `ROCKETRIDE_URI`). If `auth` fails the request errors. Once authenticated, each
  task request carries the task `token` returned by `execute` (the SDK's `use()`)
  in its `arguments`.
  Cloud requires a key; a local engine typically does not.

The default port is applied only when the URI omits one, point the client at a
different host or port to reach a remote or self-hosted engine.

## Message format

The engine protocol is a DAP-style (Debug Adapter Protocol) message exchange.
Every frame is a JSON object with a `type` of `request`, `response`, or `event`,
and a monotonically increasing `seq` used to correlate replies with the requests
that triggered them.

### Requests

The client sends a **request** naming a `command`. Arguments (including the auth
`token`) travel in `arguments`; raw file bytes, when a command carries a
payload, travel in `data` -- but never as an in-JSON value. The SDK strips
`data` out of `arguments`, appends a single `\n` byte after the JSON header,
then the raw bytes, so the frame on the wire is `<json-header>\n<binary-payload>`.

```json
{
	"type": "request",
	"seq": 1,
	"command": "rrext_process",
	"arguments": { "subcommand": "open", "object": "...", "mimeType": "...", "provider": "...", "token": "$TASK_TOKEN" }
}
```

This particular request -- opening a data pipe -- carries the task's own
`token` (returned by `execute`): a pipe is always opened on an already-running
task. Every request on the pipe (`write`, `close`, ...) carries that same
`token` in `arguments`, for example:

```json
{
	"type": "request",
	"seq": 3,
	"command": "rrext_process",
	"arguments": { "subcommand": "write", "pipe_id": 1, "token": "$TASK_TOKEN" }
}
```

followed immediately by the `\n` byte and the raw payload bytes -- `data` never
appears in the JSON itself.

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
	"body": { "pipe_id": 1 }
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
{ "type": "event", "seq": 7, "event": "apaevt_sse", "body": { "pipe_id": 1, "type": "...", "data": {} } }
```

The engine can also push a dedicated monitoring stream (task lifecycle, periodic
status snapshots, resource metrics, and per-component flow traces) over this same
socket. See [Observability](/connect/websocket/observability).

## A session, end to end

A typical run is one request/response/event conversation over a single open
socket, opened with the `auth` handshake above. The SDK methods map onto engine
commands:

1. **Start**: `use()` starts the pipeline (`execute`) and gets back a task
   token.
2. **Feed**: `send()` / `pipe()` push input (`rrext_process` / `write`), with
   file bytes in the request's `data` field; `chat()` drives a streaming,
   conversational exchange.
3. **Stream**: the engine emits `event` frames as nodes produce output, so
   responses arrive incrementally rather than in one block (see the
   [Execution model](/concepts/execution-model)).
4. **Stop**: `terminate()` closes the task (`terminate`) and releases its
   resources; closing a data pipe (`rrext_process` / `close`) returns that
   pipe's result.

The pipeline JSON sent over the socket is identical to the JSON you author
visually or by hand, the protocol just transports it.

## Keepalive & timeouts

The connection is long-lived: a task stays open while it streams. The SDK
clients keep it healthy with WebSocket pings and a periodic `rrext_ping`
command.

| Setting             | Default | Meaning                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| Ping interval       | 15 s    | How often a ping frame is sent.                         |
| Ping timeout        | 60 s (TypeScript) / 300 s (Python) | No pong within this window → the connection is closed. |
| Socket timeout      | 180 s   | Connection open/close timeout in both SDKs; Python also applies it to sends. |

## Related

- [Observability](/connect/websocket/observability): monitoring events and
  metrics over this socket.
- [MCP](/connect/mcp/stdio): pipelines-as-tools for AI assistants, transported over
  this socket.
- [TypeScript SDK](/clients/typescript) · [Python SDK](/clients/python): the
  clients that speak this protocol.
- [Pipeline JSON Reference](/reference/pipeline-reference): the `.pipe` payload shape.
- [Execution model](/concepts/execution-model): how a run streams once started.
