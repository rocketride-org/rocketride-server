# agent_langchain

A RocketRide agent node for answering questions with a LangChain agent loop and
the LLM and tools wired into the pipeline. Choose it when a single agent should
use LangChain's structured tool-call flow, rather than coordinate CrewAI
subagents.

## About LangChain

LangChain is a framework for building applications that combine language models
with tools and message-based workflows. This node uses its agent and chat-model
interfaces while keeping model and tool execution on RocketRide connections.

## What it does

The node accepts a question on `questions`, runs a LangChain agent using the
connected LLM and any connected tools, then writes the final text to `answers`.
It is also available to a parent agent as a tool. The LLM adapter asks the model
for a JSON envelope that represents either a tool call or a final answer, then
converts it into LangChain's structured message form. Choose this node for that
single-agent LangChain flow; use the CrewAI manager when work must be delegated
to configured specialist subagents.

## Connections

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used by the agent. |
| `tool` | no | Tools available to the agent through control-plane invocation. |

The `llm` connection is required. With no `tool` connection, the agent can
still produce a final answer, but has no pipeline tools to call.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | Run the agent for each incoming question and emit its final answer. |

During a run, the node sends `thinking` SSE updates for agent startup,
LLM activity, and tool-call activity.

## As a tool

The registered tool name is `<nodeId>.run_agent`, where `<nodeId>` is this
node's pipeline ID; it has no separately configured server-name prefix.

| Function | Description |
| --- | --- |
| `<nodeId>.run_agent` | Run this LangChain agent for a delegated query and return its agent result. |

The input must be an object with required non-empty `query: string` and optional
`context: object`. The node stores supplied context as a
`RocketRide.agent.tool_context.v1` context entry. The call returns
`{content, meta, stack}` to its caller instead of writing to `answers`.
`meta` holds the framework, agent and run ids, timings and the tool-call count; it carries `stop_reason` when the run reports why it stopped (`error` when it raised, or when the `require_tool_call` guard refused its answer), and no `stop_reason` means none was reported, not that the run finished. The task's control token is never included.
Non-object input, a blank query, or a non-object context raises `ValueError`.
If the LLM produces neither a tool call nor an answer in three attempts, the run
fails: `content` says what was wrong with the model's last reply and
`meta.stop_reason` is `error`.

## Configuration

The only profile is `default`: connect an LLM first, then add tools only when
the agent needs to take actions or retrieve information. Most pipelines can
leave the profile selection alone and set the fields that shape delegation and
answering behavior.

### Agent description

This text is added to the registered `run_agent` tool description when it is
non-empty. Set it when another agent may choose this node, describing the
specialist job and the kinds of requests it should receive; leave it empty when
the node is only driven from its `questions` lane. A concrete description such
as “Summarizes retrieved policy documents” gives a parent a usable routing cue.

### Instructions

Use the instruction list for additional guidance supplied by this node's
configuration. Keep each entry narrowly scoped to the work the agent should do
or the constraints it must honor. Put enduring routing information in **Agent
description** instead, because that is the text exposed to parent agents.

### Require tool call

This option is off by default. Turn it on for a workflow where an answer must
follow at least one real tool invocation, for example a response that must be
grounded in a connected store. Leave it off when the agent can validly answer
without a tool; enabled runs that answer without a tool fail with the declared
guard error.

## Notes

### JSON tool-call protocol

RocketRide's LLM seam is text-based, while the LangChain agent expects
structured tool calls. On each model turn, the adapter requests exactly one
JSON object: `{"type":"tool_call","name":"server.tool","args":{...}}` or
`{"type":"final","content":"..."}`. Connected tools receive dynamically built
argument schemas from their declared input schemas, with a generic `input`
field as the fallback.

The node and `agent_deepagent` share reply parsing, answer recovery and the
three-attempt retry loop in `ai.common.agent._internal.protocol`. This node
keeps its JSON-envelope prompt and accepts one tool call per reply; DeepAgent
also enables parallel `tool_calls`. The shared reply handling works as follows:

- A `final` envelope whose content was not escaped correctly (an inner `"`, a
  literal line break) is recovered when the envelope opens the reply and the
  reply ends with its closing `"}`, with or without a markdown fence around
  it. A JSON document pasted in unescaped is delivered exactly as written. An
  envelope that was cut off, has more text after it, has other members after
  `content` (`","note":"z"}`, even when that string also has broken escaping), has a second envelope after it, or has a
  `FINAL>>>` line inside it is retried:
  where the answer ended cannot be told. One cut-off cannot be told from a
  finished answer and is delivered: a reply that stops exactly after a `"}`
  inside the answer.
- A valid envelope can follow a preamble containing braces or ordinary JSON.
  When the first object is not an envelope, a standalone envelope on a later
  line is read. Nested objects and quoted examples are not dispatched. Replies
  mixing this fallback with `FINAL>>>` are retried instead of guessing.
- A `content` that is not a string (a JSON object, array, number or boolean) is
  delivered as JSON text. For compatibility, a parsed `final` with missing,
  null, empty or whitespace-only content remains a successful answer; this is
  distinct from an empty model reply, which is retried.
- `FINAL>>>` at the start of a line, followed by the answer as plain text, is
  also an answer. Nothing after the marker needs escaping. The prompt does not
  ask for this form; a retry does, when an answer did not parse. When all that
  follows the marker is a `final` envelope, its content is the answer, and one
  that was cut off there is retried. A whole tool-call envelope after the
  marker, with or without a fence, is retried with instructions to omit the
  marker; it is never presented as the answer. A space, tab, LF, CRLF or bare
  CR separates the marker from its answer, and only one separator is removed.
  LF, CRLF and bare CR also start a new marker line.
