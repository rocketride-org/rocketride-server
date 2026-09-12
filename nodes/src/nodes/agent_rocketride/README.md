# agent_rocketride

A RocketRide agent node that plans batches of tool calls as parallel waves and keeps their full results in keyed memory. Pick it when a task benefits from several independent tool calls per planning step and from reusing large intermediate results without repeatedly placing them in the LLM context.

## What it does

Receives questions on the `questions` lane, uses the required LLM, tool, and memory connections to plan a wave of calls, runs that wave, and eventually writes a final answer to `answers`. Each regular tool result is stored in memory while the next planning prompt receives only a structural summary; the agent can retrieve selected values later or substitute stored data into its final answer. Unlike an agent that takes a single tool action per turn, this node can execute one planned batch concurrently, with up to eight calls in a wave.

It can also act as a specialist for a parent agent through its registered `<nodeId>.run_agent` function. The service is marked experimental in its metadata.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used for planning and final-answer synthesis. |
| `tool` | no | Tools the agent may call through the control plane. |
| `memory` | yes | Keyed memory service used to store, retrieve, and clear tool results. |

The node needs both an LLM and a memory connection to run. A `tool` connection is optional, but without one the agent has no connected external tools to call.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | Run the agent for an incoming question and emit its final answer. |

## As a tool

The node registers one function under its node-id prefix: `<nodeId>.run_agent`.

| Function | Description |
| --- | --- |
| `<nodeId>.run_agent` | Run this Wave agent for a query and return its result to the calling agent. |

The input must be an object with a required, non-empty string `query`; it may also contain a `context` object. Invalid input raises a `ValueError`. When `context` is supplied, the node serializes it into the agent question as a `RocketRide.agent.tool_context.v1` context entry; serialization errors are ignored. The returned value is the agent result, whose advertised shape is `{content, meta, stack}`. The configured **Agent description**, when non-empty, is prepended to the registered function description that a parent agent sees.

## Configuration

The sole `default` profile supplies the baseline settings. Most uses need an LLM and memory connected first; then use the fields below to describe the specialist, guide its planning, bound the number of planning waves, and decide whether an answer must include a real tool invocation.

### Agent description

This text is included in the registered `run_agent` description only when the node is used as a tool. Set it to a concise account of the specialist's purpose and capabilities when a parent agent must choose whether to delegate to it. Leave it blank when the node is only driven through its `questions` lane or when no additional delegation cue is useful.

### Instructions

Instructions are inserted as separate planning-prompt instruction blocks on every wave. Use them for durable task rules or response guidance that should apply to all iterations; they accompany the system's built-in tool, memory, response-format, and behavioural instructions. Keep them focused because they are part of every LLM planning request.

### Max Waves

This integer is the maximum number of planning iterations before the node switches to a best-effort synthesis pass. The default is `10`, with allowed values from `1` to `50`. Lower it when predictable latency or tool usage matters more than continued exploration; raise it only for tasks that genuinely need several plan-and-execute rounds. A malformed empty plan also ends the loop early and uses synthesis rather than consuming additional waves.

### Require tool call

Off by default, this guard requires the run to invoke at least one real tool before returning an answer. Enable it for workflows where an answer based only on model reasoning is unacceptable. Internal reads such as `memory.peek` do not use the connected tool pipeline and therefore should not be treated as satisfying this guard; leave the guard off for questions the agent may answer without external tool use.

## Notes

### Wave execution and failure handling

The LLM returns either a final answer or a list of `{tool, args}` calls. Regular calls in that list run concurrently, capped at eight worker threads. A tool failure becomes an error result for the next planning step rather than aborting the whole run. If the wave limit is reached, or a response contains neither `done` nor any tool calls, the node makes a final LLM synthesis request from the accumulated result summaries.

The executor defines a 120-second per-call timeout constant, but its submitted futures are not awaited with that timeout in this implementation. Do not rely on that constant to terminate a slow tool call.

### Memory references

Results are stored under keys such as `wave-0.r0`, and only their structure is carried forward in the planning prompt. The internal `memory.peek` utility can read a key, apply a JMESPath path, or page through serialized data; JMESPath array previews are capped at 50 items and raw reads default to 8,000 characters. Final answers and later tool arguments may use `{{memory.ref:key}}`, optionally followed by a format and JMESPath path. Built-in formats are `markdown_table`, `html_table`, `csv`, `json`, and `text`; an unrecognized format asks the LLM to render the value instead.

## Upstream docs

- [RocketRide documentation](https://docs.rocketride.org)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `agent_rocketride.profile` | `string` | **Profile** | `"default"` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent's planning and responses. |  |
| `max_waves` | `integer` | **Max Waves**<br/>Maximum number of planning iterations before the synthesis fallback fires. | `10` |
| `require_tool_call` | `boolean` | **Require tool call**<br/>Require the agent to invoke at least one tool before answering. When on, a run that answers without calling any tool fails with a guard error. Use for determinism-critical pipelines where an ungrounded or narrated answer must never be delivered. Off by default. | `false` |

## Dependencies

- `jmespath`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_rocketride)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
