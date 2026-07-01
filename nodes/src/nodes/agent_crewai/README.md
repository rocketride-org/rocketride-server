# agent_crewai

Run CrewAI agents inside RocketRide: as a standalone agent, as a hierarchical manager that orchestrates a crew of sub-agents, or as a managed sub-agent worker.

## What it does

Three node variants share the same base driver (`crewai_base.py`), each loaded from its own sub-package:

- **CrewAI Agent** (`agent_crewai`): a standalone single agent. Assembles a CrewAI `Agent` + `Task` into a one-agent, sequential-process `Crew` and runs it to answer the incoming question.
- **CrewAI Manager** (`agent_crewai_manager`): orchestrates a crew using CrewAI's hierarchical process. Fans out a `describe` invoke to connected CrewAI Subagent nodes, assembles a `Crew` with the manager as delegator (`planning=True`, using the manager's LLM as the planning LLM), and synthesizes sub-agent outputs into one answer.
- **CrewAI Subagent** (`agent_crewai_subagent`): a managed worker. Wired into a Manager via the `crewai` channel and delegated to by name (its `role`); it has no `questions` lane and cannot be invoked directly.

Uses the **crewai** library (`>=1.14.1`). The node never calls a model provider directly: the wrapped CrewAI `BaseLLM` and `BaseTool` instances route every LLM and tool call back through the pipeline's own `llm` and `tool` channels, so each agent uses exactly the LLM and tools wired to its own node.

All crew kickoffs are funneled onto one shared asyncio event loop running on a single daemon thread (`crewai_runner.py`). This is necessary because CrewAI's process-global singletons (event bus, telemetry, console formatter) are not safe under concurrent kickoffs from multiple threads. Concurrent chats still overlap their IO at await points. A persistent event listener (`crewai_listener.py`) forwards CrewAI bus events (task started, agent thinking, tool calls, LLM calls, and so on) to the originating run as `thinking` SSE messages, routed per-run via a `ContextVar`.

CrewAI 1.14.x planning and delegation are patched at import time (`crewai_base.py`) to run safely inside the shared asyncio loop: planning is offloaded to a worker thread, and delegation tools gain async variants that use `aexecute_task()`. Without these patches, hierarchical crews raise `RuntimeError` when they detect a running event loop.

---

## Configuration

### Lanes

| Variant | Lanes | `llm` channel | `tool` channel | `crewai` channel |
|---|---|---|---|---|
| CrewAI Agent | `questions` -> `answers` | required (min 1) | optional | n/a |
| CrewAI Manager | `questions` -> `answers` | required (min 1) | n/a | required (min 1 Subagent) |
| CrewAI Subagent | none | required (min 1) | optional | n/a |

The Agent and Manager are registered as tools too (`classType: ["agent", "tool"]`) and expose themselves as `<nodeId>.run_agent`, so a parent agent can delegate to them in hierarchical pipelines. The `run_agent` tool accepts `{query: string, context?: object}` and returns `{content, meta, stack}`. Tools attach through the `tool` invoke channel (control-plane invoke), not through lanes.

The Subagent's `classType` is `["crewai"]`: it can only be wired into a Manager's `crewai` channel and cannot be called via `run_agent`. A CrewAI Agent node cannot be used as a sub-agent under a Manager (its `classType` does not include `crewai`), and a Manager cannot be nested under another Manager via the `crewai` channel. Cross-Manager composition goes through `run_agent` instead.

A Subagent can be connected to multiple Managers simultaneously: each Manager independently includes it in its own hierarchical Crew, enabling shared specialist sub-agents across delegation hierarchies.

Each variant shows only its description/instructions fields by default. Toggle **Advanced Mode** (`advanced_mode`, default `false`) to expose the CrewAI Agent and Task fields. Blank `goal`, `backstory`, and `expected_output` values fall back to built-in defaults at run time.

### CrewAI Agent

| Field | Type | Description |
|---|---|---|
| `instructions` | array | Additional instructions to guide this sub-agent when the Manager delegates to it. |
| `advanced_mode` | boolean | Default false. Expose CrewAI Agent and Task configuration directly. |
| `agent_config_header` | null |  |
| `role` | string | Sub-agent role name (e.g. 'Financial Analyst'). The Manager uses this name when routing delegation. Maps to CrewAI Agent(role=...). |
| `goal` | string | What this sub-agent aims to achieve when delegated to. Maps to CrewAI Agent(goal=...). |
| `backstory` | string | Background context for this sub-agent's expertise. Helps the Manager and the sub-agent's own LLM reason about when it's the right choice. Maps to CrewAI Agent(backstory=...). |
| `task_config_header` | null |  |
| `task_description` | string | What this sub-agent does when delegated to by the Manager. The user's request is passed as additional context at run time. Maps to CrewAI Task(description=...). |
| `expected_output` | string | Description of the expected output format. Maps to CrewAI Task(expected_output=...). |
| `agent_description` | string | Default empty. What does this agent do? Describe its purpose and capabilities, this helps parent agents select and invoke it correctly. |

