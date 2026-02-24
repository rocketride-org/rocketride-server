# RocketRide Client Libraries

Official client libraries for the RocketRide Engine. The TypeScript and Python clients communicate with the server over DAP (Debug Adapter Protocol) on WebSocket and offer the same capabilities. The MCP client provides AI assistant integration via the Model Context Protocol.

---

## Overview

- **Connect** with an API key; optional automatic reconnection (persist mode).
- **Pipelines**: start with `use()`, get a token, then send data via `send()`, `sendFiles()` / `send_files()`, or `pipe()`.
- **Chat** with AI via `chat()` and a `Question` object.
- **Lifecycle**: `onConnected` / `on_connected`, `onDisconnected` / `on_disconnected`, `onConnectError` / `on_connect_error`, `onEvent` / `on_event`.
- **Timeouts**: per-request timeout; optional max retry time for reconnects.

URIs: clients accept `http`/`https` or `ws`/`wss` and convert to WebSocket (`http` to `ws`, `https` to `wss`) when needed.

---

## Client SDK Documentation

| Client         | Package          | Document                                                   |
| -------------- | ---------------- | ---------------------------------------------------------- |
| **TypeScript** | `rocketride`     | [README-typescript-client.md](README-typescript-client.md) |
| **Python**     | `rocketride`     | [README-python-client.md](README-python-client.md)         |
| **MCP**        | `rocketride-mcp` | [README-mcp-client.md](README-mcp-client.md)               |

Each document lists every constructor option, method, type, and usage example for that client.

---

## Installation

### From PyPI / npm (public registry)

```bash
# TypeScript
npm install rocketride

# Python
pip install rocketride

# MCP
pip install rocketride-mcp
```

### From the Engine (self-hosted download)

The engine serves the latest client packages via HTTP endpoints. Once the server is running, download them directly:

| Endpoint                 | Package                | Response                                |
| ------------------------ | ---------------------- | --------------------------------------- |
| `GET /client/python`     | Python SDK wheel       | `rocketride-{version}-py3-none-any.whl` |
| `GET /client/typescript` | TypeScript SDK tarball | `rocketride-{version}.tgz`              |
| `GET /client/vscode`     | VSCode extension       | `rocketride-{version}.vsix`             |

```bash
# Download and install Python client
curl -O http://localhost:5565/client/python
pip install rocketride-*.whl

# Download and install TypeScript client
curl -O http://localhost:5565/client/typescript
npm install rocketride-*.tgz

# Download and install VSCode extension
curl -O http://localhost:5565/client/vscode
code --install-extension rocketride-*.vsix
```

These endpoints are public (no authentication required) and automatically serve the latest version. Returns 404 with a JSON error if packages are not found.

---

## License

MIT License -- see [LICENSE](../LICENSE).
