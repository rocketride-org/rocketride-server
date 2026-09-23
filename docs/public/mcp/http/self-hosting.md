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
do, OAuth requires `MCP_EXPECTED_AUDIENCE` (below); API-key auth
(`Authorization: Bearer rr_...`) works in every configuration.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_RESOURCE_IDENTIFIER` | `https://api.rocketride.ai/mcp` | Public URL of your `/mcp` endpoint (the OAuth resource identifier). Must match the deployed URL exactly. |
| `MCP_AUTHORIZATION_SERVER` | `https://auth.rocketride.ai` | OAuth authorization server advertised in discovery metadata. |
| `MCP_EXPECTED_AUDIENCE` | _(unset)_ | Audience OAuth tokens must carry — for the default Zitadel setup this is a **project id**, not a URL. When unset, OAuth tokens are accepted only on loopback binds. |
| `MCP_JWKS_URL` | `<issuer>/oauth/v2/keys` | Where token signing keys are fetched from. |
| `ROCKETRIDE_URI` | _(derived)_ | Engine address MCP tools connect back to; also the origin of widget CSP and upload/dropper links. When unset: `ws://127.0.0.1:<port>` (or `ws://[::1]:<port>`) on a loopback bind, otherwise the origin of `MCP_RESOURCE_IDENTIFIER` with `https`→`wss` / `http`→`ws` (default `wss://api.rocketride.ai`). The engine logs the resolved value at startup. |

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
