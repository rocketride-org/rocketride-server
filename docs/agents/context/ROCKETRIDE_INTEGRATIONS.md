# RocketRide Integrations Guide

How the outside world reaches RocketRide pipelines — and how pipelines reach out.

Every integration below drives a **running pipeline**: author the `.pipe` file first
(ROCKETRIDE_PIPELINES.md), start it (IDE, SDK, or CLI), then connect the outside system.
Driving pipelines from your own code is covered by ROCKETRIDE_python_API.md /
ROCKETRIDE_typescript_API.md; this guide covers everything that is *not* your own SDK
code.

## Integration map

| You want to... | Mechanism | Section |
|---|---|---|
| Let Claude / Cursor / any MCP client call your pipelines | `rocketride-mcp` MCP server | §MCP |
| Choose which pipelines appear as tools, and their names | running tasks + pipeline `name`/`description` | §MCP — Controlling the tool list |
| Trigger a pipeline from any external system over HTTP | `webhook` source node + POST | §Webhooks |
| Call a pipeline from an n8n workflow | n8n HTTP Request node → webhook source | §n8n — Calling RocketRide from n8n |
| Trigger an n8n workflow (or any of n8n's 1000+ apps) from a pipeline | `tool_n8n` node | §n8n — Calling n8n from a pipeline |
| Put a Telegram bot in front of a pipeline | `telegram` source node | §Telegram |
| Call an external HTTP API (including your own) mid-pipeline | `tool_http_request` (agent tool) or `tool_n8n` (pipeline step) | §External HTTP APIs |
| Smoke-test a pipeline from CI | `rocketride` CLI + API key secret | §CI smoke tests |

---

## MCP — Expose pipelines as tools for AI assistants

The `rocketride-mcp` server connects to a RocketRide engine over WebSocket (DAP) and
exposes your **running pipelines** as MCP tools. Claude Desktop, Claude Code, Cursor, or
any MCP client can then call a pipeline like any other tool. Discovery is automatic:
start a pipeline (IDE, SDK, or CLI) and it appears as a callable tool; stop it and the
tool disappears on the next tool-list refresh. No registration step.

### Install

```bash
pip install rocketride-mcp
```

Requires Python 3.10+. The package installs two entry points: `rocketride-mcp` (stdio
server, what MCP clients launch) and `rocketride-mcp-sse` (HTTP/SSE variant, see below).

### Configure the environment

The server is configured entirely by environment variables — there is no config file:

| Variable | Required | Description |
|---|---|---|
| `ROCKETRIDE_URI` | Yes | WebSocket URI of the engine, e.g. `ws://localhost:5565` |
| `ROCKETRIDE_AUTH` | Yes* | API key / auth token |
| `ROCKETRIDE_APIKEY` | Yes* | Accepted as an alternative to `ROCKETRIDE_AUTH` |
| `MCP_API_KEY` | No | Bearer token for the SSE variant only |

*One of `ROCKETRIDE_AUTH` / `ROCKETRIDE_APIKEY` must be set; the server refuses to start
without a URI and a key.

### Claude Desktop and Cursor

Both take the same `mcpServers` block. Claude Desktop: add it to
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows). Cursor: add it to
`.cursor/mcp.json` in the workspace.

```json
{
	"mcpServers": {
		"rocketride": {
			"command": "rocketride-mcp",
			"env": {
				"ROCKETRIDE_URI": "ws://localhost:5565",
				"ROCKETRIDE_AUTH": "your-api-key"
			}
		}
	}
}
```

### Claude Code

```bash
claude mcp add rocketride -- rocketride-mcp
```

Set `ROCKETRIDE_URI` and `ROCKETRIDE_AUTH` in the environment before running. You can also
run the server directly for debugging: `rocketride-mcp` or `python -m rocketride_mcp`.

### What a tool call does

