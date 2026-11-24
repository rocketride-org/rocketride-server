# n8n-nodes-rocketride

An [n8n](https://n8n.io) community node for [RocketRide](https://github.com/rocketride-org) — **run RocketRide AI pipelines from your n8n workflows, and trigger n8n workflows from RocketRide.** It has zero runtime dependencies.

## Installation

After this package is published to npm, self-hosted n8n instance owners can open **Settings → Community Nodes → Install** and enter `n8n-nodes-rocketride`.

On n8n Cloud, RocketRide will be available from the Nodes panel after n8n approves it as a verified community node.

To let n8n's **AI Agent** call RocketRide as a tool, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on your instance.

## Use cases

The RocketRide node invokes deployed RocketRide pipelines. Those pipelines perform the AI work; the n8n node sends inputs to them and returns their outputs.

- Parse documents and run OCR.
- Extract structured data.
- Anonymize or redact PII.
- Transform, classify, and summarize data.
- Power RAG workflows.
- Run chat and agent pipelines, including as an n8n AI Agent tool.

## Nodes

### RocketRide (action) — n8n → RocketRide

Calls a deployed RocketRide pipeline and returns its result. Set **Pipeline Address** to the pipeline's address, `developerId.pipelineId.source` (shown in the pipeline's endpoint info in RocketRide); leave it empty only when the credential's key is scoped to exactly one pipeline endpoint.

| Operation | What it sends |
| --- | --- |
| **Run Pipeline** | **Text** (raw), **JSON**, or **Structured** (`text` + `documents` with metadata — for RAG/document pipelines) |
| **Upload Files** | one or more n8n binary fields as `multipart/form-data` (16 MB cap), plus optional text |
| **Chat** | a question to a chat-enabled pipeline (toggle **Expect JSON**, optional role) |

- **`usableAsTool`** — an n8n AI Agent can call this node directly.
- **Normalized output** — a single pipeline result is lifted to the top level. RocketRide names output lanes dynamically (e.g. `chat_response`, not `answers`), so the node never hard-codes lane names; counts, result types and a result's token counts (`tokens`) are kept under `_rocketride`.

### RocketRide Trigger — RocketRide → n8n

Starts a workflow when a RocketRide pipeline calls in — a branded replacement for a generic Webhook node. Paste this trigger's URL into RocketRide's **n8n** node. Features: lifts the incoming payload to the top level, an optional shared **Secret** (checked on the `Authorization` header, rejected with `401`), and a configurable **Respond** mode (immediately / when the workflow finishes / via a *Respond to Webhook* node).

## Credentials

### RocketRide API

| Field | Notes |
| --- | --- |
| **Base URL** | Your RocketRide HTTP gateway, e.g. `http://localhost:5567`. |
| **API Key** | Your RocketRide API key (`rr_…`): an account key, which reaches every pipeline your account may call, or a key scoped to one pipeline endpoint, minted from that pipeline's endpoint info. Sent as a Bearer token. Runs are billed to the key's account. |
| **Ignore SSL Issues** | Only for a self-signed local HTTPS gateway. |

> The credential test calls the authenticated `GET /status`, so it checks the Base URL and the key together.

> **Upgrading from 0.x:** the per-pipeline keys 0.x used are no longer accepted. Re-enter the credential with an `rr_` key, and set **Pipeline Address** on each RocketRide node.

## How the two directions connect

- **n8n → RocketRide:** the **RocketRide** action node calls a deployed pipeline's webhook (`POST {baseUrl}/webhook/{address}`, or `POST {baseUrl}/webhook` with a key scoped to one endpoint).
- **RocketRide → n8n:** the **RocketRide Trigger** receives the call RocketRide's `tool_n8n` node makes.
- **Round-trips:** chain them — an n8n workflow can call RocketRide, and a RocketRide pipeline can call back into a *second* n8n workflow that starts with a RocketRide Trigger.

## Reachability

On the same machine, prefer `http://127.0.0.1:<port>` over `localhost` — n8n's Node.js runtime may resolve `localhost` to IPv6 (`::1`), which a local RocketRide engine typically doesn't listen on (you'd see "connection refused").

If RocketRide or n8n runs in Docker and the other doesn't, `localhost` won't cross the container boundary — use `http://host.docker.internal:5567` (Docker Desktop), add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux, or run both on the same Docker network. The node detects these and includes the hint in its error message.

## Compatibility

Requires n8n **1.94.0+**.

## Example

Import [`examples/run-pipeline.workflow.json`](https://github.com/rocketride-org/rocketride-server/blob/develop/packages/n8n-nodes/examples/run-pipeline.workflow.json) into n8n. To have something to call, deploy a webhook-source pipeline in RocketRide (see [`examples/rocketride-webhook.pipe`](https://github.com/rocketride-org/rocketride-server/blob/develop/packages/n8n-nodes/examples/rocketride-webhook.pipe)) put your gateway URL and an `rr_` API key in the RocketRide API credential, and set the node's **Pipeline Address** to the pipeline's address (`developerId.pipelineId.webhook_1` for that example).

## License

[MIT](LICENSE)
