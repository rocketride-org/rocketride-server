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