### CrewAI Manager

| Field | Type/Default | Description |
|---|---|---|
| `agent_description` | string, `""` | What this manager and its sub-agent crew does. Used by parent agents that call it as a tool via `<nodeId>.run_agent`. |
| `instructions` | array, `[]` | Additional instructions to guide the manager's delegation strategy. Appended to the manager's backstory. |
| `advanced_mode` | boolean, `false` | When On, exposes the manager Agent config fields below. |
| `goal` | string, `""` | What the manager is trying to achieve. Maps to `Agent(goal=...)`. |
| `backstory` | string, `""` | Background context for the manager's persona. Maps to `Agent(backstory=...)`. |

The Manager requires at least one connected CrewAI Subagent on the `crewai` channel (min 1). It raises an error at run time if no sub-agents are connected or none respond to the `describe` fan-out.

### CrewAI Subagent

| Field | Type/Default | Description |
|---|---|---|
| `instructions` | array, `[]` | Additional instructions for this sub-agent when the Manager delegates to it. Appended to its backstory. |
| `advanced_mode` | boolean, `false` | When On, exposes the Agent and Task config fields below. |
| `role` | string, `"Specialist"` | Sub-agent role name. The Manager uses this name when routing delegation. Maps to `Agent(role=...)`. |
| `goal` | string, `""` | What this sub-agent aims to achieve. Maps to `Agent(goal=...)`. |
| `backstory` | string, `""` | Background context and expertise. Helps the Manager and the sub-agent's own LLM reason about when it is the right choice. Maps to `Agent(backstory=...)`. |
| `task_description` | string, `""` | What this sub-agent does when delegated to. Supports CrewAI template variables: `{user_request}` resolves to the raw user prompt; if blank, the task is just `{user_request}`. Maps to `Task(description=...)`. |
| `expected_output` | string, `""` | Description of the expected output format. Maps to `Task(expected_output=...)`. |

---

## How the Manager works

1. Fans out a `describe` invoke to each node on the `crewai` channel individually. Each Subagent responds with its role, goal, backstory, task description, expected output, instructions, and a handle to its own engine channels.
2. Builds a CrewAI `Agent` + `Task` per descriptor (`max_iter=5`, `allow_delegation=False`), routing LLM and tool calls back through that sub-agent's own `llm`/`tool` channels. The sub-agents' channels are fully independent of the Manager's.
3. Builds the manager agent (`allow_delegation=True`, `max_iter=5`) from this node's `llm` channel and config. The user's prompt is placed in the manager's backstory as background context, keeping the goal generic.
4. Kicks off a `Process.hierarchical` Crew with `planning=True` and returns the synthesized result.

### Result extraction

In hierarchical mode CrewAI's `result.raw` often contains the manager's full ReAct trace (delegations and observations) rather than just the answer. The Manager therefore prefers the last completed task's output and strips any ReAct preamble: everything after the last `Final Answer:` marker, or, when the agent ended on a tool observation, the last complete top-level JSON block. Non-ReAct output is returned as-is.

---

## Observability

Every CrewAI bus event from a kickoff (crew/task/agent lifecycle, tool usage, LLM calls) is forwarded to the originating run's invoker as a `thinking` SSE message with a human-friendly label (for example, "Agent thinking...", "Calling <tool>..."). LLM stream chunks and CrewAI's terminal-formatter log events are skipped to avoid flooding the UI. Routing is per-run via a `ContextVar`, so concurrent chats never see each other's events.

---

## Known limitations

- When the LLM uses native function calling, CrewAI invokes tools synchronously on the shared kickoff loop, so tool calls serialize across concurrent runs in that path. The ReAct tool path (`_arun`) offloads to a thread and does not block the loop.
- CrewAI 1.14.x planning and delegation are patched at import time to run safely inside the shared asyncio loop. Without these patches, hierarchical crews raise `RuntimeError` when they detect a running event loop.

---

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