Every discovered tool takes exactly one argument: `filepath` (string, required) — the
path to a local file to process. The server reads the file (absolute or relative paths,
`file://` URIs, and `~` expansion all work), streams the bytes into the corresponding
running pipeline, and returns the pipeline's result — human-readable text plus the raw
result under `structuredContent.result`. The input schema is always this single
`filepath`; pipelines that expect chat questions or JSON payloads are better reached over
the webhook interface (§Webhooks) or the SDK.

One extra built-in tool ships with the server: **`RocketRide_Document_Processor`**, a
bundled multi-modal document-parsing pipeline started on the fly, so it works even with no
pipelines of your own running.

### Controlling the tool list

**Which pipelines become tools:** exactly the tasks *running* and *visible to the API key*
the server was configured with. That gives you two levers:

1. **Run state.** Only running pipelines are listed — completed or queued tasks are not.
   Stop a pipeline to remove its tool.
2. **Key identity.** Personal runs (dev runs and personal deploys) are owner-only: listed
   only for the account that started them, never for teammates. Team deploy runs are
   listed for anyone with permissions on that team. To expose a curated set of tools,
   configure the MCP server with a dedicated account/API key and run only the intended
   pipelines under it.

**How tools are named and described to the model:** from the pipeline JSON itself.

| Tool field | Comes from | Fallback when absent |
|---|---|---|
| name | top-level `name` field of the pipeline | the source component id (e.g. `webhook_1`) |
| description | top-level `description` field of the pipeline | `RocketRide DTC MCP Tool` |

Add both fields at the top level of the `.pipe` file (alongside `components`); they ride
through unchanged when the pipeline starts:

```json
{
	"name": "invoice-parser",
	"description": "Extracts line items, totals, and vendor data from PDF invoices.",
	"components": [ ... ],
	"project_id": "...",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"version": 1
}
```

Write the description for the model: say what the pipeline does, what kind of file it
expects, and what comes back. Keep names **unique among your running pipelines** — tool
execution matches by name, and the first match wins.

### MCP resources and prompts

The server also exposes read-only resources (JSON payloads, `rocketride://` URI scheme):
`rocketride://pipelines` (available pipelines with name + description),
`rocketride://status` (connection status, pipeline count, loaded pipeline names), and
`rocketride://nodes` (available node types and schemas). Three prompt templates ship as
well: `analyze-document` (args `pipeline`, `query`), `chat-with-data` (`pipeline`,
`question`), and `evaluate-pipeline` (`pipeline`, `test_input`, optional
`expected_output`).

### SSE mode (remote / Docker)

For remote or containerized deployments the server can run over HTTP/SSE instead of stdio:

```bash
pip install 'rocketride-mcp[sse]'
rocketride-mcp-sse --host 0.0.0.0 --port 8080
```

Defaults are `localhost:8080`. Set `MCP_API_KEY` to require `Authorization: Bearer` on
every route; without it the server logs a warning and runs unauthenticated. `/health` is
always open for monitoring.

---

## Webhooks — Trigger a pipeline over HTTP

Any pipeline whose source is a `webhook` node is HTTP-callable: external systems POST
files or data to its URL and receive the pipeline's response. (`chat` and `dropper`
sources are also HTTP-reachable — they serve browser UIs — but `webhook` is the raw
machine-to-machine intake.)

### The webhook source node

The node has **no configuration** — endpoint URL and credentials are generated when the
pipeline starts:

```json
{
	"id": "webhook_1",
	"provider": "webhook",
	"config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "webhook" }
}
```

Incoming data is routed by content type onto the node's output lanes: `tags`, `text`,
`json`, `audio`, `video`, `image`, `questions`. Wire downstream components from whichever
lanes you need (ROCKETRIDE_PIPELINES.md §Lanes).

### URL and credentials

When the pipeline starts, the Project Log (IDE task monitor) publishes three things:

- **Webhook interface URL** — `<server>/webhook/<project_id>/<source>`, where
  `project_id` is the pipeline's GUID and `source` is the source component id
  (e.g. `webhook_1`). On a local engine `<server>` defaults to `http://localhost:5565`.
- **Public Authorization Key** — a `pk_...` token.
- **Private Token** — a `tk_...` token.

