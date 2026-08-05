# n8n ↔ RocketRide Integration

RocketRide and [n8n](https://n8n.io) connect in both directions:

- **RocketRide → n8n:** the [`tool_n8n` node](../nodes/src/nodes/tool_n8n/README.md) triggers n8n
  workflows from a pipeline step or an agent tool.
- **n8n → RocketRide:** any n8n workflow calls a RocketRide pipeline through the pipeline's
  webhook endpoint, using n8n's built-in **HTTP Request** node.

Combining the two gives **round-trips**: RocketRide → n8n → RocketRide.

> Templates: [`examples/n8n-roundtrip.pipe`](../examples/n8n-roundtrip.pipe) (RR side) and
> [`examples/n8n-call-rocketride.workflow.json`](../examples/n8n-call-rocketride.workflow.json)
> (n8n side, importable).
>
> **Runnable test pipes** that exercise every mode (sync / async / sequential / agent / round-trip)
> live in [`examples/n8n/`](../examples/n8n/) — open them in the IDE. They pair with the local
> test harness in `.context/n8n-test/` (`run.sh --keep` seeds the `rr-echo` / `rr-slow` / `rr-upper`
> / `rr-callback` workflows); see that folder's `WALKTHROUGH.md` for the step-by-step.

---

## RocketRide → n8n (the `tool_n8n` node)

Drop the **n8n** node into a pipeline (wired by lanes) or attach it to an agent (tool channel).
Full reference: [`nodes/src/nodes/tool_n8n/README.md`](../nodes/src/nodes/tool_n8n/README.md).

The essentials:

1. The target n8n workflow needs a **Webhook trigger** node — triggering is webhook-only;
   manual/cron workflows can't be called over HTTP.
2. **Activate/publish** the workflow — the production `/webhook/...` route 404s until then.
3. End the workflow with a **"Respond to Webhook"** node so a result comes back (`sync` mode).
   For long runs, switch the node to `async` mode: it injects a correlation id, then polls
   executions via the public API (API key required) until the run finishes.

### Sending files / structured data

- **Structured data:** set the node's **Payload shape** to `structured` — the pipeline step sends
  `{text, documents:[{content, metadata}]}` (preserving document boundaries + metadata) instead of
  flattening to `{"data": "..."}`. The `simple` default stays back-compatible.
- **Files / binary:** wire an `image` / `audio` / `video` lane into the node — it uploads the bytes
  to n8n as `multipart/form-data` (binary part `image_0` etc., text alongside as form fields), and
  if the workflow Responds with a Binary File, the bytes come back onto the matching lane. Capped at
  16 MB (n8n's default `N8N_PAYLOAD_SIZE_MAX`) with a clear error.

### Reaching non-webhook workflows (cron / manual / event)

Triggering is webhook-only, and n8n's public API has no "run-by-id" — so a workflow whose trigger is
a **Schedule/Cron**, **Manual**, or an **app event** (Gmail, etc.) can't be invoked on demand
directly. (Such workflows still run on their own schedule; this is only about invoking them on demand
from RocketRide.)

**Escape hatch — a thin webhook dispatcher** that calls the target via n8n's **Execute Sub-Workflow** node:

```text
[RR tool_n8n] → POST /webhook/my-dispatch
                  │
n8n dispatcher: [Webhook] → [Execute Sub-Workflow → target] → [Respond to Webhook]
                  │ returns the target's output
```

1. On the **target** workflow, add an **"Execute Sub-Workflow Trigger"** ("When Executed by Another Workflow") as an entry point.
2. Import [`examples/n8n/n8n-dispatch.workflow.json`](../examples/n8n/n8n-dispatch.workflow.json), point its **Execute Workflow** node at the target, and **activate** it.
3. Set `tool_n8n`'s **Workflow** to the dispatcher's webhook path (`my-dispatch`); it's triggered like any webhook and the target's output flows back. (Verified end-to-end in the test harness: `rr-dispatch` → `rr-sub`.)

## n8n → RocketRide

Any RocketRide pipeline that starts with a **webhook**, **chat**, or **dropper** source node is
HTTP-callable. When such a pipeline starts, the source node publishes its connection details
(shown in the IDE): the **interface URL** (e.g. `http://localhost:5567/webhook`), a **public
authorization key**, and a **private token**.

In n8n, add an **HTTP Request** node:

| Setting | Value |
| ------- | ----- |
| Method  | `POST` |
| URL     | the pipeline's interface URL, e.g. `http://localhost:5567/webhook` |
| Header  | `Authorization: <public auth key>` |
| Body    | JSON payload for the pipeline |

The pipeline's `response_*` node determines what comes back to n8n. Import
[`examples/n8n-call-rocketride.workflow.json`](../examples/n8n-call-rocketride.workflow.json)
for a ready-made Webhook → HTTP Request → Respond to Webhook workflow.

## Round-trips (RocketRide → n8n → RocketRide)

Chain the two directions:

```text
RR pipeline A: [source] → [tool_n8n: workflow "rocketride-demo"] → [response]
                                  │ POST /webhook/rocketride-demo
n8n workflow:  [Webhook] → [HTTP Request → RR pipeline B's webhook] → [Respond to Webhook]
                                  │ POST http://.../webhook (pipeline B)
RR pipeline B: [webhook] → … → [response]   — its result returns to n8n, then up to pipeline A
```

Pipeline A's `tool_n8n` step waits for n8n's response, which itself contains pipeline B's
response — synchronous nesting across both systems. Start from
[`examples/n8n-roundtrip.pipe`](../examples/n8n-roundtrip.pipe) for the A side.

---

## Reach any SaaS via n8n (credential vault)

RocketRide ships no built-in SaaS connectors — but n8n has 1000+ (Slack, Gmail, HubSpot, Google
Sheets, Notion, S3, …), each authenticated by n8n's own credential store. So an RR pipeline (or
agent) can act on almost any app by triggering an n8n workflow that does the work:
`Webhook → <app node(s)> → Respond to Webhook`, then drop `tool_n8n` in the pipeline (or attach it
to an agent) pointed at that workflow. The agent-tool face lets an LLM pick which automation to fire
at runtime.

**Payload contract** — what your workflow receives:
- `simple` mode → `$json.body` = `{ "data": "<text>" }`
- `structured` mode → `$json.body` = `{ "text": "...", "documents": [{ "content", "metadata" }] }`
- binary lanes → `multipart/form-data`: text fields in `$json.body`, files in `$binary` (`image_0`, `audio_0`, …)
- `async` mode also injects `_rr_correlation_id` — echo it through so polling can match the run

Return data via a **Respond to Webhook** node (sync) or read it from the execution (async).

## Human-in-the-loop (approvals)

Gate an RR run on a human decision with n8n's **Wait** node. Use **async** mode (a sync HTTP call
would time out waiting for a person): `tool_n8n` (async) → a workflow that pauses on **Wait → On
Webhook Call** (or the **Human in the Loop** node), which exposes `$execution.resumeUrl`; notify the
approver, and when they act n8n resumes and the run returns the decision. (Async requires the API key.)

