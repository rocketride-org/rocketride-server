---
title: Resources & Widgets
sidebar_position: 3
---

# Resources & Widgets

Beyond the [tools](/connect/mcp/http/tools), the server exposes two read-only
MCP resources for live engine state, and renders some tool results as
interactive widgets in hosts that support MCP Apps.

## Resources

| URI | Contents | Freshness |
| --- | --- | --- |
| `rocketride://status` | Connection state and currently running tasks: `{"connected": true, "pipeline_count": N, "pipelines": ["name", ...]}` | Live, never cached |
| `rocketride://pipelines` | Your registered deployments — the same deployment objects `deploy_list` returns, as a bare JSON array without the tool's `ok`/`count` envelope | Cached up to 30 s |

In a resource-aware host the two appear in the resource picker automatically;
programmatic clients read them with a standard `resources/read` request.

A host listing resources will also see up to three `ui://rocketride/*.html`
entries — those are the widget bundles below, published as resources per the
MCP Apps spec, not data to read directly.

## No prompts

The server deliberately exposes **no MCP prompt templates**. Task knowledge
ships as agent skills instead (see
[Agents & Tools](/concepts/agents-tools-skills)), so the prompt surface stays
empty rather than duplicating them.

## Widgets

In hosts that support MCP Apps, three tool results render as interactive
widgets. Hosts without MCP Apps see the same results as plain JSON — the
widget is a rendering hint, never a different payload.

| Widget | Rendered for | What it does |
| --- | --- | --- |
| Pipelines table | `list_running_pipelines` | Live table of running pipelines with refresh and terminate actions |
| File dropper | `run_dropper_pipe` | In-chat drag-and-drop upload into the running pipeline, with progress |
| Trace viewer | `log_traces`, `log_trace` | Replay a run object-by-object: components entered, lane data, narration |

**Self-hosters:** the widget bundles are built with `./builder
mcp-widgets:build`; until they exist on disk the server simply advertises no
MCP Apps capability and every host gets the JSON results.
