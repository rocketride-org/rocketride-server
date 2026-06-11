---
title: WebSocket
---

# WebSocket protocol

The RocketRide [engine](/concepts/runtime-engine) speaks a native **WebSocket**
protocol. Every consumer — the [TypeScript](/develop/typescript) and
[Python](/develop/python) SDKs and the [MCP server](/protocols/mcp) — connects
over this one socket to start pipelines and stream results. You rarely touch it
directly; the SDKs frame the messages for you.

## Connection

- **Endpoint:** `ws://<host>:<port>`. The engine listens on port **5565** by
  default, so a local engine is `ws://localhost:5565`.
- **Cloud:** managed engines are reached at `https://api.rocketride.ai`; the
  client upgrades to a WebSocket from there. See [Cloud](/cloud).
- **Encoding:** JSON messages framed per the engine protocol.
- **Auth:** supply the engine URI and an API token through the client's
  configuration (`ROCKETRIDE_URI` and `ROCKETRIDE_AUTH`). Cloud requires a
  token; a local engine typically does not.

The default port is applied only when the URI omits one — point the client at a
different host or port to reach a remote or self-hosted engine.

## Keepalive & timeouts

The connection is long-lived: a pipeline stays open while it streams. The SDK
clients keep it healthy with WebSocket pings.

| Setting             | Default | Meaning                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| Ping interval       | 15 s    | How often a ping frame is sent.                         |
| Ping timeout        | 60 s    | No pong within this window → the connection is closed.  |
| Idle/socket timeout | 180 s   | No communication within this window → treated as stale. |

## What flows over the socket

A typical session, all on the same connection:

1. **Start** a pipeline — the SDK's `use()` loads a `.pipe` definition on the
   engine and returns a handle.
2. **Feed** it data — `send()` / `pipe()` push input; `chat()` drives a
   conversational, streaming exchange.
3. **Stream** results back — the engine emits output as nodes produce it, so
   responses arrive incrementally rather than in one block (see the
   [Execution model](/concepts/execution-model)).
4. **Stop** — `terminate()` ends the pipeline and releases its resources.

The pipeline JSON sent over the socket is identical to the JSON you author
visually or by hand — the protocol just transports it.

## Related

- [MCP](/protocols/mcp) — pipelines-as-tools for AI assistants, transported over
  this socket.
- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python) — the
  clients that speak this protocol.
- [Pipeline JSON reference](/pipeline-reference) — the `.pipe` payload shape.
- [Execution model](/concepts/execution-model) — how a run streams once started.
