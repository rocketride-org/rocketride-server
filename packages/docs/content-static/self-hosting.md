---
title: Self-hosting
---

# Self-hosting

Run the RocketRide [engine](/concepts/runtime-engine) on your own
infrastructure — your laptop, a server, or inside a private network — when you
need full control over where data and model calls go. It is the same engine that
powers [Cloud](/cloud); only the operator changes.

## The endpoint

A self-hosted engine listens for the [WebSocket protocol](/protocols/websocket)
on port **5565**. Locally that is:

```bash
ROCKETRIDE_URI=ws://localhost:5565
```

Point any [SDK](/develop/typescript) or the [CLI](/cli) at that URI. A local
engine typically needs no auth token; expose it beyond localhost and you should
put it behind TLS and authentication.

## Running the engine

The fastest path to a local engine is the [VS Code
extension](/ide-extensions/overview), which manages a runtime for you while you
build. To run it as a standalone service — for a server or CI — use the
containerized engine and publish port 5565:

```bash
docker run -p 5565:5565 <rocketride-engine-image>
```

## Provider credentials

Pipelines that call external models or stores need those providers' API keys.
Supply them as environment variables in the engine's environment (never commit
them); a node's `config` references the variable rather than the literal secret.
See [Nodes](/nodes) for each provider's required keys.

## Related

- [Cloud](/cloud) — the managed alternative.
- [WebSocket protocol](/protocols/websocket) — what clients speak to the engine.
- [Runtime & engine](/concepts/runtime-engine) — what the engine does with a
  pipeline.