The legacy `POST <server>/webhook` (no path segments) also works; address the run with a
`?token=<task token>` query parameter or a task-scoped key.

### Authentication

All requests carry an `Authorization` header. The `Bearer` scheme prefix is optional — the
server strips it if present. Three credential types are accepted:

| Credential | Prefix | Scope | Use it for |
|---|---|---|---|
| Public Authorization Key | `pk_` | data submission only, locked to this one run | handing to external systems (n8n, partners, webhooks) |
| Private Token | `tk_` | full task scope (data, monitor, control, debug, store) | your own server-side automation; never share |
| Account API key | — | your whole account | first-party callers; enables the selectors below |

With an **account API key** and the path-addressed URL, the server resolves *your* running
task for that project/source — your dev run by default. Two query selectors change that:
`?teamId=<id>` addresses the team's deploy run of the same project, and `?runKind=deploy`
addresses your personal deploy run. `pk_`/`tk_` keys are already locked to their run, so
they need no token or selector at all.

If the pipeline is not running, the call fails with `Your pipeline is not running` —
webhook endpoints exist only while their pipeline is up.

### Calling it

Multipart upload (file plus text fields):

```bash
curl -X POST "$WEBHOOK_URL" \
     -H "Authorization: $ROCKETRIDE_PUBLIC_KEY" \
     -F 'file=@document.pdf' \
     -F 'question=What is this about?'
```

Raw body stream (any content type; `Content-Disposition` names the file):

```bash
curl -X POST "$WEBHOOK_URL" \
     -H "Authorization: $ROCKETRIDE_PUBLIC_KEY" \
     -H 'Content-Type: application/pdf' \
     -H 'Content-Disposition: attachment; filename=document.pdf' \
     --data-binary @document.pdf
```

Plain text or JSON:

```bash
curl -X POST "$WEBHOOK_URL" \
     -H "Authorization: $ROCKETRIDE_PUBLIC_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"customer": "ACME", "total": 129.90}'
```

### What comes back

The HTTP response is built by the pipeline's `response_*` nodes — each contributes its
`laneName` as a key in the returned JSON (ROCKETRIDE_PIPELINES.md §Response Nodes and
Result Keys). An ingestion pipeline with no response nodes simply stores its output and
returns without result data. Design the pipeline's response nodes to match what the
calling system expects to parse.

---

## n8n — Bidirectional workflow integration

RocketRide and n8n connect in both directions. The combination matters: RocketRide ships
no built-in SaaS connectors, but n8n has 1000+ (Slack, Gmail, Google Sheets, Notion, S3,
...) behind its own credential vault — so a pipeline can act on almost any app by
triggering an n8n workflow that does the work.

### Calling RocketRide from n8n

Any pipeline with a `webhook` (or `chat`/`dropper`) source is callable with n8n's built-in
**HTTP Request** node — no community node needed:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | the pipeline's webhook interface URL (from the Project Log) |
| Header | `Authorization: <public authorization key>` |
| Body | JSON payload (or multipart / raw, as above) |

The pipeline's `response_*` nodes determine what the HTTP Request node receives back, so a
typical n8n workflow is `Webhook trigger -> HTTP Request (RocketRide) -> Respond to
Webhook`. Remember the run must be up — a stopped pipeline answers
`Your pipeline is not running`.

### Calling n8n from a pipeline (`tool_n8n`)

The `tool_n8n` node triggers n8n workflows. It has two faces:

- **Pipeline step** — wire a lane into it; it POSTs the data to the workflow's webhook and
  emits the workflow's response on its output lanes. Deterministic: fires on every item.
- **Agent tool** — attach it to an agent via `control` and the agent gets callable tools
  (`n8n.trigger_workflow`, `n8n.list_workflows`, `n8n.get_workflow`,
  `n8n.list_executions`, `n8n.get_execution`, `n8n.activate_workflow`,
  `n8n.deactivate_workflow`), letting the LLM decide at runtime which automation to fire.

As a pipeline step (adapted from the shipped round-trip template):

