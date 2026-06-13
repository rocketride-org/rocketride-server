# agent_deepagent

A planning-capable RocketRide agent built on the Deep Agents library, with optional managed sub-agents for hierarchical delegation.

## What it does

Runs an agent loop via `deepagents.create_deep_agent` (built on LangChain/LangGraph), which layers strategic planning, persistent state, and long-context management on top of the standard LangChain tool-calling loop. The package ships two node variants:

- **Deep Agent** (`agent_deepagent`): the orchestrator. Consumes `questions` and produces `answers`, runs standalone with its own tools, and registers as a tool (`classType: ["agent", "tool"]`) so a parent agent can delegate to it via `<nodeId>.run_agent`.
- **Deep Agent Subagent** (`agent_deepagent_subagent`): a managed worker (`classType: ["deepagent"]`). It has no `questions` lane and cannot be invoked directly or called as a tool; it must be wired into a Deep Agent via the `deepagent` invoke channel, which delegates to it based on its `description`.

Sub-agents are optional: with none connected, the Deep Agent behaves as a standard single-agent node. Inference is routed through the host LLM channel using a JSON envelope protocol, so any LLM that can follow JSON instructions works; native function-calling support is not required. Agent lifecycle progress (tool calls, LLM calls, agent steps) is streamed as SSE `thinking` events.

---

## Configuration

### Lanes

**Lanes (Deep Agent only):** `questions` -> `answers`. The Subagent declares no lanes; it is driven by an orchestrator, not by direct questions.

### Deep Agent invoke channels

| Channel     | Required    | Description                                                  |
|-------------|-------------|--------------------------------------------------------------|
| `llm`       | yes (min 1) | LLM used by the agent                                        |
| `tool`      | no          | Tools available to the agent (via control-plane invoke)      |
| `deepagent` | no          | Deep Agent Subagent nodes for hierarchical delegation        |

### Deep Agent Subagent invoke channels

| Channel | Required    | Description                                    |
|---------|-------------|------------------------------------------------|
| `llm`   | yes (min 1) | LLM this sub-agent thinks with                 |
| `tool`  | no          | Tools available to this sub-agent              |

The sub-agent's LLM and tool channels are independent of the orchestrator's. When the orchestrator delegates, the sub-agent's LLM and tool calls are routed back through this node's own channels.

Both variants use an **Advanced Mode** toggle (default `Off`): when Off, the node is edited through the Instructions list; when On, the prompt fields are exposed directly.

### Deep Agent

| Field | Type | Description |
|---|---|---|
| `description` | string | Default empty. The orchestrator reads this description to decide when to delegate to this sub-agent. Keep it specific and action-oriented, this is the only signal the orchestrator uses to pick a sub-agent. |
| `system_prompt` | string | Default empty. Instructions that define this sub-agent's role and behaviour. Leave blank to use the default. |
| `instructions` | array | Additional instructions to guide this sub-agent. Each line is appended to the system prompt. |
| `advanced_mode` | boolean | Default false. When enabled, replace the Instructions list with a direct System Prompt field for full control. |
| `agent_description` | string | Default empty. What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. |

### Deep Agent Subagent

| Field           | Type / Default   | Description                                                                                                      |
|-----------------|------------------|------------------------------------------------------------------------------------------------------------------|
| `description`   | string, `""`     | Always visible. The orchestrator reads this to decide when to delegate; it is the only signal used to pick a sub-agent. Keep it specific and action-oriented. |
| `advanced_mode` | boolean, `false` | Off shows `instructions`; On shows `system_prompt` for full control.                                             |
| `instructions`  | array, `[]`      | Additional instructions; each line is appended to the system prompt. (Advanced Mode Off)                         |
| `system_prompt` | string, `""`     | Instructions that define this sub-agent's role and behaviour. Blank uses the built-in default. (Advanced Mode On) |

The final system prompt is composed as the base `system_prompt` (or the built-in fallback when blank) with each non-empty instruction appended on its own line.

---

## Tool calling

