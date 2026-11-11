---
title: Self-hosting
sidebar_position: 4
---

# Self-hosting

Every RocketRide engine serves the MCP endpoint automatically — there is
nothing extra to install or start:

```text
http://<host>:5565/mcp
```

The engine binds `localhost` by default, so the endpoint is only reachable
from the machine itself until you configure a wider bind host. The moment you
do, OAuth requires `MCP_EXPECTED_AUDIENCE` (below). API-key auth
(`Authorization: Bearer rr_...`) is the simplest sign-in for a self-hosted
engine. On an engine not bound to localhost (this includes the Docker image, even
with a `127.0.0.1` port mapping), the key must start with `rr_`; other bearer
values are refused with 401.

> **Warning:** when neither `ROCKETRIDE_URI` nor `MCP_RESOURCE_IDENTIFIER` is set
> on such an engine, MCP tool calls connect to `wss://api.rocketride.ai`
> (RocketRide Cloud), not to your engine. `initialize` and `tools/list` succeed, then every tool call fails
> with `Invalid or revoked API key`. For a self-hosted engine, set `ROCKETRIDE_URI=ws://127.0.0.1:<port>`.

A Docker command that works end to end (MCP calls then use
`Authorization: Bearer rr_local`):

```bash
docker run -d --name rocketride-engine --platform linux/amd64 \
  -p 127.0.0.1:5565:5565 \
  -v rocketride-data:/opt/data \
  --restart unless-stopped \
  -e ROCKETRIDE_APIKEY=rr_local \
  -e ROCKETRIDE_URI=ws://127.0.0.1:5565 \
  ghcr.io/rocketride-org/rocketride-engine:latest
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_RESOURCE_IDENTIFIER` | `https://api.rocketride.ai/mcp` | Public URL of your `/mcp` endpoint (the OAuth resource identifier). Must match the deployed URL exactly. |
| `MCP_AUTHORIZATION_SERVER` | `https://auth.rocketride.ai` | OAuth authorization server advertised in discovery metadata. |
| `MCP_EXPECTED_AUDIENCE` | _(unset)_ | Audience OAuth tokens must carry — for the default Zitadel setup this is a **project id**, not a URL. When unset, OAuth tokens are accepted only on loopback binds. |
| `MCP_JWKS_URL` | `<issuer>/oauth/v2/keys` | Where token signing keys are fetched from. |
| `ROCKETRIDE_URI` | _(derived)_ | Engine address MCP tools connect back to; also the origin of widget CSP and upload/dropper links. When unset: `ws://127.0.0.1:<port>` (or `ws://[::1]:<port>`) on a loopback bind, otherwise, when `MCP_RESOURCE_IDENTIFIER` is set, its origin with `https`→`wss` / `http`→`ws`; on a non-loopback bind with neither set (for example the Docker image), `ws://127.0.0.1:<port>`, so tool calls stay on this engine (`ws://[::1]:<port>` for a `::` bind, and `ws://<bind host>:<port>` for a specific bind address). In those cases upload links, the file-drop page and widget addresses use that address too, so set `MCP_RESOURCE_IDENTIFIER` (or `ROCKETRIDE_URI`) to the engine's public address for clients on other machines. The engine logs the resolved value at startup. |
| `MCP_OPENAI_APPS_CHALLENGE_TOKEN` | _(unset)_ | Served as the plain-text body of `GET /.well-known/openai-apps-challenge` for OpenAI's plugin domain verification. Unset: the route answers 404. |

Three related guards to know about:

- `ROCKETRIDE_URI` must be encrypted when it points at a **remote** engine: a
  cleartext `ws://` / `http://` value addressing a non-loopback host fails boot,
  because the caller's own credential is sent to the engine in the first DAP
  `auth` message. The check keys on the engine's target host, not on the bind —
  a loopback-bound MCP server pointed at a remote engine is refused just the
  same, while `ws://127.0.0.1:5565` / `http://localhost:5565` stays allowed on
  any bind. Use `wss://` (or an `https://` `MCP_RESOURCE_IDENTIFIER`) for a
  remote engine, in practice via a TLS-terminating reverse proxy.
- On a non-loopback bind with `MCP_EXPECTED_AUDIENCE` unset, **all** OAuth
  tokens are refused with an explicit error — a deploy that forgets the
  audience fails loudly instead of accepting every token.
- Once an audience is configured, opaque (non-JWT) OAuth tokens are refused
  too, so a misconfigured identity provider cannot silently bypass the
  audience check.

### Local development

`MCP_DEV_NO_AUTH=1` (or the engine config key `mcp_dev_no_auth`) disables
authentication on `/mcp` — honored only when the engine binds a loopback host
(`localhost`, `127.0.0.1`, `::1`); on any other bind the bypass is ignored
and auth stays on.

### OAuth discovery document

The discovery document at `/.well-known/oauth-protected-resource/mcp` is
served publicly by design — it is how an unauthenticated client learns where
to authenticate. Publishing it does not open `/mcp` itself. (Its path is
derived from `MCP_RESOURCE_IDENTIFIER`; if you set a resource identifier with
no `/mcp` path, the document moves to `/.well-known/oauth-protected-resource`
accordingly.)

### OpenAI domain verification

OpenAI's plugin portal verifies the MCP host by fetching
`/.well-known/openai-apps-challenge` and comparing the body with the token it
generated. Set `MCP_OPENAI_APPS_CHALLENGE_TOKEN` to that token; the engine serves
it as plain text, publicly, with surrounding whitespace removed. The route is
always registered and answers 404 while the variable is unset.

## Security notes for operators

- **Inline-only pipelines** — no tool accepts a server-local pipeline path, so
  an authenticated caller cannot make the engine read pipeline definitions off
  its host filesystem.
- **`send_files` is local-engine only.** Unlike the `store_*` tools (which are
  scoped to the caller's account file store), `send_files` reads its paths on
  the machine the engine runs on, so it is offered only on a loopback bind.
  On any other bind it is not listed and calls to it are refused — see its
  [reference entry](/connect/mcp/http/tools#send_files).
- **Credential names, never values** — integration-readiness tools report
  which environment variables are configured; the values never transit MCP.
- **No rate limiting** is applied at the MCP layer; put the endpoint behind
  your own gateway if you need throttling.
- **Stateless transport** — no sessions and no sticky-session requirement, so
  the endpoint load-balances freely.

## FAQ

**My self-hosted server refuses OAuth tokens.**
On a non-loopback bind, OAuth tokens are refused until
`MCP_EXPECTED_AUDIENCE` is set — a deploy that forgets it fails loudly instead
of accepting every token. API-key auth is unaffected.

**Do widgets work on my server?**
Only after the widget bundles are built (`./builder mcp-widgets:build`) — see
[Resources & Widgets](/connect/mcp/http/resources-and-widgets#widgets).