- A tool call, the first line included, is not replaced by a `FINAL>>>` line
  after it: the line is a claim about work not yet done. The reply is then
  read as its first JSON object, as always: a tool call there runs, and
  anything else is retried. That holds for a tool call that lost its `type`
  and is the reply's first object or has no word before it on its line, and
  for one that does not parse wherever in the reply it sits: they do not
  run, and the claim after them is not delivered either. One kind of tool
  call is read as quoted: one that parses and has a word before it and a word
  after it on its line. It is prose, and a `FINAL>>>` line after it is the
  answer. Punctuation, a brace, a closing, a markup tag or a comment around a
  call is no word. A tool call wrapped inside another object that parses is not read.
- A valid `final` followed by a pending tool call is retried. Its claim is
  withheld until the model sends the call and that work runs. A quoted, valid
  call example after the final is still ordinary trailing prose. A new, closed
  markdown code block after that final also quotes examples, including malformed
  calls. An unfenced trailing call, a call in the same fence as the final, or a
  call in an unclosed block remains pending work; no successful fallback drops it.
- A `FINAL>>>` line after a `final` envelope that parses is read. With
  nothing after the marker, the envelope's content is the answer. After the
  opening of a broken one that is not quoted, inside its content or after it,
  the reply is retried: the line could as well be the answer's own text.

A reply that is neither a tool call nor an answer is retried twice, each time
with a hint that says what was wrong and how to send it: a broken tool call is
asked for again as a tool call, a broken answer after `FINAL>>>`, and a bare
JSON object (it may be an answer, or a tool call that lost its `type`) either
way. Hints include an excerpt, not the entire previous reply, and ask the
model to generate the required call from the task and tool schema. The
three-attempt budget is deliberate: a model that keeps replying in prose can
use three model calls, with their latency and token cost, before the fallback
accepts its text. After the third reply, prose is delivered as the answer, also when it
starts with a brace that opens no object (`{curly} braces`) or mentions a
`type`. An empty reply, a `FINAL>>>` with nothing after it, a reply that opens
with a JSON object that is neither shape, an envelope that was refused, a
broken envelope that is not quoted, and a broken tool call anywhere in the
reply are not answers: the run fails with `stop_reason: error`, and its answer
says what was wrong with the model's last reply without quoting it. An object
that does not parse is read by the members it carries itself, not the ones
nested in their values: its `type`, or a tool call's `name` and `args` when it
has no type. Such an object with no type counts as a tool call only as the
reply's first object or with no word before it on its line. When deciding whether
to deliver prose after three attempts, the first-object rule excludes explicit
code expressions: a leading `return`/`yield`, an
assignment, an arrow function, or a same-line function argument (including later
comma-separated arguments inside an open parenthesis). The exemption does not apply
when accepting a final claim or choosing its retry hint: a code dictionary with
`name` and `args` before `FINAL>>>` or a `final` envelope is pending work. The
claim is withheld and the model is asked to regenerate the call. A real code
example in that position cannot be distinguished from an unexecuted call and
is refused too. Prose such as `Calling: {...}` still counts
as a call. Elsewhere it is data or code, as in an answer that shows a function called with one. A tool
call's `type` right after the brace is still read when its colon is missing or
miswritten, or its key is in curly quotes or lost its closing quote. A brace that opens no object, as in a block of code, is prose and
hides nothing after it. With no word before it on its line, a tool call's
`type` right after the brace is also read with no quotes or in single quotes.
When a quote out of place or a missing closing kept the members from being
read, a `type` named in the text after the object decides, or `args` for an
object that has a name. This fallback also applies when the first key lost
either quote, gained an extra quote, or a missing opening brace made the
object appear to close before its remaining members. It is conservative:
an unreadable object followed by text naming a tool-call type may be retried
even when the model intended an example. A standalone `final` with unquoted
or single-quoted keys is retried, including in a fence or after `FINAL>>>`;
its raw envelope is not delivered as prose. Whitespace around a reply is
trimmed before it is read, as it always was.

Fence labels such as `json5`, `c++` and `objective-c` are supported for final
recovery. The marker itself must be plain `FINAL>>>` at the start of a line;
markdown wrappers such as `**FINAL>>>**` or backticks are not protocol markers
and may be delivered as prose after retries.

Recovery decodes recognized JSON escapes, including `\n`, `\t`, `\b` and
`\f`, while preserving unknown escapes. A malformed envelope does not reveal
whether a recognized escape was intended as a control character or as part of
a literal path such as `C:\new\temp`. Literal paths should use escaped
backslashes in JSON or follow `FINAL>>>`, where backslashes are preserved.
The parser does not guess path semantics or disable valid JSON escape decoding.
Recovery joins valid Unicode surrogate pairs and keeps an unpaired surrogate
as its original `\uXXXX` escape text, so recovery does not create a character
that cannot be encoded as UTF-8.
Parsed final content also preserves lone surrogates as literal `\uXXXX` escapes,
including after `FINAL>>>` and in object or array content. Valid Unicode characters
and surrogate pairs keep their decoded values.

## Upstream docs

- [LangChain documentation](https://docs.langchain.com/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `agent_langchain.profile` | `string` | **Profile** | `"default"` |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent. |  |
| `require_tool_call` | `boolean` | **Require tool call**<br/>Require the agent to invoke at least one tool before answering. When on, a run that answers without calling any tool fails with a guard error. Use for determinism-critical pipelines where an ungrounded or narrated answer must never be delivered. Off by default. | `false` |

## Dependencies

- `langchain`
- `langchain-core`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_langchain)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
