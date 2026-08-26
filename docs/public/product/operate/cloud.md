---
title: Cloud
---

# Cloud

RocketRide Cloud is a managed [engine](/concepts/runtime-engine): the same
runtime you can [self-host](/operate/self-hosting), operated for you. Instead of running
the engine yourself, you point a client at the Cloud endpoint and start building
pipelines, no infrastructure to provision.

## Connecting

Set two values and any [SDK](/clients/typescript) or the [CLI](/connect/cli) connects:

| Variable          | Value                                            |
| ----------------- | ------------------------------------------------ |
| `ROCKETRIDE_URI`  | `https://api.rocketride.ai`                      |
| `ROCKETRIDE_AUTH` | Your API token (`ROCKETRIDE_APIKEY` also works). |

```bash
ROCKETRIDE_URI=https://api.rocketride.ai
ROCKETRIDE_AUTH=your-api-token
```

> **Always use `https://` or `wss://` for Cloud.** An `http://`, `ws://`, or
> bare `host:port` URI silently downgrades to an unencrypted connection. The
> secure scheme upgrades to `wss://` under the hood, see the
> [WebSocket protocol](/connect/websocket).

Weighing Cloud against running the engine yourself? The comparison lives on
[Choose How to Run RocketRide](/operate).

## Related

- [Quickstart](/quickstart): run your first pipeline.
- [Choose How to Run RocketRide](/operate): Cloud vs. self-hosting.
- [Self-hosting](/operate/self-hosting): run the engine yourself.
- [TypeScript SDK](/clients/typescript) · [Python SDK](/clients/python) ·
  [CLI](/connect/cli): clients that connect to Cloud.
