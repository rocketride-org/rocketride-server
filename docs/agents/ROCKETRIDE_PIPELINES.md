# RocketRide Pipeline Authoring Guide

The single reference for writing RocketRide `.pipe` files — format, wiring,
configuration, patterns, and pitfalls in one place.

Everything you need while authoring lives in your workspace:

```text
.rocketride/services-catalog.json   # ALL pipeline components: name, classType, lanes, invoke
.rocketride/schema/<provider>.json  # per-component detail: lanes, invoke, config profiles
.rocketride/docs/                   # these documentation files
./pipelines/                        # conventional home for your .pipe files
.env                                # ROCKETRIDE_* variables (keys, hosts, collections)
```

**The catalog is the source of truth.** It is generated from the connected server and may list
pipeline components this document does not mention. Always confirm a provider name, its lanes,
and its `invoke` requirements in `.rocketride/services-catalog.json` before wiring it. For
client SDK usage (`client.use()`, `client.chat()`, `client.send()`), read
ROCKETRIDE_python_API.md or ROCKETRIDE_typescript_API.md.

---

## The .pipe File Format

**Extension:** `.pipe` (required). Not `.json`. Conventional location: `./pipelines/`.

> **Pitfall 1 — wrong extension.** RocketRide tooling looks for `.pipe` files specifically;
> `my_pipeline.json` will not be picked up.

### Exact field order

`components` **must be the first field**. `project_id`, `viewport`, and `version` go at the
bottom. This is the canonical layout the editor tooling expects and every shipped example uses.

> **Pitfall 2 — `project_id` at the top.** Files with `project_id` or `source` before
> `components` can be mis-recognized by the editor, which may discard or overwrite the
> `project_id`. Always put `components` first.

### Minimal valid skeleton

```json
{
	"components": [
		{ "id": "webhook_1", "provider": "webhook",
		  "config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "webhook" } },
		{ "id": "response_1", "provider": "response_text", "config": { "laneName": "text" },
		  "input": [{ "lane": "text", "from": "webhook_1" }] }
	],
	"project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"version": 1
}
```

### Top-level fields

| Field | Required | Position | Rules |
| --- | --- | --- | --- |
| `components` | yes | FIRST | Array of pipeline component objects; every `id` unique |
| `project_id` | yes | bottom | Literal, unique GUID per file. Never a variable |
| `viewport` | yes | bottom | Editor pan/zoom state; default `{ "x": 0, "y": 0, "zoom": 1 }` |
| `version` | yes | bottom | Pipeline format version; write `1` |
| `source` | optional | — | ID of the entry-point component; see Source Nodes |

**`project_id`** is the permanent identity of the pipeline (runtime events and deploy history
key on it): a literal GUID, unique per file, generated with `uuidgen` /
`python -c "import uuid; print(uuid.uuid4())"` / `crypto.randomUUID()`. Never reuse one.

> **Pitfall 3 — variable in `project_id`.** `"project_id": "${ROCKETRIDE_PROJECT_ID}"` is not
> allowed: tooling reads `project_id` straight from the file without environment resolution.

**Wrapper note:** some existing files wrap the pipeline as `{ "pipeline": { ... } }`; the
client unwraps this on load. Author the flat form.

---

## Component Fields

### `id` (string, required)

Unique within the pipeline. Convention: `<provider>_<n>` (`chat_1`, `llm_openai_1`). Other
components reference it in their `input`/`control` arrays.

### `provider` (string, required)

The exact `name` of a pipeline component from `.rocketride/services-catalog.json`. A provider
not in the catalog does not exist — never guess provider names.

### `config` (object, required)

**Every component must have a `config` object**, even `{}` — a missing `config` is rejected
with `missing 'config' object`. Common shapes:

- Profile-based (LLMs, embeddings, vector/graph stores): `{ "profile": "<name>", "<name>": { ...overrides }, "parameters": {} }`
- Source nodes: `{ "hideForm": true, "mode": "Source", "parameters": {}, "type": "<provider>" }`
- Tool nodes: `{ "type": "<provider>" }`; `memory_internal`: `{ "type": "memory_internal" }`

String values support `${ROCKETRIDE_*}` substitution (see Profiles & Config).

### `input` (array; required on non-source, non-invoked components)

Data-lane connections into this component:

```json
"input": [
	{ "lane": "text", "from": "parse_1" },
	{ "lane": "text", "from": "ocr_1" }
]
```

`lane` must be a known lane name; `from` an existing component id. Multiple inputs are
allowed, and one component's output can feed many consumers (each lists its own `input` entry
— no fan-out syntax). Source components and invoked components (tools, controlled LLMs,
sub-agents) have **no** `input` array.

> **Pitfall 4 — disconnected components.** A non-source component with neither `input` nor
> `control` receives nothing. Every data component must be reachable from a source, and data
> flow must be acyclic — never wire two components into a loop.

### `control` (array, optional)

Control-plane (invoke) connections. Goes on the **controlled** node — see Control Connections
& Invoke.

### `ui` (object, optional)

Canvas layout: `"ui": { "position": { "x": 240, "y": 200 }, "measured": { "width": 150, "height": 66 } }`.
Optional for machine-run pipelines; when humans will open the file, set positions (nodes must
not pile up at 0,0): left-to-right, ~220px x-spacing from `x:20, y:200`; width 150; heights 66
standard / 86 agents / 40 tools / 135 vector DBs. Control-plane nodes sit ~160px **below**
their invoker; sub-agent tiers stack further down.

---

## Lanes

Lanes are typed data channels. A connection is valid ONLY when the output lane of the upstream
pipeline component matches an input lane the downstream one accepts. Both sides are in the
catalog's `lanes` field: each key is an input lane, its value array the output lanes produced
from it. An empty output array `[]` means the component consumes with no output — a valid
terminal node (stores, responses).

### Lane types

| Lane | Data |
| --- | --- |
| `tags` | File metadata / raw file info from sources |
| `text` | Plain text |
| `table` | Structured / tabular data |
| `documents` | Chunked, embeddable document records |
| `questions` | Query/prompt envelopes flowing toward a model |
| `answers` | Model/agent responses |
| `image`, `audio`, `video` | Media payloads (streamed) |
| `json` | JSON payloads (produced by `webhook`/`filestore`, consumed by `response_json`) |

### Typed matching and converters

If lane types don't match, insert a converter — consult the catalog for a node that accepts
your source lane and produces the target lane (e.g. `frame_grabber`: video → image;
`accessibility_describe`: image → text). Common transformations:

| Input | Component | Outputs |
| --- | --- | --- |
| `tags` | `parse` | `text`, `table`, `image`, `video`, `audio` |
| `text` | `preprocessor_langchain` | `documents` |
| `text` | `question` | `questions` |
| `documents` / `questions` | `embedding_transformer` | same lane, with vectors added |
| `documents` | `qdrant` (store mode) | — (stored, terminal) |
| `questions` | `qdrant` (search mode) | `documents`, `answers`, `questions` |
| `questions` | `llm_openai` | `answers` |
| `image` | `ocr` | `text`, `table` |
| `audio` | `audio_transcribe` | `text` |
| `tags` | `llamaparse` / `landing_ai_parse` / `reducto` | `text`, `table` (Pattern 16) |
| `text`, `answers` | `audio_tts` / `tts_openai` / `tts_elevenlabs` | `audio` (Pattern 17) |
| `video` | `twelvelabs` | `text` (Pattern 19) |
| `image` | `image_vision_*` (openai/gemini/mistral/ollama) | `text` (Pattern 24) |
| `image` | `image_cleanup` / `background_removal` / `pose_estimation` / `depth_estimate` | `image` (+ `text` — Patterns 25/26) |
| most data/media lanes | `filestore` | `json` file reference (Pattern 18) |