## Failure handling (error workflows)

Centralize alerting/dead-lettering with an n8n **error workflow**: build one whose first node is the
**Error Trigger**, then in each target workflow's *Settings → Error workflow* select it. On failure
n8n routes the execution + error there (Slack alert, ticket, retry…) — independent of `tool_n8n`,
which still surfaces its own clear errors (404 → activate, ack → add a Respond node, timeout, …).

## Observability

In **async** mode (and from `n8n.get_execution` / `n8n.list_executions`), results carry a `url`
deep-link straight to the run in n8n's execution view — useful for tracing a RocketRide step to its
n8n execution.

## Reachability appendix (read this if anything 404s or times out)

Both directions are plain HTTP, so what matters is **where each process runs**:

| RocketRide deployment | n8n on your machine (`localhost:5678`) | What to enter as the n8n Base URL |
| --------------------- | -------------------------------------- | --------------------------------- |
| **Local** (IDE-managed, native process) | ✅ reachable | `http://localhost:5678` |
| **Docker / On-Prem** (engine in a container) | ❌ `localhost` is the container | `http://host.docker.internal:5678` — on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]`; or run n8n on the same Docker network and use `http://n8n:5678` |
| **Cloud** | ❌ private hosts unreachable | expose n8n publicly or via a tunnel (e.g. Cloudflare Tunnel) and use that URL |

The `tool_n8n` node detects the Docker case at runtime and suggests the fix in its error message.

**The reverse direction has the same physics.** If n8n runs in Docker and RocketRide runs
natively, n8n's HTTP Request node must call `http://host.docker.internal:<port>/webhook`,
not `localhost`.

**n8n behind Docker or a reverse proxy:** set n8n's `WEBHOOK_URL` environment variable to its
externally reachable URL — otherwise n8n displays (and registers) webhook URLs based on what it
sees internally (`localhost:5678`), which other systems can't reach.

**TLS:** a self-signed local n8n over HTTPS fails certificate verification by default — turn off
the node's "Verify TLS certificate" toggle for that case only.