```json
{
	"id": "tool_n8n_1",
	"provider": "tool_n8n",
	"config": {
		"type": "tool_n8n",
		"baseUrl": "${ROCKETRIDE_N8N_URL}",
		"apiKey": "${ROCKETRIDE_N8N_KEY}",
		"workflow": "my-workflow-path",
		"mode": "sync",
		"parameters": {}
	},
	"input": [{ "lane": "text", "from": "webhook_1" }]
}
```

Key config fields (see the `tool_n8n` schema for the full set):

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:5678` | Your n8n instance URL |
| `apiKey` | — | n8n public API key (`X-N8N-API-KEY`); needed only for listing/inspecting/polling and `async` mode |
| `workflow` | — | The webhook path the target workflow listens on |
| `payloadMode` | `simple` | `simple` sends `{"data": "<text>"}`; `structured` sends `{text, documents:[{content, metadata}]}` preserving document boundaries |
| `mode` | `sync` | `sync` waits for the webhook response; `async` triggers then polls executions via the public API |
| `syncTimeout` / `asyncTimeout` | `30` / `120` | Max seconds to wait (sync 1-3600, async 5-3600) |
| `webhookAuth` | `none` | Auth configured on the workflow's Webhook node: `none` / `header` / `basic` / `bearer` / `jwt` |
| `verifyTls` | on | Disable only for a self-signed local n8n over HTTPS |
| `readOnly` | on | Blocks activate/deactivate operations |

Three rules the target workflow must follow:

1. **Webhook trigger only.** n8n workflows are only invocable over HTTP through a Webhook
   trigger node. Cron/manual/app-event workflows need a thin dispatcher workflow
   (`Webhook -> Execute Sub-Workflow -> Respond to Webhook`) pointing at the target, which
   gets an "Execute Sub-Workflow Trigger" entry point.
2. **Activate the workflow.** The production `/webhook/...` route 404s until the workflow
   is activated/published.
3. **Respond.** In `sync` mode, end with a "Respond to Webhook" node or you only get a
   "workflow started" ack. For long-running or human-in-the-loop workflows (n8n Wait
   node), use `async` mode — a synchronous call would time out waiting for a person.

**Payload contract** (what the n8n workflow receives): `simple` mode puts
`{ "data": "<text>" }` in `$json.body`; `structured` mode puts
`{ "text": ..., "documents": [...] }` there; binary lanes (`image`/`audio`/`video`) arrive
as `multipart/form-data` with files in `$binary` (`image_0`, `audio_0`, ...) and text
fields in `$json.body`, capped at 16 MB (n8n's default payload limit). If the workflow
responds with a binary file, the bytes come back on the matching lane. `async` mode also
injects `_rr_correlation_id` — echo it through so polling can match the run — and async
results carry a `url` deep-link to the execution in n8n's UI.

**Reachability.** Both directions are plain HTTP, so process placement decides the URL:

| RocketRide runs... | n8n Base URL to configure |
|---|---|
| Locally (native process) | `http://localhost:5678` |
| In Docker | `http://host.docker.internal:5678` (Linux: add the `host-gateway` extra host), or same Docker network + `http://n8n:5678` |
| In the cloud | a publicly reachable n8n URL or tunnel |

The same physics applies in reverse: n8n in Docker calling a native RocketRide must use
`host.docker.internal`, not `localhost`. If n8n itself sits behind Docker or a reverse
proxy, set n8n's `WEBHOOK_URL` env var to its externally reachable URL, or it advertises
webhook URLs nobody can reach. Configure the node through env vars rather than
hardcoding: `ROCKETRIDE_N8N_URL` (base URL) and `ROCKETRIDE_N8N_KEY` (public API key).

**Round-trips** (RocketRide -> n8n -> RocketRide) chain both directions: pipeline A's
`tool_n8n` step triggers a workflow whose HTTP Request node calls pipeline B's webhook;
B's response returns through n8n to A synchronously.

---

## Telegram — A bot in front of a pipeline

The `telegram` source node connects a Telegram bot to a pipeline: incoming messages flow
in on typed lanes, and the pipeline's first answer is automatically sent back to the chat.

