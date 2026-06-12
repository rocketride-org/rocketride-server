---
title: Cloud
---

# Cloud

RocketRide Cloud is a managed [engine](/concepts/runtime-engine): the same
runtime you can [self-host](/self-hosting), operated for you. Instead of running
the engine yourself, you point a client at the Cloud endpoint and start building
pipelines, no infrastructure to provision.

## Connecting

Set two values and any [SDK](/develop/typescript) or the [CLI](/cli) connects:

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
> [WebSocket protocol](/protocols/websocket).

## Cloud vs. self-hosting

|          | Cloud                             | [Self-hosting](/self-hosting)          |
| -------- | --------------------------------- | -------------------------------------- |
| Engine   | Managed for you                   | You run it (Docker / on-prem)          |
| Endpoint | `https://api.rocketride.ai`       | `ws://localhost:5565` (or your host)   |
| Auth     | API token required                | Optional locally                       |
| Best for | Getting started, hosted workloads | Private data, full control, air-gapped |

The pipeline JSON is identical either way: the same `.pipe` file runs unchanged
against Cloud or your own engine.

## Related

- [Quickstart](/quickstart): run your first pipeline.
- [Self-hosting](/self-hosting): run the engine yourself.
- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python) ·
  [CLI](/cli): clients that connect to Cloud.
