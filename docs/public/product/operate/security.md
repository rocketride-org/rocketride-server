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
- every `ROCKETRIDE_` variable except the database names the engine removes:
  `ROCKETRIDE_DB_BROKER_URL`, `ROCKETRIDE_DB_BROKER_TOKEN`,
  `ROCKETRIDE_DB_DSNS`, `ROCKETRIDE_DB_DSN`, and `ROCKETRIDE_DB_RESOLVE_ERROR`.
  It also removes `RR_DB_BROKER_URL`, `RR_DB_BROKER_TOKEN`, `RR_DB_TLS_ROOT_CERT`
  and `RR_DB_ALLOW_INSECURE_DSN`, whatever the letter case and even when
  `RR_SUBPROCESS_ENV` would pass them.
  A task that uses a RocketRide database node then gets `ROCKETRIDE_DB_DSNS`,
  holding the DSN of each database the run was approved for, or
  `ROCKETRIDE_DB_RESOLVE_ERROR`, holding the reason none could be delivered.
  Any other `ROCKETRIDE_DB_*` name passes through like the rest.
- what nodes and the task itself use directly: `RR_STORE_URL`,
  `RR_STORE_SECRET_KEY`, `RR_SIGNING_KEY`, `RR_BASE_URL`, `RR_CORS_ORIGINS`,
  `RR_OAUTH_BROKER_URL`, `RR_PROC_PRIVATE`, `MEDIA_TOOLKIT_FFMPEG`, `AWS_*`, and
  the API-key fallbacks individual node pages document (such as
  `OPENAI_API_KEY`)

Pipeline code can read everything on that list. Any other engine setting stays
in the engine.

| Variable            | Effect                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RR_SUBPROCESS_ENV` | Extra variables to pass to tasks: names separated by commas or spaces, a trailing `*` for a prefix (`SLACK_BOT_TOKEN,GH_*`). A bare `*` passes the whole environment; use that only on a single-user install. |
| `RR_PROC_PRIVATE`   | `1` makes the engine and each task restrict their sensitive `/proc/<pid>` entries (environment, memory, open files) to root. Linux only. Hosted engines turn this on automatically.                           |

Set both in the engine's own environment or its `.env` file. Pipelines cannot
change `RR_` variables.

Limits of `RR_PROC_PRIVATE`:

- Entries such as `cmdline` and `status` stay readable to everyone.
- A process is covered only after its startup code has run, and only that
  process: other programs the engine or a task starts are not covered.
- While a crash dump is being written, the crashing process is readable again.
- A crash dump contains the process's memory, so a database password held by a crashing engine or task can appear in it. The engine does not upload
  dumps; they stay on the host that crashed.
- Same-user debuggers (`gdb`, `py-spy`) can no longer attach, and the kernel
  writes no core dumps for these processes.
- A task that cannot make itself private exits without running pipeline code.
  If the engine itself cannot, it logs a warning and keeps serving.

For strict separation between pipelines, run them under different OS users or
in separate containers.

## RocketRide cloud databases

The `rocketride_sql`, `rocketride_vector` and `rocketride_graph` nodes use a
database that the engine's account provider issues for each run. A node names
the database it wants (organization, team or personal); it never holds a host
or password.

### Who may use which database

At task start the engine asks the account provider whether the run may use each
database its nodes name. The question carries the run's own identity (user,
organization, team, whether it is a development run or a deployment, and whether
the pipeline has a public source), taken from the authenticated session and not
from the pipeline. The engine asks about every database before it provisions any
of them. If one is denied, the task does not start and none is provisioned.

A hosted engine refuses to run these nodes when its account provider is the
single-tenant default, which checks no organization, team or user membership.
The task fails with a message telling the operator that the account extension is
missing or too old.

A task receives every approved DSN in one map, so each node of the task can reach
every database the run was approved for. Nodes are separated by convention, not
by isolation: treat all nodes of a task as one trust boundary.

### Database broker credential

The engine gets DSNs from a database broker that the operator configures:

| Variable             | Effect                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `RR_DB_BROKER_URL`   | The broker's provisioning URL. Operator-only.                                                                                       |
| `RR_DB_BROKER_TOKEN` | The bearer token for that URL. It resolves any tenant's DSN, so treat it as the most sensitive secret on the engine. Operator-only. |

The legacy names `ROCKETRIDE_DB_BROKER_URL` and `ROCKETRIDE_DB_BROKER_TOKEN` are
still read as a deprecated fallback, with one warning per process. The URL decides
which pair is used and the token must come from the same pair; the two are never
mixed. An `RR_DB_BROKER_URL` with only a legacy token is "not configured".

Set these in the engine's own environment or its `.env` file. They are kept out
of reach of clients and pipelines:

- Tasks never receive them (see [Pipeline process isolation](#pipeline-process-isolation)).
- The account environment commands `get_env` and `env_keys`, and the merged
  environment used for `${...}` substitution, omit them, so a
  `${ROCKETRIDE_DB_BROKER_TOKEN}` reference in a node config stays a literal.
- `set_env` ignores them: a client cannot create, change or delete them, in the
  process environment or in the `.env` file.

The broker URL must be `https`. A non-hosted engine also accepts `http` for
`localhost`, `127.0.0.1` and `[::1]`; a hosted engine does not. A URL with
credentials, a fragment, a backslash, an empty host or an invalid port is
rejected.

The engine's broker client sends the request without following redirects (any
3xx answer fails the request and the target receives nothing), ignores proxy
environment variables, verifies the certificate and host name against the
process's trust store, and gives up after 60 seconds.

### Tenant database connections

| Variable                   | Effect                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RR_DB_TLS_ROOT_CERT`      | Path to the CA file that signs the database servers. A hosted engine connects with `sslmode=verify-full` against it. Use a file that holds only that CA: the PostgreSQL client ignores `SSL_CERT_FILE`, and the merged system bundle is not acceptable. |
| `RR_DB_ALLOW_INSECURE_DSN` | `1` lets a non-hosted engine accept a DSN with `sslmode` `disable`, `allow` or `prefer`. A hosted engine ignores it.                                                                                                                                    |

