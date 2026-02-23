# RocketRide Client API Reference

API reference for the official **TypeScript**, **Python**, and **MCP** clients. The TypeScript and Python clients talk to the RocketRide server over **DAP (Debug Adapter Protocol) on WebSocket** and offer the same capabilities. The MCP client provides AI assistant integration via the Model Context Protocol.

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
| **TypeScript** (`rocketride`) | [Package README](../../packages/client-typescript/README.md) — full API reference is installed with the package. |
| **Python** (`rocketride-client-python`) | [README-python.md](README-python.md) |
| **MCP** (`rocketride-mcp`) | [Package README](../../packages/client-mcp/README.md) — MCP stdio server for AI assistant integration. |

Each document lists every constructor option, method, and type for that client.

---

## MCP Client

The MCP (Model Context Protocol) client (`rocketride-mcp`) enables AI assistants like Claude to interact with the RocketRide Engine directly. It runs as an MCP stdio server that:

- Dynamically discovers tools from the RocketRide server
- Provides a bundled document-parsing pipeline convenience tool
- Streams local files to RocketRide EaaS for processing

### Configuration

The MCP client is configured via environment variables:

| Variable | Description |
|----------|-------------|
| `ROCKETRIDE_URI` | Server URI (e.g. `http://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key for authentication |
| `ROCKETRIDE_AUTH` | Alternative auth token |

### Installation

```bash
pip install rocketride-mcp
```

### Usage

```bash
rocketride-mcp
```

See the [MCP client README](../../packages/client-mcp/README.md) for full details.
