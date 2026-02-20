# RocketRide Client API Reference

API reference for the official **TypeScript** and **Python** clients. Both talk to the RocketRide server over **DAP (Debug Adapter Protocol) on WebSocket** and offer the same capabilities.

---

## Overview

- **Connect** with an API key; optional automatic reconnection (persist mode).
- **Pipelines**: start with `use()`, get a token, then send data via `send()`, `sendFiles()` / `send_files()`, or `pipe()`.
- **Chat** with AI via `chat()` and a `Question` object.
- **Lifecycle**: `onConnected` / `on_connected`, `onDisconnected` / `on_disconnected`, `onConnectError` / `on_connect_error`, `onEvent` / `on_event`.
- **Timeouts**: per-request timeout; optional max retry time for reconnects.

URIs: clients accept `http`/`https` or `ws`/`wss` and convert to WebSocket (`http`→`ws`, `https`→`wss`) when needed.

---

## Client docs

| Client | Document |
|--------|----------|
| **TypeScript** (`@rocketride/client-typescript`) | [Package README](../../packages/client-typescript/README.md) — full API reference is installed with the package. |
| **Python** (`rocketride-client-python`) | [README-python.md](README-python.md) |

Each document lists every constructor option, method, and type for that client.