> **Pitfall 5 — mismatched lane types.** Wiring `{ "lane": "tags", "from": "webhook_1" }` into
> a preprocessor fails: preprocessors accept `text` — put `parse` between them
> (`tags → parse → text`). A lane name that doesn't exist at all is rejected at validation
> with `input has unknown lane <lane>`.

### Hidden `_` lanes

Lane keys prefixed with `_` are **hidden internal lanes** — the canvas does not render them
and you never reference them in `input` arrays. The one you will meet is `_source`: the entry
lane of source nodes (and of `tool_pipe`). Its value array is what the node **produces** —
`chat` has `"_source": ["questions"]`, so downstream wires
`{ "lane": "questions", "from": "chat_1" }`.

### Media lanes are streamed

`image`, `audio`, and `video` stream in chunks rather than as single payloads, so arbitrarily
large media flows with bounded memory — and one object can produce **several streams on one
lane** (a frame grabber emits many `image` streams from one video). Wiring is unchanged; just
expect a media lane to deliver multiple items per input object.

### Discovering lanes

`.rocketride/services-catalog.json` has every component's `lanes` map in one file;
`.rocketride/schema/<provider>.json` adds one component's description, invoke requirements,
and config detail.

---

## Profiles & Config

### The profile system

Most configurable components select a named **profile** and optionally override its fields:

```json
"config": {
	"profile": "openai-5",
	"openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" },
	"parameters": {}
}
```

- `profile` picks a preset defined by the component; the preset's defaults (model id, token
  limits, hosts, ports) merge in automatically.
- The section named after the profile is **optional**; when present it must be an object, and
  its fields override the preset's defaults. Typically you only supply `apikey`.
- Include `"parameters": {}` in profile-based configs — all shipped examples carry it.
- Discover a component's profiles in `.rocketride/schema/<provider>.json`.

### LLM model selection (`llm_openai`)

Current profiles — each preset already carries the correct model id and token limits, so do
not override `model`/`modelTotalTokens` except with the `custom` profile:

| Profile | Model | Context (total/output tokens) |
| --- | --- | --- |
| `openai-5-4`, `openai-5-4-pro` | gpt-5.4 / gpt-5.4-pro | 1,050,000 / 128,000 |
| `openai-5-4-mini`, `openai-5-4-nano` | gpt-5.4-mini / -nano | 400,000 / 128,000 |
| `openai-5-2` | gpt-5.2 (default profile) | 400,000 / 128,000 |
| `openai-5-1` | gpt-5.1 | 400,000 / 128,000 |
| `openai-5` | gpt-5 | 400,000 / 128,000 |
| `openai-5-mini`, `openai-5-nano` | gpt-5-mini / gpt-5-nano | 400,000 / 128,000 |
| `openai-4o`, `openai-4o-mini` | gpt-4o / gpt-4o-mini | 128,000 / 16,384 |
| `custom` | you supply `model` and `apikey` (see also `llm_openai_api` for OpenAI-compatible endpoints) | you supply `modelTotalTokens` |

The schema lists more presets; check `.rocketride/schema/llm_openai.json` when you need one.
Other LLM providers follow the same pattern — e.g. `llm_anthropic` defaults to profile
`claude-sonnet-4-6` and takes `"claude-sonnet-4-6": { "apikey": "${ROCKETRIDE_ANTHROPIC_KEY}" }`.

### Embedding model selection (`embedding_transformer`)

Profiles: `miniLM` (fast), `miniAll` (balanced), `mpnet` (quality), `custom`. Server-side —
no API key: `"config": { "profile": "miniLM", "parameters": {} }`.

**Ingestion and search must use the same embedding model** (same vectors, same dimensions),
and **every vector store needs an embedding component in front of it** — for `documents` being
stored and for `questions` being searched.

### Environment variable substitution

Any string value inside `config` may reference `${ROCKETRIDE_<NAME>}`; the value is injected
server-side when the pipeline starts.

1. **Only variables prefixed `ROCKETRIDE_` are substituted.** Any other `${VAR}` reference is
   replaced with `<REDACTED>` (anti-exfiltration guard) — it does NOT pass through.
2. A `${ROCKETRIDE_*}` reference with no defined value stays as literal text.
3. Values come from the merged environment: your workspace `.env` plus org/team/user secrets
   configured server-side. The client forwards its `ROCKETRIDE_*` variables on `use()`.
4. `project_id` never takes a variable (Pitfall 3).

```env
ROCKETRIDE_URI=http://localhost:54123   # auto-filled by the extension for self-hosted dev engines
ROCKETRIDE_APIKEY=MYAPIKEY              # set your own for cloud
ROCKETRIDE_OPENAI_KEY=sk-...
ROCKETRIDE_QDRANT_HOST=localhost
ROCKETRIDE_COLLECTION_NAME=documents
```

Keep `.env` gitignored; mirror variable names with placeholders in `.env.example`. When a
pipeline references `${ROCKETRIDE_*}` variables, add them to `.env` in the same change so it
can run immediately.

> **Pitfall 6 — wrong prefix.** `"apikey": "${OPENAI_KEY}"` does not substitute (it arrives as
> `<REDACTED>`). Name it `ROCKETRIDE_OPENAI_KEY` and reference `${ROCKETRIDE_OPENAI_KEY}`.

---

## Source Nodes

Source nodes (classType `source`) are pipeline entry points: no `input` array, they produce
data. The complete set in the current catalog:

| Provider | Produces | Purpose / client method |
| --- | --- | --- |
| `chat` | `questions` | ALL conversational interfaces — `client.chat()` |
| `webhook` | `tags`, `text`, `json`, `audio`, `video`, `image`, `questions` | HTTP intake of uploads/data — `client.send()`, `client.send_files()` |
| `dropper` | `tags` | Web drag-and-drop uploads — `client.send_files()` |
| `filestore_source` | `tags` | Reads from a RocketRide file store |
| `filesys` | `tags` | Reads from the local file system |
| `telegram` | `text`, `image`, `audio`, `video`, `tags` | Telegram Bot messages, routed per message type |
| `tools` | — (nothing) | Transfers no data; exists to **host tool nodes** via invoke |

(`remote` is NOT a source — it is an infrastructure transport for distributed pipelines.)

Match the source to the client method: `chat` sources take `client.chat()` Question objects;
`webhook`/`dropper` take `client.send()` / `client.send_files()`. Sending the wrong data type
to the wrong source is a common integration failure — see the SDK docs.

### The non-empty source config rule

Source node `config` must include all four fields, with `type` set to the provider name:

```json
"config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "chat" }
```

Why it matters mechanically: when a pipeline has **no top-level `source` field**, the server
finds the entry point by scanning for exactly one component with `"mode": "Source"` (exact
case). The visual editor also keys off these fields to render the node correctly.

> **Pitfall 7 — empty source config.** `{ "id": "chat_1", "provider": "chat", "config": {} }`
> can fail source resolution and renders incorrectly on the canvas. Always write the full
> four-field source config.

### The `source` field and multiple starts

- Single source: `source` may be omitted (implied from the unique `"mode": "Source"`
  component; the editor manages the field automatically).
- A pipeline MAY contain more than one start (e.g. a `webhook` ingestion flow and a `chat`
  query flow in one file). Then specify the entry point — top-level `"source": "<id>"`, or the
  `source` argument to `client.use()` (which overrides the file) — or the server rejects with
  `Pipeline has multiple source components, please specify one explicitly`. A present `source`
  must exactly match a component `id`.
