# agent_rocketride

RocketRide's native wave-planning agent ("RocketRide Wave"), an experimental agent node that plans each step as a wave of parallel tool calls and uses keyed memory to stay token-efficient.

## What it does

Runs an iterative planning loop built directly on the RocketRide architecture: there is
no third-party agent framework underneath. Each iteration the LLM plans a batch of tool
calls, all tools in the batch run in parallel, results are stored in keyed memory, and
the loop repeats until the LLM signals `done` or `max_waves` is reached.

Token efficiency comes from a two-level memory model: the planning prompt only ever sees
structural summaries of tool results (field names, array lengths, sample values). Raw data
stays in the memory store and is pulled on demand via the built-in `memory.peek` tool
(JMESPath extraction, implemented with the **jmespath** library) or embedded into the
final answer via `{{memory.ref:...}}` template tags resolved at render time.

The node has `classType` `["agent", "tool"]`: besides answering questions on its own
lane, it exposes a `run_agent` tool so parent agents can invoke it for hierarchical
agent orchestration.

This node is **experimental**.

---

## Configuration



| Field | Type | Description |
|---|---|---|
| `agent_description` | string | Default empty. What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. |
| `instructions` | array | Additional instructions to guide the agent's planning and responses. |
| `max_waves` | integer | Default 10. Maximum number of planning iterations before the synthesis fallback fires. |
| `profile` | string | Default "default".  |



A single `default` profile exposes all three fields.

---

## Connections

### Invoke channels (control-plane)

| Channel  | Required     | Description                                       |
|----------|--------------|---------------------------------------------------|
| `llm`    | yes (max 1)  | LLM used by the agent for planning and synthesis  |
| `tool`   | no           | Tools available to the agent via control-plane invoke |
| `memory` | yes (max 1)  | Keyed memory store for the agent                  |

The `memory` channel is required. Connect a memory node before running.

### Lanes

| Lane        | Direction | Description                                   |
|-------------|-----------|-----------------------------------------------|
| `questions` | in        | Incoming questions that start an agent run    |
| `answers`   | out       | Final answer emitted when the run completes   |

---

## Agent-callable tools

### `run_agent`

Exposes this node as a tool to parent agents (addressed as `<nodeId>.run_agent`).

| Field     | Type               | Description                                           |
|-----------|--------------------|-------------------------------------------------------|
| `query`   | string (required)  | The question for the agent. Must be a non-empty string. |
| `context` | object (optional)  | Extra context passed to the agent as a JSON context block. |

Output: `{content, meta, stack}`. When invoked as a tool, the result is returned to the
caller instead of being emitted on the `answers` lane.

### `memory.peek`

Built-in tool executed locally inside the executor (not routed through the tool pipeline).
Lets the LLM extract specific values from memory on demand.

| Field    | Type               | Description                                                                 |
|----------|--------------------|-----------------------------------------------------------------------------|
| `key`    | string (required)  | Memory key to read from (e.g. `wave-0.r1`).                                 |
| `path`   | string (optional)  | JMESPath expression to extract a specific field or slice (e.g. `rows[0:5].city`). Arrays are capped at 50 items per call. |
| `offset` | integer (optional) | Character offset for chunk reading (default `0`). Only when `path` is omitted. |
| `length` | integer (optional) | Characters to return for chunk reading (default `8000`). Only when `path` is omitted. |

Peek results are not stored back into memory. The LLM should capture extracted values in
`scratch` and then remove the peek result key in the same response.

---

## How the wave loop works

1. **Plan**: one LLM call per wave. The prompt contains all connected tool descriptors
   (one compact JSON line each, plus the `memory.peek` descriptor), the operator's
   `instructions`, memory-usage rules, persistent scratch notes, and structural summaries
   of all prior results. The LLM responds with either
   `{"thought", "scratch", "remove", "tool_calls": [...]}` or
   `{"thought", "scratch", "remove", "done": true, "answer": "..."}`.
2. **Execute**: all tool calls in the batch run concurrently (max 8 threads, 120 s
   timeout each). Each result is stored in memory under a key like `wave-0.r0` and only
   a structural summary is kept in the wave history. `{{memory.ref:...}}` tags inside
   tool arguments are resolved before invocation, so the LLM can compose tool inputs
   from previously stored results.
3. **Prune**: memory keys listed in the LLM's `remove` field are cleared from the store
   and stripped from wave history, keeping the planning prompt lean on long-running tasks.
   Tool errors are returned to the LLM as context rather than aborting the run, so it can
   recover or change approach.
4. **Repeat** until `done: true` or `max_waves` is hit. On `done`, any
   `{{memory.ref:...}}` references in the answer are resolved before delivery. If the
   wave limit is reached without `done`, a synthesis fallback asks the LLM to produce a
   best-effort answer from all gathered result summaries. An empty plan (no `tool_calls`,
   no `done`) also short-circuits to synthesis instead of looping.

Progress is surfaced to the UI over the `thinking` SSE lane: per-wave planning status,
the LLM's one-sentence `thought`, which tools are running, and step completion.

---

## Memory system

The agent uses a two-level memory model to stay token-efficient:

- **Structural summaries**: always visible in the planning prompt as "Previous tool
  results". Show data shape (field names, array lengths, first rows, truncated string
  previews with char counts) without loading raw values into context.
- **`memory.peek`**: built-in tool the LLM calls on demand to extract specific values via
  JMESPath (e.g. `rows[0:5].city`). Arrays are capped at 50 items per call; large raw
  values can be paged as text with `offset`/`length` (default chunk 8000 chars, with
  `total_chars` reported so the LLM can page). Peek results are not stored back into
  memory.
- **`{{memory.ref:key}}`**: embeds the stored value by key at render time. An exact
  full-string match returns the native type (dict, list, and so on); inside larger strings
  the value is substituted as text.
- **`{{memory.ref:key:format}}`**: renders bulk data in a specific format without ever
  loading it into LLM context.
- **`{{memory.ref:key:format:path}}`**: extracts a nested JMESPath path from the stored
  value before formatting (e.g. `rows[0:20]`). The path is the last segment, so it may
  itself contain colons (slice notation). All variants are resolved by the executor at
  render time, in tool arguments and in the final answer.

The LLM also maintains a **scratch** field: persistent working notes (memory keys,
extracted values, intermediate calculations) that carry forward across waves. When the
LLM is done with a result key it signals `remove: ["wave-0.r0"]` to evict it.

---

## Formats

Built-in formatters for `{{memory.ref:key:format}}` (no LLM call):

| Format           | Output                                                    |
|------------------|-----------------------------------------------------------|
| `markdown_table` | Markdown table with header and separator rows             |
| `html_table`     | HTML `<table>` with `<thead>`/`<tbody>`, values escaped   |
| `csv`            | CSV with header row (proper quoting via Python `csv` module) |
| `json`           | Pretty-printed JSON                                       |
| `text`           | Plain-text `key: value` blocks per row                    |

Tabular formatters accept several input shapes: a bare list of dicts,
`{"rows": [...]}` (standard database-driver output), a dict with a single
list-of-dicts value, or a single dict treated as a one-row table. Any unknown format
string (e.g. `"bullet list"`) falls back to a secondary LLM call that renders the data
in the requested style.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `agent_rocketride.profile` | `string` | **Profile** | `"default"` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent's planning and responses. |  |
| `max_waves` | `integer` | **Max Waves**<br/>Maximum number of planning iterations before the synthesis fallback fires. | `10` |

## Dependencies

- `jmespath`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_rocketride)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
