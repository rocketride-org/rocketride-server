# Butterbase

Connects an agent to the [Butterbase](https://butterbase.ai) MCP server and exposes its
backend tools for tool-calling.

Butterbase is an AI-optimized Backend-as-a-Service: a managed database, authentication,
object storage, serverless functions, a model gateway, and native RAG. Through its MCP server the
agent can create apps, evolve schemas, configure auth/RLS, manage storage, deploy functions,
and deploy frontends — as tools named `butterbase.<tool>` (e.g. `butterbase.init_app`).

This is a purpose-built clone of the generic `tool_mcp_client`, hardcoded to Butterbase's
Streamable HTTP endpoint so setup is a single API key. For other MCP servers, use
`tool_mcp_client`.

## Connection

| | |
| --- | --- |
| Endpoint | `https://api.butterbase.ai/mcp` (Streamable HTTP) |
| Auth | `Authorization: Bearer <api_key>` (`bb_sk_...`) |
| Tools | Discovered at runtime via `tools/list` (init_app, schema, auth, storage, functions, …) |

Reference: [Butterbase MCP Setup](https://docs.butterbase.ai/getting-started/mcp-setup).

## Configuration

| Field | Required | Notes |
| --- | --- | --- |
| `api_key` | yes | Butterbase API key (`bb_sk_...`). Also reads `BUTTERBASE_API_KEY`. Stored encrypted. |
| `endpoint` | no | Defaults to `https://api.butterbase.ai/mcp`. |
| `serverName` | no | Tool namespace prefix. Defaults to `butterbase`. |

## Wiring

This is a `tool` node — wire it to an agent via `control` (class `tool`):

```jsonc
{
  "id": "tool_butterbase_1",
  "provider": "tool_butterbase",
  "config": { "type": "tool_butterbase", "api_key": "${BUTTERBASE_API_KEY}" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The node connects on open, discovers Butterbase's tools, and the agent calls them by their
namespaced names. Never commit keys — use node config (encrypted) or the `BUTTERBASE_API_KEY`
env var.
