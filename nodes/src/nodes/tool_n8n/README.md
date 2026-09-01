# tool_n8n

A RocketRide node that invokes an n8n webhook from pipeline lanes or gives an
agent controlled access to an n8n instance. Pick it when an existing n8n
workflow is the right automation boundary rather than rebuilding that flow on
the RocketRide canvas.

## About n8n

n8n is a workflow-automation product that connects services and custom logic
through executable workflows. It can expose a workflow through webhooks and a
public API; this node uses those interfaces from RocketRide.

## What it does

Connects a RocketRide pipeline to [n8n](https://n8n.io) workflow automation. It's a **dual node**:

- **Pipeline step** — lane input is POSTed to a workflow's webhook and the workflow's response flows out to the next node.
- **Agent tool** — an agent can trigger workflows and inspect workflows/executions at runtime.

n8n is self-hosted, so you configure your instance's **Base URL** and (for listing/polling) a **public API key**.

## Lanes

**Lanes:**

| Lane in     | Lane out            | Description                                                        |
| ----------- | ------------------- | ------------------------------------------------------------------ |
| `text` | `text` | Sends text to the configured workflow and emits its result |
| `text` | `answers` | Sends text to the configured workflow and emits its result |
| `text` | `table` | Sends text to the configured workflow and emits its result |
| `questions` | `answers` | Sends question text to the workflow and emits its result |
| `questions` | `text` | Sends question text to the workflow and emits its result |
| `questions` | `table` | Sends question text to the workflow and emits its result |
| `documents` | `documents` | Sends documents to the configured workflow and emits its result |
| `documents` | `text` | Sends documents to the configured workflow and emits its result |
| `documents` | `table` | Sends documents to the configured workflow and emits its result |
| `image` | `image` | Sends binary input as multipart and emits returned image data |
| `image` | `text` | Sends binary input as multipart and emits a text result |
| `image` | `answers` | Sends binary input as multipart and emits an answer result |
| `image` | `table` | Sends binary input as multipart and emits a structured result |
| `audio` | `audio` | Sends binary input as multipart and emits returned audio data |
| `audio` | `text` | Sends binary input as multipart and emits a text result |
| `audio` | `answers` | Sends binary input as multipart and emits an answer result |
| `audio` | `table` | Sends binary input as multipart and emits a structured result |
| `video` | `video` | Sends binary input as multipart and emits returned video data |
| `video` | `text` | Sends binary input as multipart and emits a text result |
| `video` | `answers` | Sends binary input as multipart and emits an answer result |
| `video` | `table` | Sends binary input as multipart and emits a structured result |

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

The agent never chooses the host — every request targets the configured Base URL — and `workflow` arguments are sanitized to a plain webhook path.

Tool calls return a `success` flag and an `error` message on validation or API
failure. `trigger_workflow` uses its optional `workflow` argument or the
configured workflow, and `get_workflow`, `get_execution`,
`activate_workflow`, and `deactivate_workflow` each require an `id`.

## Configuration

Configure the Base URL and the webhook path first. The default synchronous,
simple-payload setup suits a workflow that returns one response; most other
fields can remain at their defaults.

### Payload shape and result mode

Use **structured** payloads when the workflow needs separate document content
and metadata; the default **simple** mode flattens input into one `data`
string for compatibility. **Sync** waits for the webhook response and should
be paired with a response-producing workflow. Choose **async** for a long run:
it polls the public API and therefore requires the API key. Raise the matching
timeout only when the workflow genuinely needs longer than the 30-second sync
or 120-second async defaults.

### Authentication and write access

Webhook authentication is independent of the public API key. Match it to the
target Webhook node, supplying the relevant header, basic credentials, or
bearer/JWT token only for its selected mode. Keep TLS verification enabled
unless a self-signed local HTTPS instance requires otherwise. Read-only mode
is on by default; disable it only when the agent is explicitly allowed to
activate or deactivate workflows.

## Notes

### Setup

- **Triggering is webhook-only.** The target workflow needs a **Webhook** trigger node. Manual/cron/event-triggered workflows can't be triggered over HTTP directly — wrap them with a webhook **dispatcher** (Execute Sub-Workflow); see the [n8n integration guide](../../../../docs/public/product/integrations/n8n.md).
- **Activate the workflow.** A production webhook (`/webhook/...`) only exists once the workflow is **activated/published** in n8n — otherwise the call 404s and the node tells you to activate it. While editing, set `test_mode` to use the editor's one-shot `/webhook-test/...` route.
- **Return a result.** For `sync` mode, the workflow must end in a **"Respond to Webhook"** node (or set the Webhook node to respond when the last node finishes); otherwise n8n only returns a "workflow started" ack and the node warns you.
- **Docker reachability.** If RocketRide runs in a container, `localhost` points at the container, not your machine. Use `http://host.docker.internal:5678` (Docker Desktop, or add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux), or run n8n on the same Docker network and use `http://n8n:5678`. The node detects this and suggests the fix.

### Round-trips (n8n → RocketRide)

The reverse direction needs no special node: any RocketRide pipeline with a `webhook`/`chat`/`dropper` source is HTTP-callable from n8n's **HTTP Request** node, enabling RR→n8n→RR round-trips. See the [n8n integration guide](../../../../docs/public/product/integrations/n8n.md) and the templates [`examples/n8n-roundtrip.pipe`](../../../../examples/n8n-roundtrip.pipe) + [`examples/n8n-call-rocketride.workflow.json`](../../../../examples/n8n-call-rocketride.workflow.json).

### Environment variables

Either set fields in the node config or use env vars:

```bash
ROCKETRIDE_N8N_URL=http://localhost:5678
ROCKETRIDE_N8N_KEY=...   # n8n public API key
```

## Upstream docs

- [n8n documentation](https://docs.n8n.io)
