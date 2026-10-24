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
- what nodes and the task itself use directly: `RR_STORE_URL`,
  `RR_STORE_SECRET_KEY`, `RR_SIGNING_KEY`, `RR_BASE_URL`, `RR_CORS_ORIGINS`,
  `RR_OAUTH_BROKER_URL`, `RR_ENABLE_DEBUGGER_CONNECTION`,
  `MEDIA_TOOLKIT_FFMPEG`, `AWS_*`, and the API-key fallbacks individual node
  pages document (such as `OPENAI_API_KEY`)

Pipeline code can read everything on that list. Any other engine setting stays
in the engine.

On Linux the engine and every task also close themselves as they start: their
`/proc/<pid>` entries then belong to root, and the sensitive ones (environment,
memory, open files) open only to a process with `CAP_SYS_PTRACE` in their user
namespace, which root has as a rule. So one task cannot read the engine or
another task that runs as the same user without that capability.

| Variable                        | Effect                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RR_SUBPROCESS_ENV`             | Extra variables to pass to tasks: names separated by commas or spaces, a trailing `*` for a prefix (`SLACK_BOT_TOKEN,GH_*`). A bare `*` passes the whole environment; use that only on a single-user install.                                                       |
| `RR_ENABLE_DEBUGGER_CONNECTION` | `1`, `true`, `yes` or `on`, in any case, keeps the engine and its tasks open to debuggers of the same user instead of closing them; any other value leaves them closed. Linux only. Use it on a machine you debug on, never where pipelines of different users run. |

Pipelines cannot change `RR_` variables. Set `RR_SUBPROCESS_ENV` in the
engine's own environment or its `.env` file. `RR_ENABLE_DEBUGGER_CONNECTION`
has to be in the environment the engine starts with: it is read before `.env`
is loaded.

What closing a process covers, and what it costs:

- Entries such as `cmdline` and `status` stay readable to everyone.
- Only the engine's own processes are covered: other programs the engine or a
  task starts are not.
- While a crash dump is being written, the crashing process is readable again.
- Debuggers of the same user (`gdb`, `strace`, `py-spy`) cannot work on a
  closed process, whether they attach to it or start it, and the kernel writes
  no core dumps for it. Run the debugger as root, or set
  `RR_ENABLE_DEBUGGER_CONNECTION=1`.
- `RR_ENABLE_DEBUGGER_CONNECTION` opens nothing in the Docker images: their
  engine binary is execute-only, and the kernel starts such a process closed.
- An engine or a task that cannot close itself does not start.

For strict separation between pipelines, run them under different OS users or
in separate containers.

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
