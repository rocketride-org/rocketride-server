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
`trace` (`file`, `lineno`) instead of a body:

```json
{
	"type": "response",
	"seq": 2,
	"request_seq": 1,
	"command": "rrext_process",
	"success": false,
	"message": "Pipeline is not running",
	"trace": { "file": "process.cpp", "lineno": 214 }
}
```

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
