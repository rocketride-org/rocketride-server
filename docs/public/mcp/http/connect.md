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

In claude.ai and Claude Desktop, add RocketRide as a connector with the
endpoint URL. In Claude Code, run
`claude mcp add --transport http rocketride --scope user https://api.rocketride.ai/mcp`.
[Set up Claude](/connect/mcp/http/claude) has the steps for each plan,
organization setup and sign-in fixes.

### Cursor

[![Add RocketRide to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg#gh-light-mode-only)](https://cursor.com/install-mcp?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9)
[![Add RocketRide to Cursor](https://cursor.com/deeplink/mcp-install-light.svg#gh-dark-mode-only)](https://cursor.com/install-mcp?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9)

1. Click **Add to Cursor** and confirm the install in Cursor. If the button
   does not open Cursor, use the
   [app link](cursor://anysphere.cursor-deeplink/mcp/install?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9).
2. In Cursor, open **Customize > MCPs**, find `rocketride`, and turn it on if it
   is off. Sign in from there. The sign-in page opens in your browser, and you
   can create a RocketRide account on it. No key is needed.
3. Ask Cursor's agent "Which RocketRide components can I use?" It should call
   `list_components` and list them.

If your team's admin limits which MCP servers you can use, see **Cursor
Enterprise** below.

**By hand.** Put this in `~/.cursor/mcp.json` for every project, or in
`.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "rocketride": {
      "url": "https://api.rocketride.ai/mcp"
    }
  }
}
```

Save the file, restart Cursor, and sign in the same way.

**Cursor CLI.** The CLI reads the same `mcp.json` as the app. If you use only
the CLI, create `~/.cursor/mcp.json` with the config above first. Then run:

```bash
agent mcp enable rocketride
agent mcp login rocketride
```

To check, run `agent mcp list-tools rocketride`. It should list
`list_components`. On a machine with no browser, use the key form below.

**No browser.** Use a RocketRide API key instead. On any computer with a
browser, create one on the **API Keys** page of your account in the RocketRide
web app. Then add a `headers` entry on the machine with no browser:

```json
{
  "mcpServers": {
    "rocketride": {
      "url": "https://api.rocketride.ai/mcp",
      "headers": {
        "Authorization": "Bearer rr_..."
      }
    }
  }
}
```

Keep the key out of files you commit. Put it in `~/.cursor/mcp.json`, or read
it from an environment variable with `"Bearer ${env:ROCKETRIDE_APIKEY}"`.
Cursor reads the variable when it starts, so restart Cursor after you set it.

**Cloud agents.** Cursor's hosted cloud agents do not read
`~/.cursor/mcp.json`. Add the server at
[cursor.com/agents](https://cursor.com/agents) and sign in there too. Cloud
agents keep their own sign-in.

**Cursor Enterprise.** If your team uses Cursor's
[MCP allowlist](https://cursor.com/docs/mcp#mcp-allowlist), an admin first adds
a URL entry for `https://api.rocketride.ai/mcp` under **Team Settings > MCP
Configuration**. Until then, Cursor blocks the server for members, unless the
admin also lets members add their own MCP servers.

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
| **OAuth access token** | Claude, ChatGPT, Cursor, VS Code, and other clients that sign in through the browser | Automatic. The client discovers the login flow from the endpoint itself (below) |
| **RocketRide API key** (`rr_...`) | Scripts, CI jobs, and any client that cannot open a browser | `Authorization: Bearer rr_...` |

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
continue through the same flow. On the hosted server (RocketRide Cloud), dynamic client registration is on at
`https://api.rocketride.ai/oauth/register`, so a client that supports dynamic
client registration registers itself the first time it connects, and you do
not need to request a client id. If your client cannot register itself,
[contact us](https://discord.gg/PMXrtenMsY) for a client id or use an API key
header instead.
Every client is a public client that uses PKCE; no client secret is issued.

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
You do not need to ask for one on the hosted server (RocketRide Cloud). Compliant clients register automatically at
`https://api.rocketride.ai/oauth/register`. If registration fails with an
invalid redirect error, your client uses a callback address we have not added
yet: [contact us](https://discord.gg/PMXrtenMsY) with the redirect address, or
connect with an API key header instead.
