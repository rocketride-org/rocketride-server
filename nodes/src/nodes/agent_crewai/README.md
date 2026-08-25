# agent_crewai

A RocketRide family of CrewAI nodes for a standalone agent, a manager that
delegates work to CrewAI subagents, and subagents used only by that manager.
Choose the Agent for one task, or the Manager and Subagent pair when work needs
named specialists.

## About CrewAI

CrewAI is a framework whose Agent, Task, and Crew objects organize language
model work and tool use. These nodes use those objects with RocketRide-provided
LLM and tool connections instead of configuring a model provider in CrewAI.

## What it does

The standalone CrewAI Agent receives a question, builds a one-agent sequential
crew, and sends its result to `answers`; it can also serve as a parent agent's
tool. The CrewAI Manager collects descriptors from connected CrewAI Subagents,
builds a hierarchical crew, and returns its synthesized result on the same
lane or as a tool result. A Subagent is not directly runnable: the Manager
builds its Agent and Task and uses the Subagent's own LLM and optional tool
connections while delegated work runs. Choose the Agent for an independent
task and the Manager plus Subagents for explicit division of work.

## Connections

### CrewAI Agent

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used by the standalone agent. |
| `tool` | no | Tools available to the agent through control-plane invocation. |

### CrewAI Manager

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used by the manager agent. |
| `crewai` | yes | Connected CrewAI Subagent nodes to describe and delegate to. |

### CrewAI Subagent

| Connection | Required | Description |
| --- | --- | --- |
| `llm` | yes | LLM used when the Manager delegates to this subagent. |
| `tool` | no | Tools available to this subagent through control-plane invocation. |

The Manager stops with an error if no Subagent is connected or if none respond
to its `describe` fan-out. A Subagent's `tool` connection belongs to the
delegated specialist, not to the Manager.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | CrewAI Agent: run the standalone crew and emit its result. |
| `questions` | `answers` | CrewAI Manager: run the hierarchical crew and emit its result. |

CrewAI Subagent declares no lanes. Wire it to a Manager's `crewai` connection;
a direct question is rejected as an invalid use of the subagent.

## As a tool

The CrewAI Agent and CrewAI Manager each register
`<nodeId>.run_agent`, using their own pipeline node ID as the prefix. The
CrewAI Subagent is not a tool and exposes no `run_agent` function.

| Function | Description |
| --- | --- |
| `<nodeId>.run_agent` | CrewAI Agent: run the standalone agent for a delegated query and return its agent result. |
| `<nodeId>.run_agent` | CrewAI Manager: run the manager and its connected subagent crew for a delegated query and return its agent result. |

Both functions require an object with a non-empty `query: string` and accept
an optional `context: object`. Context is encoded as a
`RocketRide.agent.tool_context.v1` entry, and the result is
`{content, meta, stack}` rather than an `answers`-lane write. Non-object
input, a blank query, or non-object context raises `ValueError`. When an
agent description is configured, it is prepended to the registered tool
description that a parent agent sees.

## Configuration

Each variant has the `default` profile. Begin by wiring the LLM and, where
applicable, the Manager-to-Subagent and tool connections; use **Advanced Mode**
only after the basic role is clear. Empty advanced text fields fall back to the
drivers' built-in goal, backstory, and expected-output text where that driver
uses those fields.

### Agent description

CrewAI Agent and CrewAI Manager expose this field to parent agents through
their `run_agent` tool descriptions. Describe the actual job, inputs, and
expertise of the standalone agent or of the manager-and-crew as a whole, so a
parent can decide when to delegate. A specific value such as “Coordinates
research and fact-checking specialists” is useful; leave it empty when nothing
will call the node as a tool.

### Instructions

Instructions are appended as a bullet list to the CrewAI Agent's backstory.
For a Manager, they guide its delegation strategy through the manager
backstory; for a Subagent, they become part of the specialist's backstory.
Use short, durable constraints such as “cite the evidence supplied by tools,”
rather than duplicating the role and task text configured in Advanced Mode.

### Require tool call

This setting is off by default on the Agent and Manager. Enable it when a
response must be based on at least one real tool invocation, rather than an
answer produced without external work. For a Manager, tool invocations made by
delegated Subagents count toward the same guard. Leave it off when a valid
answer may require no tool call.

### Advanced Mode

Advanced Mode is off by default and reveals the CrewAI Agent and Task fields.
Turn it on only when the default Assistant/Specialist behavior and built-in
fallbacks are insufficient. It does not make a Subagent independently
runnable: that node remains a Manager-only component.

### Agent and task fields

For the standalone Agent, **Role**, **Goal**, **Backstory**, **Task**, and
**Expected Output** map to the CrewAI Agent and Task built for each question.
When Task is blank, the incoming question becomes the task; when it is set,
the question is appended as `User request:` context. Set Task when each run
has a stable assignment, and leave it blank for a general-purpose assistant.

For a Subagent, **Role** is the specialist name the Manager gives to CrewAI;
**Goal**, **Backstory**, **Task**, and **Expected Output** define the delegated
Agent and Task. A blank Subagent Task becomes `{user_request}`, while a
configured task can use CrewAI template variables such as `{user_request}`.
Use a unique, descriptive Role and a task that names the specialist's output;
the Manager uses the descriptor to assemble its crew.

For the Manager, **Manager Goal** and **Manager Backstory** configure its
delegator Agent. Set them when the Manager needs a particular delegation
policy or domain framing; otherwise it uses its built-in management goal and
backstory.

