---
title: Canvas Agent
description: The in-canvas coding agent that builds and edits pipelines for you — BYO API key, per-turn revert, and what gets logged.
---

# Canvas Agent

The Canvas Agent is a hosted, headless coding-agent session attached to the
pipeline you have open. It authors `.pipe` JSON directly with its own
file-editing tools, validates against the live engine as it goes, and its
edits render live on the canvas as they happen. It's available from three
surfaces in the app: an Agent sidebar section (your session list), full-chat
session tabs, and the canvas right rail attached to the open pipeline.

RocketRide hosts no inference for this feature — you bring your own
Anthropic or OpenAI API key, and the agent runs entirely against it. See
[MCP — Cloud & External Agents](/protocols/mcp/cloud) for the alternative:
connecting your own Claude Code or Cursor to RocketRide instead of using this
panel.

## Setup: bring your own key

Add a personal API key under **Account → Agent Keys**. Paste an Anthropic or
OpenAI API key; it's encrypted at rest and never displayed again once saved
(only a masked `•••• <last 4>` chip). The key is injected into your agent
session's environment server-side — it is never sent to your browser and
never appears in logs.

A personal API key is required to use this panel. Claude Pro/Max subscription
authentication is not supported here — see
[MCP — Cloud & External Agents](/protocols/mcp/cloud#no-api-key-use-rocketride-from-claude-code)
if you have a subscription but no separate API key.

## Quotas

| Limit | Default |
| --- | --- |
| Concurrent agent sessions per tenant | 10 |
| Concurrent `run_pipeline` executions per tenant | 5\* |
| Session idle timeout | 2 hours |
| Session workspace size cap | 512 MB |

\*Enforced at the engine MCP layer (shared by every client of `/mcp`, not
just the panel), separately from the other three limits above, which the
rocket-agent session service enforces itself.

Sessions past the idle timeout are archived automatically (their work is
saved first). Exceeding the concurrency limits returns an error naming the
limit you hit — wait for another session to finish or archive one yourself.

## Reverting agent changes

Every agent edit to your pipeline file is committed to a per-session history,
one commit per agent turn. You can revert to any prior turn from the session
view — this is also your audit trail of exactly what the agent changed and
when, independent of the account-level audit log below.

## What the audit log records

Every tool call, prompt, and session lifecycle event is recorded: who, what
action, when, and whether it succeeded. What is deliberately **not**
recorded is the content of your prompts or tool arguments — those can
contain document text pulled from your pipelines. Instead, each record
carries a SHA-256 digest of the canonicalized arguments (tamper-evident,
but not reversible to the original text) plus any workspace-relative
`.pipe` file paths the call touched. The per-turn revert history above
remains the place to see actual content changes; the audit log is the
action trail, not the content trail.
