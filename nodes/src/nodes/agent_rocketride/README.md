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

The input must be an object with a required, non-empty string `query`; it may also contain a `context` object. Invalid input raises a `ValueError`. When `context` is supplied, the node serializes it into the agent question as a `RocketRide.agent.tool_context.v1` context entry; serialization errors are ignored. The returned value is the agent result, whose advertised shape is `{content, meta, stack}`. `meta` holds the framework, agent and run ids, timings and the tool-call count; it carries `stop_reason` when the run reports why it stopped (`error` when it raised, or when the `require_tool_call` guard refused its answer), and no `stop_reason` means none was reported, not that the run finished. The task's control token is never included. The configured **Agent description**, when non-empty, is prepended to the registered function description that a parent agent sees.

## Configuration

The sole `default` profile supplies the baseline settings. Most uses need an LLM and memory connected first; then use the fields below to describe the specialist, guide its planning, bound the number of planning waves, decide whether an answer must include a real tool invocation, name a tool that checks the work, and limit how long one tool call may run.

### Agent description

This text is included in the registered `run_agent` description only when the node is used as a tool. Set it to a concise account of the specialist's purpose and capabilities when a parent agent must choose whether to delegate to it. Leave it blank when the node is only driven through its `questions` lane or when no additional delegation cue is useful.

### Instructions

Instructions are inserted as separate planning-prompt instruction blocks on every wave. Use them for durable task rules or response guidance that should apply to all iterations; they accompany the system's built-in tool, memory, response-format, and behavioural instructions. Keep them focused because they are part of every LLM planning request.

### Max Waves

This integer is the maximum number of planning iterations before the node switches to a best-effort synthesis pass. The default is `10`, with allowed values from `1` to `50`. Lower it when predictable latency or tool usage matters more than continued exploration; raise it only for tasks that genuinely need several plan-and-execute rounds. A reply with neither an answer nor a usable call is sent back once, saying what was wrong; if the second reply is no better, the loop ends early and uses synthesis rather than consuming additional waves.

### Require tool call

Off by default, this guard requires the run to invoke at least one real tool before returning an answer. Enable it for workflows where an answer based only on model reasoning is unacceptable. Internal reads such as `memory.peek` do not use the connected tool pipeline and therefore should not be treated as satisfying this guard; leave the guard off for questions the agent may answer without external tool use.

### Check tool

