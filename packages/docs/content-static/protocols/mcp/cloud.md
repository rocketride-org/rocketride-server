---
title: MCP — Cloud & External Agents
description: Connect Claude Code, Cursor, or any MCP-capable client to RocketRide Cloud and build pipelines from your own coding agent.
---

# MCP — Cloud & External Agents

This page covers RocketRide **Cloud's** native MCP server. If you self-host
the engine and want to expose *already-running pipelines* as tools to a
desktop MCP client, see the [`rocketride-mcp`](/protocols/mcp) bridge package
instead — that's a separate, OSS client-side tool with its own install and
config.

RocketRide Cloud exposes the [engine](/concepts/runtime-engine) directly as an
[MCP](https://modelcontextprotocol.io) (Model Context Protocol) server:
`validate_pipeline`, `run_pipeline`, component lookup, and DVR-style
debugging tools (`get_task_status`, `log_errors`, `log_execution`, ...) — the
same tools RocketRide's own in-canvas [Canvas Agent](/canvas-agent) uses,
available to any MCP client you already run.

This is the **external-agent surface**: bring your own coding agent — Claude
Code, Cursor, or anything else that speaks MCP — and point it at your
RocketRide account. It is GA (out of beta).

## Connecting

```
https://api.rocketride.ai/mcp
```

Authenticate with an `rr_` key (Settings → API Keys → New Key). Add it as a
bearer credential in your client's MCP server config, for example in Claude
Code:

```json
{
  "mcpServers": {
    "rocketride": {
      "type": "remote",
      "url": "https://api.rocketride.ai/mcp",
      "headers": { "Authorization": "Bearer rr_<your-key>" }
    }
  }
}
```

### Auto-discovery for OpenCode

OpenCode-based clients can discover the connection automatically from:

```
https://api.rocketride.ai/.well-known/opencode
```

This returns the RocketRide MCP entry with `enabled: false` — pointing an
OpenCode-based client at RocketRide never auto-activates the connection. You
flip it on and supply your own `Authorization` header; nothing is granted by
the discovery document itself.

## No API key? Use RocketRide from Claude Code

Claude Pro/Max subscription auth only works inside Anthropic's own surfaces
(Claude Code, the Claude apps) — third-party and hosted harnesses, including
RocketRide's in-canvas agent panel, are API-key only. If you have a Claude
subscription but no standalone API key, you don't need one for this surface:
connect your own Claude Code (where subscription auth is valid) to
`https://api.rocketride.ai/mcp` and build pipelines from there. The
[Canvas Agent](/canvas-agent) is the one surface that specifically requires a
personal Anthropic or OpenAI API key, because it hosts the coding agent on
RocketRide's infrastructure rather than running inside your own Claude Code
session.

## Rate limits

| Scope | Limit |
| --- | --- |
| Per `rr_` key | 120 calls/min, burst 240 |
| Per source IP (abuse backstop) | 600 calls/min |

Limits are enforced per key, not per pipeline — a single key hammering
`validate_pipeline` and `run_pipeline` in the same minute shares one budget.
Exceeding a limit returns `429`; back off and retry.

## What's available

The same 26-tool surface the in-canvas agent uses: pipeline authoring
(`validate_pipeline`, `run_pipeline`), component discovery
(`list_components`, `describe_component`), and run debugging
(`get_task_status`, `log_errors`, `log_execution`). Every call is scoped to
your account — an `rr_` key can only see and run pipelines your account owns.