- Alternative to a multi-start file: two `.pipe` files sharing the same vector-store
  collection name.

---

## Response Nodes and Result Keys

Response components (classType `infrastructure`) return data to the calling client. They are
lane-specific — `response_answers`, `response_text`, `response_documents`,
`response_questions`, `response_table`, `response_json`, `response_image`, `response_audio`,
`response_video` — use the one matching your output lane.

```json
{ "id": "response_answers_1", "provider": "response_answers", "config": { "laneName": "answers" }, "input": [{ "lane": "answers", "from": "llm_openai_1" }] }
```

- `laneName` sets the **key in the JSON response**. Default config `{}` yields the standard
  keys (`answers`, `text`, ...). If you customize it, client code must read that key — every
  response carries a `result_types` map (response key → lane type) for robust key discovery.
  When in doubt, don't customize; do customize to label multiple results of the same lane
  (e.g. two LLMs for comparison).
- **Ingestion pipelines need no response node** — the store is the terminal node.
- **Multi-agent fan-out uses ONE response node** with multiple inputs (Pattern 8).

---

## Control Connections & Invoke

Some pipeline components need control-plane connections — an LLM to think with, tools to
call, memory to use. The catalog's `invoke` field declares each component's requirements,
keyed by classType with `min`/`max` constraints, e.g.
`"invoke": { "llm": { "min": 1 }, "tool": { "min": 0 }, "memory": { "min": 1, "max": 1 } }`.

**CRITICAL: the `control` array goes on the CONTROLLED node, NOT on the invoker.** The
LLM/tool/memory node declares which component invokes it — `from` points at the invoker,
`classType` names the invoke channel. The invoking component itself has NO `control` array.

```json
// The AGENT has no control array — only input lanes:
{ "id": "agent_rocketride_1", "provider": "agent_rocketride",
  "config": { "instructions": [], "max_waves": 10, "parameters": {} },
  "input": [{ "lane": "questions", "from": "chat_1" }] },
// The LLM declares it is controlled BY the agent:
{ "id": "llm_openai_1", "provider": "llm_openai",
  "config": { "profile": "openai-5", "openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }, "parameters": {} },
  "control": [{ "classType": "llm", "from": "agent_rocketride_1" }] },
// So do the tool and the memory (classType "tool" / "memory"):
{ "id": "tool_http_request_1", "provider": "tool_http_request",
  "config": { "type": "tool_http_request" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }] }
```

- One controlled node can serve **multiple invokers**: one `control` entry per invoker.
- Tool components (classType `tool`) have empty `lanes` (`{}`): never wired via data lanes,
  only via `control`.
- Invoke is not agent-only: `summarization`, `extract_data`, `extract_facts`, `dictionary`,
  `preprocessor_llm`, `tool_chartjs`, the SQL nodes (`db_postgres`, `db_mysql`,
  `db_clickhouse`, `db_supabase`, `db_arango`, `db_hotdata`, `rocketride_sql`, `aparavi_aql`)
  and the graph stores all REQUIRE an `llm` control connection.

### Invoke requirements by agent type

| Agent | `llm` | `memory` | `tool` | Sub-agent channel |
| --- | --- | --- | --- | --- |
| `agent_rocketride` | required (exactly 1) | **required (exactly 1)** | optional | — |
| `agent_crewai`, `agent_langchain`, `agent_llamaindex` | required (min 1) | not supported | optional | — |
| `agent_deepagent` | required (min 1) | not supported | optional | `deepagent` (optional) |
| `agent_crewai_manager` | required (min 1) | not supported | **none** | `crewai` (min 1 required) |
| `agent_deepagent_subagent`, `agent_crewai_subagent` | required (min 1) | not supported | optional | — (they ARE sub-agents) |

Only `agent_rocketride` takes a `memory` connection (exactly one `memory_internal`). Do not
wire memory to the other agents — they have no memory port. `max_waves` applies to
`agent_rocketride` only; the others use `instructions` plus their own fields (see Patterns).

### Agents as tools (hierarchical delegation)

An agent can invoke another agent as a tool: the sub-agent declares
`"control": [{ "classType": "tool", "from": "<parent agent id>" }]` and has **no** `input`
lanes. The sub-agent's own LLM/memory/tools declare `control` pointing at the sub-agent, not
the parent. Agent nodes whose classType includes `tool` (`agent_rocketride`, `agent_crewai`,
`agent_crewai_manager`, `agent_langchain`, `agent_llamaindex`, `agent_deepagent`) expose
themselves to a parent as a `<nodeId>.run_agent` tool.

---

## Sub-Pipelines & Lifecycle Ownership

### Lifecycle guarantee (open / flush / close)

Each pipeline component runs its lifecycle exactly once per object, in dependency order:

