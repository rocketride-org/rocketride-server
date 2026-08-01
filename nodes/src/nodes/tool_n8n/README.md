---
title: n8n
date: 2026-06-10
sidebar_position: 1
---

<head>
  <title>n8n - RocketRide Documentation</title>
</head>

## What it does

Connects a RocketRide pipeline to [n8n](https://n8n.io) workflow automation. It's a **dual node**:

- **Pipeline step** — lane input is POSTed to a workflow's webhook and the workflow's response flows out to the next node.
- **Agent tool** — an agent can trigger workflows and inspect workflows/executions at runtime.

n8n is self-hosted, so you configure your instance's **Base URL** and (for listing/polling) a **public API key**.

## Connections

This node has no required `invoke` connections. As a tool it binds to an agent's tool channel; as a pipeline step it wires by lanes.

## As a pipeline node

**Lanes:**

| Lane in     | Lane out            | Description                                                        |
| ----------- | ------------------- | ------------------------------------------------------------------ |
| `text`      | `text`, `answers`, `table`   | Sends the text to the configured workflow; emits the result   |
| `questions` | `answers`, `text`, `table`   | Sends the question text to the workflow; emits the result     |
| `documents` | `documents`, `text`, `table` | Sends the documents to the workflow; emits the result         |
| `image` / `audio` / `video` | `image` / `audio` / `video`, `text` | Uploads the binary to the workflow as multipart; emits binary returned by n8n back onto the matching lane |

Structured (`payloadMode: structured`) and binary requests preserve document boundaries/metadata and file bytes; a `table` listener receives structured (dict/list) results.

The accumulated input is sent to the configured **Workflow (webhook path)** as JSON `{"data": "<input>"}`. The webhook response is emitted to whichever output lanes are connected.

## As a tool

Exposes these functions to an agent (namespaced under `n8n`):

| Function                | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `n8n.trigger_workflow`  | Trigger a workflow by its webhook path; returns the response             |
| `n8n.list_workflows`    | List workflows (id, name, active, webhook paths) — needs API key         |
| `n8n.get_workflow`      | Get one workflow by id — needs API key                                   |
| `n8n.list_executions`   | List recent executions (status, timestamps) — needs API key              |
| `n8n.get_execution`     | Get one execution by id, with data — needs API key                       |
| `n8n.activate_workflow` | Activate a workflow (blocked in read-only mode) — needs API key          |
| `n8n.deactivate_workflow` | Deactivate a workflow (blocked in read-only mode) — needs API key      |

The agent never chooses the host — every request targets the configured Base URL — and `workflow` arguments are sanitised to a plain webhook path.

## Configuration

| Field                | Default                 | Description                                                                        |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| n8n Base URL         | `http://localhost:5678` | Your n8n instance URL. In Docker, use `http://host.docker.internal:5678` (see below). |
| API Key              | —                       | n8n public API key (`X-N8N-API-KEY`). Only for listing/inspecting/polling.         |
| Workflow             | —                       | Webhook path the target workflow listens on (the pipeline step triggers this).     |
| Payload shape        | `simple`                | Pipeline step body: `simple` → `{"data": text}`; `structured` → `{text, documents:[{content, metadata}]}` (preserves document boundaries/metadata). |
| Result mode          | `sync`                  | `sync` waits for the webhook response; `async` triggers then polls the execution via the public API (API key required). |
| Sync timeout         | `30`                    | Max seconds to wait for the webhook response in sync mode (1–3600).                |
| Async timeout        | `120`                   | Max seconds to wait for an async execution before raising an error (5–3600).      |
| Webhook auth         | `none`                  | Auth on the workflow's Webhook node (`none` / `header` / `basic` / `bearer` / `jwt`) — separate from API key. |
| Verify TLS certificate | `Yes`                 | Leave ON; disable only for a self-signed local n8n over HTTPS.                     |
| Read-only mode       | `Yes`                   | When ON, blocks write operations (activate/deactivate).                            |

## Setup notes

- **Triggering is webhook-only.** The target workflow needs a **Webhook** trigger node. Manual/cron/event-triggered workflows can't be triggered over HTTP directly — wrap them with a webhook **dispatcher** (Execute Sub-Workflow); see the [n8n integration guide](../../../../docs/README-n8n.md).
- **Activate the workflow.** A production webhook (`/webhook/...`) only exists once the workflow is **activated/published** in n8n — otherwise the call 404s and the node tells you to activate it. While editing, set `test_mode` to use the editor's one-shot `/webhook-test/...` route.
- **Return a result.** For `sync` mode, the workflow must end in a **"Respond to Webhook"** node (or set the Webhook node to respond when the last node finishes); otherwise n8n only returns a "workflow started" ack and the node warns you.
- **Docker reachability.** If RocketRide runs in a container, `localhost` points at the container, not your machine. Use `http://host.docker.internal:5678` (Docker Desktop, or add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux), or run n8n on the same Docker network and use `http://n8n:5678`. The node detects this and suggests the fix.

## Round-trips (n8n → RocketRide)

The reverse direction needs no special node: any RocketRide pipeline with a `webhook`/`chat`/`dropper` source is HTTP-callable from n8n's **HTTP Request** node, enabling RR→n8n→RR round-trips. See the [n8n integration guide](../../../../docs/README-n8n.md) and the templates [`examples/n8n-roundtrip.pipe`](../../../../examples/n8n-roundtrip.pipe) + [`examples/n8n-call-rocketride.workflow.json`](../../../../examples/n8n-call-rocketride.workflow.json).

## Environment variables

Either set fields in the node config or use env vars:

```bash
ROCKETRIDE_N8N_URL=http://localhost:5678
ROCKETRIDE_N8N_KEY=...   # n8n public API key
```

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_n8n.apiKey` | `string` | **API Key (X-N8N-API-KEY)**<br/>n8n public API key. Needed only to list/inspect workflows and poll executions — not for triggering webhooks. | `""` |
| `tool_n8n.asyncTimeout` | `integer` | **Execution timeout (seconds)**<br/>Max seconds to wait for an async execution to finish before raising an error. | `120` |
| `tool_n8n.baseUrl` | `string` | **n8n Base URL**<br/>Base URL of your n8n instance, e.g. http://localhost:5678 or https://n8n.example.com. If RocketRide runs in Docker, use http://host.docker.internal:5678 (or the n8n container name) — 'localhost' would point at the container. | `"http://localhost:5678"` |
| `tool_n8n.mode` | `string` | **Result mode**<br/>Sync requires the workflow to end in a 'Respond to Webhook' node. Async polls the execution via the public API (API key required). | `"sync"` |
| `tool_n8n.payloadMode` | `string` | **Payload shape (pipeline step)**<br/>How lane input is sent to the workflow. 'structured' preserves document boundaries + metadata; 'simple' (default) flattens to a single string for back-compat. | `"simple"` |
| `tool_n8n.readOnly` | `boolean` | **Read-only mode**<br/>When ON, write operations (activate/deactivate workflow) are blocked. | `true` |
| `tool_n8n.syncTimeout` | `integer` | **Response timeout (seconds)**<br/>Max seconds to wait for the webhook response in sync mode (raise for slow workflows). | `30` |
| `tool_n8n.verifyTls` | `boolean` | **Verify TLS certificate**<br/>Leave ON. Disable only for a self-signed local n8n served over HTTPS. | `true` |
| `tool_n8n.webhookAuth` | `string` | **Webhook auth**<br/>Authentication on the workflow's Webhook node. Separate from the API key above. | `"none"` |
| `tool_n8n.webhookHeaderName` | `string` | **Header name**<br/>Header name (when Webhook auth = Header auth). | `""` |
| `tool_n8n.webhookHeaderValue` | `string` | **Header value**<br/>Header value (when Webhook auth = Header auth). | `""` |
| `tool_n8n.webhookPassword` | `string` | **Password**<br/>Password (when Webhook auth = Basic auth). | `""` |
| `tool_n8n.webhookToken` | `string` | **Token**<br/>Token sent as 'Authorization: Bearer <token>' (when Webhook auth = Bearer token or JWT). | `""` |
| `tool_n8n.webhookUser` | `string` | **Username**<br/>Username (when Webhook auth = Basic auth). | `""` |
| `tool_n8n.workflow` | `string` | **Workflow (webhook path)**<br/>The webhook path the target workflow listens on (set on its Webhook node). Used by the pipeline step and as the default for the trigger tool. | `""` |

## Dependencies

- `requests` `>=2.34.2`
- `idna` `>=3.10`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_n8n)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