### Setup

1. Message `@BotFather` on Telegram, run `/newbot`, and copy the bot token it issues.
2. Put the token in `.env` as a `ROCKETRIDE_*` variable so it substitutes server-side
   (ROCKETRIDE_PIPELINES.md §Environment variable substitution).
3. Author the pipeline with a `telegram` source and start it.

Node configuration (fields live under `config.parameters`):

| Field | Type | Default | Description |
|---|---|---|---|
| `botToken` | string | — | Bot token from @BotFather (required) |
| `mode` | string | `polling` | `polling` works anywhere with no public URL; `webhook` needs a public HTTPS endpoint |
| `webhookUrl` | string | — | Public HTTPS URL Telegram POSTs updates to; required in webhook mode |

A complete minimal Q&A bot (`telegram -> question -> llm -> response_answers`; the
`question` node converts the `text` lane to `questions` for the LLM):

```json
{
	"name": "telegram-support-bot",
	"description": "Answers Telegram messages with GPT-4o.",
	"components": [
		{
			"id": "telegram_1",
			"provider": "telegram",
			"config": {
				"hideForm": true,
				"mode": "Source",
				"type": "telegram",
				"parameters": {
					"botToken": "${ROCKETRIDE_TELEGRAM_TOKEN}",
					"mode": "polling"
				}
			}
		},
		{
			"id": "question_1",
			"provider": "question",
			"config": { "type": "question" },
			"input": [{ "lane": "text", "from": "telegram_1" }]
		},
		{
			"id": "llm_openai_1",
			"provider": "llm_openai",
			"config": {
				"profile": "openai-4o",
				"openai-4o": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" },
				"parameters": {}
			},
			"input": [{ "lane": "questions", "from": "question_1" }]
		},
		{
			"id": "response_answers_1",
			"provider": "response_answers",
			"config": { "laneName": "answers" },
			"input": [{ "lane": "answers", "from": "llm_openai_1" }]
		}
	],
	"project_id": "REPLACE-WITH-A-FRESH-GUID",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"version": 1
}
```

### Message routing

Each Telegram message type lands on one output lane:

| Telegram message | Lane | Notes |
|---|---|---|
| Text | `text` | Plain text |
| Photo | `image` | Largest available size is downloaded |
| Audio / voice note | `audio` | MIME type from the message |
| Video | `video` | |
| Document (PDF, Word, ...) | `tags` | Tagged stream — put a `parse` node downstream |

Stickers, locations, polls, and other unsupported types are silently ignored. Both new and
edited messages are processed.

### Replies and limits

The **first answer** in the pipeline response is sent back to the originating chat
automatically; additional answers are discarded, and no reply is sent if the pipeline
produces none — so wire `response_*` nodes so the pipeline actually produces a response.
Replies beyond Telegram's 4096-character limit are truncated with `...`; files above
Telegram's 20 MB bot-API download limit are skipped. The task monitor shows the last 6
characters of the bot token so you can verify which bot is connected without exposing the
secret.

### Polling vs webhook mode

**Polling** (the default) long-polls the Telegram API from the engine — it works behind
NAT, on laptops, and on RocketRide Cloud, with nothing to expose. Any previously
registered webhook is cleared automatically at startup.

**Webhook** mode is for self-hosted production deployments with a public HTTPS endpoint:
the node registers `webhookUrl` with Telegram along with a random secret, validates every
incoming POST against the `X-Telegram-Bot-Api-Secret-Token` header (wrong or missing
secret gets 403), and deregisters the webhook on shutdown. Your reverse proxy or tunnel
must forward the URL's path to the pipeline's data port. Webhook mode is **self-hosted
only** — cloud tenants cannot expose a pipeline port to Telegram, so use polling there.

---

## External HTTP APIs — Calling out from mid-pipeline

Two mechanisms, one choice: is the call **agent-directed** (an LLM decides when and with
what arguments) or **deterministic** (fires for every item that flows through)?

### Agent-directed: `tool_http_request`

