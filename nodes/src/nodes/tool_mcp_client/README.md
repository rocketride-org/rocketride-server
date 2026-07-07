# tool_mcp_client

A RocketRide tool node that connects to an external [Model Context Protocol](https://modelcontextprotocol.io/) server and exposes its tools to AI agents.

## What it does

Connects to an MCP server over one of three transports (STDIO (local subprocess), Streamable HTTP, or legacy HTTP+SSE), performs the MCP `initialize` handshake, discovers the server's tools via `tools/list` when the pipeline starts, and exposes them to agent nodes. Agents then discover and invoke these tools during their reasoning loop; each call is forwarded to the server as `tools/call` and the raw MCP result is returned.

This node has no pipeline lanes: it is a control-plane tool node, connected to agents via the `tools` invoke channel.

Tools are namespaced as `serverName.toolName` (e.g. `mcp.search_docs`), where `serverName` is set in configuration. Tools are discovered **once at pipeline startup** and cached; a server that adds tools later requires a pipeline restart to pick them up.

The implementation is pure Python standard library (`subprocess`, `urllib`, JSON-RPC 2.0), no MCP SDK dependency and no extra packages to install. Each request has a 20-second timeout.

---

## Configuration


| Field | Type | Description |
|---|---|---|
| `serverName` | string | Default "mcp". Namespace prefix for tools: <serverName>.<toolName> (example: local.echo) |
| `transport` | string | Default "streamable-http". How to connect to the MCP server |
| `commandLine` | string | Default "python -m rocketride_mcp". Command line to launch MCP server (stdio transport). Example: python -m rocketride_mcp |
| `endpoint` | string | Default empty. MCP Streamable HTTP endpoint URL. Example: http(s)://host:port/mcp |
| `sse_endpoint` | string | Default empty. Legacy MCP SSE URL (old transport). Example: http://127.0.0.1:8000/sse |
| `headers` | object | Default {}. Extra HTTP headers for streamable-http/sse transports |
| `bearer` | string | Default empty. Optional Authorization bearer token |


### STDIO transport

Launches a local subprocess as the MCP server and speaks JSON-RPC over its stdin/stdout. The subprocess inherits the engine's environment (with `PYTHONUNBUFFERED=1` set).

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `commandLine` | string, default `python -m rocketride_mcp` | Command line to launch the MCP server. Parsed with shell-style quoting. |

Older configs that used separate `command` + `args` fields are still accepted for backwards compatibility.

### Streamable HTTP transport

Connects to a modern Streamable HTTP MCP endpoint (spec 2025-03-26 transport). Handles both plain-JSON and SSE-streamed responses, tracks the `Mcp-Session-Id` returned by the server, and sends a best-effort `DELETE` to terminate the session when the pipeline stops.

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `endpoint` | string, default empty | MCP Streamable HTTP endpoint URL. Example: `http(s)://host:port/mcp` |
| `headers` | object, default `{}` | Extra HTTP headers |
| `bearer` | string, optional, secure | Optional Authorization bearer token |

### Legacy HTTP+SSE transport

Connects to an older two-channel MCP server: a long-lived SSE `GET` stream for responses (read on a background thread) plus an `endpoint` event that supplies the session-specific POST URL for requests.

| Field | Type / Default | Description |
|-------|----------------|-------------|
| `sse_endpoint` | string, default empty | Legacy MCP SSE URL. Example: `http://127.0.0.1:8000/sse` |
| `headers` | object, default `{}` | Extra HTTP headers |
| `bearer` | string, optional, secure | Optional Authorization bearer token |

Configuration is validated at save time: `commandLine` is required for `stdio`, `endpoint` for `streamable-http`, and `sse_endpoint` for `sse`.

---

## Profiles

| Profile | Transport | Notes |
|---------|-----------|-------|
| RocketRide MCP server (stdio) _(default)_ | `stdio` | Launches `python -m rocketride_mcp` |
| Generic MCP server (Streamable HTTP) | `streamable-http` | Enter endpoint URL |
| Generic MCP server (legacy HTTP+SSE) | `sse` | Enter SSE endpoint URL |

---

## Authentication

For the HTTP transports (`streamable-http` and `sse`), set `bearer` to send an `Authorization: Bearer <token>` header on every request. The token is stored encrypted and masked in the UI. Arbitrary additional headers (e.g. API-key headers) can be supplied via `headers`; a `bearer` value overrides any `Authorization` key in `headers`.

The STDIO transport has no authentication fields: the subprocess runs locally with the engine's environment.

---

## Butterbase preset

`services.butterbase.json` in this directory defines **Butterbase MCP Client**, a branded preset that reuses this node's implementation (not a separate node). It pins the transport to `streamable-http` with endpoint `https://api.butterbase.ai/mcp`, namespaces tools as `butterbase.<tool>` (e.g. `butterbase.init_app`), and surfaces the bearer field as a Butterbase API key (`bb_sk_...`, created in the Butterbase dashboard). Prerequisite: enable Developer Mode on your Butterbase app so the agent can create and modify resources.

---

## Notes

- Protocol versions advertised during `initialize`: `2024-11-05` for STDIO, `2025-11-25` for Streamable HTTP and SSE.
- Tool calls must use the fully namespaced `server.tool` form; a call addressed to a different `serverName` than this node's is rejected.
- The MCP server process/connection is started in `beginGlobal` and shut down in `endGlobal`; a failed handshake or tool discovery fails pipeline startup with a warning.

---

## Upstream docs

- [Model Context Protocol specification](https://modelcontextprotocol.io/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Butterbase MCP Client (`services.butterbase.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `mcp_client.bearer` | `string` | **API Key**<br/>Butterbase API key (bb_sk_...). Create one in the <b>Butterbase dashboard</b>: <a href='https://dashboard.butterbase.ai' target='_blank'>dashboard.butterbase.ai</a> → API Keys. Sent as an Authorization Bearer token. | `""` |
| `mcp_client.endpoint` | `string` | **Endpoint**<br/>Butterbase MCP Streamable HTTP endpoint. Defaults to the production server. | `"https://api.butterbase.ai/mcp"` |
| `mcp_client.serverName` | `string` | **Server name**<br/>Namespace prefix for the discovered tools: <serverName>.<toolName> (example: butterbase.init_app). | `"butterbase"` |

### MCP Client (`services.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `mcp_client.bearer` | `string` | **Bearer token**<br/>Optional Authorization bearer token | `""` |
| `mcp_client.commandLine` | `string` | **Command line**<br/>Command line to launch MCP server (stdio transport). Example: python -m rocketride_mcp | `"python -m rocketride_mcp"` |
| `mcp_client.endpoint` | `string` | **Endpoint**<br/>MCP Streamable HTTP endpoint URL. Example: http(s)://host:port/mcp | `""` |
| `mcp_client.headers` | `object` | **Headers**<br/>Extra HTTP headers for streamable-http/sse transports | `{}` |
| `mcp_client.serverName` | `string` | **Server name**<br/>Namespace prefix for tools: <serverName>.<toolName> (example: local.echo) | `"mcp"` |
| `mcp_client.sse_endpoint` | `string` | **SSE endpoint (legacy)**<br/>Legacy MCP SSE URL (old transport). Example: http://127.0.0.1:8000/sse | `""` |
| `mcp_client.transport` | `string` | **Transport**<br/>How to connect to the MCP server | `"streamable-http"` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_mcp_client)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
