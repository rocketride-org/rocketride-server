---
title: Connect a Client
sidebar_position: 1
---

# Connect a Client

The endpoint is the same for every client:

```text
https://api.rocketride.ai/mcp
```

(Self-hosted: `http://<host>:5565/mcp` — see
[Self-hosting](/connect/mcp/http/self-hosting).)

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
are negotiated on the same endpoint, so no version configuration is needed.

## Authentication

Two credential shapes are accepted; everything else is rejected at the `/mcp`
boundary:

| Credential | Who uses it | How |
| --- | --- | --- |
| **OAuth access token** | Claude, ChatGPT, and other OAuth-only clients | Automatic: the client discovers the login flow from the endpoint itself (below) |
| **RocketRide API key** (`rr_...`) | Cursor, scripts, CLIs — anything that can set a header | `Authorization: Bearer rr_...` |

Task-scoped keys (`tk_`/`pk_`) and PKCE exchange codes (`cd_`) are refused
outright — they scope a single task, not an account, and never grant access to
`/mcp`.

### How the OAuth flow bootstraps

OAuth clients need no pre-configuration beyond the URL:

1. The client `POST`s to `/mcp` with no credentials and receives a `401` whose
   `WWW-Authenticate` header names the resource-metadata URL.
2. `GET` that URL → the RFC 9728 document, which names the authorization
   server (`https://auth.rocketride.ai`).
3. The client fetches the authorization server's RFC 8414 metadata and runs a
   standard authorization-code + PKCE login.
4. It calls `/mcp` again with `Authorization: Bearer <access_token>`.

Users without a RocketRide account can sign up from the login screen and
continue through the same flow. Dynamic client registration is deliberately
disabled; client ids are issued — [contact us](https://discord.gg/PMXrtenMsY)
to register a client.

Every request acts as the account behind the presented credential: tools see
that caller's own file store, deployments, environment variables, and run logs.

## Transport details

- **Streamable HTTP, stateless.** Each POST is independent — there is no
  `Mcp-Session-Id`, so load balancers need no sticky sessions.
- **Responses may stream.** Replies arrive as SSE frames inside the POST
  response; clients must accept both `application/json` and
  `text/event-stream` (every compliant Streamable-HTTP client does).
- **Not served:** the legacy HTTP+SSE transport (no separate `/sse` endpoint)
  and WebSocket upgrades on `/mcp` (refused with close code 1008). There is no
  event replay (`Last-Event-ID`) — the server keeps no session state to replay.
- **No rate limiting** is applied at the MCP layer.

## FAQ

**I get a 401 — is something broken?**
No — that is the discovery flow. A compliant client follows the
`WWW-Authenticate` header on the 401 to the OAuth metadata and starts the
login. If your client cannot do OAuth, use an API key header instead.

**Where do I get an OAuth client id?**
Dynamic client registration is deliberately disabled; client ids are issued.
[Contact us](https://discord.gg/PMXrtenMsY) to register a client.
