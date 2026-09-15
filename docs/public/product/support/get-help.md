---
title: FAQ / Get Help
---

# Get Help

## Where to ask

| You need | Go to |
| --- | --- |
| A question answered | [GitHub Discussions](https://github.com/rocketride-org/rocketride-server/discussions), [Stack Overflow (`rocketride`)](https://stackoverflow.com/questions/tagged/rocketride), or [Discord](https://discord.gg/PMXrtenMsY) |
| To report a bug | The [bug report template](https://github.com/rocketride-org/rocketride-server/issues/new/choose) |
| To request a feature | The [feature request template](https://github.com/rocketride-org/rocketride-server/issues/new/choose) |
| To report a security vulnerability | **Privately only**: [GitHub Security Advisories](https://github.com/rocketride-org/rocketride-server/security/advisories/new) or security@rocketride.ai — never a public issue. See the [security policy](/support/security-policy). |

Support questions opened as issues get converted to Discussions — starting
there is faster.

## Before you ask

Bug reports that include these get answered in one round-trip instead of
three:

- Engine version and how it runs (VS Code local, Docker, Cloud, self-hosted)
- Client and version (Python/TypeScript SDK, CLI, VS Code extension, MCP)
- The smallest `.pipe` that reproduces the problem
- The exact error text, and the output of `validate()` /
  `validate_pipeline` on your pipeline
- What you expected instead

## Frequently asked questions

### I can't connect — connection refused. Is the engine down?

Nothing is listening on the URI you're pointing at. Start a local engine (the
[VS Code extension](/clients/vscode) or a
[self-hosted container](/operate/self-hosting) on port 5565), or set
`ROCKETRIDE_URI` to your Cloud endpoint. Details:
[Troubleshooting](/support/troubleshooting).

### I get 401 / Unauthorized against Cloud — which variable do I set?

Set `ROCKETRIDE_APIKEY`. `ROCKETRIDE_AUTH` is read only by the MCP servers,
not by the SDKs or CLI. See the
[configuration pages](/clients/python/configuration) for the full environment
table.

### My MCP client gets a 401 — is the server broken?

No — that's the OAuth discovery flow working as designed: the client follows
the `WWW-Authenticate` header to the login. If your client can't do OAuth,
send an `rr_` API key header instead. See the
[MCP connection FAQ](/connect/mcp/http/connect#faq).

### The pipeline runs but nothing comes back.

Match the method to the pipeline's source node: a `chat` source answers
`chat()`, a webhook/dropper source answers `send()` / `pipe()`. Also check
you're not reusing a stale task token.
[Troubleshooting](/support/troubleshooting) walks through it.

### How do I catch pipeline errors before running?

`validate()` in the SDKs — or the `validate_pipeline` MCP tool — runs the
engine's own validator server-side without starting a task. See
[Running Pipelines](/clients/python/pipelines).

### What does "Lane mismatch / lane not supported" mean?

The output lane of one node must match an input lane the next node accepts.
Check both ends against the [node catalog](/nodes) and the lane table on
[Execution Model](/concepts/execution-model).

### Which API key goes where — `rr_` vs `tk_`/`pk_`?

`rr_` account keys authenticate the SDKs and MCP. Task-scoped `tk_`/`pk_`
keys control a single task and are refused at the MCP endpoint; `pk_` is the
task's public key, seen in dropper/upload URLs and webhook Bearer
credentials. See
[MCP authentication](/connect/mcp/http/connect#authentication).

### How do I set up credentials for an integration node?

Call the `list_integrations` MCP tool — bare for the status of every
integration, with a `name` for field detail and the suggested environment
variables. Values never transit MCP; wiring uses `${VAR}` placeholders. See
[its reference entry](/connect/mcp/http/tools#list_integrations).

### Why are my replayed traces empty?

The run started with `pipelineTraceLevel: 'none'` — chapters and console
output survive, traces don't. Start with `summary` (or `full` when
debugging). See [run logs](/clients/python/logs) and the
[MCP replay tools](/connect/mcp/http/tools#replay-past-runs).

### How long are run logs kept?

7 days for dev runs, 30 days for deployments, on a bounded log ring —
evicted earlier under storage pressure. See [run logs](/clients/python/logs).

### My pipeline stopped by itself after ~15 minutes.

That's the idle TTL — the VS Code default is 900 seconds. Pass `ttl: 0`
("run forever") for long-lived pipelines and terminate them yourself. See
[VS Code usage](/clients/vscode/usage) and
[Running Pipelines](/clients/python/pipelines).

### My agent pipeline won't start.

Agent helpers wire via `control` connections, and each agent node has
requirements — `agent_rocketride` needs exactly one LLM and one memory node.
See [Troubleshooting](/support/troubleshooting) and
[Agents & Tools](/concepts/agents-tools-skills).

### Is my connection to Cloud encrypted?

Only if you ask for it: `http://`, `ws://`, or a bare `host:port` URI runs
unencrypted. Always use `https://` / `wss://` against Cloud. See
[Troubleshooting](/support/troubleshooting).

### The response is empty, or under a key I didn't expect.

A `response` node with a custom `laneName` puts the result under that key;
read the result's `result_types` to see which key carries which lane. See
[Troubleshooting](/support/troubleshooting).

Didn't find your problem? [Troubleshooting](/support/troubleshooting) covers
errors in depth — and the channels at the top of this page are watched.
