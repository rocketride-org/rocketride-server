---
title: Choose How to Run RocketRide
sidebar_label: Choose How to Run
---

# Choose How to Run RocketRide

One engine, two ways to run it: point your clients at managed
[RocketRide Cloud](/operate/cloud), or [run the engine
yourself](/operate/self-hosting). The pipeline JSON is identical either way —
the same `.pipe` file runs unchanged against Cloud or your own engine, so the
choice is operational, not architectural, and you can switch later.

|          | [Cloud](/operate/cloud)           | [Self-hosting](/operate/self-hosting)  |
| -------- | --------------------------------- | -------------------------------------- |
| Engine   | Managed for you                   | You run it (Docker / on-prem)          |
| Endpoint | `https://api.rocketride.ai`       | `ws://localhost:5565` (or your host)   |
| Auth     | API token required                | Optional locally                       |
| Best for | Getting started, hosted workloads | Private data, full control, air-gapped |

While you build, there is a third option that is really the second in disguise:
the [VS Code extension](/clients/vscode) deploys and manages a **local engine**
for you — self-hosting without the setup, ideal for the inner loop.

## Related

- [Cloud](/operate/cloud): connect a client to the managed endpoint.
- [Self-hosting](/operate/self-hosting): download, run, and secure your own engine.
- [Security](/operate/security): credentials, ports, and TLS.
