# RocketRide HTTP MCP Server

The RocketRide engine has a built-in MCP server — nothing to install, nothing to
run. Connect an AI assistant to it and the assistant can **build, validate, run,
and observe** RocketRide pipelines, manage deployments, and read your account
file store.

## Endpoint

```text
https://api.rocketride.ai/mcp
```

Self-hosted engines serve the same endpoint automatically at
`http://<host>:5565/mcp` as soon as the engine is up.

## Authentication

Clients like Claude and ChatGPT authenticate with OAuth — the first connection
triggers an interactive login, and users without a RocketRide account can sign
up from the same screen. Header-capable clients (Cursor, scripts, CLIs) can
instead send a RocketRide API key: `Authorization: Bearer rr_...`.

Task-scoped keys (`tk_`/`pk_`) are never accepted on this endpoint.

## Setup

### Claude

On claude.ai or Claude Desktop, go to **Settings → Connectors → Add custom
connector** and enter the endpoint URL. Complete the OAuth flow on first use.

### Claude Code

```bash
claude mcp add --transport http rocketride https://api.rocketride.ai/mcp
```

### Cursor

Add to `.cursor/mcp.json` in your workspace:

```json
{
	"mcpServers": {
		"rocketride": {
			"url": "https://api.rocketride.ai/mcp",
			"headers": { "Authorization": "Bearer rr_..." }
		}
	}
}
```

### VS Code

Command Palette → **MCP: Add Server** → **HTTP** → enter the endpoint URL.

### Other clients

Any Streamable-HTTP MCP client works — current and older MCP protocol revisions
are served on the same endpoint, so no version configuration is needed.

## What you can do

The server exposes 27 tools, organized by capability:

| Capability | Tools |
| --- | --- |
| Discover components | `list_components`, `describe_component`, `list_integrations` |
| Author pipelines | `validate_pipeline`, `describe_pipeline`, `save_template`, `load_template` |
| Run pipelines | `run_pipeline`, `run_dropper_pipe`, `send_data`, `send_files`, `terminate` |
| Watch what's running | `monitor`, `list_running_pipelines` |
| Read the file store | `store_read`, `store_list`, `store_stat`, `store_get_url` |
| Manage deployments | `deploy_add`, `deploy_list`, `deploy_status`, `deploy_remove`, `deploy_update` |
| Replay past runs | `log_chapters`, `log_read`, `log_traces`, `log_trace` |

Two things to know when working with the tools:

- **Pipelines travel inline.** No tool reads files from the server's disk — a
  client that has a `.pipe` file reads it itself and sends the JSON. File
  access goes through your account file store only.
- **Files come in over a separate channel.** `run_dropper_pipe` returns an
  `upload_url` for programmatic uploads and a `dropper_url` — a browser page
  where a person can drag and drop files into the running pipeline.

## Example prompts

> Build and run a pipeline that summarizes the PDFs I upload.

> Which components can I use right now without setting up any credentials?

> Show me what happened in my last run — where did the second document fail?

> Deploy this pipeline to run every night at 2am.

## Resources

| URI | Contents |
| --- | --- |
| `rocketride://status` | Connection state and currently running tasks. |
| `rocketride://pipelines` | Registered deployments. |

## Widgets

In hosts that support MCP Apps, some tool results render as interactive
widgets: a running-pipelines table (refresh/terminate), an in-chat file dropper
with upload progress, and a trace viewer for replaying runs. Hosts without MCP
Apps support see the same results as plain JSON.

## Self-hosting configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_RESOURCE_IDENTIFIER` | `https://api.rocketride.ai/mcp` | Public URL of your `/mcp` endpoint (the OAuth resource identifier). Must match the deployed URL exactly. |
| `MCP_AUTHORIZATION_SERVER` | `https://auth.rocketride.ai` | OAuth authorization server advertised in discovery metadata. |
| `MCP_EXPECTED_AUDIENCE` | _(unset)_ | Audience OAuth tokens must carry. When unset, OAuth tokens are accepted only on loopback binds. |
| `MCP_JWKS_URL` | `<issuer>/oauth/v2/keys` | Where token signing keys are fetched from. |

For local development, `MCP_DEV_NO_AUTH=1` disables authentication on `/mcp` —
honored only when the engine binds a loopback host (`localhost`, `127.0.0.1`,
`::1`).

The OAuth discovery document at `/.well-known/oauth-protected-resource/mcp` is
served publicly by design — it is how an unauthenticated client learns where to
authenticate. Publishing it does not open `/mcp` itself.

## Security

- **Inline-only pipelines** — no tool accepts a server-local file path, so an
  authenticated caller never gains access to the engine host's filesystem.
- **Store-scoped file access** — the store tools and `send_files` resolve paths
  through your account's file store, nothing else.
- **Credential names, never values** — integration-readiness tools report which
  environment variables are configured; the values never transit MCP.
- **Audience-enforced OAuth** — tokens must be minted for this resource;
  task-scoped keys and PKCE codes are rejected outright.

## FAQ

**I get a 401 — is something broken?**
No — that is the discovery flow. A compliant client follows the
`WWW-Authenticate` header on the 401 to the OAuth metadata and starts the
login. If your client cannot do OAuth, use an API key header instead.

**Where do I get an OAuth client id?**
Dynamic client registration is deliberately disabled; client ids are issued.
[Contact us](https://discord.gg/PMXrtenMsY) to register a client.

**My self-hosted server refuses OAuth tokens.**
On a non-loopback bind, OAuth tokens are refused until `MCP_EXPECTED_AUDIENCE`
is set — a deploy that forgets it fails loudly instead of accepting every
token. API-key auth is unaffected.