### Crew Planning

This Manager-only option is off by default. When enabled, CrewAI runs a planner
before the hierarchical crew and supplies the resulting plan to tasks; it also
adds an LLM call. Enable it only when the connected LLM reliably returns the
JSON CrewAI's planning conversion requires: a prose plan can make the whole run
fail with `Failed to get the Planning output`.

## Notes

### Manager execution

The Manager invokes `describe` on each explicitly connected Subagent, then
creates an Agent and Task for every descriptor. It gives the manager
`allow_delegation=True` and each specialist `allow_delegation=False`; the
specialist tasks have their direct tool lists cleared so the manager delegates
rather than using a specialist's tools itself. The Manager prefers the last
completed task's cleaned output to avoid returning its whole hierarchical
ReAct trace.

### Runtime and progress

All CrewAI kickoffs share one daemon-thread asyncio loop because the driver
treats CrewAI's process-wide internals as unsafe across multiple threads.
Concurrent kickoffs can still interleave at await points. A process-wide
listener forwards relevant CrewAI events to the initiating run as `thinking`
SSE messages; stream chunks and terminal formatter events are intentionally
not forwarded.

### Tool execution

The CrewAI LLM wrapper delegates through the node's `llm` connection and
reports no native function-calling support, so CrewAI uses its ReAct tool path.
Each connected tool is wrapped with an argument schema made from its declared
JSON input schema; exceptions from a wrapped tool are returned to CrewAI as an
object containing `error` and `type`.

## Upstream docs

- [CrewAI documentation](https://docs.crewai.com/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### CrewAI Agent (`services.agent.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `advanced_mode` | `boolean` | **Advanced Mode**<br/>Expose CrewAI Agent and Task configuration directly. | `false` |
| `agent_crewai.agent_config_header` | `null` | **Agent Config** | `null` |
| `agent_crewai.task_config_header` | `null` | **Task Config** | `null` |
| `agent_description` | `string` | **Agent description**<br/>What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. | `""` |
| `backstory` | `string` | **Backstory**<br/>Background context for this agent's persona. Maps to CrewAI Agent(backstory=...). |  |
| `expected_output` | `string` | **Expected Output**<br/>Description of the expected output format. Maps to CrewAI Task(expected_output=...). |  |
| `goal` | `string` | **Goal**<br/>What this agent is trying to achieve. Maps to CrewAI Agent(goal=...). |  |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the agent. |  |
| `require_tool_call` | `boolean` | **Require tool call**<br/>Require the agent to invoke at least one tool before answering. When on, a run that answers without calling any tool fails with a guard error. Use for determinism-critical pipelines where an ungrounded or narrated answer must never be delivered. Off by default. | `false` |
| `role` | `string` | **Role**<br/>Agent role name (e.g. 'Financial Analyst'). Maps to CrewAI Agent(role=...). |  |
| `task_description` | `string` | **Task**<br/>What this agent should do. If blank, the incoming question is used. Maps to CrewAI Task(description=...). |  |

### CrewAI Manager (`services.manager.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `advanced_mode` | `boolean` | **Advanced Mode**<br/>Expose CrewAI manager Agent configuration directly. | `false` |
| `agent_description` | `string` | **Agent description**<br/>What this manager + its sub-agent crew does. Used by parent agents that call this manager as a tool via `<nodeId>.run_agent` to decide when to invoke it. | `""` |
| `backstory` | `string` | **Manager Backstory**<br/>Background context for the manager's persona. Maps to CrewAI Agent(backstory=...). |  |
| `goal` | `string` | **Manager Goal**<br/>What the manager is trying to achieve. Maps to CrewAI Agent(goal=...). |  |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide the manager's delegation strategy. |  |
| `require_tool_call` | `boolean` | **Require tool call**<br/>Require the agent to invoke at least one tool before answering. When on, a run that answers without calling any tool fails with a guard error. Use for determinism-critical pipelines where an ungrounded or narrated answer must never be delivered. Off by default. | `false` |

### CrewAI Subagent (`services.subagent.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `advanced_mode` | `boolean` | **Advanced Mode**<br/>Expose CrewAI Agent and Task configuration directly. | `false` |
| `agent_crewai_subagent.agent_config_header` | `null` | **Agent Config** | `null` |
| `agent_crewai_subagent.task_config_header` | `null` | **Task Config** | `null` |
| `backstory` | `string` | **Backstory**<br/>Background context for this sub-agent's expertise. Helps the Manager and the sub-agent's own LLM reason about when it's the right choice. Maps to CrewAI Agent(backstory=...). |  |
| `expected_output` | `string` | **Expected Output**<br/>Description of the expected output format. Maps to CrewAI Task(expected_output=...). |  |
| `goal` | `string` | **Goal**<br/>What this sub-agent aims to achieve when delegated to. Maps to CrewAI Agent(goal=...). |  |
| `instructions` | `array` | **Instructions**<br/>Additional instructions to guide this sub-agent when the Manager delegates to it. |  |
| `role` | `string` | **Role**<br/>Sub-agent role name (e.g. 'Financial Analyst'). The Manager uses this name when routing delegation. Maps to CrewAI Agent(role=...). |  |
| `task_description` | `string` | **Task**<br/>What this sub-agent does when delegated to by the Manager. The user's request is passed as additional context at run time. Maps to CrewAI Task(description=...). |  |

## Dependencies

- `crewai` `>=1.14.1`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/agent_crewai)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