Empty by default. Set `verify_tool` to the name of a connected tool that checks the work, such as a compiler or test runner (for example `workspace.compile`). The planning prompt then tells the agent to call that tool after its last change and fix what it reports, instead of telling it to trust tool results. The rule is also enforced: a `done` reply is sent back until the check has passed in a later step than the last call to any other tool (a check that fails cancels any earlier pass), and a check sent in the same reply as `done` must be read before the answer is accepted. The rule covers changes: a run that calls no other tool, such as one asked whether the project compiles, may finish and report what the check found. A `done` reply that is sent back keeps its `remove` list unapplied, so the agent can still read what its calls returned. A check passes when it does not raise and its result does not report a failure in one of the ways the loop recognizes for every tool (`ok` or `success` false, `isError` true, an `error` holding text, an HTTP status of 400 or more from `tool_http_request`, an agent called as a tool whose run failed, a code runner's non-zero `exit_code` or `timed_out` true, a `tool_python` script whose own `result` reports a failure, or a list holding only errors or with an item that says it failed); anything else in the result is for the agent to read and act on. Read-only tasks pay one extra check when they called other tools.

The check is recognized by its tool name. When that tool can also change things (a command runner such as Daytona's `run_command`, or a code tool whose code the agent writes), set `verify_args` to the check's exact arguments as a JSON object, for example `{"command": "npm test"}`. Then only that exact call counts as a check, any other call to the tool counts as a change, and the planning prompt tells the agent which call to make. A `verify_args` value that is not a JSON object stops the node at startup. A `verify_tool` that names no connected tool stops the run as soon as it starts, with an error that lists the connected tools, since no check could ever pass. The host looks the name up again first, so a tool the server added after it was connected is found.

### Tool time limit

`tool_timeout` is the longest one tool call may run, in seconds, counted from when the call starts; resolving its arguments and storing its result count as part of the call. The default is `300`; `0` turns the limit off. Raise it for tools meant to run long, such as a `tool_python` script given a long timeout, or another agent called as a tool, whose own calls and waits add up. A call that runs longer is reported to the model as timed out and the wave moves on; see [Wave execution and failure handling](#wave-execution-and-failure-handling) for what happens to the call itself.

## Notes

### Wave execution and failure handling

The LLM returns either a final answer or a list of `{tool, args}` calls. Each reply is checked before the loop acts on it: `done` written as text counts by its meaning (`"false"` is not done), OpenAI-style calls (`name` plus `arguments` as JSON text) are accepted, and a call that cannot be read is skipped and reported to the model in the next prompt. A reply that sets `done` and also asks for calls runs the calls first; its answer stands only if every call succeeds. Regular calls in that list run concurrently, capped at eight worker threads. Each result in the next planning prompt shows the arguments of the call that produced it (its texts share a 600-character budget, wherever they sit in the arguments down to six levels of nesting, past which a value shows as `...`: texts that fit are shown whole, longer ones keep their start and end, at least 80 characters each, and a plain list shows its first three items), and a call identical to an earlier one in the run is marked as a repeat. A tool failure becomes an error result for the next planning step rather than aborting the whole run. If the wave limit is reached, a reply is unusable twice, or planning fails after work was gathered, the node makes a final LLM synthesis request from the accumulated result summaries, `memory.peek` previews and the agent's scratch notes. The trace records why the run stopped (`done`, `max_waves`, `empty_plan` or `error`), and so does the last status event, so a caller can tell a forced answer from a finished one.

A call that runs past the **Tool time limit** is reported to the model as timed out and the wave moves on. Python cannot stop a running thread, so the call finishes in the background and its late result is discarded. Such a call returns into the pipeline, and the engine tears a pipeline down (or hands it to the next request) only after its requests end, so a run in which a call timed out waits for that call before the run ends, however long it takes: the model has its answer already, but a call that never returns holds the run, as it did before this limit existed. Clearing the run's memory at the end waits for the store the same way. Ending such a run sooner, and safely, needs the engine to track calls in flight. A call still waiting for a worker when every worker is held by a call that timed out is reported as not run, and is then never started.

### Memory references

Results are stored under keys such as `wave-0.r0`, and only their structure is carried forward in the planning prompt. The internal `memory.peek` utility can read a key, apply a JMESPath path, or page through serialized data; JMESPath array previews are capped at 50 items and raw reads default to 8,000 characters. Final answers and later tool arguments may use `{{memory.ref:key}}`, optionally followed by a format and JMESPath path. Built-in formats are `markdown_table`, `html_table`, `csv`, `json`, and `text`; an unrecognized format asks the LLM to render the value instead. A tag whose key does not exist renders as `[missing data: <key>]` in an answer; a tool argument that is one whole tag for a missing key fails the call, and the tool does not run. Keys a reply lists in `remove` are cleared after that reply's calls have run and its answer is built, so the same reply can still use them. Each run stores its results under its own prefix in the connected memory node and clears them when it ends, so overlapping runs, and a parent and child agent sharing one memory node, cannot read or overwrite each other's keys.

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
| `tool_timeout` | `integer` | **Tool time limit (seconds)**<br/>Longest one tool call may run, counted from when it starts. A call that runs longer is reported to the agent as timed out, and the agent goes on without it. Raise it for tools that are meant to run long, such as a Python script with a long timeout or another agent called as a tool. 0 means no limit. | `300` |
| `verify_args` | `string` | **Check arguments**<br/>The exact arguments of the check, as a JSON object (e.g. {"command": "npm test"}). Set this when the check tool can also change things, such as a command runner: then only this exact call counts as a check, and any other call to that tool counts as a change. Leave empty when the check tool only checks. | `""` |
| `verify_tool` | `string` | **Check tool**<br/>Name of a connected tool that checks the work, such as a compiler or test runner (e.g. workspace.compile). When set, the agent must call it after its last change and fix what it reports before it may finish. Leave empty when no such tool is connected. | `""` |

## Dependencies

- `jmespath`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_rocketride)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
