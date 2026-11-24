---
title: Resources & Widgets
sidebar_position: 3
description: Beyond the tools, the RocketRide MCP server exposes two read-only resources for live engine state and renders some tool results as interactive widgets.
---

# Resources & Widgets

Beyond the [tools](/connect/mcp/http/tools), the server exposes two read-only
MCP resources for live engine state, and renders some tool results as
interactive widgets in hosts that support MCP Apps.

## Resources

| URI | Contents | Freshness |
| --- | --- | --- |
| `rocketride://status` | Connection state and currently running tasks: `{"connected": true, "pipeline_count": N, "pipelines": ["name", ...]}` | Live, never cached |
| `rocketride://pipelines` | The team deployments you can see — exactly what `deploy_list` returns with no arguments, minus `ok`: `{"deployments": [...], "count": N, "total": N, "page": 1, "pageSize": 50}`. Only the first page; call `deploy_list` for more | Cached up to 30 s |

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

Widgets follow the host's light or dark theme, and use the system setting
when a host sends none.

### Widget security metadata

Every widget resource carries the same `_meta` on its `resources/list`
entry and on its `resources/read` content item. Hosts that follow the MCP Apps
spec, ChatGPT among them, read it from the `resources/read` result.

- `csp`: what the widget may load and contact. The bundles are single files
  with no outside scripts, styles, fonts or frames, so `resourceDomains` is
  empty for all three. Only the file dropper connects out: its
  `connectDomains` holds the engine's origin and the MCP server's own, where
  it uploads files (one origin when the engine serves its own MCP endpoint).
  The pipelines table and the trace viewer call tools through the host and
  declare no origins.
- `openai/widgetDomain` (next to `ui`, not inside it): ChatGPT's widget
  domain, from `MCP_UI_DOMAIN` (see [Self-hosting](/connect/mcp/http/self-hosting)).
  It is left out when that is unset. The server never sends `ui.domain`:
  each host has its own format for it, so other hosts get no domain and use
  their default sandbox origin.

```json
{
  "uri": "ui://rocketride/dropper.html",
  "mimeType": "text/html;profile=mcp-app",
  "text": "<!doctype html>...",
  "_meta": {
    "ui": {
      "csp": { "connectDomains": ["https://engine.example.com"], "resourceDomains": [] }
    },
    "openai/widgetDomain": "https://widgets.example.com"
  }
}
```

The dropper's upload is also a cross-origin request from the host's widget
sandbox, so the `RR_CORS_ORIGINS` allowlist of the server that takes the
upload must include that sandbox origin.

**Self-hosters:** the widget bundles are built with `./builder
mcp-widgets:build`; until they exist on disk the server simply advertises no
MCP Apps capability and every host gets the JSON results.