`tool_http_request` is "curl for agents": it exposes a single tool, `http_request`
(registered as `<serverName>.http_request`, default `http.http_request`), to any agent it
is attached to. It has no data lanes — attach it on the control plane
(ROCKETRIDE_PIPELINES.md §Control Connections & Invoke):

```json
{
	"id": "tool_http_request_1",
	"provider": "tool_http_request",
	"config": { "type": "tool_http_request" },
	"control": [{ "classType": "tool", "from": "agent_rocketride_1" }]
}
```

The agent supplies the request. Required: `url`, `method` (`GET`, `POST`, `PUT`, `PATCH`,
`DELETE`, `HEAD`, `OPTIONS`). Optional parameters cover the common cases: `body_json`
(JSON object/array, serialized automatically and sent as `application/json`),
`bearer_token` (becomes `Authorization: Bearer ...`), `basic_auth` (`{username,
password}`), `headers`, `query_params`, `path_params` (replacements for `:name`
placeholders in the URL), and `timeout` (seconds, default 30, capped at 300). Advanced
`auth` (`none`/`basic`/`bearer`/`api_key`, where `api_key` adds a header or query
parameter) and `body` (`raw`/`form_data`/`x_www_form_urlencoded`) objects exist for the
rest. The tool returns `{status_code, status_text, headers, body, json, elapsed_ms,
content_type}` — `json` is auto-parsed when the response is JSON, otherwise `null`.

**Security guardrails** — all configured on the node, all enforced before every request:

| Config field | Default | Effect |
|---|---|---|
| `allowGET` ... `allowDELETE` | `true` | Per-method toggles |
| `allowHEAD`, `allowOPTIONS` | `false` | Off by default |
| `urlWhitelist` | empty | Regex patterns the URL must match. **Empty allows ALL URLs** (a config warning reminds you) |
| `rateLimitPerSecond` | `10` | Token-bucket per-second cap |
| `rateLimitPerMinute` | `100` | Broader throttle |
| `maxConcurrentRequests` | `5` | In-flight cap |

These live directly in the node's `config`
(e.g. `"config": { "type": "tool_http_request", "urlWhitelist": ["^https://api\\.example\\.com/"] }`).
For production, always set `urlWhitelist` — and check the logs after editing it: an
invalid regex is *skipped with a warning*, silently widening the restriction. When a rate
limit is hit the call fails immediately with a retry hint rather than queueing; set all
three limits to `0` to disable rate limiting entirely.

To call your own API with a secret, prefer passing the credential through the agent's
instructions via a `${ROCKETRIDE_*}` substitution or an `api_key` auth object — never
hardcode secrets in the pipeline JSON.

### Deterministic: `tool_n8n` as a pipeline step

For an HTTP call that must run for every item (no LLM in the loop), wire `tool_n8n` into
the data lanes (§n8n) and let a one-node n8n workflow
(`Webhook -> HTTP Request -> Respond to Webhook`) make the actual API call. You get n8n's
credential vault, retries, and execution log for free, and the pipeline step stays a pure
data transform. This is also the route to any SaaS app n8n has a connector for.

---

## CI smoke tests with the CLI

The TypeScript SDK's npm package `rocketride` installs a `rocketride` CLI — the quickest
way to prove, from CI, that a pipeline still starts, accepts data, and shuts down cleanly
against a real engine.

```bash
npm install -g rocketride     # or npx rocketride for a local install
```

Every command takes `--uri <uri>` (default: `ROCKETRIDE_URI` env var, else
`http://localhost:5565` — note the CLI defaults to the *local* server),
`--apikey <key>` (default: `ROCKETRIDE_APIKEY` env var), and
`--json [file]` for a machine-readable result (one JSON value on stdout,
or written to `file`; failures become an `{"error": ...}` envelope with a
non-zero exit — parse that instead of scraping text).

