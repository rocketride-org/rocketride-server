---
title: Security
---

# Security

An overview of how RocketRide handles credentials, network exposure, and
authentication across its components.

## Credential isolation

API keys are configured **per node** inside the pipeline definition. Each node
holds only its own credentials — there are no shared global secrets, no
credential store, and no key that grants access to more than one provider.

```json
{
  "id": "llm_1",
  "provider": "llm_openai",
  "config": {
    "profile": "openai-4o",
    "openai-4o": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }
  }
}
```

Nodes use `${ENV_VAR}` substitution so the key itself never has to appear in the
`.pipe` file. Only `ROCKETRIDE_`-prefixed variables are substituted — a
reference to any other variable is replaced with `<REDACTED>`. See [Best Practices: Credential management](/guides/best-practices#credential-management)
for how to keep keys out of version control.

## Network exposure

The engine binds to `localhost` by default:

- **Port 5565** — WebSocket API (SDK / CLI connections).
- **Source-node HTTP endpoints** (Webhook, Chat, Dropper) — the port is set
  per node in the pipeline config; 5567 is the conventional choice used in
  examples and integrations, not a fixed engine bind.

Only the source-node HTTP port needs to be accessible to external callers when
you're using a webhook-based source. Port 5565 is a management interface;
expose it only to trusted clients on a private network or behind a VPN.

For production deployments, put the engine behind a reverse proxy (nginx,
Caddy, AWS ALB) that terminates TLS and enforces rate limiting before traffic
reaches the engine.

## Endpoint authentication

When a Webhook, Chat, or Dropper source node starts, the engine generates two
credentials and writes them to the Project Log:

- **Public authorization key** - presented by external callers in the
  `Authorization: Bearer <key>` header. Safe to share with trusted API clients.
- **Private token** - the internal credential for the endpoint. Used by the SDK
  to connect to a running task via `--token`. Do not share this publicly.

The Project Log is local to the operator who started the pipeline (it is not a
shared or exportable log), so the private token is only visible to that
operator. Retrieve it from your own Project Log when you need to connect a client
with `--token`.

Both are generated fresh each time the pipeline starts. There is no persistent
credential to rotate — stopping and restarting the pipeline issues new
credentials automatically.

## MCP authentication

The [MCP server](/connect/mcp/stdio) authenticates callers in two ways:

- **`ROCKETRIDE_AUTH` / `ROCKETRIDE_APIKEY`** — the API key used to connect the
  MCP server to the RocketRide engine. Required; set in the environment.
- **`MCP_API_KEY`** — a Bearer token that clients must present to the MCP
  server when it is running in SSE (HTTP) mode. Optional for stdio mode,
  required for any network-exposed SSE deployment.

## Pipeline file security

A `.pipe` file is plain JSON. When you use `${ENV_VAR}` substitution, the key
stays in the environment and never touches disk in the pipeline file. When you
embed a key directly (for quick local testing), it is stored in plain text —
treat the file as a secret.

Do not commit `.pipe` files containing embedded credentials to version control.
Add them to `.gitignore`:

```gitignore
*.pipe
```

In CI/CD, pass the pipeline file through a secrets-expansion step before
passing it to `rocketride start`, or inject keys via environment variables and
use `${...}` references.

## Dependency scanning

The RocketRide codebase runs automated dependency scanning: CodeQL via
GitHub's default setup, plus Trivy and OpenSSF Scorecard on pushes to
`develop`/`main` and on scheduled runs. See [Security](/support/security-policy) for the
vulnerability reporting process and SLA.

## Related

- [Best Practices](/guides/best-practices): credential management patterns.
- [Self-hosting](/operate/self-hosting): network configuration.
- [MCP Server](/connect/mcp/stdio): MCP-specific authentication.
- [Security policy](/support/security-policy): vulnerability reporting.
