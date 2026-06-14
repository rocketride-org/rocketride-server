# agent_langchain

A RocketRide agent node that runs a single tool-calling agent loop using LangChain.

## What it does

Receives a question on the `questions` lane, runs a LangChain agent loop (via `langchain.agents.create_agent`) against the connected LLM and tool nodes, and emits the final answer on the `answers` lane.

Uses **langchain** and **langchain-core**, installed lazily from `requirements.txt` when the pipeline starts (not at config time). The LangChain framework never talks to a model provider directly: it drives a thin chat-model adapter that delegates every completion to the LLM node connected on the `llm` channel, and a tool adapter that routes every tool call through the engine's control-plane invoke to the connected tool nodes.

The node is registered with `classType: ["agent", "tool"]`, so besides answering questions from the lane it also exposes itself as a `run_agent` tool that parent agents can invoke for hierarchical orchestration.

Failures are graceful: if the agent run raises, the error message is emitted as the answer content with a `RocketRide.agent.error.v1` entry on the payload's `stack` instead of crashing the pipeline.

---

## Configuration

### Lanes

| Lane        | Direction | Description                                           |
|-------------|-----------|-------------------------------------------------------|
| `questions` | in        | Incoming `Question` objects that trigger an agent run |
| `answers`   | out       | Final answer text produced by the agent               |

The node also streams progress events over the `thinking` SSE lane during a run: agent start, LLM call start/completion/error, tool call start/completion/error, and agent think/finish notifications.

### Fields

| Field | Type | Description |
|---|---|---|
| `agent_description` | string | Default empty. What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. |
| `instructions` | array | Additional instructions to guide the agent. |
| `profile` | string | Default "default".  |

A single `default` profile exists (`agent_langchain.profile`), containing both fields.

---

## Connections

| Channel | Required       | Description                                             |
|---------|----------------|---------------------------------------------------------|
| `llm`   | yes (min: 1)   | LLM the agent thinks with                               |
| `tool`  | no (min: 0)    | Tools available to the agent (via control-plane invoke) |

---

## Tool calling: JSON envelope protocol

RocketRide's LLM seam is text-only, but LangChain agents expect a chat model that returns structured `tool_calls`. The node bridges this with a JSON envelope protocol: on every turn the LLM is instructed to output exactly one JSON object, either

```json
{"type":"tool_call","name":"server.tool","args":{...}}
```

or

```json
{"type":"final","content":"..."}
```

The envelope is parsed into an `AIMessage` with structured `tool_calls`, so the protocol works with any LLM that can follow JSON instructions; native function-calling support is not required. Up to three attempts are made per turn: after each malformed output the model is re-prompted with a correction notice, and if all attempts fail the raw text is returned as the final answer for that turn.

Each connected tool is wrapped as a LangChain `BaseTool` whose argument schema is built dynamically from the tool's real JSON input schema (falling back to a generic `input` field when no usable schema is available), so tool parameters are preserved end-to-end across LangChain versions.

---

## Using as a tool

The node exposes a `run_agent` tool (invocable as `<nodeId>.run_agent`) so parent agents can delegate work to it in hierarchical pipelines.

| Direction | Shape                               |
|-----------|-------------------------------------|
| Input     | `{query: string, context?: object}` |
| Output    | `{content, meta, stack}`            |

`query` must be a non-empty string. An optional `context` object is attached to the question as a `RocketRide.agent.tool_context.v1` JSON block. When invoked as a tool the answer payload is returned to the caller and not written to the `answers` lane.

The tool's description automatically includes the configured `agent_description`, which is how a parent agent decides whether this agent fits a sub-task.

---

## Answer payload

Every run produces a payload with:

- `content`: the final answer text (or the error message on failure)
- `meta`: `framework` (`langchain`), `agent_id`, `run_id`, `started_at`, `ended_at`, and `task_id` when available
- `stack`: a `RocketRide.agent.raw.v1` entry carrying the raw framework output, or a `RocketRide.agent.error.v1` entry on failure

When the run is triggered from the `questions` lane, only `content` is written to the `answers` lane; the full payload is what `run_agent` callers receive.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `agent_langchain.profile` | `string` | **Profile** | `"default"` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent. |  |

## Dependencies

- `langchain`
- `langchain-core`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_langchain)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