| Command | What it does | Exit code |
|---|---|---|
| `rocketride start --pipeline <file>` | Starts a pipeline, prints its task token, exits | 0 on start, 1 on any error |
| `rocketride upload <files...> --pipeline <file>` | Starts the pipeline, uploads the files, **terminates the run** | 0 / 1 |
| `rocketride upload <files...> --token <token>` | Uploads into an already-running task (does not stop it) | 0 / 1 |
| `rocketride list` | One-shot list of your active tasks | 0 / 1 |
| `rocketride stop --token <token>` | Terminates a running task | 0 / 1 |
| `rocketride store <dir/type/write/rm/mkdir/stat>` | Cloud file store operations | 0 / 1 |
| `rocketride app <create/verify/deploy>` | App scaffold / precheck / registry deploy | 0 / 1 |
| `rocketride deploy <add/publish/run/schedule/...>` | Deploy lifecycle one-shots (deployment target) | 0 / 1 |

`upload --pipeline` is the CI workhorse: one command exercises connect, auth, pipeline
start, data flow, and teardown, and cleans up after itself. For live monitoring use
the platform's event monitor / server monitor apps — every CLI command is one-shot.

### GitHub Actions example

Store the API key as a repository secret (here `ROCKETRIDE_APIKEY`) and keep a small
fixture file in the repo:

```yaml
name: pipeline-smoke

on:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      ROCKETRIDE_URI: ${{ vars.ROCKETRIDE_URI }}         # e.g. https://rocketride.example.com:5565
      ROCKETRIDE_APIKEY: ${{ secrets.ROCKETRIDE_APIKEY }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install the RocketRide CLI
        run: npm install -g rocketride

      - name: Smoke-test the ingest pipeline
        run: rocketride upload smoke/sample.pdf --pipeline pipelines/ingest.pipe
```

To smoke-test an **already-running deployment** instead of starting a fresh run, store its
task token as a secret and upload into it (this does not stop the run):

```yaml
      - name: Smoke-test the running deployment
        env:
          ROCKETRIDE_TOKEN: ${{ secrets.ROCKETRIDE_TASK_TOKEN }}
        run: rocketride upload smoke/sample.pdf --token "$ROCKETRIDE_TOKEN"
```

Notes for reliable CI runs:

- **Secrets stay in env vars.** The CLI reads `ROCKETRIDE_URI`, `ROCKETRIDE_APIKEY`,
  `ROCKETRIDE_PIPELINE`, and `ROCKETRIDE_TOKEN` from the environment, so no key needs to
  appear on the command line. If the pipeline itself references `${ROCKETRIDE_*}`
  placeholders (API keys for LLM nodes etc.), export those in the job env too — the client
  forwards its `ROCKETRIDE_*` variables and the server substitutes them at start.
- **Exit-code semantics.** The exit code covers connection, auth, pipeline start, and
  teardown failures. Per-file upload failures are reported in the output summary
  (`Failed uploads: N`) but do **not** flip the exit code — keep the fixture small and
  known-good, or grep the log if you need a per-file gate.
- **Output is a TTY monitor** (box-style frames with ANSI codes) — noisy in a CI log but
  harmless. Do **not** use `status` in CI: it monitors continuously until interrupted.
  For richer assertions drive the SDK directly (ROCKETRIDE_typescript_API.md §8 Events &
  Monitoring).
- An alternative HTTP-level smoke for an always-on deployment: `curl` its webhook URL with
  the `pk_` key (§Webhooks) and assert on the JSON response.

---

## Cross-references

- **Authoring the pipelines these integrations expose** — ROCKETRIDE_PIPELINES.md
  (file format, lanes, source/response nodes, env substitution) and
  ROCKETRIDE_COMPONENT_REFERENCE.md (node catalog; per-node schemas live in
  `.rocketride/schema/<name>.json`).
- **Driving pipelines from your own code** — ROCKETRIDE_python_API.md /
  ROCKETRIDE_typescript_API.md, §3 Pipeline Execution and §4 Sending Data; the full CLI
  reference is §15 of the TypeScript doc.
- **Watching integrated pipelines run** — ROCKETRIDE_OBSERVABILITY.md (runtime logs,
  lifecycle events, traces).
- **Workspace setup, `.env` conventions** — ROCKETRIDE_README.md.