- A component is **opened before any upstream component may emit to it** (including data
  emitted during an upstream's own open).
- A component is **flushed (`closing`) only after ALL of its upstream inputs have flushed**,
  and closed after they close.

This matters for a **merging (join)** component that buffers its inputs and emits on flush
(for example an embedder or chunker that accumulates and writes on `closing`): it is
guaranteed to receive every upstream branch's flush-time output before it flushes itself, so
no branch is dropped regardless of the order components were added on the canvas.

The same guarantee applies **inside a control node's sub-pipeline**, to any depth. A control
node (for example `tool_pipe`) that drives an inline sub-pipeline flushes and closes that
sub-pipeline in dependency order on each invocation — a join in the sub-pipeline receives
every branch's flush-time output before it flushes, exactly as at the top level. The flush
completes before the tool reads its result, so a diamond sub-pipeline returns the merged
output of all branches, not just the first. Nesting works the same way: a sub-pipeline may
itself contain an agent that invokes another `tool_pipe`, and each level flushes its own
sub-pipeline in order.

### Ownership: three wirings rejected at open

For this guarantee to hold, each sub-pipeline node has exactly one lifecycle owner. Three
wirings break that and are **rejected when the pipeline opens** (`client.use()` fails
immediately — validation time, before any data flows):

1. **A node that drives a sub-pipeline must not also be data-fed.** Do not wire a data input
   into an invoke node (e.g. `tool_pipe`) that also has output lanes connected to a
   sub-pipeline — its owning region and its per-invocation run would both drive that
   sub-pipeline. (An invoke node with *no* sub-pipeline may be data-fed; there is nothing to
   double-drive.)
2. **A sub-pipeline node must not be shared between two control nodes.** A node reachable
   from two different invoke nodes has ambiguous ownership and is rejected. Give each invoke
   node its own sub-pipeline.
3. **A sub-pipeline must not merge into the main pipeline (or a second start).** Every node a
   control node's sub-pipeline reaches must belong to that sub-pipeline only. If a
   sub-pipeline node is also reachable from the source — because the main flow (or another
   start) feeds into it, or the sub-pipeline flows back into a main-flow node — the main flow
   owns it and flushes it at end-of-object, not during the invocation, so the tool would read
   an incomplete result. Keep the sub-pipeline self-contained; end each branch in its own
   response node.

The engine names nodes in these errors by service title plus your component id, so the
message points straight at the wiring to fix:

| Broken wiring | Engine error contains (verbatim) |
| --- | --- |
| Sub-pipeline shared with the main flow or a second start | `Control node "Pipeline Tool" (pipe_tool_1) reaches node "Prompt" (sub_a) that the main flow owns; a control node's sub-pipeline must not be shared with the main pipeline or another start` |
| One sub-pipeline node reached by two control nodes | `is reachable from two control roots ( ... and ... ) - a node has exactly one lifecycle owner` |
| An invoke node that drives a sub-pipeline and is itself data-fed | `drives a sub-pipeline and is also data-fed` (for `tool_pipe` specifically, lane validation rejects earlier: `input lane ... not found in service definition` — `tool_pipe` accepts no data input at all) |

**Valid:** invoking the *same* tool from two agents — one sub-pipeline, one owner. Only
*sharing nodes between* sub-pipelines (or with the main flow) is rejected.

> **Pitfall 8 — feeding a sub-pipeline from the main flow.** A `prompt` node with
> `{ "lane": "text", "from": "pipe_tool_1" }` must not ALSO take
> `{ "lane": "questions", "from": "chat_1" }`. Remove the second input; the tool alone feeds
> its sub-pipeline, and each branch ends in its own response node.

### `tool_pipe` specifics

`tool_pipe` turns an inline sub-pipeline into an agent tool:

```json
{ "id": "pipe_tool_1", "provider": "tool_pipe",
  "config": { "profile": "default", "default": {
      "tool_description": "Runs the input through the sub-pipeline and returns the merged answer.",
      "return_type": "answers" } },
  "control": [{ "classType": "tool", "from": "agent_1" }] }
```

`tool_description` is what the agent reads to decide when to call the tool; `return_type`
selects which response lane value returns to it — `text` (default), `answers`, `documents`,
or `table`. Sub-pipeline heads take `input` **from** `pipe_tool_1` on `text`, `questions`,
`documents`, `table`, or `answers`. `tool_pipe` is invoke-only: it never takes a data input.

---

## Patterns

`→` is a data lane; `[controlled by X: ...]` lists nodes whose `control` points at X.

### Pattern 1: Chat/Q&A with RAG

```text
chat → embedding_transformer → qdrant → llm_openai → response_answers
```

Any conversational interface — `client.chat()`; use `chat` for ALL Q&A pipelines, not just
web UIs. Optionally insert a `prompt` node between store and LLM to merge retrieved
`documents` with the `questions` and add instructions (see Starter 2).

### Pattern 2: Simple chat (no RAG)

```text
chat → llm_openai → response_answers
```

### Pattern 3: Document processing / ingestion

```text
webhook → parse → preprocessor_langchain → embedding_transformer → qdrant
```

`client.send()` / `client.send_files()`. No response node — the store is terminal.

### Pattern 4: Simple document extraction

```text
webhook → parse → response_text
```

### Pattern 5: OCR pipeline

```text
webhook → parse → ocr → preprocessor_langchain → embedding_transformer → qdrant
```

(`parse` emits `image` to `ocr`; `ocr` emits `text` onward.)

### Pattern 6: Direct LLM analysis of uploads

```text
webhook → parse → question → llm_openai → response_answers
```

(`question` converts `text` to `questions`; LLMs consume `questions`, not raw text.)

### Pattern 7: Multi-modal processing

```text
                 → ocr (image) →
webhook → parse →                             → join node (multiple text inputs) → ...
                 → audio_transcribe (audio) →
```

A downstream node merges branches by listing multiple `input` entries; the lifecycle
guarantee ensures every branch flushes into the join before the join flushes.

### Pattern 8: Multi-agent fan-out (parallel agents)

```text
        → agent_a →
chat →  → agent_b →  → response_answers   (ONE node, one `input` entry per agent)
        → agent_c →
```

> **Pitfall 9 — one response node per agent.** Do NOT create a response node per agent. Use a
> single `response_answers` with one `input` entry per agent; all answers return together
> under one key as a list. To label results separately instead, give each agent its own
> response node with a distinct `laneName` — the comparison variant, a deliberate choice.

### Pattern 9: Advanced RAG with summaries

```text
                → [preprocessor_langchain → embedding_transformer → qdrant (content)]
webhook → parse →
                → [summarization [controlled: llm] → embedding_transformer → qdrant (summaries)]
```

Two-tier retrieval indexing. `summarization` requires an `llm` control connection.

### Pattern 10: Deep Agent with sub-agents

```text
chat → agent_deepagent → response_answers
	[controlled by agent: llm (required), tools (optional), subagents (optional, channel "deepagent")]
	[controlled by each subagent: its own llm (required), its own tools (optional)]
```

```json
{ "id": "agent_deepagent_1", "provider": "agent_deepagent",
  "config": { "instructions": ["Plan, delegate to sub-agents when useful, synthesize."], "agent_description": "Orchestrator", "parameters": {} },
  "input": [{ "lane": "questions", "from": "chat_1" }] },
{ "id": "agent_deepagent_subagent_1", "provider": "agent_deepagent_subagent",
  "config": { "description": "Researches topics on the web and reports findings.", "instructions": [], "parameters": {} },
  "control": [{ "classType": "deepagent", "from": "agent_deepagent_1" }] }
```

Both the orchestrator and each subagent get their own LLM via
`"control": [{ "classType": "llm", "from": "<that node's id>" }]`. The subagent has **no
lanes** and cannot be invoked directly or called as a tool; its `description` is the ONLY
signal the orchestrator uses to pick it — keep it specific and action-oriented. With no
subagents, `agent_deepagent` is a standard single agent.

### Pattern 11: CrewAI Manager with a crew

```text
chat → agent_crewai_manager → response_answers
	[controlled by manager: llm (required), agent_crewai_subagent nodes (min 1, channel "crewai")]
	[controlled by each subagent: its own llm (required), its own tools (optional)]
```

```json
{ "id": "agent_crewai_manager_1", "provider": "agent_crewai_manager",
  "config": { "instructions": ["Delegate to the right specialist and synthesize one answer."], "parameters": {} },
  "input": [{ "lane": "questions", "from": "chat_1" }] },
{ "id": "agent_crewai_subagent_1", "provider": "agent_crewai_subagent",
  "config": { "role": "Financial Analyst", "instructions": [], "parameters": {} },
  "control": [{ "classType": "crewai", "from": "agent_crewai_manager_1" }] }
```

The manager has **no `tool` channel** — tools go on the subagents. Subagents are delegated
to by their `role` name, have no lanes, and cannot be invoked directly. A regular
`agent_crewai` cannot serve as a subagent, and managers cannot nest under managers on the
`crewai` channel — compose managers through the `run_agent` tool instead. One subagent MAY
serve multiple managers.

### Pattern 12: LlamaIndex agent

```text
chat → agent_llamaindex → response_answers
	[controlled by agent: llm (required), tools (optional)]
```

Config fields: `agent_description`, `instructions`, `parameters` (no `max_waves`, no memory).
Wiring is identical to `agent_crewai`/`agent_langchain` — LLM and tools declare `control`
pointing at `agent_llamaindex_1`.

### Pattern 13: MCP tools via `mcp_client`

```json
{ "id": "mcp_client_1", "provider": "mcp_client",
  "config": { "profile": "streamable_http", "streamable_http": { "serverName": "mcp", "endpoint": "${ROCKETRIDE_MCP_ENDPOINT}" }, "parameters": {} },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }] }
```

Connects to an external MCP server and exposes its tools to the controlling agent. Profiles:
`RocketRide` (stdio, default — the bundled RocketRide MCP server), `streamable_http`
(`endpoint` field), `sse` (legacy, `sse_endpoint` field). A plain `tool` node: control wiring
only, no lanes.

### Pattern 14: Graph store Q&A (`graph_neo4j`, `graph_falkordb`, `rocketride_graph`)

```text
chat → graph_falkordb → response_answers
                      → response_table
	[controlled by graph store: llm (required — writes the Cypher)]
```

All three share the shape: `questions` in; `table`, `text`, `answers` out; an `llm` control
connection is REQUIRED (it crafts Cypher from the question). Config is profile-based —
`graph_falkordb` profile `default` takes `host`, `port`, `graph`, and a `db_description`
(describe the schema so the LLM writes good Cypher); `graph_neo4j` defaults
`database: "neo4j"`; `rocketride_graph` (built-in) needs no external server. Their classType
also includes `tool`, so an agent can control a graph store as a tool instead.

### Pattern 15: Memory options

Three distinct mechanisms — choose deliberately:

| Provider | Kind | Wiring |
| --- | --- | --- |
| `memory_internal` | Run-scoped agent scratchpad | `control: [{ "classType": "memory", "from": "<agent_rocketride id>" }]`; config `{ "type": "memory_internal" }`. Required (exactly 1) by `agent_rocketride` only |
| `memory_persistent` | Cross-session session store (experimental) | **Data lanes, not control**: pass-through on `questions → questions` and `answers → answers`. Sits in the data path around the LLM; sessions keyed by `session_id` metadata. Profiles: `memory` (in-process, default), `redis` (production), `custom` |
| `tool_mem0` | Long-term shared memory as agent tools | `control: [{ "classType": "tool", "from": "<agent id>" }]`; config `{ "type": "tool_mem0" }` plus profile fields (`api_key`, `user_id`). Exposes `mem0.remember` / `mem0.recall`. Complements — does not replace — the agent's required `memory` node |

`memory_persistent` placement: wire `questions` from `chat_1` into `memory_persistent_1`, its
`questions` output into the LLM, and the LLM's `answers` through a `memory_persistent` input
before the response node — it enriches questions with stored session context and records
answers back.

> **Pitfall 10 — treating every "memory" as the same port.** `memory_internal` is
> control-wired and only `agent_rocketride` accepts it; `memory_persistent` is lane-wired (it
> has NO invoke capability); `tool_mem0` is an ordinary tool. Wiring `memory_persistent` via
> `control`, or `memory_internal` to a CrewAI/LangChain/LlamaIndex/Deep agent, does not work.

### Pattern 16: Alternative document parsers

```text
webhook → llamaparse | landing_ai_parse | reducto → (text/table) → ...
```

Three cloud parsers are drop-in alternatives to the built-in `parse` for the `tags →
text/table` step. All take an API key (field name `api_key`, not `apikey`):

| Provider | Strengths | Key config (profile `default`) |
| --- | --- | --- |
| `llamaparse` | Complex layouts via LVM/agentic modes, markdown output | `api_key`, `parse_mode` (default `parse_page_with_lvm`), `lvm_model` |
| `landing_ai_parse` | Landing.ai ADE (DPT-2): clean Markdown + tables | `api_key` (falls back to `${ROCKETRIDE_LANDING_AI_KEY}`), `region` |
| `reducto` | Handwriting (agentic OCR), multilingual, figure summaries | `api_key`, `Contains_Handwritten_Text`, `Contains_Non_English_Text`, `Summarize_Text` |

`landing_ai_extract` extends the pair into schema-driven extraction: it consumes the parser's
`text` and emits `answers`/`documents` shaped by a JSON Schema you supply (`schema_file` — in a
`.pipe` file a `data:application/json;base64,...` URI; `strict: true` fails instead of
returning partial results):

```json
{ "id": "landing_ai_extract_1", "provider": "landing_ai_extract",
  "config": { "profile": "default", "default": { "api_key": "${ROCKETRIDE_LANDING_AI_KEY}",
      "schema_file": "data:application/json;base64,...", "strict": false }, "parameters": {} },
  "input": [{ "lane": "text", "from": "landing_ai_parse_1" }] }
```

Prefer the built-in `parse` when documents must stay on your infrastructure; a cloud parser
when layout fidelity on hard PDFs matters more.

> **Pitfall 12 — alternative parsers emit only `text` and `table`.** Unlike `parse`, they have
> no media output lanes — the OCR branch of Pattern 5 and the fan-out of Pattern 7 do not
> apply. Keep `parse` when you need to route embedded images or media.

### Pattern 17: Text-to-speech — generate and return spoken audio

```text
chat → llm_openai → tts_openai → response_audio
```

All three TTS nodes accept `text`, `documents`, `questions`, or `answers` and emit `audio`:

| Provider | Output | Key config |
| --- | --- | --- |
| `audio_tts` (Kokoro-82M, on-server, no key) | WAV | profile `kokoro`; `kokoro_voice` (default `af_heart`) |
| `tts_openai` | MP3 | profiles `gpt-4o-mini-tts` (default), `tts-1`, `tts-1-hd`; `voice` (default `alloy`); `apikey` (host fallback `OPENAI_API_KEY`) |
| `tts_elevenlabs` | MP3 | profiles `eleven_multilingual_v2` (default), `eleven_turbo_v2_5`, `eleven_flash_v2_5`, `eleven_v3`; `voice` (a voice_id); `apikey` (host fallback `ELEVENLABS_API_KEY`) |

Config follows the standard profile shape — `{ "profile": "eleven_multilingual_v2",
"eleven_multilingual_v2": { "apikey": "${ROCKETRIDE_ELEVENLABS_KEY}" }, "parameters": {} }` —
with input `{ "lane": "answers", "from": "llm_openai_1" }`; `response_audio` then takes
`{ "lane": "audio", "from": "tts_1" }` with config `{ "laneName": "audio" }`.

**Returning the artifact:** `response_audio` returns the audio inline — under the response
key each entry is `{ "mime_type": ..., "audio": "<base64>" }`. For long audio, or when the
caller wants a link instead of a payload, persist and return a reference instead:
`... → tts_1 → filestore (emitUrl on) → response_json` — the response then carries
`{ "path": ..., "url": ... }` per file: `url` is a signed download link (TTL `urlExpiresIn`,
max 3600s), `path` stays fetchable later via the SDK's `fs_*` methods (Pattern 18).

### Pattern 18: Drop-zone uploads and fetching files after the run

```text
dropper → parse → ...processing... → filestore → response_json
```

`dropper` serves its own drag-and-drop upload page (URL and auth key are printed to the
Project Log on start, form `{host}/dropper/{project_id}/{source}?auth=...`); it also accepts
`client.send()` / `client.send_files()`. Uploads flow through the pipeline as raw objects on
`tags` — **the dropper does not save them anywhere**. Anything you want to keep must be
written explicitly, and the sink for that is `filestore`, config
`{ "profile": "default", "default": { "targetDir": "output/", "emitUrl": true }, "parameters": {} }`:

- `filestore` accepts `documents`/`text`/`table`/`image`/`audio`/`video` — not `tags`, so it
  persists processed lane data, not the raw upload (media lanes do carry the original bytes;
  parsed text stores as `.txt`/`.md`).
- Files land in the account file store under `targetDir` (default `output/`), named from the
  source file's stem; `onConflict` = `unique` (default, `_1`/`_2` suffixes) / `overwrite` /
  `skip`. One `{ "path": ..., "url"? }` reference per file goes out on `json`.
- **Fetching afterwards:** the same store is the one the client SDK reaches — `fs_list_dir()`,
  `fs_read()` / `fs_read_string()`, `fs_get_url()` (signed browser URL) — or re-ingest with
  `filestore_source` (config `path`, optional `recursive`). Development runs anchor to your
  user file tree, deployed runs to the task's team subtree; relative paths behave identically.

### Pattern 19: Video understanding (`twelvelabs`)

```text
webhook → twelvelabs → response_text
```

`twelvelabs` sends each incoming `video` stream to the TwelveLabs Pegasus model and emits the
generated analysis as `text`. Config is profile `default` with `apikey` and `instructions` —
an array used as the analysis prompt, default `Describe this video.`:
`"config": { "profile": "default", "default": { "apikey": "${ROCKETRIDE_TWELVELABS_KEY}",
"instructions": ["List the key scenes and summarize the narrative."] }, "parameters": {} }`.

Know what it is: **per-video analysis, not a search index.** Each video is uploaded to a
temporary index that is deleted after the answer returns — nothing accumulates or stays
searchable; indexing restarts per video (polled up to 15 minutes before timing out) and the
video is buffered fully in memory first. Accepted containers: MP4, MOV, AVI, WebM, MKV, MPG.
To make video findable instead, index frame descriptions:
`frame_grabber → image_vision_* → preprocessor → embedding → store` (Patterns 24 and 1).

### Pattern 20: Guardrails on LLM input and output

```text
chat → guardrails (input) → llm_openai → guardrails (output) → response_answers
```

`guardrails` is a pass-through filter on `questions`, `answers`, and `documents` —
deterministic regex/heuristic checks, no model calls, no added latency. Input side:
prompt-injection detection, blocked/allowed topic keywords (`blocked_topics` /
`allowed_topics`), length/token caps. Output side: PII detection, content safety, format
validation (`expected_format`: `json`, `markdown`, lists), and a hallucination check grounding
answers against whatever `documents` you also wire in (e.g. from the RAG store):

```json
{ "id": "guard_out_1", "provider": "guardrails",
  "config": { "profile": "strict", "strict": { "policy_mode": "block" }, "parameters": {} },
  "input": [
    { "lane": "answers", "from": "llm_openai_1" },
    { "lane": "documents", "from": "qdrant_1" } ] }
```

Profiles: `basic` (injection + PII, `warn`), `strict` (all checks, `block`), `custom`
(individual `enable_*` flags). `policy_mode` sets the reaction: `block` drops the offending
item entirely, `warn` logs and forwards, `log` records silently.

> **Pitfall 13 — one guardrails node for both directions.** Feeding the LLM's `answers` back
> into the node that fed it `questions` creates a cycle (Pitfall 4) — use two nodes, one per
> side. And the default profile only **warns**: nothing is blocked until you select `strict`
> or set `policy_mode: "block"`.

### Pattern 21: Web research synthesized by an LLM

```text
chat → agent_rocketride → response_answers
    [controlled by agent: llm, memory_internal, tool_tavily (search), tool_firecrawl (read pages)]
```

Research needs two capabilities: finding sources and reading them; the agent's LLM does the
synthesis. Search tools (pick one): `tool_tavily` (`apikey`, `maxResults`, `searchDepth`
`basic`/`advanced`, `topic` `general`/`news`/`finance`) or `tool_exa_search` (`apikey`,
`numResults`, `searchType` `auto`/`neural`/`keyword`, `useAutoprompt`, `includeText`). Page
reader: `tool_firecrawl` (`apikey`; exposes `firecrawl.scrape_url` and `firecrawl.map_url`).
Tool configs are flat — `{ "type": "tool_tavily", "apikey": "${ROCKETRIDE_TAVILY_KEY}" }` —
and each tool declares `"control": [{ "classType": "tool", "from": "agent_rocketride_1" }]`
exactly as in Pattern 13.

No-agent variant: `search_exa` is a **data-lane** search node — `chat → search_exa →
response_answers` returns the raw Exa result JSON (`questions` in, `answers`/`text` out;
profile `default` with `apikey`, `type`, `numResults`, `includeHighlights`). One search per
question, no LLM, no synthesis — deterministic lookups; use the agent form for research.

### Pattern 22: GraphRAG shared memory with Cognee (`tool_cognee`)

```text
chat → agent_rocketride → response_answers
    [controlled by agent: llm, memory_internal, tool_cognee]
```

`tool_cognee` connects to a running Cognee server (self-hosted, default
`http://localhost:8000`, or Cognee Cloud) and gives the agent graph-backed semantic memory as
tools: `<nodeId>.remember` (store text — turned into a knowledge graph + embeddings),
`<nodeId>.recall` (natural-language query, default strategy
`GRAPH_COMPLETION_DECOMPOSITION`), and `<nodeId>.memory_status` (poll processing state). Config
is flat (other fields: `search_type`, `top_k`, `request_timeout`, `allow_dataset_override`):

```json
{ "id": "tool_cognee_1", "provider": "tool_cognee",
  "config": { "type": "tool_cognee", "base_url": "${ROCKETRIDE_COGNEE_URL}",
    "api_key": "${ROCKETRIDE_COGNEE_KEY}", "dataset": "shared-research" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }] }
```

- ONE Cognee node can serve several agents (one `control` entry per agent) — that is how they
  share memory; keep `allow_dataset_override` off so every call stays in the operator's dataset.
- `remember` can run in the background; have the agent poll `memory_status` until `completed`
  before relying on `recall`. There is no destructive clear tool.
- It complements — not replaces — `agent_rocketride`'s required `memory_internal`; and unlike
  Pattern 14's graph stores (which query an EXISTING graph), Cognee builds the graph from text.

### Pattern 23: Agent running Python safely (`tool_python`)

```json
{ "id": "tool_python_1", "provider": "tool_python", "config": { "type": "tool_python" },
  "control": [{ "classType": "tool", "from": "agent_rocketride_1" }] }
```

Exposes one tool, `python.execute`: the agent submits a script and gets back
`{ stdout, stderr, exit_code, timed_out, result }` (assign a variable named `result` to return
a structured value). The sandbox is RestrictedPython: safe builtins, guarded attribute access,
and an import allowlist of pure-computation stdlib modules (`math`, `json`, `re`, `datetime`,
`collections`, ...) — **no network, filesystem, or subprocess access by default**. Optional
config: `timeout` (seconds, default 20, max 1200) and `allowedModules` (extra imports;
missing ones are pip-installed on first use). Output truncates at 50 KB per stream. Grant
file access separately (and deliberately) via `tool_filesystem` if results must persist.

### Pattern 24: Vision Q&A on images (`image_vision_*`)

```text
webhook → image_vision_openai → response_text
```

`image_vision_openai` / `image_vision_gemini` / `image_vision_mistral` / `image_vision_ollama`
are **data-lane** nodes, not chat LLMs: they consume the `image` lane (emitting the model's
answer as `text`) or image `documents` (each `Image` document becomes a `Text` document,
metadata preserved), with the question **fixed in config** — `prompt` and `systemPrompt` live
in the profile alongside `apikey` (default prompt: `Describe this image in detail.`):

```json
"config": { "profile": "openai-4-1", "openai-4-1": {
    "apikey": "${ROCKETRIDE_OPENAI_KEY}",
    "prompt": "Extract every visible serial number and label." }, "parameters": {} }
```

How they differ from `llm_*`: `llm_openai` and friends consume `questions` and answer
per-question (or serve agents via `control`); `image_vision_*` cannot be invoked by an agent
and take no `questions` — they apply one configured prompt to every image that flows past.
Use them for batch annotation/OCR/description; use a vision-capable `llm_*` behind `chat` for
free-form questions. Default profiles: OpenAI `gpt-4.1`, Gemini `2.5 Flash`, Mistral `Large
3`, Ollama `llama3.2-vision:11b` (local; profile carries `serverbase`). The `documents` route
feeds indexing: vision text → `preprocessor_langchain` → embedding → store makes video frames
or image sets searchable.

### Pattern 25: Image operations in batch

```text
filestore_source → parse → image_cleanup → ocr → ...                      (better OCR)
webhook → parse → background_removal → filestore → response_json          (cutouts, persisted)
parse → thumbnail → image_vision_* (documents)                            (cheaper vision)
```

- `image_cleanup` (`image → image`, no config): OCR pre-processing — grayscale, contrast
  (CLAHE), deskew, despeckle; always outputs PNG. Drop it between `parse` and `ocr`.
- `thumbnail` (`image → image`/`documents`, no config): fixed 128×128 PNG center-crop; emits
  an `Image` document per stream on `documents` — feed a vision node to cut token cost.
- `background_removal` (`image → image` + `text`): BiRefNet cutout — straight-alpha RGBA PNG
  on `image`, JSON alpha stats on `text`. Profiles `birefnet-default` (1K) / `birefnet-hr`
  (2K, finer hair/edge detail); `maxEdge` caps inference resolution.

For folder-scale batches, source from the account file store (`filestore_source`, folder
`path`, `recursive: true`) and sink with `filestore` — the run is finite, ending when the
folder is fully processed (Pattern 18 covers fetching the outputs).

### Pattern 26: Pose and depth estimation

```text
webhook → parse → pose_estimation → filestore     (or response_image / response_text)
```

Both are `image → image` + `text` nodes, one result pair per frame:

| Provider | `image` out | `text` out | Config |
| --- | --- | --- | --- |
| `pose_estimation` | Frame annotated with skeleton + keypoints | JSON array of persons (box + 17 COCO keypoints) | profiles `rtmpose-tiny`/`-medium` (default)/`-large`; `threshold` (default 0.3); `max_persons` (default 20) |
| `depth_estimate` | Colorized depth map (red = near, blue = far) | JSON stats `{min, max, mean}` | profile `v2-small` (Depth Anything V2); `maxEdge` (default 1024) |

Each output lane is produced only when something downstream listens on it — wire `text` to a
response/store node for the machine-readable result. For video, put `frame_grabber` in front
(`video → image`, one stream per frame).

### Pattern 27: Structured extraction with validation

```text
webhook → parse → extract_data [controlled: llm] → schema_validate → response_answers
```

`extract_data` (requires an `llm` control connection) pulls a configured column set out of
`text`/`table`/`documents`. Chunks merge progressively; ONE consolidated JSON result is
emitted per object at close — on `answers` as a single answer, and/or on `documents` as one
document per extracted row (feed that to embedding → store to index rows):

```json
{ "id": "extract_data_1", "provider": "extract_data",
  "config": { "profile": "default", "default": { "fields": [
      { "column": "invoice_number", "type": "text", "defval": "" },
      { "column": "total", "type": "decimal", "defval": "" } ] }, "parameters": {} },
  "input": [{ "lane": "text", "from": "parse_1" }] }
```

(Wire the controlled LLM with `"control": [{ "classType": "llm", "from": "extract_data_1" }]`.)
Field `type`s include `text`, `decimal`, `int`, `date`, `datetime`, `json`, `url`, `email`,
`phone`, `uuid` (1-32 fields). `schema_validate` (`answers → answers`) is the validation
guard — but know what it validates: **structured financial fact records**, not arbitrary
JSON. It deterministically flags missing/non-numeric amounts, missing currency,
metric/category mismatches (a cost row declared as revenue), sign violations, and missing
provenance, adding a `validation` block per fact; it never fixes, drops, or reorders records,
and calls no LLM. For validation against a general JSON Schema, use `landing_ai_extract`
(Pattern 16) with `strict: true` instead.

> **Pitfall 14 — expecting `response_json` to return LLM output.** The `json` lane is produced
> only by `webhook` and `filestore`. Structured results from `extract_data`,
> `landing_ai_extract`, or an `expectJson` LLM leave on **`answers`** — terminate with
> `response_answers` (JSON answers arrive to the client already parsed). `response_json` is for
> `filestore` file references and webhook JSON pass-through.

### Pattern 28: pgvector — `postgres` vs `db_postgres`

Two Postgres providers, two different jobs; mixing them up fails validation:

| | `postgres` (pgvector) | `db_postgres` (relational) |
| --- | --- | --- |
| Role | Vector store INSIDE your Postgres (pgvector extension) | Text-to-SQL over existing tables |
| Lanes | `documents` in (terminal); `questions` in → `documents`/`answers`/`questions` | `questions` in → `table`/`text`/`answers` |
| LLM | No `llm` port — never wire `control` to it | REQUIRES an `llm` control connection (writes the SQL; `max_attempts` retries via EXPLAIN; `allow_execute` off by default) |
| Config | profile `local`: `host`, `port`, `user`, `password`, `database`, `collection` (table name), `similarity` (`cosine`/`l2`/`inner_product`); needs `embedding_transformer` in front of BOTH lanes | profile `default`: `host`, `user`, `password`, `database`, `table`, `db_description` (describe the schema — better SQL) |

Wiring is identical to `qdrant` (Starter 2 / Pattern 3) — only the config block changes:
`{ "profile": "local", "local": { "host": "${ROCKETRIDE_PG_HOST}", "port": 5432, "user":
"postgres", "password": "${ROCKETRIDE_PG_PASSWORD}", "database": "rocketride", "collection":
"documents" }, "parameters": {} }`. Both can also serve an agent as a tool (`postgres` exposes
`search`/`upsert`/`delete`). Use `postgres` to avoid running a separate vector database when
you already operate Postgres.

> **Pitfall 15 — vector store wired like a SQL node (or vice versa).** `db_postgres` without
> an `llm` control connection fails validation; `postgres` without an embedding node in front
> stores nothing searchable (and search must use the SAME embedding model as ingestion).

### Pattern 29: Choosing a store — relational vs vector vs graph

| You need | Family | Providers | Wiring shape |
| --- | --- | --- | --- |
| 'Find content like this' — semantic similarity over chunks | Vector | `qdrant`, `postgres` (pgvector), `pinecone`, `milvus`, `chroma`, `weaviate`, `rocketride_vector` (built-in) | `documents` in via embedding (ingest); `questions` in via embedding (search). No LLM port |
| Exact answers over structured tables — filters, joins, aggregates | Relational | `db_postgres`, `db_mysql`, `db_clickhouse`, `db_supabase`, `rocketride_sql` (built-in) | `questions` → `table`/`text`/`answers`; `llm` control REQUIRED (crafts SQL). No ingestion lanes — data already lives in the DB |
| 'How is A connected to B' — relationship traversal | Graph | `graph_neo4j`, `graph_falkordb`, `rocketride_graph` (built-in) | `questions` → `table`/`text`/`answers`; `llm` control REQUIRED (crafts Cypher). Queries an EXISTING graph (Pattern 14) |

Rules of thumb: unstructured documents you must search → vector (Patterns 1/3). Numbers,
inventories, transactions → relational (give the LLM a good `db_description`). Entity
relationships → graph — noting the graph nodes only QUERY a graph; to build one from text,
use `tool_cognee` (Pattern 22). The families compose: an agent can control any of these as
tools, so RAG plus a `db_postgres` tool on one agent is a common shape. The built-in
`rocketride_*` variants need no external server — the fastest prototypes before pointing the
same wiring at production infrastructure.

---

## Starter Pipelines

Two complete, verified pipelines. Copy, then regenerate `project_id`. (`ui` blocks omitted —
add positions per the `ui` section if humans will open these on the canvas.)

### Starter 1: File processing (upload → parse → OCR → NER → anonymize → text out)

Drive with `client.send_files()`. `parse` sends `text` straight to `ner` and routes `image`
through `ocr`, whose text merges into the same `ner` node.

```json
{
	"components": [
		{ "id": "webhook_1", "provider": "webhook",
		  "config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "webhook" } },
		{ "id": "parse_1", "provider": "parse", "config": {},
		  "input": [{ "lane": "tags", "from": "webhook_1" }] },
		{ "id": "ocr_1", "provider": "ocr", "config": {},
		  "input": [{ "lane": "image", "from": "parse_1" }] },
		{ "id": "ner_1", "provider": "ner", "config": {},
		  "input": [
			{ "lane": "text", "from": "parse_1" },
			{ "lane": "text", "from": "ocr_1" }
		  ] },
		{ "id": "anonymize_text_1", "provider": "anonymize_text", "config": {},
		  "input": [{ "lane": "text", "from": "ner_1" }] },
		{ "id": "response_text_1", "provider": "response_text", "config": { "laneName": "text" },
		  "input": [{ "lane": "text", "from": "anonymize_text_1" }] }
	],
	"project_id": "6744c740-0cdb-4667-b471-6c31d17d92d2",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"version": 1
}
```

### Starter 2: Chat + LLM with RAG retrieval

Drive with `client.chat()`. The `prompt` node merges retrieved `documents` with the question
before the LLM. Ingest documents separately (Pattern 3) into the same collection.

```json
{
	"components": [
		{ "id": "chat_1", "provider": "chat",
		  "config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "chat" } },
		{ "id": "embedding_transformer_1", "provider": "embedding_transformer",
		  "config": { "profile": "miniLM", "parameters": {} },
		  "input": [{ "lane": "questions", "from": "chat_1" }] },
		{ "id": "qdrant_1", "provider": "qdrant",
		  "config": { "profile": "local", "local": {
			  "host": "${ROCKETRIDE_QDRANT_HOST}", "port": 6333,
			  "collection": "${ROCKETRIDE_COLLECTION_NAME}" }, "parameters": {} },
		  "input": [{ "lane": "questions", "from": "embedding_transformer_1" }] },
		{ "id": "prompt_1", "provider": "prompt",
		  "config": { "instructions": ["Use the provided context to answer the question. If the context is not relevant, say so."], "parameters": {} },
		  "input": [
			{ "lane": "documents", "from": "qdrant_1" },
			{ "lane": "questions", "from": "qdrant_1" }
		  ] },
		{ "id": "llm_openai_1", "provider": "llm_openai",
		  "config": { "profile": "openai-5", "openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }, "parameters": {} },
		  "input": [{ "lane": "questions", "from": "prompt_1" }] },
		{ "id": "response_answers_1", "provider": "response_answers", "config": { "laneName": "answers" },
		  "input": [{ "lane": "answers", "from": "llm_openai_1" }] }
	],
	"project_id": "1327e7c0-8479-4ab7-a319-c4dc944daeb5",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"version": 1
}
```

For a no-RAG chat, drop `embedding_transformer_1`, `qdrant_1`, and `prompt_1` and wire
`{ "lane": "questions", "from": "chat_1" }` straight into the LLM (Pattern 2).

### Driving pipelines from code (pointers)

- Start once with `client.use(filepath='...')` and reuse the returned token; pass
  `use_existing=True` in long-running services to avoid `Pipeline already running`.
- **Never block the async event loop** (`input()`, `readFileSync()`, `time.sleep()`): a
  blocked loop starves the websocket keepalive and the connection dies after ~60s idle with
  `Connection closed` / `Connection timeout`. Use the async I/O patterns in
  ROCKETRIDE_python_API.md / ROCKETRIDE_typescript_API.md (critical section).
- Read response keys via `result_types` rather than assuming defaults (see Response Nodes).

> **Pitfall 11 — extending the engine: raw Pydantic models into `dictToJson`.** In custom
> node or filter-callback code, never pass a Pydantic model (`Question`, `Answer`,
> `IInvokeLLM`, `IInvokeTool`, ...) directly to the engine's JSON utilities — it crashes the
> C++ side. Call `.model_dump()` first: `dictToJson(question.model_dump())`.

---

## Validation Checklist

- [ ] File named with `.pipe` extension
- [ ] `components` is the FIRST field; `project_id`, `viewport`, `version` at the bottom
- [ ] `project_id` is a fresh literal GUID (never a variable, never reused)
- [ ] Every component `id` unique; every `provider` exists in `.rocketride/services-catalog.json`
- [ ] Every component has a `config` object (even `{}`)
- [ ] Source config has all of `hideForm`, `mode: "Source"`, `parameters`, `type`
- [ ] More than one start? Top-level `source` names the entry component
- [ ] Lane types match on every connection (upstream output = downstream input, per catalog)
- [ ] Non-source, non-invoked components all have `input`; no cycles, no orphans
- [ ] `control` arrays sit on the CONTROLLED nodes; every `invoke` minimum satisfied
      (`agent_rocketride`: exactly 1 llm + exactly 1 memory; managers: their sub-agent channels)
- [ ] Sub-pipelines self-contained: no data input into `tool_pipe`, no node shared between two
      control roots, no merge back into the main flow; each branch ends in its own response node
- [ ] `memory_internal` config includes `"type": "memory_internal"`; agent configs include `"parameters": {}`
- [ ] Secrets via `${ROCKETRIDE_*}` only; variables present in `.env` (and named in `.env.example`)
- [ ] Ingestion-only pipelines end in a store; response nodes only where results return to the client
- [ ] Media-lane smoke tests use CONTENT-BEARING fixtures — an image with
      visible text, audio with speech. A blank/1×1 file proves the branch
      runs without error, never that it extracts anything

## Error Messages

Validation errors (pipeline rejected before running):

| Error contains | Cause / fix |
| --- | --- |
| `'pipeline.components' must be an array` | Missing/malformed `components` — provide the array, first |
| `Component 'id' must be a non-empty string` / `Duplicate component` / `'provider' must be a non-empty string` | Every component needs a unique string id and a catalog provider name |
| `missing 'config' object` | Add `config` to the component (at minimum `{}`) |
| `config 'profile' must be a non-empty string` / `config missing profile object '<name>'` | `profile` must be a string; a same-named section, if present, must be an object |
| `input has unknown lane <lane>` | Use a lane name from the catalog |
| `input references unknown component id:` / `control references unknown component id:` | `from` must name an existing component |
| `'pipeline.source' references unknown component id:` | Point `source` at a real component id |
| `Pipeline has multiple source components, please specify one explicitly` | Two+ `mode: "Source"` components — add top-level `source` (or pass `source` to `client.use()`) |
| `input lane <lane> not found in service definition` | Data input wired into invoke-only `tool_pipe` — remove it; `tool_pipe` is invoked, never fed |
| `...must not be shared with the main pipeline or another start` | Sub-pipeline node also reachable from a start — make the sub-pipeline self-contained (ownership rule 3) |
| `...is reachable from two control roots...a node has exactly one lifecycle owner` | Node shared between two invoke nodes' sub-pipelines — one sub-pipeline per invoke node (rule 2) |
| `...drives a sub-pipeline and is also data-fed...` | Remove the data input from the invoke node (rule 1) |

Runtime errors:

| Error | Likely cause / fix |
| --- | --- |
| `Connection closed` / `Connection timeout` | **Blocked async event loop** — async I/O only; see the SDK docs |
| `KeyError: 'answers'` | Custom `laneName` changed the response key — read keys via `result_types` |
| `Pipeline already running` | `use()` while running — `use_existing=True`, or `terminate()` first |
| `Component not found` / `Lane not supported` | Provider or lane not in the catalog — check spelling and `lanes` |
| `Connection refused` / `Invalid API key` | External service down, or wrong `.env` values — check hosts, ports, `${ROCKETRIDE_*}` names |

---

**Remember:** every `.pipe` file is a complete, self-contained pipeline definition. When in
doubt: read `.rocketride/services-catalog.json` for what exists,
`.rocketride/schema/<provider>.json` for how to configure it, start minimal
(source → response), and add one pipeline component at a time.