The host LLM is opaque to the driver, so tool calling uses a JSON envelope protocol: each LLM call is prefixed with a system preamble instructing the model to output exactly one JSON object in one of three shapes:

- Single tool call: `{"type":"tool_call","name":"server.tool","args":{...}}`
- Parallel tool calls: `{"type":"tool_calls","calls":[{"name":"...","args":{...}}, ...]}`
- Final answer: `{"type":"final","content":"..."}`

The plural `tool_calls` form dispatches all entries concurrently (LangGraph's async ToolNode fans them out via `asyncio.gather`), which is what unlocks parallel sub-agent delegation in a single turn.

Up to 3 attempts are made when the LLM produces malformed JSON, and a tolerant parser extracts the first balanced JSON object, rescuing responses wrapped in markdown fences, followed by trailing prose, or stacked with a stray second object (a common failure mode: a duplicate call or hallucinated `final` appended after a `tool_call`).

Host tool descriptors are converted to LangChain `BaseTool` instances with typed Pydantic input schemas built from each tool's JSON-Schema `inputSchema`; tool execution and LLM calls are bridged off the event loop via `asyncio.to_thread` so concurrent calls do not serialize.

---

## Hierarchical delegation

Connect one or more Deep Agent Subagent nodes to the `deepagent` invoke channel to turn the Deep Agent into an orchestrator. On each run:

1. The orchestrator fans out a `describe` invoke to every connected Subagent node.
2. Each sub-agent returns its name, description, system prompt, instructions, and a reference to its own engine channels.
3. The orchestrator builds a `deepagents.middleware.subagents.SubAgent` record per descriptor, wiring each sub-agent's LLM and tools to its own channels, and passes them to `create_deep_agent(subagents=...)`.
4. The orchestrator's LLM gains a `task(description, subagent_type)` tool it calls to delegate work. Each sub-agent runs in its own `AgentContext` that inherits the run metadata, so SSE events route back to the same logical run.

Give each sub-agent its own LLM, tools, and a clear `description`: the description is the only signal the orchestrator uses to choose a delegate. A Subagent can be connected to multiple orchestrators simultaneously; each orchestrator independently includes it in its own hierarchical run. A `describe` failure on one node is logged and skipped, not fatal to the run.

---

## Using as a tool

The Deep Agent (not the Subagent) exposes itself as an invokable tool, `<nodeId>.run_agent`, so parent agents can delegate to it in nested pipelines.

- **Input:** `{query: string, context?: object}`. `query` must be a non-empty string; `context`, when provided, is attached to the question as a `RocketRide.agent.tool_context.v1` JSON payload.
- **Output:** `{content, meta, stack}`.

When `agent_description` is non-empty it is included in the tool's description so parent agents can select this agent correctly.

---

## Observability

The driver emits SSE `thinking` events throughout a run: host-tool discovery count, sub-agent collection count, agent start, per-tool start/completion/error (with tool name and input length), LLM call start/completion/error, and agent thinking/done transitions.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Deep Agent (`services.agent.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `advanced_mode` | `boolean` | **Advanced Mode**<br/>When enabled, replace the Instructions list with direct Agent Description and System Prompt fields for full control. | `false` |
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent. Each line is appended to the system prompt. |  |
| `system_prompt` | `string` | **System prompt**<br/>Instructions that define this agent's role and behaviour. Leave blank to use the default. | `""` |

### Deep Agent Subagent (`services.subagent.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `advanced_mode` | `boolean` | **Advanced Mode**<br/>When enabled, replace the Instructions list with a direct System Prompt field for full control. | `false` |
| `description` | `string` | **Description**<br/>The orchestrator reads this description to decide when to delegate to this sub-agent. Keep it specific and action-oriented, this is the only signal the orchestrator uses to pick a sub-agent. | `""` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide this sub-agent. Each line is appended to the system prompt. |  |
| `system_prompt` | `string` | **System prompt**<br/>Instructions that define this sub-agent's role and behaviour. Leave blank to use the default. | `""` |

## Dependencies

- `deepagents`
- `langchain`
- `langchain-core`
- `pydantic`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_deepagent)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
