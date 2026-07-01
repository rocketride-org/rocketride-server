# tool_xtrace_memory

A RocketRide tool node that gives an AI agent long-term, shared memory, `remember` and `recall`, backed by the [xTrace Memory Manager](https://docs.mem.xtrace.ai) service.

## What it does

Exposes two agent tools backed by the xTrace Memory Manager HTTP API. `remember` sends
conversation turns to xTrace, which runs server-side LLM extraction to pull out **facts**
(and optionally **artifacts**) and **episodes**, embeds them, and stores them in your org's
memory pool. `recall` retrieves the relevant slice with natural-language search, optionally
LLM-composed into a ready-to-inject context block. That extraction + relevance selection is
the "reasoning" layer a plain vector store doesn't give you.

This is a `tool` node, not the agent's `memory` subsystem. RocketRide's `memory` classType is
a single, run-scoped scratchpad (e.g. `memory_internal`, `put`/`get`/`peek`) that the agent
uses internally and excludes from tool discovery. xTrace is different: an external service for
**long-term, semantic, shared** recall that the agent calls explicitly via tools. It therefore
*complements* the required short-term memory subsystem rather than replacing it, wire both.

The store is persistent and shared: it is never cleared when a pipeline or session opens, and
anything one agent remembers can be recalled by another agent pointing at the same org, and,
via groups, across users.

Uses **requests** + **tenacity** to talk to the documented HTTP API directly (the xTrace
Python SDK is on their roadmap). Ingest is synchronous by default (`wait` is on): the
`remember` call waits up to `ingest_timeout` seconds for extraction to finish so the agent
gets a terminal result. Ingest is a non-idempotent write, so it is retried only on HTTP 429,
never on 5xx or timeouts, to avoid duplicate memories; idempotent reads retry on 429, 5xx,
and timeouts with exponential backoff.

---

## Configuration

Only `api_key` and `org_id` are required. The fields below `show_advanced` are hidden in the
UI until the **Advanced settings** toggle is turned on; the defaults work for most cases.


| Field | Type | Description |
|---|---|---|
| `api_key` | string | Default empty. xTrace API key (xtk_...). Get it from the <b>Developer Portal</b>: <a href='https://app.xtrace.ai' target='_blank'>app.xtrace.ai</a> → Settings → API Keys (not in mem.xtrace.ai). |
| `org_id` | string | Default empty. xTrace organization id (org_...). Same place as the API key: <a href='https://app.xtrace.ai' target='_blank'>app.xtrace.ai</a> → Settings → API Keys. |
| `user_id` | string | Default empty. Who this memory belongs to (used to store and recall). Can be passed by the agent per call. |
| `group_ids` | string | Default empty. Optional. Comma-separated group ids (grp_...) to share memory across users/agents. Leave empty for private memory. |
| `show_advanced` | boolean | Default false. Show advanced options. The defaults work for most cases, leave off for a simple setup. |
| `base_url` | string | Default "https://api.production.xtrace.ai". xTrace Memory API base URL. Production by default; use https://api.staging.xtrace.ai for staging. |
| `agent_id` | string | Default empty. Optional agent scope stamped on ingested memories and AND-narrowed on recall. |
| `app_id` | string | Default empty. Optional app scope stamped on ingested memories and AND-narrowed on recall. |
| `wait` | boolean | Default true. When on, ingest waits (up to ~30s) for extraction to finish so the agent gets a terminal result. When off, ingest returns immediately and runs in the background. |
| `ingest_timeout` | integer | Default 30. Max seconds to wait/poll for an ingest job to reach a terminal state. |
| `extract_artifacts` | boolean | Default false. Opt into artifact extraction (the most expensive stage). Facts and episodes are always extracted. Leave off unless you need it. |
| `search_mode` | string | Default "compose". 'compose' returns a ready-to-inject markdown context block (LLM-selected); 'retrieve' returns ranked rows only. |
| `search_limit` | integer | Default 10. Maximum number of memory rows to retrieve per recall. |


---

## Available tools

The node's prefix is `xtrace`, so the tools surface to the agent as `xtrace.remember` and
`xtrace.recall`.

### remember

`POST /v1/memories`: store conversation turns in shared, persistent memory. xTrace extracts
facts and episodes server-side so they can be recalled later by this or other agents in the
same org/group.


| Tool | Description |
|---|---|---|
| `remember` | Store conversation turns in shared, persistent memory. xTrace extracts facts and episodes server-side so they can be recalled later by this or other agents in the same org/group. |
| `recall` | Search shared memory for context relevant to a query. In compose mode returns a ready-to-inject context block plus the ranked memories behind it. |


Returns `{success, status, job_id, memories_created, error}` where `status` is
`succeeded` / `failed` / `pending` (`pending` only when `wait` is off or the timeout is hit).

### recall

`POST /v1/memories/search`: search shared memory for context relevant to a query. In compose
mode returns a ready-to-inject context block plus the ranked memories behind it.

| Argument    | Description |
|-------------|-------------|
| `query`     | Required. Natural-language query describing what context is needed. |
| `user_id`   | Scope to one user. Defaults to the node config value. |
| `group_ids` | Scope to shared groups (any-of). Defaults to the node config value. |
| `mode`      | `compose` or `retrieve`. Defaults to the node config `search_mode`. |
| `limit`     | Max rows to retrieve (1–100). Defaults to the node config `search_limit`. |

Returns `{success, context, results, count, error}`: `context` is the ready-to-inject
markdown (compose mode, otherwise empty); `results` rows carry `id`, `type`, `text`, `score`.

At least one scope axis is required by the API: a recall with no `user_id`, no `group_ids`,
and no configured `agent_id` / `app_id` returns an error instead of searching the whole org.

---

## Wiring

This is a control-plane tool node with no data lanes. Wire it to an agent via `control`
(class `tool`), alongside the agent's required `memory` node:

```jsonc
{
  "id": "tool_xtrace_memory_1",
  "provider": "tool_xtrace_memory",
  "config": { "type": "tool_xtrace_memory" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent discovers `xtrace.remember` / `xtrace.recall` as tools and calls them per its
instructions. Point several agents (in one pipe or across runs) at the same `org_id`
(+ `group_ids`) to give them one shared brain.

---

## Authentication

Get your credentials from the **Developer Portal: [app.xtrace.ai](https://app.xtrace.ai) →
Settings → API Keys**, copy your **Org id** (`org_…`) and create an **API key** (`xtk_…`).
They are not in `mem.xtrace.ai`.

Both can also come from environment variables (`XTRACE_API_KEY`, `XTRACE_ORG_ID`) instead of
node config. Every request sends the `x-api-key` and `X-Org-Id` headers. Never commit keys,
use node config (encrypted at rest) or env vars.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `xtrace_memory.agent_id` | `string` | **Agent id**<br/>Optional agent scope stamped on ingested memories and AND-narrowed on recall. | `""` |
| `xtrace_memory.api_key` | `string` | **API Key**<br/>xTrace API key (xtk_...). Get it from the <b>Developer Portal</b>: <a href='https://app.xtrace.ai' target='_blank'>app.xtrace.ai</a> → Settings → API Keys (not in mem.xtrace.ai). | `""` |
| `xtrace_memory.app_id` | `string` | **App id**<br/>Optional app scope stamped on ingested memories and AND-narrowed on recall. | `""` |
| `xtrace_memory.base_url` | `string` | **Base URL**<br/>xTrace Memory API base URL. Production by default; use https://api.staging.xtrace.ai for staging. | `"https://api.production.xtrace.ai"` |
| `xtrace_memory.extract_artifacts` | `boolean` | **Extract artifacts**<br/>Opt into artifact extraction (the most expensive stage). Facts and episodes are always extracted. Leave off unless you need it. | `false` |
| `xtrace_memory.group_ids` | `string` | **Group ids (shared memory)**<br/>Optional. Comma-separated group ids (grp_...) to share memory across users/agents. Leave empty for private memory. | `""` |
| `xtrace_memory.ingest_timeout` | `integer` | **Ingest timeout (s)**<br/>Max seconds to wait/poll for an ingest job to reach a terminal state. | `30` |
| `xtrace_memory.org_id` | `string` | **Org id**<br/>xTrace organization id (org_...). Same place as the API key: <a href='https://app.xtrace.ai' target='_blank'>app.xtrace.ai</a> → Settings → API Keys. | `""` |
| `xtrace_memory.search_limit` | `integer` | **Recall limit**<br/>Maximum number of memory rows to retrieve per recall. | `10` |
| `xtrace_memory.search_mode` | `string` | **Recall mode**<br/>'compose' returns a ready-to-inject markdown context block (LLM-selected); 'retrieve' returns ranked rows only. | `"compose"` |
| `xtrace_memory.show_advanced` | `boolean` | **Advanced settings**<br/>Show advanced options. The defaults work for most cases, leave off for a simple setup. | `false` |
| `xtrace_memory.user_id` | `string` | **User id**<br/>Who this memory belongs to (used to store and recall). Can be passed by the agent per call. | `""` |
| `xtrace_memory.wait` | `boolean` | **Synchronous ingest**<br/>When on, ingest waits (up to ~30s) for extraction to finish so the agent gets a terminal result. When off, ingest returns immediately and runs in the background. | `true` |

## Dependencies

- `requests`
- `tenacity`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_xtrace_memory)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
