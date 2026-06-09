---
title: WebSocket (5565)
---

# WebSocket protocol (port 5565)

The RocketRide engine exposes a WebSocket interface on port **5565**. Consumer
SDKs (TypeScript, Python) and the MCP server connect over this socket to submit
pipelines and stream results.

:::note
This page is a co-located stub. Expand it from the engine's protocol source in
`packages/server` whenever the wire protocol changes (see the co-located
documentation rule).
:::

## Connection

- **Endpoint:** `ws://<host>:5565`
- **Encoding:** JSON messages framed per the engine protocol.

## Related

- [MCP](/protocols/mcp) — pipelines-as-tools, transported over this socket.
- [Pipeline JSON reference](/pipeline-reference) — the `.pipe` payload shape.