On a hosted engine the engine rebuilds every DSN the broker returns instead of
trusting it: host, port, database and credentials are kept, and the query becomes
exactly `sslmode=verify-full&sslrootcert=<RR_DB_TLS_ROOT_CERT>`. It raises
`require` and `verify-ca` to `verify-full`, and it fails closed on:

- `sslmode` `disable`, `allow`, `prefer` or an unknown value;
- an `sslrootcert` supplied by the broker;
- a repeated parameter, or any parameter other than `sslmode` and `sslrootcert`
  (such as `host`, `hostaddr`, `service`, `options`, `sslcert` or `sslkey`);
- a fragment, several hosts, no host, an invalid port or a key/value DSN.

If `RR_DB_TLS_ROOT_CERT` is unset, missing or holds no PEM certificate, the
database nodes fail with a message for the operator, before the broker is called.
The database server's certificate must chain to that CA and carry a name that
matches the DSN host. Each task also checks the DSN it was given and refuses it
with an error that begins `hosted policy:` if it does not meet these rules.

A non-hosted engine adds `sslmode=require` when none is given, accepts
`verify-ca` and `verify-full`, and rejects the weaker modes unless
`RR_DB_ALLOW_INSECURE_DSN=1`. The structural rules above apply on every engine.

### Audit log lines

For each database a task start asks for, the engine writes one warning-level log
line, `RocketRide DB access` followed by JSON with the task id, organization,
user, team, run kind, owner kind, scope, owner, `outcome` and `reason`. The
outcome is `issued`, `denied`, `resolve_failed` or `aborted` (another database in
the same start was denied or failed, so nothing is delivered). The line never
contains a DSN, password or token. The engine also sends the task id to the broker
in an `X-Request-Id` header so the broker's own log can be matched to it.

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
