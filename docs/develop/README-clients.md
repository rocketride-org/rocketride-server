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
| **TypeScript** | `rocketride`     | [README-typescript-client.md](../README-typescript-client.md) |
| **Python**     | `rocketride`     | [README-python-client.md](../README-python-client.md)         |
| **MCP**        | `rocketride-mcp` | [README-mcp-client.md](../README-mcp-client.md)               |

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
| `GET /client/python/{filename}` | Python SDK wheel (curl: use `latest`) | `rocketride-{version}-py3-none-any.whl` |
| `GET /client/typescript` | TypeScript SDK tarball | `rocketride-{version}.tgz`              |
| `GET /client/vscode`     | VSCode extension       | `rocketride-{version}.vsix`             |
| `GET /client/shell`      | Shell platform package | `shell.tgz`                             |
| `GET /client/docs`       | Agent docs bundle      | `docs.zip` (docs + stubs + manifest)    |

All `/client/*` responses carry `Cache-Control: no-cache` so HTTP caches
revalidate instead of serving stale artifacts after a server upgrade.

The agent docs bundle is what `rocketride init` and the VS Code extension
install into a workspace's `.rocketride/docs/` — its `manifest.json` carries a
content hash consumers use as their change stamp, so an unchanged bundle is a
no-op to re-install.

The recommended workspace bootstrap, per language:

```bash
# TypeScript — the init shim, served by the server itself. No arguments
# needed: the shim reads the server from its own install URL, downloads
# that server's client into .rocketride/client/rocketride.tgz, installs
# it as a content-hashed file: dependency, and runs `rocketride init`.
pnpm install http://localhost:5565/client/typescript-init
pnpm exec typescript-init

# Python — install the server's wheel by its concrete filename (pip
# requires the .whl name in the URL), then init:
pip install http://localhost:5565/client/python/rocketride-1.3.0-py3-none-any.whl
rocketride init
```

Once the `rocketride` package is published to npmjs/PyPI, the public
bootstrap is simply `pnpm add rocketride` / `pip install rocketride`
followed by `rocketride init`; the forms above remain the self-hosted
path. Re-running `typescript-init` / `rocketride init` is the update
path — the client and workspace refresh against the connected server.

Two direct-URL forms to avoid, both verified broken:

- `pnpm add http://.../client/typescript` — pnpm caches URL tarballs by
  URL and NEVER refetches, so after a server upgrade it silently
  reinstalls the old cached build. The shim's `file:` dependency is
  hashed by content, so a rebuilt server package always installs. (The
  shim itself is safe to cache — it is tiny, stable, and carries no
  server-versioned content.)
- `pip install http://.../client/python/latest` — pip rejects URLs
  without a recognizable archive filename ("neither 'setup.py' nor
  'pyproject.toml' found"). The `/latest` route is for curl/scripting
  only; pip installs use the concrete wheel filename.

```bash
# Download and install Python client (use "latest" as filename for newest version)
curl -o rocketride-latest.whl http://localhost:5565/client/python/latest
pip install rocketride-latest.whl

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

MIT License -- see [LICENSE](../../LICENSE).
