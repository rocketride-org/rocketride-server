## MCP Client node

`mcp_client` is a tool-provider node that connects to an external MCP server and exposes that server’s tools to agents via the engine tool invoke seam.

### Supported transports
- **STDIO**: spawns an MCP server subprocess and speaks JSON-RPC over stdin/stdout.
- **Streamable HTTP**: talks to a modern MCP server over a single HTTP endpoint (typically `/mcp`).
- **Legacy SSE**: talks to older MCP servers using the legacy SSE transport (`/sse` + `/messages/`).

### UI configuration
- **serverName**: namespace prefix for exposed tools (tools appear as `<serverName>.<toolName>`).
- **transport**: `stdio | streamable-http | sse`
- **stdio.commandLine**: a full command line such as `python -m RocketRide_mcp`
- **stdio.env**: optional env vars for the spawned subprocess (key/value map)
- **streamable-http.endpoint**: e.g. `http://127.0.0.1:8002/mcp`
- **sse.sse_endpoint**: e.g. `http://127.0.0.1:8003/sse`
- **headers/bearer**: optional auth for HTTP-based transports

### Local smoke tests
Run from repo root:

```bash
# STDIO (spawns a mock stdio server and calls tools/list + tools/call)
python nodes/src/nodes/mcp_client/test_suite/smoke_stdio.py

# Streamable HTTP (spawns a local HTTP MCP server and calls tools/list + tools/call)
python nodes/src/nodes/mcp_client/test_suite/smoke_streamable_http.py

# Legacy SSE (requires a local SSE MCP server already running)
python nodes/src/nodes/mcp_client/test_suite/smoke_sse.py
```

