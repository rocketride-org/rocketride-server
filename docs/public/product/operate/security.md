---
title: Security
description: An overview of how RocketRide handles credentials, network exposure, and authentication across its components.
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

## Pipeline process isolation

Each running pipeline is a separate engine process (a task). A task does not
inherit the engine's full environment, only an allowlist:

- process basics: `PATH`, `HOME`, locale, TLS and proxy settings
- interpreter and ML runtime settings (`PYTHON*`, `HF_*`, `CUDA_*`, and similar)
- every `ROCKETRIDE_` variable except five the engine removes:
  `ROCKETRIDE_DB_BROKER_URL`, `ROCKETRIDE_DB_BROKER_TOKEN`,
  `ROCKETRIDE_DB_DSNS`, `ROCKETRIDE_DB_DSN`, and `ROCKETRIDE_DB_RESOLVE_ERROR`.
  A task that uses a RocketRide database node then gets `ROCKETRIDE_DB_DSNS`,
  holding the DSN of each database the run was approved for.
  Any other `ROCKETRIDE_DB_*` name passes through like the rest.
  `ROCKETRIDE_` is the pipelines' and the clients' namespace; the engine's own
  settings are `RR_` names, which a task does not get unless listed below.
- what nodes and the task itself use directly: `RR_CORS_ORIGINS`,
  `RR_OAUTH_BROKER_URL`, `RR_PROC_PRIVATE`, `RR_MOCK` (test servers only),
  `MEDIA_TOOLKIT_FFMPEG`, `AWS_*`, and the API-key fallbacks individual node
  pages document (such as `OPENAI_API_KEY`). The object store and its secret,
  the engine's address, its API key and the fetch-URL signing key stay in the
  engine: a task's files and state go through it.

Pipeline code can read everything on that list. Any other engine setting stays
in the engine.

An engine started with a retired `ROCKETRIDE_` spelling of one of its own
settings refuses to start and names the replacement (`ROCKETRIDE_MOCK` is now
`RR_MOCK`). A standalone engine's API key is `RR_APIKEY`; `ROCKETRIDE_APIKEY`
is what a client sends, and an engine that has it but not `RR_APIKEY` refuses
to start.

| Variable            | Effect                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RR_SUBPROCESS_ENV` | Extra variables to pass to tasks: names separated by commas or spaces, a trailing `*` for a prefix (`SLACK_BOT_TOKEN,GH_*`). A bare `*` passes the whole environment except the five `ROCKETRIDE_DB_` variables the engine removes (listed above); use a bare `*` only on a single-user install. |
| `RR_PROC_PRIVATE`   | `1` makes the engine and each task restrict their sensitive `/proc/<pid>` entries (environment, memory, open files) to root. Linux only. Hosted engines turn this on automatically.                                                                                                              |

Four of the engine's own secrets never reach a task, whatever
`RR_SUBPROCESS_ENV` names, a prefix such as `RR_*` and a bare `*` included:
`RR_APIKEY`, `RR_MCP_ENGINE_AUTH`, `RR_DATACORE_GRANT_KEY` and
`RR_DB_BROKER_TOKEN`.

Set both in the engine's own environment or its `.env` file. Pipelines cannot
change `RR_` variables.

Limits of `RR_PROC_PRIVATE`:

- Entries such as `cmdline` and `status` stay readable to everyone.
- A process is covered only after its startup code has run, and only that
  process: other programs the engine or a task starts are not covered.
- While a crash dump is being written, the crashing process is readable again.
- Same-user debuggers (`gdb`, `py-spy`) can no longer attach, and the kernel
  writes no core dumps for these processes.
- A task that cannot make itself private exits without running pipeline code.
  If the engine itself cannot, it logs a warning and keeps serving.

For strict separation between pipelines, run them under different OS users or
in separate containers: `--runtime=docker` starts every task in a container of
its own (see [Tasks in containers](/operate/self-hosting/task-containers)).

## Network exposure

The engine binds to `localhost` by default:

- **Port 5565** — WebSocket API (SDK / CLI connections).
- **Source-node HTTP endpoints** (Webhook, Chat, Dropper) — the port is set
  per node in the pipeline config; 5567 is the conventional choice used in
  examples and integrations, not a fixed engine bind.
- **Task data ports** — under `--runtime=spawn` each running pipeline
  listens on `localhost`, on a port from a pool that starts at
  `--base_port` (20000 by default), for the engine
  only. It accepts a connection only with that pipeline run's own token, which
  the engine keeps and replaces on every start; the pipeline's process is given
  only a hash of it. The engine connects as soon as the process reports its
  listener, and over that connection the process may ask the engine only for
  the commands the engine registered for it — today one, `spend.check`, which
  asks whether the run's own organization may open a pipe. Its `/status`
  endpoint accepts only that token. Under `--runtime=docker` a task listens on
  port 5570 inside its own container (see
  [Tasks in containers](/operate/self-hosting/task-containers)); where the
  engine cannot dial the container's own address, that port is also published
  on a pool port of the host's `127.0.0.1`. Other containers on the same Docker
  network can reach port 5570 too, so there the per-run token is what keeps
  them out. Under `--runtime=k8s` it listens on port 5570 of its own pod, which
  the engine dials at the pod's address or through a forwarded pool port of its
  own `127.0.0.1`; any pod the cluster's network lets through can reach that
  port, and the token keeps those out as well.

Only the source-node HTTP port needs to be accessible to external callers when
you're using a webhook-based source. Port 5565 is a management interface;
expose it only to trusted clients on a private network or behind a VPN.

For production deployments, put the engine behind a reverse proxy (nginx,
Caddy, AWS ALB) that terminates TLS and enforces rate limiting before traffic
reaches the engine.

## Endpoint authentication

A Webhook, Chat, or Dropper source node generates no credential of its own.
When the pipeline starts, the node's Endpoint Info shows its address,
`developerId.pipelineId.source`, and its URL, `<server>/webhook/<address>`.
Every request carries an account API key (`rr_...`) in the
`Authorization: Bearer <key>` header, and the server checks on every call that
the key's account may send to that address. Whose key is on the request is who
pays. A URL never carries a credential: `?auth=` is not accepted. The URL may
root the address at one rung (`<server>/webhook/=team/<tid>/<address>`); the
root is a selector, never a way out of a key's scope, and an endpoint-scoped
key's frozen team refuses every other team root.

- **Endpoint-scoped key** - minted from the Endpoint Info panel: permission
  `task.data` on that one address, frozen to your home team. Hand this one to
  external systems that can set a request header (n8n, scripts, partners); it
  reaches nothing else. A native provider webhook that cannot add a header,
  such as GitHub's or Stripe's (they sign the request with their own secret),
  needs an HTTPS relay that verifies the provider's signature, then adds the
  key and forwards the request: the server does not check provider signatures.
- **Account key** - your whole account, for first-party callers and your own
  automation. Do not share it.

Keys persist until they expire or you revoke them in your API keys, so revoke
an endpoint key when the system holding it no longer needs it. Stopping or
restarting a pipeline does not change its address or its keys.

## MCP authentication

The engine's built-in [MCP server](/connect/mcp/http) (`/mcp`) accepts two
credentials and rejects everything else:

- **OAuth access token**, for Claude, ChatGPT and other OAuth clients. The
  client discovers the sign-in flow from the endpoint itself.
- **RocketRide API key** (`rr_...`), sent as `Authorization: Bearer rr_...`, for
  Cursor, scripts and anything else that can set a header.

No other credential is accepted on this endpoint: a PKCE exchange code (`cd_`)
never grants access to `/mcp`. The only exception is the `MCP_DEV_NO_AUTH=1` development
bypass, which the engine honors only on a loopback address. A self-hosted engine on a non-loopback address refuses OAuth
tokens until `MCP_EXPECTED_AUDIENCE` is set; see
[Self-hosting the MCP server](/connect/mcp/http/self-hosting).

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
- [MCP Server](/connect/mcp/http/connect#authentication): MCP-specific authentication.
- [Security policy](/support/security-policy): vulnerability reporting.
